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

/** What Music's Up Next panel shows, read by the T3 Music Up Next helper through Accessibility. */
export const MusicNativeQueue = Schema.Union([
  Schema.TaggedStruct("ok", {
    sections: Schema.Array(MusicNativeQueueSection),
    /** False when Music's list goes on past the rows it shows. */
    complete: Schema.Boolean,
  }),
  Schema.TaggedStruct("panel-closed", {}),
  /** Music's window has neither the panel nor its button T3 knows. */
  Schema.TaggedStruct("unrecognised", {}),
  /** The panel was found but its rows could not be read. */
  Schema.TaggedStruct("unreadable", {}),
  /** The header that opens Music's queue is not on screen. */
  Schema.TaggedStruct("no-upcoming-visible", {}),
  /** T3 Music Up Next is not allowed Accessibility yet. */
  Schema.TaggedStruct("permission-needed", {}),
  /** The T3 Music Up Next helper is not installed on this Mac. */
  Schema.TaggedStruct("helper-missing", {}),
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

/** A T3-managed queue, formula or explicit; a new T3 play makes a new one. */
export const MusicQueueId = Schema.String.check(Schema.isPattern(/^q[0-9a-z]{6,40}$/));
export type MusicQueueId = typeof MusicQueueId.Type;

/** Bumps on every order change (materialise, edit, shuffle, Reset, replacement), never on a step. */
export const MusicQueueRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export type MusicQueueRevision = typeof MusicQueueRevision.Type;

/** `s<n>`: index n in the source's song list. `a<n>`: the n-th song added. Stable once given. */
export const MusicQueueEntryKey = Schema.String.check(Schema.isPattern(/^[sa](0|[1-9]\d{0,6})$/));
export type MusicQueueEntryKey = typeof MusicQueueEntryKey.Type;

/** Names a queue entry and the song it must still hold, so an edit never lands on another song. */
export const MusicQueueTarget = Schema.Struct({
  key: MusicQueueEntryKey,
  trackId: MusicPersistentId,
});
export type MusicQueueTarget = typeof MusicQueueTarget.Type;

/** A song from a row: its playlist (the library for library rows) and position, checked by id. */
export const MusicSongRef = Schema.Struct({
  playlistId: MusicPersistentId,
  trackId: MusicPersistentId,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type MusicSongRef = typeof MusicSongRef.Type;

const MUSIC_QUEUE_PAGE = 50;

export const MusicQueueActive = Schema.Struct({
  id: MusicQueueId,
  revision: MusicQueueRevision,
  /** False for an unedited playlist queue, which T3 still steps by formula. */
  edited: Schema.Boolean,
  currentKey: MusicQueueEntryKey,
});
export type MusicQueueActive = typeof MusicQueueActive.Type;

/** The queue a Resume card offers. Labels are display hints saved with the entry. */
export const MusicSavedQueue = Schema.Struct({
  id: MusicQueueId,
  revision: MusicQueueRevision,
  trackName: MusicText,
  artist: Schema.NullOr(MusicText),
  sourceName: MusicText,
  positionSec: Schema.Number,
  /** Only a live query or Resume sets this; Music being closed never does. */
  sourceMissing: Schema.Boolean,
});
export type MusicSavedQueue = typeof MusicSavedQueue.Type;

/** An edited queue a new play replaced; `music.undoReplace` with this tuple restores it. */
export const MusicReplacedQueue = Schema.Struct({
  replacedId: MusicQueueId,
  replacedRevision: MusicQueueRevision,
  byId: MusicQueueId,
  byRevision: MusicQueueRevision,
  /** Server epoch ms. */
  expiresAt: Schema.Number,
});
export type MusicReplacedQueue = typeof MusicReplacedQueue.Type;

export const MusicQueueStatus = Schema.Struct({
  active: Schema.NullOr(MusicQueueActive),
  saved: Schema.NullOr(MusicSavedQueue),
  replaced: Schema.NullOr(MusicReplacedQueue),
  favouritesRevision: Schema.Int,
  recentRevision: Schema.Int,
});
export type MusicQueueStatus = typeof MusicQueueStatus.Type;

export const MusicQueueEntry = Schema.Struct({
  key: MusicQueueEntryKey,
  trackId: MusicPersistentId,
  name: MusicText,
  artist: MusicText,
  durationSec: Schema.Number,
  /** The song could not be found; it shows disabled and the step skips it. */
  unavailable: Schema.Boolean,
});
export type MusicQueueEntry = typeof MusicQueueEntry.Type;

export const MusicGetQueueInput = Schema.Struct({ queueId: MusicQueueId });
export type MusicGetQueueInput = typeof MusicGetQueueInput.Type;

export const MusicQueueView = Schema.Struct({
  id: MusicQueueId,
  revision: MusicQueueRevision,
  currentKey: MusicQueueEntryKey,
  edited: Schema.Boolean,
  sourceName: MusicText,
  /** Songs in the playlist when this formula queue was read; the first edit sends it back. */
  sourceCount: Schema.optionalKey(Schema.Int),
  current: Schema.NullOr(MusicQueueEntry),
  /** In play order, at most MUSIC_QUEUE_PAGE. */
  upcoming: Schema.Array(MusicQueueEntry),
  totalUpcoming: Schema.Int,
  /** Repeat all: the list continues from the top. */
  wraps: Schema.Boolean,
  shuffled: Schema.Boolean,
});
export type MusicQueueView = typeof MusicQueueView.Type;

const MusicQueueSongs = Schema.Array(MusicSongRef).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
);

export const MusicQueueEdit = Schema.Union([
  Schema.TaggedStruct("play-next", { songs: MusicQueueSongs }),
  Schema.TaggedStruct("add", { songs: MusicQueueSongs }),
  /** `toIndex` is the place among upcoming entries once the target is lifted out; 0 is next. */
  Schema.TaggedStruct("move", {
    target: MusicQueueTarget,
    toIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.TaggedStruct("remove", {
    targets: Schema.Array(MusicQueueTarget).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MUSIC_QUEUE_PAGE),
    ),
  }),
  /** Puts the last removed entry back where it was, with the revision its removal produced. */
  Schema.TaggedStruct("undo-remove", { target: MusicQueueTarget }),
  Schema.TaggedStruct("clear-upcoming", {}),
  /** Playlist order: drops added songs but the current one and turns shuffle off. */
  Schema.TaggedStruct("reset", {}),
]);
export type MusicQueueEdit = typeof MusicQueueEdit.Type;

export const MusicEditQueueInput = Schema.Struct({
  queueId: MusicQueueId,
  expectedRevision: MusicQueueRevision,
  /** The first edit of an unedited playlist queue: the song count its view read. */
  sourceCount: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  edit: MusicQueueEdit,
});
export type MusicEditQueueInput = typeof MusicEditQueueInput.Type;

export const MusicQueueRef = Schema.Struct({ id: MusicQueueId, revision: MusicQueueRevision });
export type MusicQueueRef = typeof MusicQueueRef.Type;

export const MusicUndoReplaceInput = Schema.Struct({
  replacedId: MusicQueueId,
  replacedRevision: MusicQueueRevision,
  byId: MusicQueueId,
  byRevision: MusicQueueRevision,
});
export type MusicUndoReplaceInput = typeof MusicUndoReplaceInput.Type;

/** Names the saved queue, so a stale client never resumes or dismisses its replacement. */
export const MusicSavedQueueInput = Schema.Struct({
  queueId: MusicQueueId,
  revision: MusicQueueRevision,
});
export type MusicSavedQueueInput = typeof MusicSavedQueueInput.Type;

export const MusicListSource = Schema.Literals(["favourites", "recent"]);
export type MusicListSource = typeof MusicListSource.Type;

/** Plays from a row and continues through the rest of that list as a T3 queue. */
export const MusicPlayListInput = Schema.Struct({
  source: MusicListSource,
  /** Null starts at the top (or a random song when shuffling). */
  startTrackId: Schema.NullOr(MusicPersistentId),
  shuffle: Schema.optionalKey(Schema.Boolean),
});
export type MusicPlayListInput = typeof MusicPlayListInput.Type;

const MUSIC_LIST_PAGE_LIMIT = 100;

const MusicPage = {
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MUSIC_LIST_PAGE_LIMIT })),
};

