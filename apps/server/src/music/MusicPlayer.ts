import {
  MusicError,
  type MusicArtwork,
  type MusicAgentCue,
  type MusicArtworkInput,
  type MusicControlInput,
  type MusicImportHistoryInput,
  type MusicImportHistoryResult,
  type MusicLibrarySearch,
  type MusicLibrarySong,
  type MusicListTracksInput,
  type MusicPlayerState,
  type MusicPlaylists,
  type MusicPlaylistTrack,
  type MusicPlaylistTracks,
  type MusicPlayPlaylistInput,
  type MusicPlayTrackInput,
  type MusicSearchLibraryInput,
  type MusicStats,
  type MusicStatsInput,
  type MusicUpNext,
  type MusicUpNextInput,
  MUSIC_LIBRARY_SEARCH_LIMIT,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import { localDayKey, MusicListeningStats } from "./MusicListeningStats.ts";

export class MusicPlayer extends Context.Service<
  MusicPlayer,
  {
    readonly stateStream: Stream.Stream<MusicPlayerState>;
    readonly listPlaylists: Effect.Effect<MusicPlaylists, MusicError>;
    readonly playPlaylist: (input: MusicPlayPlaylistInput) => Effect.Effect<void, MusicError>;
    readonly listTracks: (
      input: MusicListTracksInput,
    ) => Effect.Effect<MusicPlaylistTracks, MusicError>;
    readonly playTrack: (input: MusicPlayTrackInput) => Effect.Effect<void, MusicError>;
    readonly searchLibrary: (
      input: MusicSearchLibraryInput,
    ) => Effect.Effect<MusicLibrarySearch, MusicError>;
    /** The songs T3 Code will play after the one at `index`, as STEP_SCRIPT moves on. */
    readonly upNext: (input: MusicUpNextInput) => Effect.Effect<MusicUpNext, MusicError>;
    readonly control: (input: MusicControlInput) => Effect.Effect<void, MusicError>;
    readonly artwork: (input: MusicArtworkInput) => Effect.Effect<MusicArtwork, MusicError>;
    readonly stats: (input: MusicStatsInput) => Effect.Effect<MusicStats, MusicError>;
    readonly importHistory: (
      input: MusicImportHistoryInput,
    ) => Effect.Effect<MusicImportHistoryResult, MusicError>;
    readonly clearHistory: Effect.Effect<void, MusicError>;
    /** Agent requests drive the cue; working projects attribute listening time. */
    readonly observeAgents: (activity: AgentActivity, cue: MusicAgentCue) => Effect.Effect<void>;
  }
>()("t3/music/MusicPlayer") {}

export interface AgentActivity {
  /** Open approval and question requests across unarchived threads. */
  readonly requestIds: ReadonlySet<string>;
  readonly workingProjectIds: ReadonlySet<string>;
  /** Requests open before the server started watching; they never trigger the cue. */
  readonly preexisting: ReadonlySet<string>;
}

type CueApplied =
  | { readonly kind: "lower-volume"; readonly from: number; readonly to: number }
  | { readonly kind: "pause"; readonly trackId: string; readonly positionSec: number };

interface CueState {
  readonly known: ReadonlySet<string>;
  /** Requests that arrived since the cue last cleared; answering all of them restores. */
  readonly triggers: ReadonlySet<string>;
  readonly applied: CueApplied | null;
}

const INITIAL_CUE_STATE: CueState = { known: new Set(), triggers: new Set(), applied: null };

function planCue(
  state: CueState,
  requestIds: ReadonlySet<string>,
  preexisting: ReadonlySet<string>,
): { readonly next: CueState; readonly step: "apply" | "restore" | null } {
  const fresh = [...requestIds].filter((id) => !state.known.has(id) && !preexisting.has(id));
  const triggers = new Set([...state.triggers].filter((id) => requestIds.has(id)));
  for (const id of fresh) triggers.add(id);
  const step =
    fresh.length > 0 && state.applied === null
      ? "apply"
      : triggers.size === 0 && state.applied !== null
        ? "restore"
        : null;
  return { next: { known: new Set(requestIds), triggers, applied: state.applied }, step };
}

function parseCueResult(result: string): CueApplied | null {
  const paused = /^paused ([0-9A-F]{16}) (\d+(?:\.\d+)?)$/.exec(result);
  if (paused !== null) {
    return { kind: "pause", trackId: paused[1]!, positionSec: Number(paused[2]) };
  }
  const lowered = /^lowered (\d+) (\d+)$/.exec(result);
  return lowered === null
    ? null
    : { kind: "lower-volume", from: Number(lowered[1]), to: Number(lowered[2]) };
}

// Scripts are fixed text. Anything from a request reaches them only as osascript argv.

// Sending Music an Apple event registers osascript as a foreground app, which puts a
// second T3 Code icon in the Dock. Declaring no UI first keeps it background-only;
// ARTWORK_SCRIPT does the same inside its run handler.
export const JXA_NO_DOCK_ICON = `ObjC.import("AppKit");
$.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyProhibited);
`;
const WATCH_SCRIPT = `ObjC.import("Foundation");
function emit(value) {
  $.NSFileHandle.fileHandleWithStandardOutput.writeData(
    $(JSON.stringify(value) + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
}
function sample(Music) {
  if (!Music.running()) return { running: false };
  const state = Music.playerState();
  const out = { running: true, state: state, shuffle: Music.shuffleEnabled(), volume: Music.soundVolume(), repeat: Music.songRepeat(), track: null, position: 0, playlistId: null };
  if (state !== "stopped") {
    try {
      const p = Music.currentTrack.properties();
      // macOS 14 renamed "loved" to "favorited".
      const favorited = p.favorited !== undefined ? p.favorited : p.loved;
      out.track = { id: p.persistentID, name: p.name, artist: p.artist, album: p.album, duration: p.duration, favorited: favorited };
      out.position = Music.playerPosition();
    } catch (error) {}
    try { out.playlistId = Music.currentPlaylist.persistentID(); } catch (error) {}
  }
  return out;
}
function run(argv) {
  const Music = Application("Music");
  const interval = Number(argv[0]);
  let failures = 0;
  while (true) {
    try {
      emit(sample(Music));
      failures = 0;
    } catch (error) {
      // A denial or a Music that stays stuck ends the watcher so the server can report it.
      // A single failure, such as Music quitting mid-sample, only skips that sample.
      failures += 1;
      if (error.errorNumber === -1743 || failures >= 3) throw error;
    }
    delay(interval);
  }
}`;

const LIST_SCRIPT = `function run() {
  const lists = Application("Music").userPlaylists;
  const ids = lists.persistentID();
  const names = lists.name();
  const kinds = lists.specialKind();
  const durations = lists.duration();
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    if (kinds[i] === "none") out.push({ id: ids[i], name: names[i], durationSec: durations[i] });
  }
  return JSON.stringify(out);
}`;

const PLAY_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const applyShuffle = () => {
    if (argv[1] === "shuffle-on") Music.shuffleEnabled = true;
    if (argv[1] === "shuffle-off") Music.shuffleEnabled = false;
  };
  applyShuffle();
  found[0].play();
  // Music ignores shuffle while an Autoplay song (no playlist) was current, so set it again.
  applyShuffle();
  return "ok";
}`;

// Capped and clipped inside the script so the reply stays well under the output limit.
const LIST_TRACKS_SCRIPT = `function run(argv) {
  const found = Application("Music").playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const tracks = found[0].tracks;
  const ids = tracks.persistentID();
  const limit = Math.min(ids.length, Number(argv[1]));
  const names = tracks.name();
  const artists = tracks.artist();
  const durations = tracks.duration();
  const clip = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
  const out = [];
  for (let i = 0; i < limit; i++) {
    out.push({ id: ids[i], index: i, name: clip(names[i]), artist: clip(artists[i]), durationSec: durations[i] });
  }
  return JSON.stringify({ total: ids.length, tracks: out });
}`;

// Appended after a script's run handler; function declarations hoist. The library also holds
// videos and other media, so T3 moves through its songs only. Its bulk-read positions do not
// match track specifiers (it skips indexes), so a library song is played by its id.
const SONGS_JXA = `
function songs(Music, playlist) {
  const tracks = playlist.tracks;
  const ids = tracks.persistentID();
  if (playlist.persistentID() !== Music.libraryPlaylists[0].persistentID()) {
    return { ids: ids, pick: (values) => values, play: (i) => tracks[i].play() };
  }
  const kinds = tracks.mediaKind();
  const keep = (_, i) => kinds[i] === "song";
  const songIds = ids.filter(keep);
  return {
    ids: songIds,
    pick: (values) => values.filter(keep),
    play: (i) => tracks.whose({ persistentID: songIds[i] })()[0].play(),
  };
}
// T3's shuffle: positions in play order. The same count, seed and first always give the same
// order, so the step and Up Next scripts agree. first < 0 shuffles every position.
function playOrder(count, seed, first) {
  const rest = [];
  for (let i = 0; i < count; i++) if (i !== first) rest.push(i);
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296;
  };
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = rest[i]; rest[i] = rest[j]; rest[j] = swap;
  }
  return first >= 0 && first < count ? [first].concat(rest) : rest;
}
// argv seed and first ("free", "none" or a position) as an order, or null when not shuffling.
function shuffleOrder(count, seed, first, current) {
  if (first === "none") return null;
  return playOrder(count, Number(seed), first === "free" ? -1 : first === "current" ? current : Number(first));
}`;

// A song can appear more than once, so it is found by position, checked against its id.
const PLAY_TRACK_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const list = songs(Music, found[0]);
  const ids = list.ids;
  const index = Number(argv[2]);
  const target = ids[index] === argv[1] ? index : ids.indexOf(argv[1]);
  if (target < 0) return "not-found";
  list.play(target);
  return "ok:" + target;
}${SONGS_JXA}`;

