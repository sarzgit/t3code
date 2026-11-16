import {
  MUSIC_HISTORY_IMPORT_MAX_ROWS,
  type MusicHistoryRow,
  type MusicPlayerState,
  type MusicPlaylist,
  type MusicPlaylistPreferences,
  type MusicQueueActive,
  type MusicQueueView,
  type MusicRepeatMode,
  type MusicUpNextInput,
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
    // The server reads the library once a minute and filters it, so each query is cheap.
    librarySearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:library-search",
      tag: WS_METHODS.musicSearchLibrary,
      staleTimeMs: 60_000,
      idleTtlMs: 60_000,
    }),
    // Keyed by the current song and position, so a new song asks again; a reopened tab re-reads.
    upNext: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:up-next",
      tag: WS_METHODS.musicGetUpNext,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    // Music's own queue changes in Music without telling T3, so it is re-read while shown.
    nativeQueue: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:native-queue",
      tag: WS_METHODS.musicGetNativeQueue,
      staleTimeMs: 0,
      idleTtlMs: 0,
      refreshIntervalMs: 10_000,
    }),
    // Opening the Stats tab re-reads; the server buffers a minute of listening before writing.
    stats: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:stats",
      tag: WS_METHODS.musicGetStats,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    // Each chunk saves on its own and re-sending one changes nothing, so no shared lane.
    importHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:import-history",
      tag: WS_METHODS.musicImportHistory,
    }),
    clearHistory: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:clear-history",
      tag: WS_METHODS.musicClearHistory,
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
    // Queue identity, the saved queue and list revisions; never per sample, so cheap to hold.
    queue: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:music:queue",
      tag: WS_METHODS.subscribeMusicQueue,
      idleTtlMs: 0,
    }),
    // Keyed by queue id; callers refresh when the revision, current entry or edited flag moves.
    queueView: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:queue-view",
      tag: WS_METHODS.musicGetQueue,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    favorites: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:favorites",
      tag: WS_METHODS.musicListFavorites,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    recent: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:music:recent",
      tag: WS_METHODS.musicListRecent,
      staleTimeMs: 0,
      idleTtlMs: 0,
    }),
    editQueue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:edit-queue",
      tag: WS_METHODS.musicEditQueue,
      scheduler,
      concurrency,
    }),
    undoReplace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:undo-replace",
      tag: WS_METHODS.musicUndoReplace,
      scheduler,
      concurrency,
    }),
    playList: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:play-list",
      tag: WS_METHODS.musicPlayList,
      scheduler,
      concurrency,
    }),
    resumeQueue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:resume-queue",
      tag: WS_METHODS.musicResumeQueue,
      scheduler,
      concurrency,
    }),
    dismissSavedQueue: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:dismiss-saved-queue",
      tag: WS_METHODS.musicDismissSavedQueue,
      scheduler,
      concurrency,
    }),
    setTrackFavorited: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:set-track-favorited",
      tag: WS_METHODS.musicSetTrackFavorited,
      scheduler,
      concurrency,
    }),
    clearRecent: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:music:clear-recent",
      tag: WS_METHODS.musicClearRecent,
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

export type MusicUpNextSource =
  | { readonly _tag: "nothing-playing" }
  /** T3 runs the queue, formula or edited: its own list, editable even under repeat one. */
  | { readonly _tag: "queue"; readonly active: MusicQueueActive }
  /** Music runs its own queue (Play or Shuffle in Music, Autoplay); its Up Next panel is read. */
  | { readonly _tag: "native"; readonly trackId: string }
  /** Repeat one: the current song plays again until someone skips. */
  | { readonly _tag: "repeating" }
  | { readonly _tag: "known"; readonly input: MusicUpNextInput };

/**
 * An active T3 queue always wins. Without one (or from a server before queues), T3's own list
 * while T3 Code moves through a playlist itself, in its own shuffled order when Music's shuffle
 * is on (Music's flag decides each step, so it decides here too). Otherwise the queue is
 * Music's, read from its Up Next panel.
 */
export function musicUpNextSource(
  state: MusicPlayerState,
  active: MusicQueueActive | null = null,
): MusicUpNextSource {
  if (active !== null) return { _tag: "queue", active };
  if (state._tag !== "ready" || state.track === null || state.playback === "stopped") {
    return { _tag: "nothing-playing" };
  }
  const from = state.playingFrom;
  if (from === undefined || (state.shuffle && from.shuffle === undefined)) {
    return { _tag: "native", trackId: state.track.id };
  }
  if (state.repeat === "one") return { _tag: "repeating" };
  return {
    _tag: "known",
    input: {
      playlistId: from.playlistId,
      trackId: state.track.id,
      index: from.index,
      wrap: state.repeat === "all",
      ...(state.shuffle && from.shuffle !== undefined ? { shuffle: from.shuffle } : {}),
    },
  };
}

