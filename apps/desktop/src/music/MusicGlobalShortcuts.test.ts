import { assert, it } from "@effect/vitest";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type KeybindingShortcut,
  type MusicGlobalShortcuts as MusicGlobalShortcutsSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

const { registerMock, unregisterMock } = vi.hoisted(() => ({
  registerMock: vi.fn<(accelerator: string, callback: () => Promise<void>) => boolean>(),
  unregisterMock: vi.fn<(accelerator: string) => void>(),
}));

// No unregisterAll: calling it would throw, since it would also free other services' keys.
vi.mock("electron", () => ({
  globalShortcut: { register: registerMock, unregister: unregisterMock },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopShortcutRecording from "../app/DesktopShortcutRecording.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as MiniPlayerWindow from "./MiniPlayerWindow.ts";
import * as MusicGlobalShortcuts from "./MusicGlobalShortcuts.ts";

const chord = (key: string, modifiers: Partial<KeybindingShortcut> = {}): KeybindingShortcut => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: false,
  ...modifiers,
});

const SNAP_SHOT = chord("2", { ctrlKey: true, shiftKey: true });

function withShortcuts(
  bindings: MusicGlobalShortcutsSettings["bindings"],
  patch: Partial<ClientSettings> = {},
): ClientSettings {
  return {
    ...DEFAULT_CLIENT_SETTINGS,
    snapShotShortcut: SNAP_SHOT,
    musicGlobalShortcuts: { enabled: true, bindings },
    ...patch,
  };
}

function fakeWindow() {
  const sent: unknown[][] = [];
  const window = {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: (...args: unknown[]) => sent.push(args) },
  } as unknown as Electron.BrowserWindow;
  return { window, sent };
}

const setup = (
  options: {
    readonly platform?: NodeJS.Platform;
    readonly localEnvironmentEnabled?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    registerMock.mockReset().mockReturnValue(true);
    unregisterMock.mockReset();
    const main = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
    const mini = yield* Ref.make<Option.Option<ElectronWindow.MusicMiniPlayerRegistration>>(
      Option.none(),
    );
    const miniCalls: string[] = [];
    const layer = MusicGlobalShortcuts.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
            platform: options.platform ?? "darwin",
          } as DesktopEnvironment.DesktopEnvironment["Service"]),
          Layer.mock(ElectronWindow.ElectronWindow, {
            main: Ref.get(main),
            musicMiniPlayer: Ref.get(mini),
          }),
          Layer.mock(MiniPlayerWindow.MusicMiniPlayerWindow, {
            open: ({ focus }) => Effect.sync(() => miniCalls.push(`open:${focus}`)),
            close: Effect.sync(() => miniCalls.push("close")),
          }),
          DesktopAppSettings.layerTest({
            ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
            localEnvironmentEnabled: options.localEnvironmentEnabled ?? true,
          }),
          Layer.mock(DesktopClientSettings.DesktopClientSettings, { get: Effect.succeedNone }),
        ),
      ),
      Layer.provideMerge(DesktopShortcutRecording.layer),
    );
    return { main, mini, miniCalls, layer };
  });

const registered = () => registerMock.mock.calls.map(([accelerator]) => accelerator);
const press = (accelerator: string) =>
  Effect.promise(() => {
    const call = registerMock.mock.calls.findLast(([registeredAs]) => registeredAs === accelerator);
    if (call === undefined) throw new Error(`${accelerator} was never registered`);
    return call[1]();
  });

it.effect("registers only valid bindings and frees only its own keys on every way off", () =>
  Effect.gen(function* () {
    const { layer } = yield* setup();
    yield* Effect.gen(function* () {
      const shortcuts = yield* MusicGlobalShortcuts.MusicGlobalShortcuts;
      const bindings = {
        playPause: chord("p", { modKey: true, altKey: true }),
        // Shift alone, the same key as play/pause, and Snap Shot's key are all refused.
        next: chord("n", { shiftKey: true }),
        previous: chord("p", { metaKey: true, altKey: true }),
        favorite: SNAP_SHOT,
        toggleMiniPlayer: chord("m", { ctrlKey: true, altKey: true }),
      };
      yield* shortcuts.configure(withShortcuts(bindings));
      assert.deepEqual(registered(), ["CommandOrControl+Alt+P", "Control+Alt+M"]);
      assert.deepEqual(yield* shortcuts.status, {
        playPause: "registered",
        toggleMiniPlayer: "registered",
      });

      // Changing one binding frees only that key; the unchanged one is not registered again.
      const changed = {
        ...bindings,
        toggleMiniPlayer: chord("j", { ctrlKey: true, altKey: true }),
      };
      yield* shortcuts.configure(withShortcuts(changed));
      assert.deepEqual(
        unregisterMock.mock.calls.map(([accelerator]) => accelerator),
        ["Control+Alt+M"],
      );
      assert.deepEqual(registered().slice(2), ["Control+Alt+J"]);

      unregisterMock.mockClear();
      yield* shortcuts.configure(withShortcuts(changed, { musicPlayerEnabled: false }));
      assert.sameMembers(
        unregisterMock.mock.calls.map(([accelerator]) => accelerator),
        ["CommandOrControl+Alt+P", "Control+Alt+J"],
      );
      assert.deepEqual(yield* shortcuts.status, {});

      yield* shortcuts.configure(withShortcuts(changed));
      unregisterMock.mockClear();
      yield* shortcuts.configure({
        ...withShortcuts(changed),
        musicGlobalShortcuts: { enabled: false, bindings: changed },
      });
      assert.lengthOf(unregisterMock.mock.calls, 2);

      yield* shortcuts.configure(withShortcuts(changed));
      // Either Settings recorder lets go of T3's keys only, and the last one to end takes them back.
      const recordings = yield* DesktopShortcutRecording.DesktopShortcutRecording;
      const ours = ["CommandOrControl+Alt+P", "Control+Alt+J"];
      for (const [first, second] of [
        ["music", "snapShot"],
        ["snapShot", "music"],
      ] as const) {
        unregisterMock.mockClear();
        registerMock.mockClear();
        yield* recordings.set(first, true);
        assert.sameMembers(
          unregisterMock.mock.calls.map(([accelerator]) => accelerator),
          ours,
        );
        assert.deepEqual(yield* shortcuts.status, {});
        yield* recordings.set(second, true);
        // A save while recording keeps them free.
        yield* shortcuts.configure(withShortcuts(changed));
        yield* recordings.set(first, false);
        assert.lengthOf(registerMock.mock.calls, 0, `${first} ended while ${second} records`);
        yield* recordings.set(second, false);
        assert.sameMembers(registered(), ours);
      }
      // A recorder that never says it stopped gives the keys back after a minute.
      registerMock.mockClear();
      yield* recordings.set("snapShot", true);
      yield* TestClock.adjust("59 seconds");
      assert.lengthOf(registerMock.mock.calls, 0);
      yield* TestClock.adjust("1 second");
      assert.sameMembers(registered(), ours);
      unregisterMock.mockClear();
    }).pipe(Effect.provide(layer));
    // Quitting closes the layer's scope, which frees what is still held.
    assert.sameMembers(
      unregisterMock.mock.calls.map(([accelerator]) => accelerator),
      ["CommandOrControl+Alt+P", "Control+Alt+J"],
    );
  }),
);