// Reads the whole library once; the server filters it, so a query never reaches a script.
const LIBRARY_SCRIPT = `function run() {
  const Music = Application("Music");
  const library = Music.libraryPlaylists[0];
  const list = songs(Music, library);
  const clip = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
  return JSON.stringify({
    playlistId: library.persistentID(),
    ids: list.ids,
    names: list.pick(library.tracks.name()).map(clip),
    artists: list.pick(library.tracks.artist()).map(clip),
    albums: list.pick(library.tracks.album()).map(clip),
    durations: list.pick(library.tracks.duration()),
  });
}${SONGS_JXA}`;

// Finds the current song the way STEP_SCRIPT does, so the list is what next will play.
const UP_NEXT_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const list = songs(Music, found[0]);
  const ids = list.ids;
  const given = Number(argv[2]);
  const current = ids[given] === argv[1] ? given : ids.indexOf(argv[1]);
  if (current < 0) return "not-found";
  const sequence = shuffleOrder(ids.length, argv[5], argv[6], current) || ids.map((_, i) => i);
  const at = sequence.indexOf(current);
  const order = [];
  // Under repeat all the list ends with the current song coming round again.
  for (let step = 1; step <= ids.length && order.length < Number(argv[4]); step++) {
    if (at + step >= ids.length && argv[3] !== "wrap") break;
    order.push(sequence[(at + step) % ids.length]);
  }
  const tracks = found[0].tracks;
  const names = order.length > 0 ? list.pick(tracks.name()) : [];
  const artists = order.length > 0 ? list.pick(tracks.artist()) : [];
  const durations = order.length > 0 ? list.pick(tracks.duration()) : [];
  const clip = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
  return JSON.stringify({
    playlistName: clip(found[0].name()),
    tracks: order.map((i) => ({ id: ids[i], index: i, name: clip(names[i]), artist: clip(artists[i]), durationSec: durations[i] })),
  });
}${SONGS_JXA}`;

// Music plays a scripted song alone and stops, so the server moves through the playlist itself,
// in T3's shuffled order while Music's shuffle is on. The flag is read here, not from a sample,
// so a late sample cannot change what plays. argv: playlist, song, position, direction, seed,
// shuffle start, Music's playlist for the song, whether Music confirmed the song.
const STEP_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const automatic = argv[3] === "advance";
  if (automatic && !Music.running()) return "gone";
  const playback = Music.playerState();
  if (automatic && playback === "paused") return "hold";
  const onPick = playback !== "stopped" && Music.currentTrack.persistentID() === argv[1];
  // Music takes a moment to switch to a picked song, so only a song it confirmed is checked.
  if (playback !== "stopped" && (automatic || argv[7] === "seen")) {
    // Someone started other music in Music; it is not T3's to move on.
    if (!onPick) return "changed";
    if (argv[6] !== "none") {
      let playlistId = null;
      try { playlistId = Music.currentPlaylist.persistentID(); } catch (error) {}
      if (playlistId !== null && playlistId !== argv[6]) return "changed";
    }
  }
  if (automatic && playback !== "stopped" && (playback !== "playing" || Music.songRepeat() !== "all" || Music.playerPosition() >= 4)) return "hold";
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const previous = argv[3] === "previous";
  const restart = () => { Music.playerPosition = 0; return "restart"; };
  // Only T3's song restarts; Music may still be on the one before it.
  if (previous && onPick && Music.playerPosition() > 3) return restart();
  const list = songs(Music, found[0]);
  const ids = list.ids;
  const given = Number(argv[2]);
  const current = ids[given] === argv[1] ? given : ids.indexOf(argv[1]);
  if (current < 0) return "not-found";
  // With no order yet, shuffle from the current song, as turning shuffle on does.
  const start = Music.shuffleEnabled() ? (argv[5] === "none" ? "current" : argv[5]) : "none";
  const sequence = shuffleOrder(ids.length, argv[4], start, current) || ids.map((_, i) => i);
  let step = sequence.indexOf(current) + (previous ? -1 : 1);
  if (step < 0 || step >= ids.length) {
    if (Music.songRepeat() !== "all") {
      if (previous) return restart();
      Music.stop();
      return "end";
    }
    step = (step + ids.length) % ids.length;
  }
  const target = sequence[step];
  list.play(target);
  return "ok:" + target + ":" + ids[target] + ":" + (start === "current" ? current : start);
}${SONGS_JXA}`;

