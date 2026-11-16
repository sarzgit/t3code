import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import { getDesktopUrl, isSameOriginRendererNavigation } from "../electron/ElectronProtocol.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MUSIC_MINI_PLAYER_SETTINGS_CHANGED_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const BOUNDS_PERSIST_DEBOUNCE_MS = 500;
const MINI_PLAYER_ROUTE = "#/music/mini";

const { logWarning } = makeComponentLogger("music-mini-player");

export class MusicMiniPlayerWindow extends Context.Service<
  MusicMiniPlayerWindow,
  {
    /** Opening again only shows the existing window; `focus: false` shows it without focus. */
    readonly open: (options: { readonly focus: boolean }) => Effect.Effect<void>;
    readonly close: Effect.Effect<void>;
    readonly toggle: Effect.Effect<void>;
    readonly pinned: Effect.Effect<boolean>;
    readonly setPinned: (pinned: boolean) => Effect.Effect<void>;
    readonly openMain: Effect.Effect<void>;
    /** Runs after every client settings write: closes when the player is off, else tells it to re-read. */
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/music/MiniPlayerWindow/MusicMiniPlayerWindow") {}

function readDisplays() {
  try {
    return Electron.screen
      .getAllDisplays()
      .map((display) => ({ bounds: display.bounds, workArea: display.workArea }));
  } catch {
    return [];
  }
}

function applyPinned(window: Electron.BrowserWindow, pinned: boolean, platform: NodeJS.Platform) {
  if (window.isDestroyed()) return;
  window.setAlwaysOnTop(pinned, platform === "darwin" ? "floating" : "normal");
  if (platform === "darwin") {
    window.setVisibleOnAllWorkspaces(pinned, {
      visibleOnFullScreen: pinned,
      // Electron's temporary UIElement transformation would remove the app from the Dock.
      skipTransformProcessType: true,
    });
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const mutex = yield* Semaphore.make(1);
  const windowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());

  const liveWindow = Ref.get(windowRef).pipe(
    Effect.map(Option.filter((window) => !window.isDestroyed())),
  );

  const playerEnabled = clientSettings.get.pipe(
    Effect.map(
      Option.match({
        onNone: () => DEFAULT_CLIENT_SETTINGS.musicPlayerEnabled,
        onSome: (settings) => settings.musicPlayerEnabled,
      }),
    ),
    Effect.orElseSucceed(() => false),
  );

  const persist = (patch: DesktopAppSettings.MusicMiniPlayerSettingsPatch) =>
    appSettings.setMusicMiniPlayer(patch).pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        logWarning("failed to save mini-player settings", { message: error.message }),
      ),
    );

  const reveal = (window: Electron.BrowserWindow, focus: boolean) =>
    Effect.sync(() => {
      if (window.isDestroyed()) return;
      if (focus) {
        window.show();
        window.focus();
      } else {
        window.showInactive();
      }
    });

  const create = Effect.fn("MusicMiniPlayerWindow.create")(function* (focus: boolean) {
    const settings = yield* appSettings.get;
    const main = yield* electronWindow.main;
    const bounds = DesktopWindow.resolveMusicMiniPlayerBounds(
      settings.musicMiniPlayerBounds,
      readDisplays(),
      Option.isSome(main) ? main.value.getBounds() : null,
    );
    const applicationUrl = getDesktopUrl(environment.isDevelopment);
    const shouldUseDarkColors = yield* electronTheme.shouldUseDarkColors;
    const window = yield* electronWindow.create(
      {
        ...bounds,
        show: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: settings.musicMiniPlayerPinned,
        title: environment.displayName,
        backgroundColor: shouldUseDarkColors ? "#000000" : "#ffffff",
        ...(environment.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: environment.preloadPath,
          // The seek bar keeps time while another app is focused.
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
        },
      },
      { auxiliary: true },
    );
    applyPinned(window, settings.musicMiniPlayerPinned, environment.platform);

    // The same isolation the main window gets in DesktopWindow, without its external-link handoff.
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!isSameOriginRendererNavigation({ applicationUrl, navigationUrl: url })) {
        event.preventDefault();
      }
    });
    window.webContents.on("will-attach-webview", (event) => event.preventDefault());
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const modifier = environment.platform === "darwin" ? input.meta : input.control;
      const closeChord = modifier && !input.alt && !input.shift && input.key.toLowerCase() === "w";
      if (closeChord || (input.key === "Escape" && !modifier && !input.alt && !input.shift)) {
        event.preventDefault();
        window.close();
      }
    });

    let boundsFiber: Fiber.Fiber<void, never> | undefined;
    const savePosition = () => {
      if (window.isDestroyed()) return;
      const { x, y } = window.getBounds();
      runFork(persist({ bounds: { ...DesktopAppSettings.MUSIC_MINI_PLAYER_SIZE, x, y } }));
    };
    window.on("move", () => {
      if (boundsFiber !== undefined) runFork(Fiber.interrupt(boundsFiber));
      boundsFiber = runFork(
        Effect.sleep(BOUNDS_PERSIST_DEBOUNCE_MS).pipe(Effect.andThen(Effect.sync(savePosition))),
      );
    });
    window.on("close", () => {
      if (boundsFiber !== undefined) runFork(Fiber.interrupt(boundsFiber));
      savePosition();
    });
    window.on("closed", () => {
      runFork(
        Effect.all([
          electronWindow.clearMusicMiniPlayer(window),
          Ref.update(windowRef, (current) =>
            Option.isSome(current) && current.value === window ? Option.none() : current,
          ),
        ]),
      );
    });
    window.once("ready-to-show", () => runFork(reveal(window, focus)));

    // Desktop IPC answers it only once registered, so register before its renderer can call in.
    yield* electronWindow.setMusicMiniPlayer({ window, applicationUrl });
    yield* Ref.set(windowRef, Option.some(window));
    void window.loadURL(`${applicationUrl}${MINI_PLAYER_ROUTE}`).catch(() => undefined);
  });

  const open = Effect.fn("MusicMiniPlayerWindow.open")(function* ({
    focus,
  }: {
    readonly focus: boolean;
  }) {
    if (yield* Ref.get(desktopState.quitting)) return;
    if (!(yield* playerEnabled)) return;
    const existing = yield* liveWindow;
    if (Option.isSome(existing)) return yield* reveal(existing.value, focus);
    yield* create(focus).pipe(
      Effect.catch((error) =>
        logWarning("failed to open the mini-player", { message: error.message }),
      ),
    );
  }, mutex.withPermits(1));

  const close = Effect.gen(function* () {
    const existing = yield* liveWindow;
    if (Option.isSome(existing)) existing.value.close();
  }).pipe(Effect.withSpan("MusicMiniPlayerWindow.close"));

  return MusicMiniPlayerWindow.of({
    open,
    close,
    toggle: Effect.gen(function* () {
      if (Option.isSome(yield* liveWindow)) return yield* close;
      yield* open({ focus: true });
    }).pipe(Effect.withSpan("MusicMiniPlayerWindow.toggle")),
    pinned: appSettings.get.pipe(Effect.map((settings) => settings.musicMiniPlayerPinned)),
    setPinned: Effect.fn("MusicMiniPlayerWindow.setPinned")(function* (pinned) {
      const existing = yield* liveWindow;
      if (Option.isSome(existing)) applyPinned(existing.value, pinned, environment.platform);
      yield* persist({ pinned });
    }),
    openMain: desktopWindow.revealOrCreateMain.pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        logWarning("failed to open the main window", { message: error.message }),
      ),
      Effect.withSpan("MusicMiniPlayerWindow.openMain"),
    ),
    configure: Effect.fn("MusicMiniPlayerWindow.configure")(function* (settings) {
      if (!settings.musicPlayerEnabled) return yield* close;
      const existing = yield* liveWindow;
      if (Option.isSome(existing) && !existing.value.webContents.isDestroyed()) {
        existing.value.webContents.send(MUSIC_MINI_PLAYER_SETTINGS_CHANGED_CHANNEL);
      }
    }),
  });
});

export const layer = Layer.effect(MusicMiniPlayerWindow, make);
