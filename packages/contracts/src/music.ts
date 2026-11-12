import * as Schema from "effect/Schema";

/** Music app persistent ids are 16 hex digits. */
export const MusicPersistentId = Schema.String.check(Schema.isPattern(/^[0-9A-F]{16}$/));
export type MusicPersistentId = typeof MusicPersistentId.Type;

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

export const MusicPlayPlaylistInput = Schema.Struct({ playlistId: MusicPersistentId });
export type MusicPlayPlaylistInput = typeof MusicPlayPlaylistInput.Type;

export const MusicControlInput = Schema.Union([
  Schema.TaggedStruct("play-pause", {}),
  Schema.TaggedStruct("next", {}),
  Schema.TaggedStruct("previous", {}),
  Schema.TaggedStruct("set-shuffle", { enabled: Schema.Boolean }),
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
  operation: Schema.Literals(["list-playlists", "play-playlist", "control", "artwork"]),
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
        return "That playlist is no longer in your Music library.";
      case "unavailable":
        return "The Music app did not respond. Try again.";
    }
  }
}