// Playlist Shuffle: T3 shuffles the playlist itself and starts at the top of its order.
const PLAY_SHUFFLED_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const list = songs(Music, found[0]);
  if (list.ids.length === 0) return "empty";
  const target = playOrder(list.ids.length, Number(argv[1]), -1)[0];
  Music.shuffleEnabled = true;
  list.play(target);
  // Music ignores shuffle while an Autoplay song (no playlist) was current, so set it again.
  Music.shuffleEnabled = true;
  return "ok:" + target + ":" + list.ids[target];
}${SONGS_JXA}`;

const CONTROL_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  switch (argv[0]) {
    case "play-pause": Music.playpause(); break;
    case "next": Music.nextTrack(); break;
    case "previous": Music.backTrack(); break;
    case "shuffle-on": Music.shuffleEnabled = true; break;
    case "shuffle-off": Music.shuffleEnabled = false; break;
    case "seek": Music.playerPosition = Number(argv[1]); break;
    case "volume": Music.soundVolume = Number(argv[1]); break;
    // Music ignores repeat changes unless a song is playing.
    case "repeat": Music.songRepeat = argv[1]; break;
    case "favorite": {
      const track = Music.currentTrack;
      if (track.persistentID() !== argv[1]) return "mismatch";
      const value = argv[2] === "true";
      try { track.favorited = value; } catch (error) { track.loved = value; }
      break;
    }
  }
  return "ok";
}`;

// Never launches Music: running() asks the system, not the app.
const CUE_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  if (!Music.running()) return "none";
  switch (argv[0]) {
    case "lower-volume": {
      if (Music.playerState() !== "playing") return "none";
      const from = Music.soundVolume();
      const to = Math.round(from * Number(argv[1]));
      if (to >= from) return "none";
      Music.soundVolume = to;
      return "lowered " + from + " " + Music.soundVolume();
    }
    case "pause": {
      if (Music.playerState() !== "playing") return "none";
      Music.pause();
      return "paused " + Music.currentTrack.persistentID() + " " + Music.playerPosition();
    }
    case "restore-volume":
      // A volume the user changed meanwhile stays.
      if (Music.soundVolume() === Number(argv[2])) Music.soundVolume = Number(argv[1]);
      return "ok";
    case "resume":
      // Only the song the cue paused, where it paused: anything else is the user's doing.
      if (
        Music.playerState() === "paused" &&
        Music.currentTrack.persistentID() === argv[1] &&
        // Pausing and reading back differ by hundredths; a second of play means the user did it.
        Math.abs(Music.playerPosition() - Number(argv[2])) < 0.5
      ) Music.play();
      return "ok";
  }
  return "none";
}`;

// AppleScript, because JXA cannot write artwork raw data to a file.
const ARTWORK_SCRIPT = `use framework "AppKit"
use scripting additions
on run argv
  current application's NSApplication's sharedApplication()'s setActivationPolicy:(current application's NSApplicationActivationPolicyProhibited)
  set wantedId to item 1 of argv
  set outPath to item 2 of argv
  if application "Music" is not running then return "none"
  tell application "Music"
    try
      set t to current track
    on error
      return "none"
    end try
    if persistent ID of t is not wantedId then return "mismatch"
    if (count of artworks of t) is 0 then return "none"
    set artData to raw data of artwork 1 of t
  end tell
  -- "POSIX file outPath" fails under "use framework" (-1700); the coercion form works.
  set fileRef to open for access (outPath as POSIX file) with write permission
  try
    set eof fileRef to 0
    write artData to fileRef
    close access fileRef
  on error errorMessage number errorNumber
    close access fileRef
    error errorMessage number errorNumber
  end try
  return "ok"