const NO_REGISTRATION_CASES: ReadonlyArray<
  readonly [
    string,
    { readonly platform?: NodeJS.Platform; readonly localEnvironmentEnabled?: boolean },
  ]
> = [
  ["off macOS", { platform: "win32" }],
  ["while the primary environment is not this Mac", { localEnvironmentEnabled: false }],
];
it.effect.each(NO_REGISTRATION_CASES)("registers nothing %s", ([, options]) =>
  Effect.gen(function* () {
    const { layer } = yield* setup(options);
    yield* Effect.gen(function* () {
      const shortcuts = yield* MusicGlobalShortcuts.MusicGlobalShortcuts;
      yield* shortcuts.configure(
        withShortcuts({ next: chord("n", { ctrlKey: true, altKey: true }) }),
      );
      assert.lengthOf(registerMock.mock.calls, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("reports a key another app holds and retries it without touching owned keys", () =>
  Effect.gen(function* () {
    const { layer } = yield* setup();
    yield* Effect.gen(function* () {
      const shortcuts = yield* MusicGlobalShortcuts.MusicGlobalShortcuts;
      registerMock.mockImplementation((accelerator) => accelerator !== "Control+Alt+N");
      const settings = withShortcuts({
        playPause: chord("p", { ctrlKey: true, altKey: true }),
        next: chord("n", { ctrlKey: true, altKey: true }),
      });
      yield* shortcuts.configure(settings);
      assert.deepEqual(yield* shortcuts.status, { playPause: "registered", next: "unavailable" });

      // The other app let go: the same save registers it, and play/pause is not registered twice.
      registerMock.mockReturnValue(true);
      yield* shortcuts.configure(settings);
      assert.deepEqual(registered(), ["Control+Alt+P", "Control+Alt+N", "Control+Alt+N"]);
      assert.deepEqual(yield* shortcuts.status, { playPause: "registered", next: "registered" });
      assert.lengthOf(unregisterMock.mock.calls, 0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("sends actions to the main window, else the mini-player, once per held key", () =>
  Effect.gen(function* () {
    const { main, mini, miniCalls, layer } = yield* setup();
    yield* Effect.gen(function* () {
      const shortcuts = yield* MusicGlobalShortcuts.MusicGlobalShortcuts;
      yield* shortcuts.configure(
        withShortcuts({
          playPause: chord("p", { ctrlKey: true, altKey: true }),
          next: chord("n", { ctrlKey: true, altKey: true }),
          toggleMiniPlayer: chord("m", { ctrlKey: true, altKey: true }),
        }),
      );
      const mainWindow = fakeWindow();
      const miniWindow = fakeWindow();
      yield* Ref.set(main, Option.some(mainWindow.window));
      yield* Ref.set(
        mini,
        Option.some({ window: miniWindow.window, applicationUrl: "t3code://app/" }),
      );

      yield* press("Control+Alt+P");
      yield* press("Control+Alt+P");
      yield* press("Control+Alt+N");
      yield* TestClock.adjust("299 millis");
      yield* press("Control+Alt+P");
      yield* TestClock.adjust("1 millis");
      yield* press("Control+Alt+P");
      assert.deepEqual(mainWindow.sent, [
        [MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL, "playPause"],
        [MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL, "next"],
        [MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL, "playPause"],
      ]);

      yield* Ref.set(main, Option.none());
      yield* TestClock.adjust("300 millis");
      yield* press("Control+Alt+N");
      assert.deepEqual(miniWindow.sent, [[MUSIC_GLOBAL_SHORTCUT_ACTION_CHANNEL, "next"]]);

      // Toggle is handled here: it closes an open mini-player and opens one without focus.
      yield* press("Control+Alt+M");
      yield* Ref.set(mini, Option.none());
      yield* TestClock.adjust("300 millis");
      yield* press("Control+Alt+M");
      // With no renderer, only the toggle acts.
      yield* TestClock.adjust("300 millis");
      yield* press("Control+Alt+P");
      assert.deepEqual(miniCalls, ["close", "open:false"]);
      assert.lengthOf(miniWindow.sent, 1);
      assert.lengthOf(mainWindow.sent, 3);
    }).pipe(Effect.provide(layer));
  }),
);