/** Up Next re-reads the queue when its order, current entry or edited flag moves. */
export function musicQueueViewRevision(active: MusicQueueActive): string {
  return `${active.revision}:${active.currentKey}:${active.edited ? "e" : "f"}`;
}

/** The identity an edit names. The first edit of a formula queue sends back its song count. */
export function musicQueueEditBase(
  view: Pick<MusicQueueView, "id" | "revision" | "edited" | "sourceCount">,
): { queueId: string; expectedRevision: number; sourceCount?: number } {
  return {
    queueId: view.id,
    expectedRevision: view.revision,
    ...(view.edited || view.sourceCount === undefined ? {} : { sourceCount: view.sourceCount }),
  };
}

/**
 * Pages a Favourites view shows. Pages opened with Show more hold only while the first page
 * still comes from the same library read; a new read starts again from the top.
 */
export function musicListPages(
  pages: { readonly count: number; readonly snapshotAt: number | null },
  firstSnapshotAt: number | null,
): number {
  return pages.count > 1 && pages.snapshotAt === firstSnapshotAt ? pages.count : 1;
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

/** Rows per import request: the server's limit, about 200 KB of JSON. */
export const MUSIC_HISTORY_CHUNK_ROWS = MUSIC_HISTORY_IMPORT_MAX_ROWS;
const MAX_TEXT = 500;
const DAY_SECONDS = 86_400;
const DATE_PLAYED = /^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;

export type ParsedMusicHistory =
  | { readonly _tag: "parsed"; readonly rows: ReadonlyArray<MusicHistoryRow> }
  | { readonly _tag: "wrong-file" }
  | { readonly _tag: "empty" };

/** RFC 4180 records: quoted fields may hold commas, quotes ("") and line breaks. */
function* csvRecords(text: string): Generator<Array<string>> {
  let field = "";
  let record: Array<string> = [];
  let quoted = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') field += char;
      else if (text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      yield record;
      field = "";
      record = [];
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    yield record;
  }
}

/** Must match the server's song key so one song never spans two rows of a day. */
const songKey = (name: string, artist: string) => {
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  return `${normalize(artist)}\u0000${normalize(name)}`;
};

/**
 * Reads Apple's "Apple Music - Play History Daily Tracks.csv" into one row per day and song.
 * The export repeats a day and song (one row per device or source), so those add up here.
 * "Track Description" is "Artist - Title"; one without the separator is all title.
 */
export function parseMusicHistoryCsv(text: string): ParsedMusicHistory {
  const records = csvRecords(text);
  const header = records.next();
  if (header.done) return { _tag: "wrong-file" };
  const columns = header.value.map((name) => name.trim());
  const dateColumn = columns.indexOf("Date Played");
  const durationColumn = columns.indexOf("Play Duration Milliseconds");
  const descriptionColumn = columns.indexOf("Track Description");
  if (dateColumn < 0 || durationColumn < 0 || descriptionColumn < 0) return { _tag: "wrong-file" };
  const rows = new Map<string, MusicHistoryRow>();
  for (const record of records) {
    const date = DATE_PLAYED.exec(record[dateColumn]?.trim() ?? "");
    const milliseconds = Number(record[durationColumn]);
    const description = record[descriptionColumn]?.trim() ?? "";
    if (date === null || !(milliseconds > 0) || description === "") continue;
    const separator = description.indexOf(" - ");
    const artist = separator < 0 ? "" : description.slice(0, separator).trim();
    const name = separator < 0 ? description : description.slice(separator + 3).trim();
    const day = `${date[1]}-${date[2]}-${date[3]}`;
    const key = `${day}\u0000${songKey(name, artist)}`;
    const seconds = (rows.get(key)?.seconds ?? 0) + milliseconds / 1000;
    rows.set(key, {
      day,
      name: rows.get(key)?.name ?? name.slice(0, MAX_TEXT),
      artist: rows.get(key)?.artist ?? artist.slice(0, MAX_TEXT),
      seconds: Math.min(seconds, DAY_SECONDS),
    });
  }
  return rows.size === 0 ? { _tag: "empty" } : { _tag: "parsed", rows: [...rows.values()] };
}