end run`;

const WATCH_INTERVAL_SECONDS = "1";
const WATCH_RESTART_DELAY = Duration.seconds(5);
// Music can take over ten seconds to answer its first Apple event after launch or idle.
const SCRIPT_TIMEOUT = Duration.seconds(30);
const ARTWORK_SIZE_PX = "192";
const MAX_ARTWORK_BYTES = 256 * 1024;
const MAX_WATCH_LINE_CHARS = 16 * 1024;
/** Clients extrapolate position while playing, so only a seek or stall needs a new state. */
const POSITION_DRIFT_SECONDS = 2;
const CUE_VOLUME_FACTOR = "0.3";
/** Longer gaps between samples (a sleeping Mac, a stuck Music) are not counted as listening. */
const MAX_CREDIT_SECONDS = 5;
const STATS_FLUSH_INTERVAL = Duration.minutes(1);

const UNSUPPORTED: MusicPlayerState = { _tag: "unsupported" };
const NOT_RUNNING: MusicPlayerState = { _tag: "not-running" };
const PERMISSION_DENIED: MusicPlayerState = { _tag: "permission-denied" };
const UNAVAILABLE: MusicPlayerState = { _tag: "unavailable" };

const PERSISTENT_ID = /^[0-9A-F]{16}$/;
const MAX_TEXT = 500;

const RawSample = Schema.Struct({
  running: Schema.Boolean,
  state: Schema.optional(Schema.String),
  shuffle: Schema.optional(Schema.Boolean),
  track: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.String),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        artist: Schema.optional(Schema.NullOr(Schema.String)),
        album: Schema.optional(Schema.NullOr(Schema.String)),
        duration: Schema.optional(Schema.NullOr(Schema.Number)),
        favorited: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  position: Schema.optional(Schema.NullOr(Schema.Number)),
  playlistId: Schema.optional(Schema.NullOr(Schema.String)),
  volume: Schema.optional(Schema.NullOr(Schema.Number)),
  repeat: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeRawSample = Schema.decodeUnknownOption(Schema.fromJsonString(RawSample));

const RawPlaylists = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, durationSec: Schema.Number }),
);
const decodeRawPlaylists = Schema.decodeUnknownOption(Schema.fromJsonString(RawPlaylists));

const RawTracks = Schema.Struct({
  total: Schema.Number,
  tracks: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      index: Schema.Number,
      name: Schema.NullOr(Schema.String),
      artist: Schema.NullOr(Schema.String),
      durationSec: Schema.NullOr(Schema.Number),
    }),
  ),
});
const decodeRawTracks = Schema.decodeUnknownOption(Schema.fromJsonString(RawTracks));
const MAX_PLAYLIST_TRACKS = 5_000;

const RawLibrary = Schema.Struct({
  playlistId: Schema.String,
  ids: Schema.Array(Schema.NullOr(Schema.String)),
  names: Schema.Array(Schema.NullOr(Schema.String)),
  artists: Schema.Array(Schema.NullOr(Schema.String)),
  albums: Schema.Array(Schema.NullOr(Schema.String)),
  durations: Schema.Array(Schema.NullOr(Schema.Number)),
});
const decodeRawLibrary = Schema.decodeUnknownOption(Schema.fromJsonString(RawLibrary));
const MAX_LIBRARY_BYTES = 32 * 1024 * 1024;
/** Searches typed in a row share one read of the library. */
const LIBRARY_SNAPSHOT_TTL = Duration.minutes(1);

const RawUpNext = Schema.Struct({
  playlistName: Schema.NullOr(Schema.String),
  tracks: RawTracks.fields.tracks,
});
const decodeRawUpNext = Schema.decodeUnknownOption(Schema.fromJsonString(RawUpNext));
const UP_NEXT_LIMIT = 25;

const text = (value: string | null | undefined) => (value ?? "").slice(0, MAX_TEXT);
const seconds = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const persistentId = (value: string | null | undefined) =>
  value !== undefined && value !== null && PERSISTENT_ID.test(value) ? value : null;

const playlistTracks = (tracks: typeof RawTracks.Type.tracks): Array<MusicPlaylistTrack> =>
  tracks.flatMap((track) => {
    const id = persistentId(track.id);
    return id === null || !Number.isInteger(track.index) || track.index < 0
      ? []
      : [
          {
            id,
            index: track.index,
            name: text(track.name),
            artist: text(track.artist),
            durationSec: seconds(track.durationSec),
          },
        ];
  });

/** Lowercase, without accents, with runs of whitespace collapsed. */
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

interface LibraryEntry {
  readonly song: MusicLibrarySong;
  readonly foldedName: string;
  readonly foldedText: string;
}

interface MusicLibrarySnapshot {
  readonly playlistId: string;
  readonly entries: ReadonlyArray<LibraryEntry>;
}

/** One library read; a malformed row drops alone and the others keep their positions. */
function decodeLibrarySnapshot(stdout: string): MusicLibrarySnapshot | null {
  const raw = Option.getOrNull(decodeRawLibrary(stdout));
  const playlistId = persistentId(raw?.playlistId);
  if (raw === null || playlistId === null) return null;
  const entries = raw.ids.flatMap((rawId, index): Array<LibraryEntry> => {
    const id = persistentId(rawId);
    if (id === null) return [];
    const song = {
      id,
      index,
      name: text(raw.names[index]),
      artist: text(raw.artists[index]),
      album: text(raw.albums[index]),
      durationSec: seconds(raw.durations[index]),
    };
    return [
      {
        song,
        foldedName: fold(song.name),
        foldedText: fold(`${song.name} ${song.artist} ${song.album}`),
      },
    ];
  });
  return { playlistId, entries };
}

/** Every word must appear in a song's name, artist or album; name matches rank first. */
function searchMusicLibrary(
  snapshot: MusicLibrarySnapshot,
  query: string,
  limit: number,
): MusicLibrarySearch {
  const needle = fold(query);
  const words = needle === "" ? [] : needle.split(" ");
  const rank = (entry: LibraryEntry) =>
    entry.foldedName.startsWith(needle) ? 0 : entry.foldedName.includes(needle) ? 1 : 2;
  const matches =
    words.length === 0
      ? []
      : snapshot.entries.filter((entry) => words.every((word) => entry.foldedText.includes(word)));
  return {
    playlistId: snapshot.playlistId,
    songs: matches
      .map((entry) => ({ entry, rank: rank(entry) }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, limit)
      .map(({ entry }) => entry.song),
    total: matches.length,
  };
}

/** Turns one watcher line into a player state; null for a line that is not a sample. */
export function decodeWatchLine(line: string): MusicPlayerState | null {
  const sample = Option.getOrNull(decodeRawSample(line));
  if (sample === null) return null;
  if (!sample.running) return NOT_RUNNING;
  const trackId = persistentId(sample.track?.id);
  return {
    _tag: "ready",
    // Fast-forwarding and rewinding still advance through the track.
    playback:
      sample.state === "paused" ? "paused" : sample.state === "stopped" ? "stopped" : "playing",
    track:
      sample.track && trackId !== null
        ? {
            id: trackId,
            name: text(sample.track.name),
            artist: text(sample.track.artist),
            album: text(sample.track.album),
            durationSec: seconds(sample.track.duration),
            ...(typeof sample.track.favorited === "boolean"
              ? { favorited: sample.track.favorited }
              : {}),
          }
        : null,
    positionSec: seconds(sample.position),
    shuffle: sample.shuffle ?? false,
    playlistId: persistentId(sample.playlistId),
    ...(typeof sample.volume === "number" && Number.isFinite(sample.volume)
      ? { volume: Math.round(Math.min(100, Math.max(0, sample.volume))) }
      : {}),
    ...(sample.repeat === "off" || sample.repeat === "one" || sample.repeat === "all"
      ? { repeat: sample.repeat }
      : {}),
  };
}

export interface EmittedMusicState {
  readonly state: MusicPlayerState;
  readonly atMs: number;
}

/** Whether subscribers need `next`, given the last state they received. */
export function musicStateChanged(
  previous: EmittedMusicState | null,
  next: MusicPlayerState,
  nowMs: number,
): boolean {
  if (previous === null) return true;
  const before = previous.state;
  if (before._tag !== "ready" || next._tag !== "ready") return before._tag !== next._tag;
  if (
    before.playback !== next.playback ||
    before.shuffle !== next.shuffle ||
    before.volume !== next.volume ||
    before.repeat !== next.repeat ||
    before.playlistId !== next.playlistId ||
    JSON.stringify(before.track) !== JSON.stringify(next.track) ||
    JSON.stringify(before.playingFrom) !== JSON.stringify(next.playingFrom)
  ) {
    return true;
  }
  const expected =
    before.positionSec +
    (before.playback === "playing" ? Math.max(0, nowMs - previous.atMs) / 1000 : 0);
  return Math.abs(next.positionSec - expected) > POSITION_DRIFT_SECONDS;
}

/** A song played from a playlist, which the server keeps moving through (see STEP_SCRIPT). */
export interface PickedSong {
  readonly playlistId: string;
  readonly trackId: string;
  readonly index: number;
  readonly startedAtMs: number;
  /** False until the watcher reports the song; Music takes a moment to switch. */
  readonly seen: boolean;
  /** The playlist Music first reported for the song; another one means Music took over. */
  readonly musicPlaylistId: string | null;
  readonly positionSec: number;
  readonly durationSec: number;
  /** Seeds T3's shuffled order; it carries from song to song so the order holds still. */
  readonly seed: number;
  /** Set while T3 shuffles: where the order starts, or null for a fresh whole-playlist shuffle. */
  readonly shuffle: { readonly first: number | null } | null;
}

/** The watcher samples once a second, so the last playing sample can be a few seconds early. */
const SONG_END_MARGIN_SECONDS = 4;
const PICK_SETTLE_MS = 5_000;

export const pickSong = (
  playlistId: string,
  trackId: string,
  index: number,
  startedAtMs: number,
  seed: number,
  shuffle: PickedSong["shuffle"] = null,
): PickedSong => ({
  playlistId,
  trackId,
  index,
  startedAtMs,
  seen: false,
  musicPlaylistId: null,
  positionSec: 0,
  durationSec: 0,
  seed,
  shuffle,
});

/** The state with where T3 plays from, once Music confirms the picked song. */
const withPlayingFrom = (state: MusicPlayerState, picked: PickedSong | null): MusicPlayerState => {
  if (picked === null || !picked.seen || state._tag !== "ready") return state;
  if (state.track?.id !== picked.trackId) return state;
  const { playlistId, index, seed, shuffle } = picked;
  return {
    ...state,
    playingFrom: {
      playlistId,
      index,
      ...(shuffle === null ? {} : { shuffle: { seed, first: shuffle.first } }),
    },
  };
};

/** STEP_SCRIPT's "none", "free" or position for a pick's shuffle. */
const shuffleArg = (shuffle: PickedSong["shuffle"]) =>
  shuffle === null ? "none" : shuffle.first === null ? "free" : String(shuffle.first);

const parseShuffleArg = (value: string | undefined): PickedSong["shuffle"] => {
  if (value === "free") return { first: null };
  const first = Number(value);
  return value !== undefined && Number.isInteger(first) && first >= 0 ? { first } : null;
};

export type PickedSongUpdate =
  | { readonly _tag: "follow"; readonly picked: PickedSong; readonly hide: boolean }
  | { readonly _tag: "advance" }
  | { readonly _tag: "drop" };

/**
 * What one watcher sample means for the picked song. `hide` holds back a stopped sample
 * that only reflects the gap before the next song starts.
 */
export function followPickedSong(
  picked: PickedSong,
  state: MusicPlayerState,
  nowMs: number,
): PickedSongUpdate {
  if (state._tag === "unavailable" || state._tag === "permission-denied") {
    return { _tag: "follow", picked, hide: false };
  }
  if (state._tag !== "ready") return { _tag: "drop" };
  const track = state.playback === "stopped" ? null : state.track;
  if (!picked.seen && track?.id !== picked.trackId) {
    const settling = nowMs - picked.startedAtMs < PICK_SETTLE_MS;
    if (track !== null && !settling) return { _tag: "drop" };
    return { _tag: "follow", picked, hide: track === null && settling };
  }
  const nearEnd =
    picked.durationSec > 0 && picked.positionSec >= picked.durationSec - SONG_END_MARGIN_SECONDS;
  if (track === null)
    return nearEnd ? { _tag: "advance" } : { _tag: "follow", picked, hide: false };
  if (track.id !== picked.trackId) return { _tag: "drop" };
  // The same song started from another playlist, album or Autoplay is Music's queue now.
  if (
    picked.musicPlaylistId !== null &&
    state.playlistId !== null &&
    state.playlistId !== picked.musicPlaylistId
  ) {
    return { _tag: "drop" };
  }
  // With repeat all, Music loops a lone song instead of stopping.
  if (
    nearEnd &&
    state.playback === "playing" &&
    state.repeat === "all" &&
    state.positionSec < SONG_END_MARGIN_SECONDS
  ) {
    return { _tag: "advance" };
  }
  return {
    _tag: "follow",
    picked: {
      ...picked,
      seen: true,
      // A sample read while Music switched can still name the old playlist.
      musicPlaylistId:
        picked.musicPlaylistId ??
        (nowMs - picked.startedAtMs >= PICK_SETTLE_MS ? state.playlistId : null),
      // Shuffle turned on in Music shuffles on from the current song. A sample never clears an
      // order: it may have read the flag before a change, and steps read Music's flag anyway.
      shuffle: picked.shuffle ?? (state.shuffle ? { first: picked.index } : null),
      positionSec: state.positionSec,
      durationSec: track.durationSec,
    },
    hide: false,
  };
}

const isPermissionDenied = (output: ProcessRunner.ProcessRunOutput) =>
  output.stderr.includes("-1743");

/** Splits a byte stream into lines; keeps a bounded partial line between chunks. */
function makeLineSplitter(onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let pending = "";
  return (chunk: Uint8Array) => {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      onLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > MAX_WATCH_LINE_CHARS) pending = "";
  };
}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listening = yield* MusicListeningStats;
  const supported = platform === "darwin";

  const states = yield* PubSub.sliding<MusicPlayerState>(16);
  const latest = yield* Ref.make<Option.Option<MusicPlayerState>>(Option.none());
  const lastEmitted = yield* Ref.make<EmittedMusicState | null>(null);
  const updateLock = yield* Semaphore.make(1);
  const subscriberLock = yield* Semaphore.make(1);
  const subscriberCount = yield* Ref.make(0);
  const watcher = yield* FiberHandle.make<void, never>();
  const lastSample = yield* Ref.make<EmittedMusicState | null>(null);
  const seekSinceSample = yield* Ref.make<{
    readonly positionSec: number;
    readonly atMs: number;
  } | null>(null);
  const workingProjectIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const cueState = yield* Ref.make<CueState>(INITIAL_CUE_STATE);
  const cueLock = yield* Semaphore.make(1);
  const samplingForAgents = yield* Ref.make(false);

  // Credits the time since the previous sample to the song that was playing then.
  const creditSample = Effect.fnUntraced(function* (state: MusicPlayerState, now: number) {
    const previous = yield* Ref.getAndSet(lastSample, { state, atMs: now });
    if (previous === null) return;
    const before = previous.state;
    if (before._tag !== "ready" || before.playback !== "playing" || before.track === null) return;
    const elapsed = (now - previous.atMs) / 1000;
    if (!(elapsed > 0) || elapsed > MAX_CREDIT_SECONDS) return;
    yield* listening.credit({
      day: localDayKey(previous.atMs),
      trackId: before.track.id,
      name: before.track.name,
      artist: before.track.artist,
      seconds: elapsed,
      projectIds: [...(yield* Ref.get(workingProjectIds))],
    });
  });

  const runScript = Effect.fn("MusicPlayer.runScript")(function* (
    operation: MusicError["operation"],
    language: "JavaScript" | "AppleScript",
    script: string,
    args: ReadonlyArray<string>,
    maxOutputBytes = 1024 * 1024,
  ) {
    if (!supported) return yield* new MusicError({ operation, reason: "unsupported" });
    const output = yield* runner
      .run({
        command: "osascript",
        args: [
          "-l",
          language,
          "-e",
          language === "JavaScript" ? JXA_NO_DOCK_ICON + script : script,
          ...args,
        ],
        timeout: SCRIPT_TIMEOUT,
        maxOutputBytes,
      })
      .pipe(
        Effect.mapError((cause) => new MusicError({ operation, reason: "unavailable", cause })),
      );
    if (output.code !== 0) {
      return yield* new MusicError({
        operation,
        reason: isPermissionDenied(output) ? "permission-denied" : "unavailable",
      });
    }
    return output.stdout.trim();
  });

  // Held while a song is picked or stepped, so the watcher judges samples against the song
  // Music was last told to play. Songs only advance on their own while someone watches.
  const pickLock = yield* Semaphore.make(1);
  const newSeed = Random.nextIntBetween(1, 2_147_483_647);
  const picked = yield* Ref.make<PickedSong | null>(null);
  let sampleVersion = 0;

  const stepPicked = Effect.fn("MusicPlayer.stepPickedSong")(function* (
    from: PickedSong,
    direction: "next" | "previous" | "advance",
  ) {
    const result = yield* runScript("control", "JavaScript", STEP_SCRIPT, [
      from.playlistId,
      from.trackId,
      String(from.index),
      direction,
      String(from.seed),
      shuffleArg(from.shuffle),
      from.musicPlaylistId ?? "none",
      from.seen ? "seen" : "unseen",
    ]);
    const [outcome, index, trackId, shuffle] = result.split(":");
    if (outcome === "ok" || outcome === "restart" || outcome === "end") sampleVersion++;
    const nextId = persistentId(trackId);
    const now = yield* Clock.currentTimeMillis;
    const next =
      outcome === "ok" && nextId !== null
        ? pickSong(from.playlistId, nextId, Number(index), now, from.seed, parseShuffleArg(shuffle))
        : outcome === "restart"
          ? { ...from, positionSec: 0 }
          : outcome === "hold"
            ? from
            : null;
    yield* Ref.set(picked, next);
    return outcome;
  });

  /** The sample to publish, with where T3 is playing from; null holds it back. */
  const followSample = (state: MusicPlayerState, version: number) =>
    pickLock.withPermits(1)(
      Effect.gen(function* () {
        if (version !== sampleVersion) return null;
        const current = yield* Ref.get(picked);
        if (current === null) return state;
        const decision = followPickedSong(current, state, yield* Clock.currentTimeMillis);
        switch (decision._tag) {
          case "follow": {
            yield* Ref.set(picked, decision.picked);
            return decision.hide ? null : withPlayingFrom(state, decision.picked);
          }
          case "drop":
            yield* Ref.set(picked, null);
            return state;
          case "advance":
            yield* stepPicked(current, "advance").pipe(Effect.catch(() => Ref.set(picked, null)));
            return null;
        }
      }),
    );

  // Per-sample work, about once a second while anyone watches; the watcher run owns the span.
  const update = Effect.fnUntraced(function* (sample: MusicPlayerState, version = sampleVersion) {
    const state = yield* followSample(sample, version);
    if (state === null) return;
    yield* updateLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.set(seekSinceSample, null);
        yield* creditSample(state, now);
        yield* Ref.set(latest, Option.some(state));
        if (!musicStateChanged(yield* Ref.get(lastEmitted), state, now)) return;
        yield* Ref.set(lastEmitted, { state, atMs: now });
        yield* PubSub.publish(states, state);
      }),
    );
  });

  /** Publishes the last ready state changed by a control that just went through. */
  const republish = (
    change: (state: Extract<MusicPlayerState, { _tag: "ready" }>) => MusicPlayerState,
  ) =>
    updateLock.withPermits(1)(
      Effect.gen(function* () {
        const sampled = yield* Ref.get(lastSample);
        if (sampled === null || sampled.state._tag !== "ready") return;
        const now = yield* Clock.currentTimeMillis;
        // A seek since that sample is where Music is now; republishing the sample would undo it.
        const from = (yield* Ref.get(seekSinceSample)) ?? {
          positionSec: sampled.state.positionSec,
          atMs: sampled.atMs,
        };
        const moved = sampled.state.playback === "playing" ? (now - from.atMs) / 1000 : 0;
        const state = change({ ...sampled.state, positionSec: from.positionSec + moved });
        yield* Ref.set(latest, Option.some(state));
        yield* Ref.set(lastEmitted, { state, atMs: now });
        yield* PubSub.publish(states, state);
      }),
    );

  const runWatcherOnce = Effect.fn("MusicPlayer.watch")(function* () {
    const lines = yield* Queue.unbounded<{ readonly line: string; readonly version: number }>();
    const split = makeLineSplitter((line) => {
      // A successful playback control invalidates samples captured before it finished.
      Queue.offerUnsafe(lines, { line, version: sampleVersion });
    });
    const consume = Effect.forever(
      Queue.take(lines).pipe(
        Effect.flatMap(({ line, version }) => {
          const state = decodeWatchLine(line);
          return state === null ? Effect.void : update(state, version);
        }),
      ),
    );
    const exitState = yield* runner
      .run({
        command: "osascript",
        args: ["-l", "JavaScript", "-e", JXA_NO_DOCK_ICON + WATCH_SCRIPT, WATCH_INTERVAL_SECONDS],
        timeout: Duration.infinity,
        maxOutputBytes: 64 * 1024,
        outputMode: "truncate",
        onStdoutChunk: split,
      })
      .pipe(
        Effect.map((output) => (isPermissionDenied(output) ? PERMISSION_DENIED : UNAVAILABLE)),
        Effect.orElseSucceed(() => UNAVAILABLE),
        Effect.raceFirst(consume),
      );
    yield* update(exitState);
  });

  // Restart after a crash, a quit Music app, or a permission change in System Settings.
  const watchLoop = Effect.forever(
    runWatcherOnce().pipe(Effect.andThen(Effect.sleep(WATCH_RESTART_DELAY))),
  ).pipe(
    Effect.raceFirst(
      Effect.forever(Effect.sleep(STATS_FLUSH_INTERVAL).pipe(Effect.andThen(listening.flush))),
    ),
    Effect.ensuring(Ref.set(lastSample, null).pipe(Effect.andThen(listening.flush))),
  );

  const retain = subscriberLock.withPermits(1)(
    Ref.getAndUpdate(subscriberCount, (count) => count + 1).pipe(
      Effect.flatMap((previous) =>
        previous === 0 ? FiberHandle.run(watcher, watchLoop, { onlyIfMissing: true }) : Effect.void,
      ),
      Effect.asVoid,
    ),
  );
  const release = subscriberLock.withPermits(1)(
    Ref.updateAndGet(subscriberCount, (count) => count - 1).pipe(
      Effect.flatMap((count) =>
        count === 0
          ? FiberHandle.clear(watcher).pipe(
              Effect.andThen(Ref.set(latest, Option.none())),
              Effect.andThen(Ref.set(lastEmitted, null)),
            )
          : Effect.void,
      ),
    ),
  );

  const stateStream: MusicPlayer["Service"]["stateStream"] = supported
    ? Stream.unwrap(
        Effect.gen(function* () {
          yield* Effect.acquireRelease(retain, () => release);
          // Under the update lock, so the snapshot is never also published to this subscriber.
          const [subscription, initial] = yield* updateLock.withPermits(1)(
            Effect.all([PubSub.subscribe(states), Ref.get(latest)]),
          );
          return Stream.concat(
            Option.isSome(initial) ? Stream.make(initial.value) : Stream.empty,
            Stream.fromSubscription(subscription),
          );
        }),
      )
    : Stream.concat(Stream.make(UNSUPPORTED), Stream.never);

  const listPlaylists = runScript("list-playlists", "JavaScript", LIST_SCRIPT, []).pipe(
    Effect.flatMap((stdout) =>
      Option.match(decodeRawPlaylists(stdout), {
        onNone: () =>
          Effect.fail(new MusicError({ operation: "list-playlists", reason: "unavailable" })),
        onSome: (raw) =>
          Effect.succeed({
            playlists: raw.flatMap((playlist) => {
              const id = persistentId(playlist.id);
              return id === null
                ? []
                : [{ id, name: text(playlist.name), durationSec: seconds(playlist.durationSec) }];
            }),
          }),
      }),
    ),
    Effect.withSpan("MusicPlayer.listPlaylists"),
  );

  const playPlaylist = Effect.fn("MusicPlayer.playPlaylist")(function* (
    input: MusicPlayPlaylistInput,
  ) {
    if (input.shuffle === true) {
      const seed = yield* newSeed;
      const result = yield* runScript("play-playlist", "JavaScript", PLAY_SHUFFLED_SCRIPT, [
        input.playlistId,
        String(seed),
      ]);
      const [outcome, index, trackId] = result.split(":");
      const id = persistentId(trackId);
      if (outcome === "empty") return;
      if (outcome !== "ok" || id === null) {
        return yield* new MusicError({ operation: "play-playlist", reason: "not-found" });
      }
      sampleVersion++;
      yield* Ref.set(
        picked,
        pickSong(input.playlistId, id, Number(index), yield* Clock.currentTimeMillis, seed, {
          first: null,
        }),
      );
      return;
    }
    const shuffle =
      input.shuffle === undefined ? "keep" : input.shuffle ? "shuffle-on" : "shuffle-off";
    const result = yield* runScript("play-playlist", "JavaScript", PLAY_SCRIPT, [
      input.playlistId,
      shuffle,
    ]);
    if (result === "not-found") {
      return yield* new MusicError({ operation: "play-playlist", reason: "not-found" });
    }
    sampleVersion++;
    yield* Ref.set(picked, null);
  }, pickLock.withPermits(1));

  const listTracks = Effect.fn("MusicPlayer.listTracks")(function* (input: MusicListTracksInput) {
    const result = yield* runScript(
      "list-tracks",
      "JavaScript",
      LIST_TRACKS_SCRIPT,
      [input.playlistId, String(MAX_PLAYLIST_TRACKS)],
      8 * 1024 * 1024,
    );
    if (result === "not-found") {
      return yield* new MusicError({ operation: "list-tracks", reason: "not-found" });
    }
    const raw = Option.getOrNull(decodeRawTracks(result));
    if (raw === null) {
      return yield* new MusicError({ operation: "list-tracks", reason: "unavailable" });
    }
    return {
      total: Math.max(0, Math.floor(raw.total)),
      tracks: playlistTracks(raw.tracks),
    } satisfies MusicPlaylistTracks;
  });

  const playTrack = Effect.fn("MusicPlayer.playTrack")(function* (input: MusicPlayTrackInput) {
    const result = yield* runScript("play-track", "JavaScript", PLAY_TRACK_SCRIPT, [
      input.playlistId,
      input.trackId,
      String(input.index),
    ]);
    if (result === "not-found") {
      return yield* new MusicError({ operation: "play-track", reason: "not-found" });
    }
    sampleVersion++;
    const index = Number(result.split(":")[1]);
    yield* Ref.set(
      picked,
      pickSong(
        input.playlistId,
        input.trackId,
        Number.isInteger(index) ? index : input.index,
        yield* Clock.currentTimeMillis,
        yield* newSeed,
      ),
    );
  }, pickLock.withPermits(1));

  const readLibrary = Effect.fn("MusicPlayer.readLibrary")(function* () {
    const result = yield* runScript(
      "search-library",
      "JavaScript",
      LIBRARY_SCRIPT,
      [],
      MAX_LIBRARY_BYTES,
    );
    const snapshot = decodeLibrarySnapshot(result);
    if (snapshot === null) {
      return yield* new MusicError({ operation: "search-library", reason: "unavailable" });
    }
    return snapshot;
  });

  const librarySnapshot = yield* Cache.makeWith((_: "library") => readLibrary(), {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LIBRARY_SNAPSHOT_TTL : Duration.zero),
  });

  const searchLibrary = Effect.fn("MusicPlayer.searchLibrary")(function* (
    input: MusicSearchLibraryInput,
  ) {
    const snapshot = yield* Cache.get(librarySnapshot, "library");
    return searchMusicLibrary(snapshot, input.query, MUSIC_LIBRARY_SEARCH_LIMIT);
  });

  const upNext = Effect.fn("MusicPlayer.upNext")(function* (input: MusicUpNextInput) {
    const result = yield* runScript("up-next", "JavaScript", UP_NEXT_SCRIPT, [
      input.playlistId,
      input.trackId,
      String(input.index),
      input.wrap ? "wrap" : "stop",
      String(UP_NEXT_LIMIT),
      String(input.shuffle?.seed ?? 0),
      shuffleArg(input.shuffle ?? null),
    ]);
    if (result === "not-found") {
      return yield* new MusicError({ operation: "up-next", reason: "not-found" });
    }
    const raw = Option.getOrNull(decodeRawUpNext(result));
    if (raw === null) return yield* new MusicError({ operation: "up-next", reason: "unavailable" });
    return {
      playlistName: text(raw.playlistName),
      tracks: playlistTracks(raw.tracks),
    } satisfies MusicUpNext;
  });

  const controlArgs = (input: MusicControlInput): ReadonlyArray<string> => {
    switch (input._tag) {
      case "set-shuffle":
        return [input.enabled ? "shuffle-on" : "shuffle-off"];
      case "seek":
        return ["seek", String(input.positionSec)];
      case "set-volume":
        return ["volume", String(input.volume)];
      case "set-repeat":
        return ["repeat", input.mode];
      case "set-favorited":
        return ["favorite", input.trackId, String(input.favorited)];
      default:
        return [input._tag];
    }
  };

  const control = Effect.fn("MusicPlayer.control")(function* (input: MusicControlInput) {
    if (input._tag === "next" || input._tag === "previous") {
      const current = yield* Ref.get(picked);
      // A playlist that is gone, or music someone else started, leaves Music's own controls.
      const outcome = current === null ? null : yield* stepPicked(current, input._tag);
      if (outcome !== null && outcome !== "not-found" && outcome !== "changed") return;
    }
    yield* runScript("control", "JavaScript", CONTROL_SCRIPT, controlArgs(input));
    if (input._tag === "set-shuffle") {
      const current = yield* Ref.updateAndGet(picked, (current) =>
        current === null
          ? null
          : {
              ...current,
              shuffle: input.enabled ? (current.shuffle ?? { first: current.index }) : null,
            },
      );
      // Up Next follows at once rather than at the next sample; the next step reads Music's flag.
      yield* republish((state) => withPlayingFrom({ ...state, shuffle: input.enabled }, current));
    }
    if (
      input._tag === "seek" ||
      input._tag === "set-shuffle" ||
      input._tag === "play-pause" ||
      input._tag === "next" ||
      input._tag === "previous"
    ) {
      sampleVersion++;
    }
    if (input._tag === "seek") {
      yield* Ref.update(picked, (current) =>
        current === null ? null : { ...current, positionSec: input.positionSec },
      );
      const atMs = yield* Clock.currentTimeMillis;
      yield* Ref.set(seekSinceSample, { positionSec: input.positionSec, atMs });
    }
  }, pickLock.withPermits(1));

  const applyCue = Effect.fn("MusicPlayer.applyCue")(function* (cue: "lower-volume" | "pause") {
    const result = yield* runScript("control", "JavaScript", CUE_SCRIPT, [cue, CUE_VOLUME_FACTOR]);
    const applied = parseCueResult(result);
    if (applied?.kind === "pause") sampleVersion++;
    return applied;
  }, pickLock.withPermits(1));

  const restoreCue = Effect.fn("MusicPlayer.restoreCue")(function* (applied: CueApplied) {
    yield* runScript(
      "control",
      "JavaScript",
      CUE_SCRIPT,
      applied.kind === "pause"
        ? ["resume", applied.trackId, String(applied.positionSec)]
        : ["restore-volume", String(applied.from), String(applied.to)],
    );
    if (applied.kind === "pause") sampleVersion++;
  }, pickLock.withPermits(1));

  const observeAgents = Effect.fn("MusicPlayer.observeAgents")(function* (
    activity: AgentActivity,
    cue: MusicAgentCue,
  ) {
    yield* Ref.set(workingProjectIds, activity.workingProjectIds);
    if (!supported) return;
    // While agents work, sample Music for stats even with no client watching.
    const sampling = activity.workingProjectIds.size > 0;
    if (sampling !== (yield* Ref.getAndSet(samplingForAgents, sampling))) {
      yield* sampling ? retain : release;
    }
    // Uninterruptible (scripts are bounded by SCRIPT_TIMEOUT), so a shutdown mid-change still
    // records what to restore.
    yield* cueLock.withPermits(1)(
      Effect.gen(function* () {
        const { next, step } = planCue(
          yield* Ref.get(cueState),
          activity.requestIds,
          activity.preexisting,
        );
        let applied = next.applied;
        if (step === "apply" && cue !== "off") {
          applied = yield* applyCue(cue).pipe(Effect.orElseSucceed(() => null));
        } else if (step === "restore" && applied !== null) {
          yield* restoreCue(applied).pipe(Effect.ignore);
          applied = null;
        }
        yield* Ref.set(cueState, { ...next, applied });
      }).pipe(Effect.uninterruptible),
    );
  });

  // Music should not stay quiet or paused because the server stopped mid-request.
  yield* Effect.addFinalizer(() =>
    cueLock.withPermits(1)(
      Ref.get(cueState).pipe(
        Effect.flatMap(({ applied }) =>
          applied === null ? Effect.void : restoreCue(applied).pipe(Effect.ignore),
        ),
      ),
    ),
  );

  const extractArtwork = Effect.fn("MusicPlayer.extractArtwork")(function* (trackId: string) {
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-" });
    const rawPath = path.join(directory, "artwork");
    const jpegPath = path.join(directory, "artwork.jpg");
    const result = yield* runScript("artwork", "AppleScript", ARTWORK_SCRIPT, [trackId, rawPath]);
    if (result !== "ok") return { dataUrl: null } satisfies MusicArtwork;
    const resized = yield* runner
      .run({
        command: "sips",
        args: ["-Z", ARTWORK_SIZE_PX, "-s", "format", "jpeg", rawPath, "--out", jpegPath],
        timeout: SCRIPT_TIMEOUT,
      })
      .pipe(Effect.option);
    if (Option.isNone(resized) || resized.value.code !== 0) {
      return { dataUrl: null } satisfies MusicArtwork;
    }
    const bytes = yield* fileSystem.readFile(jpegPath).pipe(Effect.option);
    if (Option.isNone(bytes) || bytes.value.byteLength > MAX_ARTWORK_BYTES) {
      return { dataUrl: null } satisfies MusicArtwork;
    }
    return {
      dataUrl: `data:image/jpeg;base64,${Buffer.from(bytes.value).toString("base64")}`,
    } satisfies MusicArtwork;
  }, Effect.scoped);

  // Concurrent requests for one track share a lookup. Only found artwork is kept:
  // a mismatch means the track changed mid-request, and a missing one may appear later.
  const artworkCache = yield* Cache.makeWith(extractArtwork, {
    capacity: 20,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && exit.value.dataUrl !== null ? Duration.infinity : Duration.zero,
  });

  const artwork = Effect.fn("MusicPlayer.artwork")(function* (input: MusicArtworkInput) {
    return yield* Cache.get(artworkCache, input.trackId).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          Effect.fail(new MusicError({ operation: "artwork", reason: "unavailable", cause })),
      }),
    );
  });

  return MusicPlayer.of({
    stateStream,
    listPlaylists,
    playPlaylist,
    listTracks,
    playTrack,
    searchLibrary,
    upNext,
    control,
    artwork,
    stats: Effect.fn("MusicPlayer.stats")(function* (input: MusicStatsInput) {
      if (!supported) return yield* new MusicError({ operation: "stats", reason: "unsupported" });
      return yield* listening.summary(input);
    }),
    importHistory: Effect.fn("MusicPlayer.importHistory")(function* (
      input: MusicImportHistoryInput,
    ) {
      if (!supported) {
        return yield* new MusicError({ operation: "import-history", reason: "unsupported" });
      }
      return yield* listening.importHistory(input);
    }),
    clearHistory: supported
      ? listening.clearHistory
      : Effect.fail(new MusicError({ operation: "import-history", reason: "unsupported" })),
    observeAgents,
  });
});

export const layer = Layer.effect(MusicPlayer, make);
