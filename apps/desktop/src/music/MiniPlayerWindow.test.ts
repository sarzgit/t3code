import * as NodeModule from "node:module";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({
  screen: {
    getAllDisplays: () => [
      {
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        workArea: { x: 0, y: 38, width: 1440, height: 862 },
      },
    ],
  },
}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { MUSIC_MINI_PLAYER_SETTINGS_CHANGED_CHANNEL } from "../ipc/channels.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as MiniPlayerWindow from "./MiniPlayerWindow.ts";

type Listener = (...args: Array<any>) => void;

function makeFakeWindow() {
  const windowListeners = new Map<string, Listener[]>();
  const contentsListeners = new Map<string, Listener[]>();
  let destroyed = false;
  let openHandler: ((details: { url: string }) => { action: string }) | undefined;
  const ownHandlers = new Map<string, () => unknown>();
  const window = {
    ownHandlers,
    calls: [] as string[],
    sent: [] as string[],
    on: (event: string, listener: Listener) => {
      windowListeners.set(event, [...(windowListeners.get(event) ?? []), listener]);
    },
    once: (event: string, listener: Listener) => {
      windowListeners.set(event, [...(windowListeners.get(event) ?? []), listener]);
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of windowListeners.get(event) ?? []) listener(...args);
    },
    emitContents: (event: string, ...args: unknown[]) => {
      for (const listener of contentsListeners.get(event) ?? []) listener(...args);
    },
    openWindow: (url: string) => openHandler?.({ url }),
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 900, y: 60, width: 340, height: 88 }),
    show: () => window.calls.push("show"),
    showInactive: () => window.calls.push("showInactive"),
    focus: () => window.calls.push("focus"),
    setAlwaysOnTop: (flag: boolean) => window.calls.push(`alwaysOnTop:${flag}`),
    setVisibleOnAllWorkspaces: () => undefined,
    loadURL: (url: string) => {
      window.calls.push(`load:${url}`);
      return Promise.resolve();
    },
    close: () => {
      window.calls.push("close");
      window.emit("close");
      destroyed = true;
      window.emit("closed");
    },
    webContents: {
      isDestroyed: () => destroyed,
      send: (channel: string) => window.sent.push(channel),
      on: (event: string, listener: Listener) => {
        contentsListeners.set(event, [...(contentsListeners.get(event) ?? []), listener]);
      },
      setWindowOpenHandler: (handler: typeof openHandler) => {
        openHandler = handler;
      },
      ipc: {
        handle: (channel: string, handler: () => unknown) => {
          ownHandlers.set(channel, handler);
        },
      },
    },
  };
  return window;
}

const setup = Effect.gen(function* () {
  const created: Array<{
    readonly options: Electron.BrowserWindowConstructorOptions;
    readonly auxiliary: boolean;
    readonly window: ReturnType<typeof makeFakeWindow>;
  }> = [];
  const registered = yield* Ref.make<Option.Option<ElectronWindow.MusicMiniPlayerRegistration>>(
    Option.none(),
  );
  const settings = yield* Ref.make<ClientSettings>(DEFAULT_CLIENT_SETTINGS);
  const mainReveals = yield* Ref.make(0);
  const layer = MiniPlayerWindow.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
          platform: "darwin",
          isDevelopment: false,
          displayName: "T3 Code",
          preloadPath: "/app/preload.cjs",
          musicMiniPlayerPreloadPath: "/app/musicMiniPlayerPreload.cjs",
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
        DesktopState.layer,
        Layer.mock(ElectronTheme.ElectronTheme, { shouldUseDarkColors: Effect.succeed(true) }),
        Layer.mock(ElectronWindow.ElectronWindow, {
          main: Effect.succeedNone,
          create: (options, behavior) =>
            Effect.sync(() => {
              const window = makeFakeWindow();
              created.push({ options, auxiliary: behavior?.auxiliary === true, window });
              return window as unknown as Electron.BrowserWindow;
            }),
          setMusicMiniPlayer: (registration) => Ref.set(registered, Option.some(registration)),
          clearMusicMiniPlayer: () => Ref.set(registered, Option.none()),
        }),
        Layer.mock(DesktopWindow.DesktopWindow, {
          revealOrCreateMain: Ref.update(mainReveals, (count) => count + 1).pipe(
            Effect.as({} as Electron.BrowserWindow),
          ),
        }),
        DesktopAppSettings.layerTest(),
        Layer.mock(DesktopClientSettings.DesktopClientSettings, {
          get: Ref.get(settings).pipe(Effect.asSome),
        }),
      ),
    ),
  );
  return { created, registered, settings, mainReveals, layer };
});

