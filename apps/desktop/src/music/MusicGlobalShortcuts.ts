import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type MusicGlobalShortcutAction,
  type MusicGlobalShortcutStatus,
} from "@t3tools/contracts";
import {
  MUSIC_GLOBAL_SHORTCUT_ACTIONS,
  musicGlobalShortcutIssues,
} from "@t3tools/shared/musicGlobalShortcuts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShortcutRecording from "../app/DesktopShortcutRecording.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import { toElectronAccelerator } from "../snapShot/snapShot.ts";
import * as MiniPlayerWindow from "./MiniPlayerWindow.ts";

// The callback gets no key event, so a held key is told apart from a new press by time alone.
const ACTION_COOLDOWN_NS = 300_000_000n;

const { logWarning } = makeComponentLogger("music-global-shortcuts");

export class MusicGlobalShortcuts extends Context.Service<
  MusicGlobalShortcuts,
  {
    readonly initialize: Effect.Effect<void>;
    /** Runs after every client settings write; registers or frees only this service's keys. */
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
    readonly status: Effect.Effect<MusicGlobalShortcutStatus>;
  }
>()("@t3tools/desktop/music/MusicGlobalShortcuts") {}

function register(accelerator: string, callback: () => Promise<void>): boolean {
  try {
    return Electron.globalShortcut.register(accelerator, callback);
  } catch {
    return false;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const miniPlayer = yield* MiniPlayerWindow.MusicMiniPlayerWindow;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const mutex = yield* Semaphore.make(1);
  const apple = environment.platform === "darwin";
  const owned = new Map<MusicGlobalShortcutAction, string>();
  const failed = new Set<MusicGlobalShortcutAction>();
  const lastFiredAt = new Map<MusicGlobalShortcutAction, bigint>();
  const recordings = yield* DesktopShortcutRecording.DesktopShortcutRecording;
  // While a Settings recorder is open, T3's own keys are let go (see DesktopShortcutRecording).
  let recording = false;
  let lastSettings: ClientSettings | null = null;

  const liveContents = (window: Electron.BrowserWindow) =>
    window.isDestroyed() || window.webContents.isDestroyed()
      ? Option.none()
      : Option.some(window.webContents);

  const renderer = Effect.gen(function* () {
    const main = Option.flatMap(yield* electronWindow.main, liveContents);
    if (Option.isSome(main)) return main;
    return Option.flatMap(yield* electronWindow.musicMiniPlayer, (registration) =>
      liveContents(registration.window),
    );
  });

  const trigger = Effect.fn("MusicGlobalShortcuts.trigger")(function* (
    action: MusicGlobalShortcutAction,
  ) {
    const now = yield* Clock.currentTimeNanos;
    const last = lastFiredAt.get(action);
    if (last !== undefined && now - last < ACTION_COOLDOWN_NS) return;
    lastFiredAt.set(action, now);
    if (action === "toggleMiniPlayer") {
      if (Option.isSome(yield* electronWindow.musicMiniPlayer)) return yield* miniPlayer.close;
      // A global key must not pull focus from the app the user is typing in.
      return yield* miniPlayer.open({ focus: false });
    }
    const target = yield* renderer;
    if (Option.isSome(target)) target.value.send(MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL, action);
  });

  const unregister = (action: MusicGlobalShortcutAction) => {
    const accelerator = owned.get(action);
    if (accelerator === undefined) return;
    owned.delete(action);
    try {
      Electron.globalShortcut.unregister(accelerator);
    } catch {
      // Already gone; nothing else holds it on our behalf.
    }
  };

  const desired = Effect.fn("MusicGlobalShortcuts.desired")(function* (settings: ClientSettings) {
    const result = new Map<MusicGlobalShortcutAction, string>();
    const { enabled, bindings } = settings.musicGlobalShortcuts;
    if (!apple || !enabled || !settings.musicPlayerEnabled) return result;
    // The music player follows the primary environment, which is this Mac only while it runs here.
    const local = yield* appSettings.get.pipe(
      Effect.map((app) => app.localEnvironmentEnabled),
      Effect.orElseSucceed(() => false),
    );
    if (!local) return result;
    const issues = musicGlobalShortcutIssues(bindings, settings.snapShotShortcut, apple);
    for (const action of MUSIC_GLOBAL_SHORTCUT_ACTIONS) {
      const shortcut = bindings[action];
      if (shortcut !== undefined && issues[action] === undefined) {
        result.set(action, toElectronAccelerator(shortcut));
      }
    }
    return result;
  });

  const apply = Effect.fn("MusicGlobalShortcuts.apply")(function* (settings: ClientSettings) {
    lastSettings = settings;
    const next = recording
      ? new Map<MusicGlobalShortcutAction, string>()
      : yield* desired(settings);
    // Free changed keys first, so two actions can swap keys in one save.
    for (const action of MUSIC_GLOBAL_SHORTCUT_ACTIONS) {
      if (owned.has(action) && owned.get(action) !== next.get(action)) unregister(action);
    }
    failed.clear();
    for (const [action, accelerator] of next) {
      if (owned.get(action) === accelerator) continue;
      const onPress = () => runPromise(trigger(action)).catch(() => undefined);
      if (register(accelerator, onPress)) {
        owned.set(action, accelerator);
      } else {
        failed.add(action);
        yield* logWarning("music shortcut unavailable", { action, accelerator });
      }
    }
  });

  const reapply = Effect.suspend(() =>
    lastSettings === null
      ? clientSettings.get.pipe(
          Effect.map(Option.getOrElse(() => DEFAULT_CLIENT_SETTINGS)),
          Effect.flatMap(apply),
        )
      : apply(lastSettings),
  ).pipe(Effect.ignore);

  yield* recordings.onChange(
    Effect.fn("MusicGlobalShortcuts.recordingChanged")(function* (next: boolean) {
      recording = next;
      yield* reapply;
    }, mutex.withPermits(1)),
  );

  const releaseAll = Effect.sync(() => {
    for (const action of MUSIC_GLOBAL_SHORTCUT_ACTIONS) unregister(action);
    failed.clear();
  });

  yield* Effect.addFinalizer(() => releaseAll);

  return MusicGlobalShortcuts.of({
    initialize: clientSettings.get.pipe(
      Effect.map(Option.getOrElse(() => DEFAULT_CLIENT_SETTINGS)),
      Effect.flatMap(apply),
      Effect.ignore,
      mutex.withPermits(1),
      Effect.withSpan("MusicGlobalShortcuts.initialize"),
    ),
    configure: Effect.fn("MusicGlobalShortcuts.configure")(function* (settings) {
      yield* apply(settings);
    }, mutex.withPermits(1)),
    status: Effect.sync(() => {
      const status: { -readonly [K in MusicGlobalShortcutAction]?: "registered" | "unavailable" } =
        {};
      for (const action of owned.keys()) status[action] = "registered";
      for (const action of failed) status[action] = "unavailable";
      return status;
    }).pipe(mutex.withPermits(1)),
  });
});

export const layer = Layer.effect(MusicGlobalShortcuts, make);
