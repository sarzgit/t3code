import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as MiniPlayerWindow from "../../music/MiniPlayerWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Main window only: the popover button, command palette and in-app keybinding.
export const toggleMusicMiniPlayer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MUSIC_MINI_PLAYER_TOGGLE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.musicMiniPlayer.toggle")(function* () {
    yield* (yield* MiniPlayerWindow.MusicMiniPlayerWindow).toggle;
  }),
});

export const getMusicMiniPlayerState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MUSIC_MINI_PLAYER_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Struct({ pinned: Schema.Boolean }),
  handler: Effect.fn("desktop.ipc.musicMiniPlayer.getState")(function* () {
    return { pinned: yield* (yield* MiniPlayerWindow.MusicMiniPlayerWindow).pinned };
  }),
});

export const setMusicMiniPlayerPinned = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MUSIC_MINI_PLAYER_SET_PINNED_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.musicMiniPlayer.setPinned")(function* (pinned) {
    yield* (yield* MiniPlayerWindow.MusicMiniPlayerWindow).setPinned(pinned);
  }),
});

export const closeMusicMiniPlayer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MUSIC_MINI_PLAYER_CLOSE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.musicMiniPlayer.close")(function* () {
    yield* (yield* MiniPlayerWindow.MusicMiniPlayerWindow).close;
  }),
});

export const openMainFromMusicMiniPlayer = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.MUSIC_MINI_PLAYER_OPEN_MAIN_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.musicMiniPlayer.openMain")(function* () {
    yield* (yield* MiniPlayerWindow.MusicMiniPlayerWindow).openMain;
  }),
});