export const MusicListFavoritesInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  ...MusicPage,
});
export type MusicListFavoritesInput = typeof MusicListFavoritesInput.Type;

export const MusicFavorites = Schema.Struct({
  playlistId: MusicPersistentId,
  songs: Schema.Array(MusicLibrarySong),
  total: Schema.Int,
  /** When the library read behind this page was taken; a change means start again. */
  snapshotAt: Schema.Number,
});
export type MusicFavorites = typeof MusicFavorites.Type;

export const MusicSetTrackFavoritedInput = Schema.Struct({
  trackId: MusicPersistentId,
  favorited: Schema.Boolean,
});
export type MusicSetTrackFavoritedInput = typeof MusicSetTrackFavoritedInput.Type;

export const MusicListRecentInput = Schema.Struct(MusicPage);
export type MusicListRecentInput = typeof MusicListRecentInput.Type;

export const MusicRecentSong = Schema.Struct({
  trackId: MusicPersistentId,
  name: MusicText,
  artist: MusicText,
  album: MusicText,
  durationSec: Schema.Number,
  lastPlayedAt: Schema.Number,
  /** Position among the library's songs; null when the song is no longer in the library. */
  index: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type MusicRecentSong = typeof MusicRecentSong.Type;

export const MusicRecent = Schema.Struct({
  /** The library playlist the songs play from; null when the library could not be read. */
  playlistId: Schema.NullOr(MusicPersistentId),
  songs: Schema.Array(MusicRecentSong),
  total: Schema.Int,
});
export type MusicRecent = typeof MusicRecent.Type;

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
    "queue",
    "favorites",
    "recent",
  ]),
  reason: Schema.Literals([
    "unsupported",
    "permission-denied",
    "not-found",
    "unavailable",
    /** The queue changed since the client read it; it refetches. */
    "queue-changed",
    "queue-too-long",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported":
        return "Music control needs a T3 Code server running on macOS.";
      case "permission-denied":
        return "Allow T3 Code to control Music in System Settings › Privacy & Security › Automation.";
      case "not-found":
        return this.operation === "play-track" || this.operation === "queue"
          ? "That song is no longer in this playlist."
          : this.operation === "favorites" || this.operation === "recent"
            ? "That song is no longer in your Music library."
            : "That playlist is no longer in your Music library.";
      case "queue-changed":
        return "Up Next changed. Try again.";
      case "queue-too-long":
        return "This playlist is too long to edit in Up Next.";
      case "unavailable":
        return this.operation === "import-history"
          ? "Listening history could not be saved. Try again."
          : this.operation === "native-queue"
            ? "T3 Music Up Next didn't return Music's Up Next. Try again."
            : "The Music app did not respond. Try again.";
    }
  }
}
