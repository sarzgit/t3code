import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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
});
export type MusicTrack = typeof MusicTrack.Type;

export const MusicPlayback = Schema.Literals(["playing", "paused", "stopped"]);
export type MusicPlayback = typeof MusicPlayback.Type;

export const MusicRepeatMode = Schema.Literals(["off", "one", "all"]);
export type MusicRepeatMode = typeof MusicRepeatMode.Type;

export const MusicVolume = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

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
]);
export type MusicControlInput = typeof MusicControlInput.Type;

export const MusicArtworkInput = Schema.Struct({ trackId: MusicPersistentId });
export type MusicArtworkInput = typeof MusicArtworkInput.Type;

export const MusicArtwork = Schema.Struct({
  /** A small JPEG data URL, or null when the track has no artwork or is no longer playing. */
  dataUrl: Schema.NullOr(Schema.String),
});
export type MusicArtwork = typeof MusicArtwork.Type;

export class MusicError extends Schema.TaggedError<MusicError>()("MusicError", {
  operation: Schema.Literals([
    "list-playlists",
    "play-playlist",
    "list-tracks",
    "play-track",
    "control",
    "artwork",
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
        return "The Music app did not respond. Try again.";
    }
  }
}
