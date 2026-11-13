import {
  type MusicPlayerState,
  type MusicPlaylist,
  type MusicPlaylistPreferences,
  type MusicRepeatMode,
  WS_METHODS,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createMusicEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // One Music lane per environment: commands land in click order, so the latest value wins.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
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
    tracks: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:tracks",
      tag: WS_METHODS.musicListTracks,
      staleTimeMs: 30_000,
      idleTtlMs: 60_000,
    }),
    // Opening the Stats tab re-reads; the server buffers a minute of listening before writing.
    stats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:stats",
      tag: WS_METHODS.musicGetStats,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    playPlaylist: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:play-playlist",
      tag: WS_METHODS.musicPlayPlaylist,
      scheduler,
      concurrency,
    }),
    playTrack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:play-track",
      tag: WS_METHODS.musicPlayTrack,
      scheduler,
      concurrency,
    }),
    control: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:control",
      tag: WS_METHODS.musicControl,
      scheduler,
      concurrency,
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

/** "3:07", or "1:02:09" past an hour. */
export function formatTrackTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

export function nextRepeatMode(mode: MusicRepeatMode): MusicRepeatMode {
  return mode === "off" ? "all" : mode === "all" ? "one" : "off";
}

/** Where this client sent a seek; it stands in for the server's position until a newer state. */
export interface MusicSeekAnchor {
  readonly positionSec: number;
  readonly atMs: number;
}

/**
 * The watcher only reports a seek that moves more than two seconds from where clients expect,
 * so a small seek may never be confirmed. A newer server state always wins.
 */
export function withSeekAnchor(
  received: ReceivedMusicState,
  anchor: MusicSeekAnchor | null,
): ReceivedMusicState {
  if (anchor === null || received.receivedAtMs >= anchor.atMs) return received;
  if (received.state._tag !== "ready") return received;
  return {
    state: { ...received.state, positionSec: anchor.positionSec },
    receivedAtMs: anchor.atMs,
  };
}
