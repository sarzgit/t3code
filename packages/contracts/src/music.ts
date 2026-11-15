import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectId } from "./baseSchemas.ts";

const MUSIC_PERSISTENT_ID_PATTERN = /^[0-9A-F]{16}$/;

/** Music app persistent ids are 16 hex digits. */
export const MusicPersistentId = Schema.String.check(Schema.isPattern(MUSIC_PERSISTENT_ID_PATTERN));
export type MusicPersistentId = typeof MusicPersistentId.Type;

/** Bad entries drop alone, so a hand edit cannot reset the settings file. */
const MusicPlaylistIdList = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(MusicPersistentId),
    SchemaTransformation.transform<ReadonlyArray<string>, ReadonlyArray<unknown>>({
      decode: (values) =>
        values.filter(
          (value): value is string =>
            typeof value === "string" && MUSIC_PERSISTENT_ID_PATTERN.test(value),
        ),
      encode: (values) => values,
    }),
  ),
  Schema.withDecodingDefault(Effect.succeed([])),
);

/** Which library playlists T3 pins or hides. Apple Music itself is never changed. */
export const MusicPlaylistPreferences = Schema.Struct({
  pinned: MusicPlaylistIdList,
  hidden: MusicPlaylistIdList,
});
export type MusicPlaylistPreferences = typeof MusicPlaylistPreferences.Type;

export const MusicPlaylistPlacement = Schema.Literals(["pinned", "listed", "hidden"]);
export type MusicPlaylistPlacement = typeof MusicPlaylistPlacement.Type;

export const MusicPlaylistChange = Schema.Struct({
  id: MusicPersistentId,
  placement: MusicPlaylistPlacement,
});
export type MusicPlaylistChange = typeof MusicPlaylistChange.Type;

/** Pinning keeps an already pinned playlist in place; hiding also unpins. */
export function applyMusicPlaylistChanges(
  current: MusicPlaylistPreferences,
  changes: ReadonlyArray<MusicPlaylistChange>,
): MusicPlaylistPreferences {
  let pinned = [...current.pinned];
  let hidden = [...current.hidden];
  for (const { id, placement } of changes) {
    if (placement === "pinned") {
      hidden = hidden.filter((entry) => entry !== id);
      if (!pinned.includes(id)) pinned.push(id);
    } else if (placement === "hidden") {
      pinned = pinned.filter((entry) => entry !== id);
      if (!hidden.includes(id)) hidden.push(id);
    } else {
      pinned = pinned.filter((entry) => entry !== id);
      hidden = hidden.filter((entry) => entry !== id);
    }
  }
  return { pinned, hidden };
}

const MusicText = Schema.String.check(Schema.isMaxLength(500));

export const MusicTrack = Schema.Struct({
  id: MusicPersistentId,
  name: MusicText,
  artist: MusicText,
  album: MusicText,
  durationSec: Schema.Number,
  // Absent from a server before favorites, or when Music can't report it.
  favorited: Schema.optionalKey(Schema.Boolean),
});
export type MusicTrack = typeof MusicTrack.Type;

export const MusicPlayback = Schema.Literals(["playing", "paused", "stopped"]);
export type MusicPlayback = typeof MusicPlayback.Type;

export const MusicRepeatMode = Schema.Literals(["off", "one", "all"]);
export type MusicRepeatMode = typeof MusicRepeatMode.Type;

export const MusicVolume = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