it.effect("keeps one isolated, registered window and closes it when the player is turned off", () =>
  Effect.gen(function* () {
    const { created, registered, settings, mainReveals, layer } = yield* setup;
    yield* Effect.gen(function* () {
      const player = yield* MiniPlayerWindow.MusicMiniPlayerWindow;
      yield* player.open({ focus: true });
      yield* player.open({ focus: false });
      assert.lengthOf(created, 1);
      const { options, auxiliary, window } = created[0]!;
      assert.isTrue(auxiliary);
      assert.deepInclude(options, { x: 1440 - 340 - 16, y: 38 + 16, alwaysOnTop: true });
      // Its own preload: the desktop bridge without Clerk's sign-in, token and passkey bridge.
      assert.deepInclude(options.webPreferences, {
        preload: "/app/musicMiniPlayerPreload.cjs",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      });
      assert.include(window.calls, "load:t3code://app/#/music/mini");
      const registration = yield* Ref.get(registered);
      assert.isTrue(
        Option.isSome(registration) && registration.value.applicationUrl === "t3code://app/",
      );

      // Same guards as the main window: no popups and no navigation off the app origin.
      assert.deepEqual(window.openWindow("https://example.com/"), { action: "deny" });
      const blocked = { prevented: false, preventDefault: () => (blocked.prevented = true) };
      window.emitContents("will-navigate", blocked, "https://example.com/");
      const allowed = { prevented: false, preventDefault: () => (allowed.prevented = true) };
      window.emitContents("will-navigate", allowed, "t3code://app/#/music/mini");
      assert.deepEqual([blocked.prevented, allowed.prevented], [true, false]);

      // And Clerk's main-process handlers never answer it, whatever reaches them.
      assert.sameMembers([...window.ownHandlers.keys()], [...MiniPlayerWindow.CLERK_CHANNELS]);
      for (const handler of window.ownHandlers.values()) assert.throws(handler);

      window.emit("ready-to-show");
      yield* Effect.yieldNow;
      assert.includeMembers(window.calls, ["show", "focus", "showInactive"]);

      yield* player.configure(yield* Ref.get(settings));
      assert.deepEqual(window.sent, [MUSIC_MINI_PLAYER_SETTINGS_CHANGED_CHANNEL]);

      yield* player.openMain;
      assert.equal(yield* Ref.get(mainReveals), 1);

      yield* player.configure({ ...DEFAULT_CLIENT_SETTINGS, musicPlayerEnabled: false });
      assert.include(window.calls, "close");
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* Ref.get(registered)));

      yield* Ref.set(settings, { ...DEFAULT_CLIENT_SETTINGS, musicPlayerEnabled: false });
      yield* player.toggle;
      assert.lengthOf(created, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("saves pin and position, and restores the saved position", () =>
  Effect.gen(function* () {
    const { created, layer } = yield* setup;
    yield* Effect.gen(function* () {
      const player = yield* MiniPlayerWindow.MusicMiniPlayerWindow;
      const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
      yield* player.toggle;
      yield* player.setPinned(false);
      assert.isFalse(yield* player.pinned);
      assert.include(created[0]!.window.calls, "alwaysOnTop:false");
      yield* player.toggle;
      yield* Effect.yieldNow;
      assert.deepEqual((yield* appSettings.get).musicMiniPlayerBounds, {
        x: 900,
        y: 60,
        width: 340,
        height: 88,
      });

      yield* player.toggle;
      assert.lengthOf(created, 2);
      assert.deepInclude(created[1]!.options, { x: 900, y: 60, alwaysOnTop: false });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("closes on Cmd+W or Escape only, leaving other chords to the renderer", () =>
  Effect.gen(function* () {
    const { created, layer } = yield* setup;
    yield* Effect.gen(function* () {
      const player = yield* MiniPlayerWindow.MusicMiniPlayerWindow;
      const press = (input: Partial<Electron.Input>) => {
        const event = { prevented: false, preventDefault: () => (event.prevented = true) };
        created.at(-1)!.window.emitContents("before-input-event", event, {
          type: "keyDown",
          key: "",
          meta: false,
          control: false,
          alt: false,
          shift: false,
          ...input,
        });
        return event.prevented;
      };
      yield* player.open({ focus: true });
      const ignored = [
        press({ key: "w" }),
        press({ key: "w", control: true }),
        press({ key: "W", meta: true, shift: true }),
        press({ key: "w", meta: true, alt: true }),
        press({ key: "Escape", meta: true }),
        press({ key: "w", meta: true, type: "keyUp" }),
      ];
      assert.deepEqual(ignored, [false, false, false, false, false, false]);
      assert.notInclude(created[0]!.window.calls, "close");

      assert.isTrue(press({ key: "W", meta: true }));
      assert.include(created[0]!.window.calls, "close");

      yield* player.open({ focus: true });
      assert.isTrue(press({ key: "Escape" }));
      assert.include(created[1]!.window.calls, "close");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("refuses every channel the installed Clerk SDK handles in the main process", () =>
  Effect.gen(function* () {
    // The SDK names its channels in one shared module; a new one must be added to the list.
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sdk = path.dirname(NodeModule.createRequire(import.meta.url).resolve("@clerk/electron"));
    const channels = new Set<string>();
    for (const file of (yield* fs.readDirectory(sdk)).filter((name) => name.endsWith(".js"))) {
      const source = yield* fs.readFileString(path.join(sdk, file));
      for (const match of source.matchAll(/"(clerk:[a-z-]+:[a-z-]+)"/g)) channels.add(match[1]!);
    }
    assert.isAbove(channels.size, 0);
    assert.sameMembers([...channels], [...MiniPlayerWindow.CLERK_CHANNELS]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
