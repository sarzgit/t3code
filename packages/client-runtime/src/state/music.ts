import {
  type MusicPlayerState,
  type MusicPlaylist,
  type MusicPlaylistPreferences,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createMusicEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    // The server keeps a Music watcher running while anyone subscribes, so let go at once.
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:music:state",
      tag: WS_METHODS.subscribeMusicState,
      idleTtlMs: 0,
    }),
    playlists: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:playlists",
      tag: WS_METHODS.musicListPlaylists,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    // A miss (no artwork yet, a slow first reply, a track change mid-request) retries while shown.
    artwork: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:artwork",
      tag: WS_METHODS.musicGetArtwork,
      refreshIntervalMs: 15_000,
      isFinal: (artwork) => artwork.dataUrl !== null,
    }),
    playPlaylist: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:play-playlist",
      tag: WS_METHODS.musicPlayPlaylist,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:control",
      tag: WS_METHODS.musicControl,
    }),
  };
}

/** A player state stamped with when this client received it. */
export interface ReceivedMusicState {
  readonly state: MusicPlayerState;
  readonly receivedAtMs: number;
}

/**
 * Seconds into the current track at `nowMs`. Measured from when this client received the
 * state, never the server's clock, so a remote server with a skewed clock still shows the
 * right position.
 */
export function musicPositionAt(received: ReceivedMusicState, nowMs: number): number {
  const { state } = received;
  if (state._tag !== "ready" || state.track === null) return 0;
  const elapsed =
    state.playback === "playing" ? Math.max(0, nowMs - received.receivedAtMs) / 1000 : 0;
  const position = state.positionSec + elapsed;
  return state.track.durationSec > 0 ? Math.min(position, state.track.durationSec) : position;
}

export function formatMusicDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} hr ${minutes} min`;
  return `${minutes} min`;
}

export interface ArrangedMusicPlaylists {
  readonly pinned: ReadonlyArray<MusicPlaylist>;
  readonly listed: ReadonlyArray<MusicPlaylist>;
  /** Not searched: the restore view lists every hidden playlist. */
  readonly hidden: ReadonlyArray<MusicPlaylist>;
}

/** Pinned in pin order, the rest in library order. Ids no longer in the library are skipped. */
export function arrangeMusicPlaylists(
  playlists: ReadonlyArray<MusicPlaylist>,
  preferences: MusicPlaylistPreferences,
  search: string,
): ArrangedMusicPlaylists {
  const needle = search.trim().toLocaleLowerCase();
  const matches = (playlist: MusicPlaylist) =>
    needle === "" || playlist.name.toLocaleLowerCase().includes(needle);
  const byId = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const pinnedIds = new Set(preferences.pinned);
  const hiddenIds = new Set(preferences.hidden);
  return {
    pinned: preferences.pinned.flatMap((id) => {
      const playlist = byId.get(id);
      return playlist && !hiddenIds.has(id) && matches(playlist) ? [playlist] : [];
    }),
    listed: playlists.filter(
      (playlist) => !pinnedIds.has(playlist.id) && !hiddenIds.has(playlist.id) && matches(playlist),
    ),
    hidden: playlists.filter((playlist) => hiddenIds.has(playlist.id)),
  };
}