/** T3 Code's own shuffle of a playlist: the same seed and start always give the same order. */
export const MusicShuffleOrder = Schema.Struct({
  seed: Schema.Int,
  /** The position the order starts from; null for a fresh shuffle of the whole playlist. */
  first: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type MusicShuffleOrder = typeof MusicShuffleOrder.Type;

export const MusicPlayerState = Schema.Union([
  /** The server's host is not macOS. */
  Schema.TaggedStruct("unsupported", {}),
  Schema.TaggedStruct("not-running", {}),
  /** macOS denied T3 Code permission to control Music (Automation). */
  Schema.TaggedStruct("permission-denied", {}),
  Schema.TaggedStruct("unavailable", {}),
  Schema.TaggedStruct("ready", {
    playback: MusicPlayback,
    track: Schema.NullOr(MusicTrack),
    positionSec: Schema.Number,
    shuffle: Schema.Boolean,
    playlistId: Schema.NullOr(MusicPersistentId),
    // Optional so a client still reads a server from before these controls.
    volume: Schema.optionalKey(MusicVolume),
    repeat: Schema.optionalKey(MusicRepeatMode),
    /** Set while T3 Code moves through a playlist itself: where the current song sits in it. */
    playingFrom: Schema.optionalKey(
      Schema.Struct({
        playlistId: MusicPersistentId,
        index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        /** Set while T3 Code shuffles the playlist itself. */
        shuffle: Schema.optionalKey(MusicShuffleOrder),
      }),
    ),
  }),
]);
export type MusicPlayerState = typeof MusicPlayerState.Type;

export const MusicPlaylist = Schema.Struct({
  id: MusicPersistentId,
  name: MusicText,
  durationSec: Schema.Number,
});
export type MusicPlaylist = typeof MusicPlaylist.Type;

export const MusicPlaylists = Schema.Struct({ playlists: Schema.Array(MusicPlaylist) });
export type MusicPlaylists = typeof MusicPlaylists.Type;

export const MusicPlayPlaylistInput = Schema.Struct({
  playlistId: MusicPersistentId,
  /** Sets shuffle before playing; omitted keeps Music's current setting. */
  shuffle: Schema.optionalKey(Schema.Boolean),
});
export type MusicPlayPlaylistInput = typeof MusicPlayPlaylistInput.Type;

export const MusicPlaylistTrack = Schema.Struct({
  id: MusicPersistentId,
  /** Position in the playlist; a song can appear more than once. */
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: MusicText,
  artist: MusicText,
  durationSec: Schema.Number,
});
export type MusicPlaylistTrack = typeof MusicPlaylistTrack.Type;

export const MusicListTracksInput = Schema.Struct({ playlistId: MusicPersistentId });
export type MusicListTracksInput = typeof MusicListTracksInput.Type;

export const MusicPlaylistTracks = Schema.Struct({
  tracks: Schema.Array(MusicPlaylistTrack),
  /** Songs in the playlist; more than `tracks.length` when the list was capped. */
  total: Schema.Int,
});
export type MusicPlaylistTracks = typeof MusicPlaylistTracks.Type;

export const MusicPlayTrackInput = Schema.Struct({
  playlistId: MusicPersistentId,
  trackId: MusicPersistentId,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MusicPlayTrackInput = typeof MusicPlayTrackInput.Type;

export const MUSIC_LIBRARY_SEARCH_LIMIT = 50;

export const MusicSearchLibraryInput = Schema.Struct({
  query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type MusicSearchLibraryInput = typeof MusicSearchLibraryInput.Type;

export const MusicLibrarySong = Schema.Struct({
  id: MusicPersistentId,
  /** Position among the library's songs; play it with the library's `playlistId`. */
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  name: MusicText,
  artist: MusicText,
  album: MusicText,
  durationSec: Schema.Number,
});
export type MusicLibrarySong = typeof MusicLibrarySong.Type;

export const MusicLibrarySearch = Schema.Struct({
  /** The library playlist the songs belong to. */
  playlistId: MusicPersistentId,
  songs: Schema.Array(MusicLibrarySong),
  /** Every match; more than `songs.length` when the list was capped. */
  total: Schema.Int,
});
export type MusicLibrarySearch = typeof MusicLibrarySearch.Type;

export const MusicUpNextInput = Schema.Struct({
  playlistId: MusicPersistentId,
  trackId: MusicPersistentId,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Repeat all: continue from the top after the last song. */
  wrap: Schema.Boolean,
  shuffle: Schema.optionalKey(MusicShuffleOrder),
});
export type MusicUpNextInput = typeof MusicUpNextInput.Type;

export const MusicUpNext = Schema.Struct({
  playlistName: MusicText,
  /** Songs after the current one, in play order; empty after the last song. */
  tracks: Schema.Array(MusicPlaylistTrack),
});
export type MusicUpNext = typeof MusicUpNext.Type;

/** Asks again when the song changes. */
export const MusicNativeQueueInput = Schema.Struct({ trackId: Schema.NullOr(MusicPersistentId) });
export type MusicNativeQueueInput = typeof MusicNativeQueueInput.Type;

/** A section of Music's own Up Next, as its panel draws it. */
export const MusicNativeQueueSection = Schema.Struct({
  /** Music's header, e.g. "Continue Playing" or "Playing Next". */
  title: MusicText,
  /** Music's source button, e.g. "From musics!". */
  source: Schema.NullOr(MusicText),
  /** Music's combined label for each song ("Title Artist — Album"), in its order. */
  songs: Schema.Array(MusicText),
});
export type MusicNativeQueueSection = typeof MusicNativeQueueSection.Type;

/** What Music's Up Next panel shows, read through Accessibility. */
export const MusicNativeQueue = Schema.Union([
  Schema.TaggedStruct("ok", {
    sections: Schema.Array(MusicNativeQueueSection),
    /** False when Music's list goes on past the rows it shows. */
    complete: Schema.Boolean,
  }),
  Schema.TaggedStruct("panel-closed", {}),
  /** Music's window has neither the panel nor its button T3 knows. */
  Schema.TaggedStruct("unrecognised", {}),
  /** The panel shows only history; no upcoming header is on screen. */
  Schema.TaggedStruct("no-upcoming-visible", {}),
  Schema.TaggedStruct("permission-needed", {
    grant: Schema.Literals(["accessibility", "automation"]),
  }),
  Schema.TaggedStruct("not-running", {}),
]);
export type MusicNativeQueue = typeof MusicNativeQueue.Type;

export const MusicControlInput = Schema.Union([
  Schema.TaggedStruct("play-pause", {}),
  Schema.TaggedStruct("next", {}),
  Schema.TaggedStruct("previous", {}),
  Schema.TaggedStruct("set-shuffle", { enabled: Schema.Boolean }),
  Schema.TaggedStruct("seek", {
    positionSec: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
  }),
  Schema.TaggedStruct("set-volume", { volume: MusicVolume }),
  Schema.TaggedStruct("set-repeat", { mode: MusicRepeatMode }),
  /** Names the track so a click never favorites the song that replaced it. */
  Schema.TaggedStruct("set-favorited", { trackId: MusicPersistentId, favorited: Schema.Boolean }),
]);
export type MusicControlInput = typeof MusicControlInput.Type;

export const MusicArtworkInput = Schema.Struct({ trackId: MusicPersistentId });
export type MusicArtworkInput = typeof MusicArtworkInput.Type;

export const MusicArtwork = Schema.Struct({
  /** A small JPEG data URL, or null when the track has no artwork or is no longer playing. */
  dataUrl: Schema.NullOr(Schema.String),
});
export type MusicArtwork = typeof MusicArtwork.Type;

export const MusicStatsInput = Schema.Struct({ days: Schema.Literals([1, 7, 30]) });
export type MusicStatsInput = typeof MusicStatsInput.Type;

export const MusicStats = Schema.Struct({
  /** T3's own samples, Apple's export, and library plays estimated at full song length. */
  totalSec: Schema.Number,
  /** One entry per day in the range, oldest first, in the server's local time. */
  days: Schema.Array(Schema.Struct({ date: Schema.String, seconds: Schema.Number })),
  /** Last day covered by imported Apple Music history; absent when none is imported. */
  importedThrough: Schema.optionalKey(Schema.String),
  artists: Schema.Array(Schema.Struct({ name: MusicText, seconds: Schema.Number })),
  tracks: Schema.Array(
    Schema.Struct({ name: MusicText, artist: MusicText, seconds: Schema.Number }),
  ),
  /** Time listened while an agent was working in each project. */
  projects: Schema.Array(Schema.Struct({ projectId: ProjectId, seconds: Schema.Number })),
});
export type MusicStats = typeof MusicStats.Type;

const MUSIC_HISTORY_DAY_PATTERN = /^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** One song's listening on one day, summed from Apple's Play History Daily Tracks export. */
const MusicHistoryDay = Schema.String.check(Schema.isPattern(MUSIC_HISTORY_DAY_PATTERN));

export const MusicHistoryRow = Schema.Struct({
  day: MusicHistoryDay,
  name: MusicText,
  artist: MusicText,
  seconds: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 86_400 })),
});
export type MusicHistoryRow = typeof MusicHistoryRow.Type;

export const MUSIC_HISTORY_IMPORT_MAX_ROWS = 2_000;

/** A chunk of an import. Chunks are independent: re-sending one changes nothing. */
export const MusicImportHistoryInput = Schema.Struct({
  rows: Schema.Array(MusicHistoryRow).check(Schema.isMaxLength(MUSIC_HISTORY_IMPORT_MAX_ROWS)),
  /**
   * Sent with the last chunk only: the export's final day. Until it arrives the import does not
   * replace library-synced listening, so a stopped import hides nothing.
   */
  coveredThrough: Schema.optionalKey(MusicHistoryDay),
});
export type MusicImportHistoryInput = typeof MusicImportHistoryInput.Type;

export const MusicImportHistoryResult = Schema.Struct({
  /** Last day covered by all imported history so far. */
  importedThrough: Schema.NullOr(Schema.String),
});
export type MusicImportHistoryResult = typeof MusicImportHistoryResult.Type;

export const MusicAgentCue = Schema.Literals(["off", "lower-volume", "pause"]);
export type MusicAgentCue = typeof MusicAgentCue.Type;

export class MusicError extends Schema.TaggedError<MusicError>()("MusicError", {
  operation: Schema.Literals([
    "list-playlists",
    "play-playlist",
    "list-tracks",
    "play-track",
    "search-library",
    "up-next",
    "native-queue",
    "control",
    "artwork",
    "stats",
    "import-history",
  ]),
  reason: Schema.Literals(["unsupported", "permission-denied", "not-found", "unavailable"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Music control needs a T3 Code server running on macOS.";
      case "permission-denied":
        return "Allow T3 Code to control Music in System Settings › Privacy & Security › Automation.";
      case "not-found":
        return this.operation === "play-track"
          ? "That song is no longer in this playlist."
          : "That playlist is no longer in your Music library.";
      case "unavailable":
        return this.operation === "import-history"
          ? "Listening history could not be saved. Try again."
          : "The Music app did not respond. Try again.";
    }
  }
}
