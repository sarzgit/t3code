import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

vi.mock("electron", () => ({}));

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as IpcChannels from "./channels.ts";
import * as DesktopIpc from "./DesktopIpc.ts";

it.effect("answers only the main window's top frame", () =>
  Effect.gen(function* () {
    const mainFrame = {};
    const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
    const sync = new Map<string, DesktopIpc.DesktopIpcSyncListener>();
    const ipc = yield* DesktopIpc.DesktopIpc.pipe(
      Effect.provide(
        DesktopIpc.layer({
          removeHandler: (channel) => void invoke.delete(channel),
          handle: (channel, listener) => void invoke.set(channel, listener),
          removeAllListeners: (channel) => void sync.delete(channel),
          on: (channel, listener) => void sync.set(channel, listener),
        }).pipe(
          Layer.provide(
            Layer.mock(ElectronWindow.ElectronWindow, {
              main: Effect.succeedSome({
                webContents: { id: 1, mainFrame },
              } as unknown as Electron.BrowserWindow),
              musicMiniPlayer: Effect.succeedNone,
            }),
          ),
        ),
      ),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: "token",
        payload: Schema.Void,
        result: Schema.String,
        handler: () => Effect.succeed("secret"),
      }),
    );
    yield* ipc.handleSync({ channel: "token-sync", handler: () => Effect.succeed("secret") });

    const senders = {
      app: { sender: { id: 1 }, senderFrame: mainFrame },
      appSubframe: { sender: { id: 1 }, senderFrame: {} },
      previewGuest: { sender: { id: 2 }, senderFrame: {} },
    };
    const results: Record<string, unknown> = {};
    for (const [name, sender] of Object.entries(senders)) {
      const event = { ...sender, returnValue: "unset" as unknown };
      sync.get("token-sync")!(event);
      results[name] = [
        yield* Effect.promise(() =>
          Promise.resolve(invoke.get("token")!(sender, undefined)).catch(() => "rejected"),
        ),
        event.returnValue,
      ];
    }
    assert.deepEqual(results, {
      app: ["secret", "secret"],
      appSubframe: ["rejected", undefined],
      previewGuest: ["rejected", undefined],
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "answers the music mini-player's top frame on the app origin for its allowlist only",
  () =>
    Effect.gen(function* () {
      const mainFrame = {};
      const miniFrame = { url: "t3code://app/#/music/mini" };
      const invoke = new Map<string, DesktopIpc.DesktopIpcHandleListener>();
      const ipc = yield* DesktopIpc.DesktopIpc.pipe(
        Effect.provide(
          DesktopIpc.layer({
            removeHandler: (channel) => void invoke.delete(channel),
            handle: (channel, listener) => void invoke.set(channel, listener),
            removeAllListeners: () => undefined,
            on: () => undefined,
          }).pipe(
            Layer.provide(
              Layer.mock(ElectronWindow.ElectronWindow, {
                main: Effect.succeedSome({
                  webContents: { id: 1, mainFrame },
                } as unknown as Electron.BrowserWindow),
                musicMiniPlayer: Effect.succeedSome({
                  window: {
                    webContents: { id: 3, mainFrame: miniFrame },
                  } as unknown as Electron.BrowserWindow,
                  applicationUrl: "t3code://app/",
                }),
              }),
            ),
          ),
        ),
      );
      const allowed = IpcChannels.GET_CLIENT_SETTINGS_CHANNEL;
      // Main-only powers: file and folder dialogs, shell, navigation, settings writes, permissions.
      const mainOnly = [
        IpcChannels.PICK_FOLDER_CHANNEL,
        IpcChannels.PICK_THEME_FILES_CHANNEL,
        IpcChannels.OPEN_EXTERNAL_CHANNEL,
        IpcChannels.OPEN_SYSTEM_SETTINGS_CHANNEL,
        IpcChannels.REQUEST_SNAP_SHOT_PERMISSIONS_CHANNEL,
        IpcChannels.SETUP_SNAP_SHOT_CHANNEL,
        IpcChannels.SET_CLIENT_SETTINGS_CHANNEL,
        IpcChannels.GET_CONNECTION_CATALOG_CHANNEL,
        IpcChannels.MUSIC_MINI_PLAYER_TOGGLE_CHANNEL,
      ];
      for (const channel of [allowed, ...mainOnly]) {
        yield* ipc.handle(
          DesktopIpc.makeIpcMethod({
            channel,
            payload: Schema.Void,
            result: Schema.String,
            handler: () => Effect.succeed("ok"),
          }),
        );
      }

      const call = (channel: string, sender: DesktopIpc.DesktopIpcInvokeEvent) =>
        Effect.promise(() =>
          Promise.resolve(invoke.get(channel)!(sender, undefined)).catch(() => "rejected"),
        );
      const mini = { sender: { id: 3 }, senderFrame: miniFrame };
      const results: Record<string, unknown> = {
        miniAllowed: yield* call(allowed, mini),
        miniSubframe: yield* call(allowed, {
          sender: { id: 3 },
          senderFrame: { url: "t3code://app/" },
        }),
        miniNavigatedAway: yield* call(allowed, {
          sender: { id: 3 },
          senderFrame: Object.assign(miniFrame, { url: "https://example.com/" }),
        }),
        previewGuest: yield* call(allowed, { sender: { id: 2 }, senderFrame: {} }),
      };
      miniFrame.url = "t3code://app/#/music/mini";
      for (const channel of mainOnly) {
        results[channel] = [
          yield* call(channel, mini),
          yield* call(channel, { sender: { id: 1 }, senderFrame: mainFrame }),
        ];
      }
      assert.deepEqual(results, {
        miniAllowed: "ok",
        miniSubframe: "rejected",
        miniNavigatedAway: "rejected",
        previewGuest: "rejected",
        ...Object.fromEntries(mainOnly.map((channel) => [channel, ["rejected", "ok"]])),
      });
    }).pipe(Effect.scoped),
);
