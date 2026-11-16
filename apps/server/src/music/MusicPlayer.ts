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
  type MusicNativeQueue,
  type MusicNativeQueueInput,
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
  type MusicEditQueueInput,
  type MusicFavorites,
  type MusicGetQueueInput,
  type MusicListFavoritesInput,
  type MusicListRecentInput,
  type MusicPlayListInput,
  type MusicQueueEntry,
  type MusicQueueRef,
  type MusicQueueStatus,
  type MusicReplacedQueue,
  type MusicSongRef,
  type MusicQueueView,
  type MusicRecent,
  type MusicSavedQueueInput,
  type MusicSetTrackFavoritedInput,
  type MusicUndoReplaceInput,
  MUSIC_LIBRARY_SEARCH_LIMIT,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
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
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProcessRunner from "../processRunner.ts";
import { localDayKey, MusicListeningStats } from "./MusicListeningStats.ts";
import * as MusicQueue from "./MusicQueue.ts";
import * as MusicQueueStore from "./MusicQueueStore.ts";
import {
  followRecentPlay,
  MusicRecent as MusicRecentStore,
  type RecentPlay,
} from "./MusicRecent.ts";

type QueueDisplay = MusicQueueStore.QueueDisplay;
type QueueFormula = MusicQueueStore.QueueFormula;
const { sanitizeDisplay } = MusicQueueStore;

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
    /** What Music's own Up Next panel shows, while Music runs its own queue. */
    readonly nativeQueue: (
      input: MusicNativeQueueInput,
    ) => Effect.Effect<MusicNativeQueue, MusicError>;
    readonly control: (input: MusicControlInput) => Effect.Effect<void, MusicError>;
    readonly artwork: (input: MusicArtworkInput) => Effect.Effect<MusicArtwork, MusicError>;
    readonly stats: (input: MusicStatsInput) => Effect.Effect<MusicStats, MusicError>;
    readonly importHistory: (
      input: MusicImportHistoryInput,
    ) => Effect.Effect<MusicImportHistoryResult, MusicError>;
    readonly clearHistory: Effect.Effect<void, MusicError>;
    /** Agent requests drive the cue; working projects attribute listening time. */
    readonly observeAgents: (activity: AgentActivity, cue: MusicAgentCue) => Effect.Effect<void>;
    /** The T3 queue's identity, the saved queue and list revisions; works with Music closed. */
    readonly queueStream: Stream.Stream<MusicQueueStatus>;
    readonly getQueue: (input: MusicGetQueueInput) => Effect.Effect<MusicQueueView, MusicError>;
    readonly editQueue: (input: MusicEditQueueInput) => Effect.Effect<MusicQueueRef, MusicError>;
    readonly undoReplace: (
      input: MusicUndoReplaceInput,
    ) => Effect.Effect<MusicQueueRef, MusicError>;
    readonly playList: (input: MusicPlayListInput) => Effect.Effect<void, MusicError>;
    readonly resumeQueue: (input: MusicSavedQueueInput) => Effect.Effect<void, MusicError>;
    readonly dismissSavedQueue: (input: MusicSavedQueueInput) => Effect.Effect<void, MusicError>;
    readonly listFavorites: (
      input: MusicListFavoritesInput,
    ) => Effect.Effect<MusicFavorites, MusicError>;
    readonly setTrackFavorited: (
      input: MusicSetTrackFavoritedInput,
    ) => Effect.Effect<void, MusicError>;
    readonly listRecent: (input: MusicListRecentInput) => Effect.Effect<MusicRecent, MusicError>;
    readonly clearRecent: Effect.Effect<void, MusicError>;
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
// match track specifiers (it skips indexes), so a library song is played by its id. Songs play
// once: otherwise Music carries on by itself (in its own shuffle) and T3 loses its order.
const SONGS_JXA = `
function songs(Music, playlist) {
  const tracks = playlist.tracks;
  const ids = tracks.persistentID();
  if (playlist.persistentID() !== Music.libraryPlaylists[0].persistentID()) {
    return { ids: ids, pick: (values) => values, play: (i) => tracks[i].play({ once: true }) };
  }
  const kinds = tracks.mediaKind();
  const keep = (_, i) => kinds[i] === "song";
  const songIds = ids.filter(keep);
  return {
    ids: songIds,
    pick: (values) => values.filter(keep),
    play: (i) => tracks.whose({ persistentID: songIds[i] })()[0].play({ once: true }),
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

// Read-only: how many times a song sits in a playlist.
const COPIES_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "0";
  return String(songs(Music, found[0]).ids.filter((id) => id === argv[1]).length);
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
    favorited: favoritedColumn(list, library.tracks),
  });
}
// macOS 14 renamed "loved" to "favorited". Without either, only Favourites goes; search stays.
function favoritedColumn(list, tracks) {
  try { return list.pick(tracks.favorited()); } catch (error) {}
  try { return list.pick(tracks.loved()); } catch (error) {}
  return null;
}${SONGS_JXA}`;

// Any library song by id, not only the current one.
const FAVORITE_TRACK_SCRIPT = `function run(argv) {
  const found = Application("Music").libraryPlaylists[0].tracks.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const value = argv[1] === "true";
  try { found[0].favorited = value; } catch (error) { found[0].loved = value; }
  return "ok";
}`;

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

// Songs play once, so the server steps itself, in T3's order while Music's shuffle is on. The
// flag is read here so a late sample cannot change what plays; stopped, Music reads it as off.
// argv: playlist, song, position, direction, seed, shuffle start, Music's playlist for the
// song, whether Music confirmed the song, and T3's shuffle mode for when Music is stopped.
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
  const ownsPosition = onPick || playback === "stopped";
  if (previous && ownsPosition && Music.playerPosition() > 3) return restart();
  const list = songs(Music, found[0]);
  const ids = list.ids;
  const given = Number(argv[2]);
  const current = ids[given] === argv[1] ? given : ids.indexOf(argv[1]);
  if (current < 0) return "not-found";
  const shuffled = playback === "stopped" ? argv[8] === "on" : Music.shuffleEnabled();
  // With no order yet, shuffle from the current song, as turning shuffle on does.
  const start = shuffled ? (argv[5] === "none" ? "current" : argv[5]) : "none";
  const sequence = shuffleOrder(ids.length, argv[4], start, current) || ids.map((_, i) => i);
  let step = sequence.indexOf(current) + (previous ? -1 : 1);
  if (step < 0 || step >= ids.length) {
    if (Music.songRepeat() !== "all") {
      // T3's song is just starting while Music still reports the one before it.
      if (previous) return ownsPosition ? restart() : "hold";
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
  // Music ignores a shuffle change until a song is playing, and a streamed song can take seconds
  // to start; the write before play covers Music already playing something.
  Music.shuffleEnabled = true;
  list.play(target);
  for (let i = 0; i < 100 && Music.playerState() !== "playing"; i++) delay(0.1);
  Music.shuffleEnabled = true;
  return "ok:" + target + ":" + list.ids[target] + ":" + (Music.shuffleEnabled() ? "on" : "off");
}${SONGS_JXA}`;

// STEP_SCRIPT's order for an unedited queue, read for Up Next with the same shuffle decision.
// argv: playlist, song, position, seed, shuffle start, T3's shuffle mode when stopped, limit.
const FORMULA_QUEUE_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const list = songs(Music, found[0]);
  const ids = list.ids;
  const given = Number(argv[2]);
  const current = ids[given] === argv[1] ? given : ids.indexOf(argv[1]);
  if (current < 0) return "not-found";
  const shuffled = Music.playerState() === "stopped" ? argv[5] === "on" : Music.shuffleEnabled();
  const start = shuffled ? (argv[4] === "none" ? "current" : argv[4]) : "none";
  const sequence = shuffleOrder(ids.length, argv[3], start, current) || ids.map((_, i) => i);
  const at = sequence.indexOf(current);
  const shown = [current].concat(sequence.slice(at + 1, at + 1 + Number(argv[6])));
  const tracks = found[0].tracks;
  const names = list.pick(tracks.name());
  const artists = list.pick(tracks.artist());
  const durations = list.pick(tracks.duration());
  const clip = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
  return JSON.stringify({
    playlistName: clip(found[0].name()),
    count: ids.length,
    shuffled: shuffled,
    wraps: Music.songRepeat() === "all",
    total: ids.length - at - 1,
    tracks: shown.map((i) => ({ id: ids[i], index: i, name: clip(names[i]), artist: clip(artists[i]), durationSec: durations[i] })),
  });
}${SONGS_JXA}`;

// The whole order STEP_SCRIPT would walk, played songs included, for a queue's first edit.
// argv: as FORMULA_QUEUE_SCRIPT, with the most songs allowed in place of the limit.
const MATERIALISE_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const found = Music.playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const ids = songs(Music, found[0]).ids;
  if (ids.length > Number(argv[6])) return "too-long";
  const given = Number(argv[2]);
  const current = ids[given] === argv[1] ? given : ids.indexOf(argv[1]);
  if (current < 0) return "not-found";
  const shuffled = Music.playerState() === "stopped" ? argv[5] === "on" : Music.shuffleEnabled();
  const start = shuffled ? (argv[4] === "none" ? "current" : argv[4]) : "none";
  const sequence = shuffleOrder(ids.length, argv[3], start, current) || ids.map((_, i) => i);
  return JSON.stringify({ ids: ids, sequence: sequence, current: current, shuffled: shuffled });
}${SONGS_JXA}`;

// Names for queue entries in one call, each found by position and checked against its id.
// argv: the songs as JSON [{ playlistId, trackId, index }], and the source playlist or "none".
const SONG_INFO_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const refs = JSON.parse(argv[0]);
  const lists = Object.create(null);
  const clip = (value) => (typeof value === "string" ? value.slice(0, 300) : "");
  const open = (id) => {
    if (!(id in lists)) {
      const found = Music.playlists.whose({ persistentID: id })();
      lists[id] = found.length === 0 ? null : { playlist: found[0], list: songs(Music, found[0]), columns: null };
    }
    return lists[id];
  };
  const out = refs.map((ref) => {
    const entry = open(ref.playlistId);
    if (entry === null) return null;
    const ids = entry.list.ids;
    const index = ids[ref.index] === ref.trackId ? ref.index : ids.indexOf(ref.trackId);
    if (index < 0) return null;
    if (entry.columns === null) {
      const tracks = entry.playlist.tracks;
      entry.columns = { names: entry.list.pick(tracks.name()), artists: entry.list.pick(tracks.artist()), durations: entry.list.pick(tracks.duration()) };
    }
    return { id: ids[index], index: index, name: clip(entry.columns.names[index]), artist: clip(entry.columns.artists[index]), durationSec: entry.columns.durations[index] };
  });
  let playlistName = null;
  if (argv[1] !== "none") {
    const source = Music.playlists.whose({ persistentID: argv[1] })();
    if (source.length > 0) playlistName = clip(source[0].name());
  }
  return JSON.stringify({ playlistName: playlistName, wraps: Music.songRepeat() === "all", songs: out });
}${SONGS_JXA}`;

// STEP_SCRIPT for an edited queue: the same guards, then the first of the server's candidates
// that still resolves. argv: current song, direction, Music's playlist for it, whether Music
// confirmed it, and candidates as JSON without and with wrapping round (for repeat all).
const QUEUE_STEP_SCRIPT = `function run(argv) {
  const Music = Application("Music");
  const automatic = argv[1] === "advance";
  if (automatic && !Music.running()) return "gone";
  const playback = Music.playerState();
  if (automatic && playback === "paused") return "hold";
  const onPick = playback !== "stopped" && Music.currentTrack.persistentID() === argv[0];
  if (playback !== "stopped" && (automatic || argv[3] === "seen")) {
    if (!onPick) return "changed";
    if (argv[2] !== "none") {
      let playlistId = null;
      try { playlistId = Music.currentPlaylist.persistentID(); } catch (error) {}
      if (playlistId !== null && playlistId !== argv[2]) return "changed";
    }
  }
  if (automatic && playback !== "stopped" && (playback !== "playing" || Music.songRepeat() !== "all" || Music.playerPosition() >= 4)) return "hold";
  const previous = argv[1] === "previous";
  const restart = () => { Music.playerPosition = 0; return "restart"; };
  const ownsPosition = onPick || playback === "stopped";
  if (previous && ownsPosition && Music.playerPosition() > 3) return restart();
  const wrap = Music.songRepeat() === "all";
  const refs = JSON.parse(wrap ? argv[5] : argv[4]);
  if (refs.length === 0) {
    if (previous) return ownsPosition ? restart() : "hold";
    Music.stop();
    return "end";
  }
  const lists = Object.create(null);
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (!(ref.playlistId in lists)) {
      const found = Music.playlists.whose({ persistentID: ref.playlistId })();
      lists[ref.playlistId] = found.length === 0 ? null : songs(Music, found[0]);
    }
    const list = lists[ref.playlistId];
    if (list === null) continue;
    const target = list.ids[ref.index] === ref.trackId ? ref.index : list.ids.indexOf(ref.trackId);
    if (target < 0) continue;
    list.play(target);
    return "ok:" + i + ":" + (wrap ? "w" : "f") + ":" + target;
  }
  // Every candidate is gone: stop as at an end, never Music's own Next.
  Music.stop();
  return "exhausted:" + (wrap ? "w" : "f");
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
    // Resume only: still the song Resume played, from its playlist? The saved song's length is
    // often unknown until Music has it playing. argv: position, tail, track id, playlist id, seek.
    case "seek-before-end": {
      let playlistId = null;
      try { playlistId = Music.currentPlaylist.persistentID(); } catch (error) {}
      if (Music.currentTrack.persistentID() !== argv[3] || playlistId !== argv[4]) return "changed";
      if (argv[5] !== "seek") return "kept";
      const duration = Number(Music.currentTrack.duration());
      const position = Number(argv[1]);
      if (!(duration > 0) || position >= duration - Number(argv[2])) return "end";
      Music.playerPosition = position;
      break;
    }
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
  favorited: Schema.optional(Schema.NullOr(Schema.Array(Schema.NullOr(Schema.Boolean)))),
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

const RawQueueTrack = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  name: Schema.NullOr(Schema.String),
  artist: Schema.NullOr(Schema.String),
  durationSec: Schema.NullOr(Schema.Number),
});
const decodeRawFormulaQueue = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      playlistName: Schema.NullOr(Schema.String),
      count: Schema.Number,
      shuffled: Schema.Boolean,
      wraps: Schema.Boolean,
      total: Schema.Number,
      tracks: Schema.Array(RawQueueTrack),
    }),
  ),
);
const decodeRawMaterialised = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ids: Schema.Array(Schema.String),
      sequence: Schema.Array(Schema.Number),
      current: Schema.Number,
      shuffled: Schema.Boolean,
    }),
  ),
);
const decodeRawSongInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      playlistName: Schema.NullOr(Schema.String),
      wraps: Schema.Boolean,
      songs: Schema.Array(Schema.NullOr(RawQueueTrack)),
    }),
  ),
);
const MAX_QUEUE_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Positions save this often while playing, and at once on pause, a step or new labels. */
const QUEUE_CHECKPOINT_MS = 15_000;
const REPLACED_HOLD = Duration.seconds(30);
/** Resume seeks only past this, and not into the last RESUME_TAIL_SECONDS. */
const RESUME_MIN_SECONDS = 5;
const RESUME_TAIL_SECONDS = 10;
/** How far a playing song may have moved on since its last checkpoint and still be T3's. */
const ADOPT_PLAYING_DRIFT_SECONDS = QUEUE_CHECKPOINT_MS / 1000 + 75;
const ADOPT_PAUSED_DRIFT_SECONDS = 1.5;
const UNAVAILABLE_SONG = "Unavailable song";

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

// Music's scripting has no queue, so a separate helper app (apps/server/native/music-up-next) reads
// the rows Music's Up Next panel shows through Accessibility. T3 launches it through LaunchServices
// so macOS holds the helper, not T3 Code, responsible: a grant there never reaches T3's own
// processes or the agents it runs.
/** The helper exits on its own after 10 s; this only bounds the launch around it. */
const NATIVE_QUEUE_LAUNCH_TIMEOUT = Duration.seconds(15);
const MAX_NATIVE_QUEUE_BYTES = 512 * 1024;
/** One read of Music's panel serves every client asking about the same song at about once. */
const NATIVE_QUEUE_SHARE = Duration.seconds(2);

const RawNativeRow = Schema.Struct({
  texts: Schema.Array(Schema.String),
  buttons: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.NullOr(Schema.String)),
      label: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
type RawNativeRow = typeof RawNativeRow.Type;
const RawNativeRead = Schema.Struct({
  kind: Schema.String,
  rows: Schema.optional(Schema.Array(RawNativeRow)),
  lastVisibleIndex: Schema.optional(Schema.NullOr(Schema.Number)),
  rowCount: Schema.optional(Schema.NullOr(Schema.Number)),
});
const decodeRawNativeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ request: Schema.String, read: RawNativeRead })),
);

const rowLabel = (row: RawNativeRow) => row.texts.find((value) => value.trim() !== "");
/** Music gives each song its More button (`actionButton`); other rows are headers. */
const isQueueSong = (row: RawNativeRow) =>
  row.buttons.some((button) => button.id === "actionButton");
/** The header that opens Music's queue carries its Clear (`action`) or source (`from`) button. */
const opensQueue = (row: RawNativeRow) =>
  !isQueueSong(row) && row.buttons.some((button) => button.id === "action" || button.id === "from");

/** The helper's read as Up Next; rows before the header that opens the queue are history. */
function parseNativeQueue(read: typeof RawNativeRead.Type): MusicNativeQueue | null {
  switch (read.kind) {
    case "not-running":
      return { _tag: "not-running" };
    case "closed":
      return { _tag: "panel-closed" };
    case "unrecognised":
      return { _tag: "unrecognised" };
    case "unreadable":
      return { _tag: "unreadable" };
    case "permission-needed":
      return { _tag: "permission-needed" };
    case "panel":
      break;
    default:
      return null;
  }
  const rows = read.rows ?? [];
  const start = rows.findIndex(opensQueue);
  if (start < 0) {
    // An empty list is an empty queue, not one scrolled out of view.
    return read.rowCount === 0
      ? { _tag: "ok", sections: [], complete: true }
      : { _tag: "no-upcoming-visible" };
  }
  const sections: Array<{ title: string; source: string | null; songs: Array<string> }> = [];
  let complete =
    typeof read.rowCount === "number" &&
    typeof read.lastVisibleIndex === "number" &&
    read.lastVisibleIndex >= read.rowCount - 1;
  for (const row of rows.slice(start)) {
    const label = rowLabel(row);
    // A row Music has not drawn yet ends what can be read.
    if (label === undefined) {
      complete = false;
      break;
    }
    if (isQueueSong(row)) {
      sections.at(-1)!.songs.push(text(label));
      continue;
    }
    const source = row.buttons.find((button) => button.id === "from")?.label ?? null;
    sections.push({ title: text(label), source: source === null ? null : text(source), songs: [] });
  }
  return { _tag: "ok", sections, complete };
}

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
  readonly byId: ReadonlyMap<string, LibraryEntry>;
  /** Favourited song ids; T3's own changes patch it in place. Null when Music can't say. */
  readonly favorited: Set<string> | null;
  readonly readAt: number;
}

/** One library read; a malformed row drops alone and the others keep their positions. */
function decodeLibrarySnapshot(stdout: string, readAt: number): MusicLibrarySnapshot | null {
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
  const flags = raw.favorited ?? null;
  return {
    playlistId,
    entries,
    byId: new Map(entries.map((entry) => [entry.song.id, entry])),
    favorited:
      flags === null
        ? null
        : new Set(
            entries.flatMap((entry) => (flags[entry.song.index] === true ? [entry.song.id] : [])),
          ),
    readAt,
  };
}

const matchesWords = (entry: LibraryEntry, words: ReadonlyArray<string>) =>
  words.every((word) => entry.foldedText.includes(word));

/** Favourited songs in library order, filtered like search; null when Music can't say. */
function listFavoriteSongs(
  snapshot: MusicLibrarySnapshot,
  input: MusicListFavoritesInput,
): MusicFavorites | null {
  const favorited = snapshot.favorited;
  if (favorited === null) return null;
  const needle = fold(input.query ?? "");
  const words = needle === "" ? [] : needle.split(" ");
  const matches = snapshot.entries.filter(
    (entry) => favorited.has(entry.song.id) && matchesWords(entry, words),
  );
  return {
    playlistId: snapshot.playlistId,
    songs: matches.slice(input.offset, input.offset + input.limit).map((entry) => entry.song),
    total: matches.length,
    snapshotAt: snapshot.readAt,
  };
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
    words.length === 0 ? [] : snapshot.entries.filter((entry) => matchesWords(entry, words));
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
  /** T3's shuffled order: where it starts, or null for a fresh whole-playlist shuffle. */
  readonly shuffle: { readonly first: number | null } | null;
  /** Music's shuffle flag as last seen playing; stopped, Music reads it as off. */
  readonly shuffled: boolean;
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
  shuffled: shuffle !== null,
});

/** The state with where T3 plays from, once Music confirms the picked song. */
const withPlayingFrom = (state: MusicPlayerState, picked: PickedSong | null): MusicPlayerState => {
  if (picked === null || !picked.seen || state._tag !== "ready") return state;
  if (state.track?.id !== picked.trackId) return state;
  const { playlistId, index, seed, shuffle, shuffled } = picked;
  return {
    ...state,
    playingFrom: {
      playlistId,
      index,
      ...(shuffle === null || !shuffled ? {} : { shuffle: { seed, first: shuffle.first } }),
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

/** The one T3 queue an environment owns: active while T3 plays it, otherwise resumable. */
interface QueueState {
  readonly id: string;
  readonly revision: number;
  readonly active: boolean;
  /** Null while an unedited playlist queue still steps by formula. */
  readonly explicit: MusicQueue.ExplicitQueue | null;
  /** How a formula queue steps; kept while saved so Resume restarts the same order. */
  readonly formula: QueueFormula | null;
  readonly currentKey: string;
  readonly trackId: string;
  readonly positionSec: number;
  readonly display: QueueDisplay;
  /** Only a live query or Resume sets this. */
  readonly sourceMissing: boolean;
}

/** A Reset turned shuffle off and waits for Music to confirm before the formula takes over. */
interface ResetAck {
  readonly id: string;
  readonly revision: number;
  readonly confirmed: boolean;
  readonly deadline: number;
}

const formulaOf = (picked: PickedSong): QueueFormula => ({
  playlistId: picked.playlistId,
  seed: picked.seed,
  shuffleFirst: picked.shuffle === null ? null : (picked.shuffle.first ?? "free"),
  shuffled: picked.shuffled,
});

const formulaShuffle = (formula: QueueFormula): PickedSong["shuffle"] =>
  formula.shuffleFirst === null
    ? null
    : { first: formula.shuffleFirst === "free" ? null : formula.shuffleFirst };

const sameFormula = (a: QueueFormula, b: QueueFormula) =>
  a.playlistId === b.playlistId &&
  a.seed === b.seed &&
  a.shuffleFirst === b.shuffleFirst &&
  a.shuffled === b.shuffled;

/** The queue-level source label survives a step; song labels belong to one entry. */
const sourceOnly = (display: QueueDisplay): QueueDisplay =>
  display.sourceName === undefined ? {} : { sourceName: display.sourceName };

const entryDisplay = (display: QueueDisplay, song: MusicQueue.QueueSong): QueueDisplay =>
  sanitizeDisplay({
    ...sourceOnly(display),
    ...(song.meta === null ? {} : { trackName: song.meta.name, artist: song.meta.artist }),
  });

const QUEUE_PAGE = 50;

/** Songs for a script's argv; only position, id and playlist ever reach Music. */
const songRefsArgument = (refs: ReadonlyArray<MusicSongRef>) =>
  JSON.stringify(
    refs.map((ref) => ({ playlistId: ref.playlistId, trackId: ref.trackId, index: ref.index })),
  );

export type PickedSongUpdate =
  | { readonly _tag: "follow"; readonly picked: PickedSong; readonly hide: boolean }
  | { readonly _tag: "advance" }
  | {
      readonly _tag: "drop";
      readonly reason: "music-quit" | "other-song" | "never-started" | "other-playlist";
    };

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
  if (state._tag !== "ready") return { _tag: "drop", reason: "music-quit" };
  const track = state.playback === "stopped" ? null : state.track;
  if (!picked.seen && track?.id !== picked.trackId) {
    const settling = nowMs - picked.startedAtMs < PICK_SETTLE_MS;
    if (track !== null && !settling) return { _tag: "drop", reason: "never-started" };
    return { _tag: "follow", picked, hide: track === null && settling };
  }
  const nearEnd =
    picked.durationSec > 0 && picked.positionSec >= picked.durationSec - SONG_END_MARGIN_SECONDS;
  if (track === null)
    return nearEnd ? { _tag: "advance" } : { _tag: "follow", picked, hide: false };
  if (track.id !== picked.trackId) return { _tag: "drop", reason: "other-song" };
  // The same song started from another playlist, album or Autoplay is Music's queue now.
  if (
    picked.musicPlaylistId !== null &&
    state.playlistId !== null &&
    state.playlistId !== picked.musicPlaylistId
  ) {
    return { _tag: "drop", reason: "other-playlist" };
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
      // Shuffle turned on in Music shuffles on from the current song. A sample never clears the
      // order, only the mode: it may have read the flag before a change.
      shuffle: picked.shuffle ?? (state.shuffle ? { first: picked.index } : null),
      shuffled: state.shuffle,
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

const LIST_LABELS = { favourites: "Favourites", recent: "Recently played" } as const;

const make = Effect.fn("MusicPlayer.make")(function* (options: { readonly upNextHelper: string }) {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listening = yield* MusicListeningStats;
  const recent = yield* MusicRecentStore;
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

  // The T3 queue. Its state changes only under pickLock, beside the pick it describes.
  const store = yield* MusicQueueStore.MusicQueueStore;
  const replacedTimer = yield* FiberHandle.make<void, never>();
  let queue: QueueState | null = null;
  /** Entries a step found gone; they show disabled. */
  let unavailableKeys = new Set<string>();
  /** Music's shuffle flag as last accepted for an explicit queue; null until a sample sets it. */
  let musicShuffle: boolean | null = null;
  /** After T3 writes shuffle, samples showing the old value are ignored until this passes. */
  let settle: { readonly value: boolean; readonly deadline: number } | null = null;
  let resetAck: ResetAck | null = null;
  let replaced: { readonly info: MusicReplacedQueue; readonly held: QueueState } | null = null;
  let lastCheckpointAt = 0;
  let lastPlayback: string | null = null;
  /**
   * The queue read from files at startup, until the first sample with a song decides whether
   * Music still holds it where T3 left it (a restart mid-song, often during a long pause).
   */
  let restored: { readonly id: string; readonly revision: number } | null = null;
  /** The last normal playlist list, for labels only; never fetched just for a label. */
  let playlistNames: ReadonlyMap<string, string> = new Map();
  let libraryId: string | null = null;
  /** Bump when an open Favourites or Recently played view should read again. */
  let favouritesRevision = 0;
  let recentRevision = 0;
  let recentPlay: RecentPlay | null = null;
  /** The current song's favourite flag as last sampled, to notice a change made in Music. */
  let favoriteSeen: { readonly trackId: string; readonly value: boolean } | null = null;
  /** T3's own favourite write; samples showing the old value are ignored until this passes. */
  let favoriteWrite: {
    readonly trackId: string;
    readonly value: boolean;
    readonly deadline: number;
  } | null = null;

  const readLibrary = Effect.fn("MusicPlayer.readLibrary")(function* () {
    const result = yield* runScript(
      "search-library",
      "JavaScript",
      LIBRARY_SCRIPT,
      [],
      MAX_LIBRARY_BYTES,
    );
    const snapshot = decodeLibrarySnapshot(result, yield* Clock.currentTimeMillis);
    if (snapshot === null) {
      return yield* new MusicError({ operation: "search-library", reason: "unavailable" });
    }
    libraryId = snapshot.playlistId;
    return snapshot;
  });

  // Search, Favourites and Recently played share one read a minute, however many clients look.
  const librarySnapshot = yield* Cache.makeWith((_: "library") => readLibrary(), {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LIBRARY_SNAPSHOT_TTL : Duration.zero),
  });
  const library = (operation: MusicError["operation"]) =>
    Cache.get(librarySnapshot, "library").pipe(
      Effect.mapError((error) => new MusicError({ operation, reason: error.reason, cause: error })),
    );

  const savedFiles = yield* store.load;
  if (savedFiles.body !== null) {
    const body = savedFiles.body;
    const saved = MusicQueueStore.resolveSaved(body, savedFiles.position);
    if (saved === null) {
      yield* Effect.logWarning("saved music queue does not hold together; ignoring it");
    } else {
      queue = {
        id: body.id,
        revision: body.revision,
        active: false,
        explicit: saved.explicit,
        formula: body.formula ?? null,
        currentKey: saved.currentKey,
        trackId: saved.trackId,
        positionSec: saved.positionSec,
        display: saved.display,
        sourceMissing: false,
      };
      // Only a queue T3 never let go of may be taken back; T3 letting go writes active false.
      if (saved.wasActive) restored = { id: body.id, revision: body.revision };
    }
  }

  const statusOf = (): MusicQueueStatus => ({
    active:
      queue?.active === true
        ? {
            id: queue.id,
            revision: queue.revision,
            edited: queue.explicit !== null,
            currentKey: queue.currentKey,
          }
        : null,
    saved:
      queue !== null && !queue.active
        ? {
            id: queue.id,
            revision: queue.revision,
            trackName: queue.display.trackName ?? "Saved song",
            artist: queue.display.artist ?? null,
            sourceName: queue.display.sourceName ?? "Playlist",
            positionSec: queue.positionSec,
            sourceMissing: queue.sourceMissing,
          }
        : null,
    replaced: replaced?.info ?? null,
    favouritesRevision,
    recentRevision,
  });
  const queueStatus = yield* SubscriptionRef.make(statusOf());
  /** Publishes transitions only, never a sample. One step, so no later status is overwritten. */
  const publishQueue = SubscriptionRef.updateSome(queueStatus, (current) => {
    const next = statusOf();
    return JSON.stringify(current) === JSON.stringify(next) ? Option.none() : Option.some(next);
  });

  const bodyOf = (state: QueueState): MusicQueueStore.QueueBody =>
    state.explicit !== null
      ? MusicQueueStore.bodyFromExplicit(state.explicit, state.display)
      : {
          version: 1,
          id: state.id,
          revision: state.revision,
          currentKey: state.currentKey,
          trackId: state.trackId,
          display: state.display,
          formula: state.formula!,
        };
  const positionOf = (state: QueueState, savedAt: number): MusicQueueStore.QueuePosition => ({
    version: 1,
    id: state.id,
    revision: state.revision,
    currentKey: state.currentKey,
    trackId: state.trackId,
    positionSec: state.positionSec,
    savedAt,
    display: state.display,
    active: state.active,
  });

  // Only a clean shutdown marks its last checkpoint closed, and only that one may be taken back
  // after a restart: a crash or a failed write leaves an earlier one, so the queue stays a Resume
  // card whatever Music did meanwhile.
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const current = queue;
      if (current === null) return;
      const savedAt = yield* Clock.currentTimeMillis;
      yield* store.savePosition({ ...positionOf(current, savedAt), closed: true });
      yield* store.settled;
    }),
  );

  const clearReplaced = Effect.suspend(() => {
    replaced = null;
    return FiberHandle.clear(replacedTimer);
  });

  /** Makes `next` the queue, saves what changed and publishes. */
  const commit = Effect.fnUntraced(function* (
    next: QueueState,
    write: "body" | "position" | "none",
  ) {
    queue = next;
    const hold = replaced?.info;
    // Undo is only for the queue that replaced it, unchanged and still playing.
    if (
      hold !== undefined &&
      !(next.active && next.id === hold.byId && next.revision === hold.byRevision)
    ) {
      yield* clearReplaced;
    }
    if (write !== "none") {
      const now = yield* Clock.currentTimeMillis;
      lastCheckpointAt = now;
      yield* write === "body"
        ? store.saveBody(bodyOf(next), positionOf(next, now))
        : store.savePosition(positionOf(next, now));
    }
    yield* publishQueue;
  });

  const forgetPending = () => {
    settle = null;
    resetAck = null;
    musicShuffle = null;
  };

  const deactivate = Effect.suspend(() => {
    const current = queue;
    if (current === null || !current.active) return Effect.void;
    forgetPending();
    return commit({ ...current, active: false }, "position");
  });

  /** Follows the pick for a formula queue, and makes any queue inactive once T3 lets go. */
  const syncQueue = Effect.gen(function* () {
    const current = queue;
    if (current === null || !current.active) return;
    const pick = yield* Ref.get(picked);
    if (pick === null) return yield* deactivate;
    if (current.explicit !== null || current.formula === null) return;
    const formula = formulaOf(pick);
    const key = `s${pick.index}`;
    const moved = key !== current.currentKey || pick.trackId !== current.trackId;
    const reordered = !sameFormula(formula, current.formula);
    if (!moved && !reordered) return;
    // Pinning where a shuffle starts records the order already shown, so only a flag change
    // is a new order.
    const flipped = formula.shuffled !== current.formula.shuffled;
    const next: QueueState = {
      ...current,
      formula,
      revision: flipped ? current.revision + 1 : current.revision,
      ...(moved
        ? {
            currentKey: key,
            trackId: pick.trackId,
            positionSec: 0,
            display: sourceOnly(current.display),
          }
        : {}),
    };
    yield* commit(next, reordered ? "body" : "position");
  });

  const setPicked = (next: PickedSong | null) =>
    Ref.set(picked, next).pipe(Effect.andThen(syncQueue));

  const sourcePlaylistOf = (state: QueueState | null) =>
    state === null
      ? null
      : state.explicit !== null
        ? state.explicit.source.kind === "playlist"
          ? state.explicit.source.playlistId
          : null
        : (state.formula?.playlistId ?? null);

  const sourceNameFor = (playlistId: string) =>
    playlistNames.get(playlistId) ?? (playlistId === libraryId ? "Library" : undefined);

  /** A label from a normal read for the queue's source checkpoints at once if it changed. */
  const noteSourceName = (queueId: string, playlistId: string, name: string | undefined) =>
    Effect.suspend(() => {
      const current = queue;
      const label = sanitizeDisplay({ sourceName: name }).sourceName;
      if (
        current === null ||
        current.id !== queueId ||
        label === undefined ||
        sourcePlaylistOf(current) !== playlistId ||
        current.display.sourceName === label
      ) {
        return Effect.void;
      }
      return commit({ ...current, display: { ...current.display, sourceName: label } }, "position");
    });

  const newQueueId = Effect.map(
    Effect.all([newSeed, newSeed]),
    (parts) => `q${parts.map((part) => part.toString(36).padStart(6, "0")).join("")}`,
  );

  /**
   * A new T3 play: a new queue, by formula for a playlist or explicit for a list. An edited one
   * it replaces is held briefly for Undo.
   */
  const startQueue = Effect.fn("MusicPlayer.startQueue")(function* (
    pick: PickedSong,
    list?: (id: string) => MusicQueue.ExplicitQueue,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const id = yield* newQueueId;
    const old = queue;
    yield* clearReplaced;
    if (old !== null && old.explicit !== null) {
      const info: MusicReplacedQueue = {
        replacedId: old.id,
        replacedRevision: old.revision,
        byId: id,
        byRevision: 0,
        expiresAt: now + Duration.toMillis(REPLACED_HOLD),
      };
      replaced = { info, held: { ...old, active: false } };
      yield* FiberHandle.run(
        replacedTimer,
        Effect.sleep(REPLACED_HOLD).pipe(
          Effect.andThen(
            pickLock.withPermits(1)(
              Effect.suspend(() => {
                if (replaced?.info !== info) return Effect.void;
                replaced = null;
                return publishQueue;
              }),
            ),
          ),
        ),
      );
    }
    forgetPending();
    unavailableKeys = new Set();
    const explicit = list?.(id) ?? null;
    if (explicit === null) {
      const sourceName = sourceNameFor(pick.playlistId);
      return yield* commit(
        {
          id,
          revision: 0,
          active: true,
          explicit: null,
          formula: formulaOf(pick),
          currentKey: `s${pick.index}`,
          trackId: pick.trackId,
          positionSec: 0,
          display: sourceName === undefined ? {} : { sourceName },
          sourceMissing: false,
        },
        "body",
      );
    }
    const value = MusicQueue.currentValue(explicit);
    const song = MusicQueue.songForValue(explicit, value)!;
    const sourceName =
      explicit.source.kind === "playlist" ? undefined : LIST_LABELS[explicit.source.kind];
    yield* commit(
      {
        id,
        revision: explicit.revision,
        active: true,
        explicit,
        formula: null,
        currentKey: MusicQueue.entryKey(value),
        trackId: song.trackId,
        positionSec: 0,
        display: entryDisplay(sourceName === undefined ? {} : { sourceName }, song),
        sourceMissing: false,
      },
      "body",
    );
  });

  /** Once Music confirms a Reset's shuffle off, a playlist queue steps by formula again. */
  const tryHandoff = Effect.gen(function* () {
    const ack = resetAck;
    const current = queue;
    if (ack === null || current === null) return;
    if (
      !current.active ||
      current.explicit === null ||
      ack.id !== current.id ||
      ack.revision !== current.revision
    ) {
      // Revoked. An unconfirmed Reset still consumes its late acknowledgement.
      if (ack.confirmed) resetAck = null;
      return;
    }
    if (!ack.confirmed) return;
    const { source } = current.explicit;
    if (source.kind !== "playlist") {
      resetAck = null;
      return;
    }
    const pick = yield* Ref.get(picked);
    // An added song keeps playing; the handoff waits for the next source song.
    if (MusicQueue.currentValue(current.explicit) < 0 || pick === null) return;
    resetAck = null;
    const next: PickedSong = {
      ...pick,
      playlistId: source.playlistId,
      shuffle: null,
      shuffled: false,
    };
    yield* Ref.set(picked, next);
    yield* commit(
      { ...current, explicit: null, formula: formulaOf(next), currentKey: `s${next.index}` },
      "body",
    );
  });

  const applyToggle = Effect.fn("MusicPlayer.toggleQueueShuffle")(function* (on: boolean) {
    const current = queue;
    if (current === null || current.explicit === null) return;
    const explicit = MusicQueue.toggleShuffle(current.explicit, on, yield* newSeed);
    yield* commit({ ...current, explicit, revision: explicit.revision }, "body");
  });

  /** One edge per change of Music's flag; T3's own writes and a pending Reset settle first. */
  const observeShuffle = Effect.fnUntraced(function* (shuffle: boolean, now: number) {
    const ack = resetAck;
    if (ack !== null && !ack.confirmed) {
      if (!shuffle) {
        resetAck = { ...ack, confirmed: true };
        musicShuffle = false;
        settle = null;
        yield* tryHandoff;
      } else if (now >= ack.deadline) {
        // The write did not take: report Music's flag, keep source order, never reshuffle.
        musicShuffle = true;
      }
      return;
    }
    if (settle !== null) {
      if (shuffle === settle.value) {
        settle = null;
        musicShuffle = shuffle;
        return;
      }
      if (now < settle.deadline) return;
      settle = null;
    } else if (musicShuffle === null || shuffle === musicShuffle) {
      musicShuffle = shuffle;
      return;
    }
    musicShuffle = shuffle;
    yield* applyToggle(shuffle);
  });

  /** Position and labels for the current entry, from a sample of the song itself. */
  const observeQueueSample = Effect.fnUntraced(function* (state: MusicPlayerState) {
    const current = queue;
    if (current === null || !current.active || state._tag !== "ready") return;
    const now = yield* Clock.currentTimeMillis;
    const track = state.playback === "stopped" ? null : state.track;
    if (track !== null && track.id === current.trackId) {
      const display = sanitizeDisplay({
        ...current.display,
        trackName: track.name,
        artist: track.artist,
      });
      const labelled =
        display.trackName !== current.display.trackName ||
        display.artist !== current.display.artist;
      const due =
        (state.playback === "paused" && lastPlayback === "playing") ||
        (state.playback === "playing" && now - lastCheckpointAt >= QUEUE_CHECKPOINT_MS);
      const next = { ...current, positionSec: state.positionSec, display };
      if (labelled || due) {
        yield* commit(next, "position");
      } else {
        queue = next;
      }
    }
    lastPlayback = state.playback;
    if (current.explicit !== null && state.playback !== "stopped") {
      yield* observeShuffle(state.shuffle, now);
    }
  });

  const stepExplicit = Effect.fn("MusicPlayer.stepQueue")(function* (
    from: PickedSong,
    direction: "next" | "previous" | "advance",
  ) {
    const current = queue;
    const explicit = current?.explicit ?? null;
    if (current === null || explicit === null) return "changed";
    const options = MusicQueue.candidates(explicit, direction === "previous" ? "previous" : "next");
    const refs = (list: ReadonlyArray<MusicQueue.Candidate>) =>
      songRefsArgument(list.map(({ song }) => song));
    const result = yield* runScript("control", "JavaScript", QUEUE_STEP_SCRIPT, [
      from.trackId,
      direction,
      from.musicPlaylistId ?? "none",
      from.seen ? "seen" : "unseen",
      refs(options.forward),
      refs(options.wrapped),
    ]);
    const [outcome, first, pool, second] = result.split(":");
    yield* Effect.annotateCurrentSpan("music.step.outcome", outcome);
    if (outcome === "ok" || outcome === "restart" || outcome === "end" || outcome === "exhausted") {
      sampleVersion++;
    }
    if (outcome === "hold") return outcome;
    if (outcome === "restart") {
      yield* Ref.set(picked, { ...from, positionSec: 0 });
      return outcome;
    }
    const tried = (outcome === "ok" ? pool : first) === "w" ? options.wrapped : options.forward;
    const chosen = outcome === "ok" ? tried[Number(first)] : undefined;
    const skipped =
      chosen !== undefined ? tried.slice(0, Number(first)) : outcome === "exhausted" ? tried : [];
    for (const entry of skipped) unavailableKeys.add(MusicQueue.entryKey(entry.value));
    const index = Number(second);
    if (chosen === undefined || !Number.isInteger(index)) {
      // Ended, nothing left to play, or Music took over: the queue stays resumable here.
      yield* setPicked(null);
      return outcome;
    }
    const key = MusicQueue.entryKey(chosen.value);
    unavailableKeys.delete(key);
    yield* Ref.set(
      picked,
      pickSong(
        chosen.song.playlistId,
        chosen.song.trackId,
        index,
        yield* Clock.currentTimeMillis,
        from.seed,
      ),
    );
    yield* commit(
      {
        ...current,
        explicit: MusicQueue.moveCursor(explicit, chosen.at),
        currentKey: key,
        trackId: chosen.song.trackId,
        positionSec: 0,
        display: entryDisplay(current.display, chosen.song),
      },
      "position",
    );
    yield* tryHandoff;
    return outcome;
  });

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
      from.shuffled ? "on" : "off",
    ]);
    const [outcome, index, trackId, shuffle] = result.split(":");
    yield* Effect.annotateCurrentSpan("music.step.outcome", outcome);
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
    yield* setPicked(next);
    return outcome;
  });

  /** The sample to publish, with where T3 is playing from; null holds it back. */
  const followSample = (state: MusicPlayerState, version: number) =>
    pickLock.withPermits(1)(
      Effect.gen(function* () {
        if (version !== sampleVersion) return null;
        if (restored !== null && (yield* Ref.get(picked)) === null) yield* adoptRestored(state);
        const current = yield* Ref.get(picked);
        if (current === null) return state;
        const decision = followPickedSong(current, state, yield* Clock.currentTimeMillis);
        switch (decision._tag) {
          case "follow": {
            // An edited queue's order is its own; Music's shuffle only toggles it.
            const next =
              queue?.active === true && queue.explicit !== null
                ? { ...decision.picked, shuffle: null }
                : decision.picked;
            yield* Ref.set(picked, next);
            yield* syncQueue;
            yield* observeQueueSample(state);
            return decision.hide ? null : withPlayingFrom(state, next);
          }
          case "drop":
            // A rare, short span, so the trace says why T3 let go of the song it was playing.
            yield* setPicked(null).pipe(
              Effect.withSpan("MusicPlayer.dropPick", {
                attributes: {
                  "music.drop.reason": decision.reason,
                  "music.playback": state._tag === "ready" ? state.playback : state._tag,
                  "music.pick.seen": current.seen,
                },
              }),
            );
            return state;
          case "advance":
            yield* (
              queue?.active === true && queue.explicit !== null
                ? stepExplicit(current, "advance")
                : stepPicked(current, "advance")
            ).pipe(Effect.catch(() => setPicked(null)));
            return null;
        }
      }),
    );

  /** A song heard long enough moves to the top of Recently played. */
  const observeRecent = Effect.fnUntraced(function* (
    previous: EmittedMusicState | null,
    state: MusicPlayerState,
    now: number,
  ) {
    const followed = followRecentPlay(recentPlay, previous, state, now, MAX_CREDIT_SECONDS);
    recentPlay = followed.play;
    if (followed.qualified === null) return;
    yield* recent.record(followed.qualified);
    recentRevision++;
    yield* publishQueue;
  });

  /** A favourite changed in Music itself makes the next Favourites read start fresh. */
  const observeFavorite = Effect.fnUntraced(function* (state: MusicPlayerState, now: number) {
    const track = state._tag === "ready" && state.playback !== "stopped" ? state.track : null;
    if (track === null || track.favorited === undefined) return;
    const value = track.favorited;
    const write = favoriteWrite;
    if (write !== null && write.trackId === track.id) {
      if (value !== write.value && now < write.deadline) return;
      favoriteWrite = null;
    }
    const seen = favoriteSeen;
    favoriteSeen = { trackId: track.id, value };
    if (seen === null || seen.trackId !== track.id || seen.value === value) return;
    if (write !== null && write.trackId === track.id && write.value === value) return;
    yield* Cache.invalidate(librarySnapshot, "library");
    favouritesRevision++;
    yield* publishQueue;
  });

  /** T3 changed a favourite: patch the shared read in place instead of reading it again. */
  const noteFavoriteWrite = Effect.fnUntraced(function* (trackId: string, value: boolean) {
    favoriteWrite = { trackId, value, deadline: (yield* Clock.currentTimeMillis) + PICK_SETTLE_MS };
    const cached = yield* Cache.getSuccess(librarySnapshot, "library");
    if (Option.isSome(cached) && cached.value.favorited !== null) {
      if (value) cached.value.favorited.add(trackId);
      else cached.value.favorited.delete(trackId);
    }
    favouritesRevision++;
    yield* publishQueue;
  });

  // Per-sample work, about once a second while anyone watches; the watcher run owns the span.
  const update = Effect.fnUntraced(function* (sample: MusicPlayerState, version = sampleVersion) {
    const state = yield* followSample(sample, version);
    if (state === null) return;
    yield* updateLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.set(seekSinceSample, null);
        yield* observeRecent(yield* Ref.get(lastSample), state, now);
        yield* observeFavorite(state, now);
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
      Effect.forever(
        Effect.sleep(STATS_FLUSH_INTERVAL).pipe(
          Effect.andThen(listening.flush),
          Effect.andThen(recent.flush),
        ),
      ),
    ),
    Effect.ensuring(
      Ref.set(lastSample, null).pipe(Effect.andThen(listening.flush), Effect.andThen(recent.flush)),
    ),
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
    Effect.tap((result) =>
      pickLock.withPermits(1)(
        Effect.suspend(() => {
          playlistNames = new Map(
            result.playlists.flatMap((playlist) => {
              const name = sanitizeDisplay({ sourceName: playlist.name }).sourceName;
              return name === undefined ? [] : [[playlist.id, name] as const];
            }),
          );
          const current = queue;
          const source = sourcePlaylistOf(current);
          return current === null || source === null
            ? Effect.void
            : noteSourceName(current.id, source, playlistNames.get(source));
        }),
      ),
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
      const [outcome, index, trackId, shuffleFlag] = result.split(":");
      const id = persistentId(trackId);
      if (outcome === "empty") return;
      if (outcome !== "ok" || id === null) {
        return yield* new MusicError({ operation: "play-playlist", reason: "not-found" });
      }
      sampleVersion++;
      const pick = pickSong(
        input.playlistId,
        id,
        Number(index),
        yield* Clock.currentTimeMillis,
        seed,
        {
          first: null,
        },
      );
      // If Music never took the shuffle, say so; turning it on later keeps this order.
      const next = shuffleFlag === "off" ? { ...pick, shuffled: false } : pick;
      yield* Ref.set(picked, next);
      yield* startQueue(next);
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
    // Music runs its own queue now; T3's stays resumable.
    yield* setPicked(null);
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
    const pick = pickSong(
      input.playlistId,
      input.trackId,
      Number.isInteger(index) ? index : input.index,
      yield* Clock.currentTimeMillis,
      yield* newSeed,
    );
    yield* Ref.set(picked, pick);
    yield* startQueue(pick);
  }, pickLock.withPermits(1));

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

  // One helper at a time, so a slow read never overlaps the next.
  const helperLock = yield* Semaphore.make(1);
  const readNativeQueue = Effect.fn("MusicPlayer.readNativeQueue")(
    function* () {
      if (!supported) {
        return yield* new MusicError({ operation: "native-queue", reason: "unsupported" });
      }
      const unavailable = (cause?: unknown) =>
        new MusicError({ operation: "native-queue", reason: "unavailable", cause });
      const installed = yield* fileSystem
        .exists(options.upNextHelper)
        .pipe(Effect.orElseSucceed(() => false));
      if (!installed) return { _tag: "helper-missing" } satisfies MusicNativeQueue;
      const directory = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-music-up-next-" })
        .pipe(Effect.mapError(unavailable));
      const output = path.join(directory, "queue.json");
      const request = (yield* Effect.all([newSeed, newSeed, newSeed])).join("-");
      // LaunchServices, not a child process, so the helper is responsible for itself.
      const launched = yield* runner
        .run({
          command: "open",
          args: [
            "-g",
            "-n",
            "-W",
            "--env",
            `T3_MUSIC_UP_NEXT_OUT=${output}`,
            "--env",
            `T3_MUSIC_UP_NEXT_REQUEST=${request}`,
            "--env",
            "T3_MUSIC_UP_NEXT_PROMPT=1",
            options.upNextHelper,
          ],
          timeout: NATIVE_QUEUE_LAUNCH_TIMEOUT,
        })
        .pipe(Effect.mapError(unavailable));
      if (launched.code !== 0) return yield* unavailable();
      const info = yield* fileSystem.stat(output).pipe(Effect.mapError(unavailable));
      if (Number(info.size) > MAX_NATIVE_QUEUE_BYTES) return yield* unavailable();
      const answer = yield* fileSystem.readFileString(output).pipe(Effect.mapError(unavailable));
      const raw = Option.getOrNull(decodeRawNativeResponse(answer));
      // Only this request's answer counts.
      if (raw === null || raw.request !== request) return yield* unavailable();
      const queue = parseNativeQueue(raw.read);
      return queue === null ? yield* unavailable() : queue;
    },
    Effect.scoped,
    // The helper runs outside this process; a cancelled request must not free the lock while it
    // still runs. Bounded by the launch timeout and the helper's own 10 s exit. Waiting for the
    // lock stays cancellable.
    Effect.uninterruptible,
    helperLock.withPermits(1),
  );

  const nativeQueueCache = yield* Cache.makeWith((_trackId: string) => readNativeQueue(), {
    capacity: 4,
    timeToLive: () => NATIVE_QUEUE_SHARE,
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
      const outcome =
        current === null
          ? null
          : queue?.active === true && queue.explicit !== null
            ? yield* stepExplicit(current, input._tag)
            : yield* stepPicked(current, input._tag);
      if (outcome !== null && outcome !== "not-found" && outcome !== "changed") return;
    }
    const explicitShuffle =
      input._tag === "set-shuffle" && queue?.active === true && queue.explicit !== null;
    // Off again while a Reset waits for its confirmation only retries the Reset's write.
    const retryReset =
      explicitShuffle &&
      input._tag === "set-shuffle" &&
      !input.enabled &&
      resetAck !== null &&
      !resetAck.confirmed &&
      resetAck.revision === queue?.revision;
    const result = yield* runScript("control", "JavaScript", CONTROL_SCRIPT, controlArgs(input));
    if (input._tag === "set-favorited" && result === "ok") {
      yield* noteFavoriteWrite(input.trackId, input.favorited);
    }
    if (input._tag === "set-shuffle") {
      if (explicitShuffle) {
        if (!retryReset) {
          // A deliberate shuffle on supersedes a pending Reset.
          if (input.enabled) resetAck = null;
          settle = {
            value: input.enabled,
            deadline: (yield* Clock.currentTimeMillis) + PICK_SETTLE_MS,
          };
          if (musicShuffle !== input.enabled) {
            musicShuffle = input.enabled;
            yield* applyToggle(input.enabled);
          }
        }
      } else {
        yield* Ref.update(picked, (current) =>
          current === null
            ? null
            : {
                ...current,
                shuffle: input.enabled ? (current.shuffle ?? { first: current.index }) : null,
                shuffled: input.enabled,
              },
        );
        yield* syncQueue;
      }
      const current = yield* Ref.get(picked);
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

  const queueChanged = () => new MusicError({ operation: "queue", reason: "queue-changed" });

  /** Server-side details for songs a client named by playlist position; null when gone. */
  const readSongs = Effect.fn("MusicPlayer.readQueueSongs")(function* (
    refs: ReadonlyArray<MusicSongRef>,
    sourcePlaylistId: string | null,
  ) {
    const result = yield* runScript(
      "queue",
      "JavaScript",
      SONG_INFO_SCRIPT,
      [songRefsArgument(refs), sourcePlaylistId ?? "none"],
      MAX_QUEUE_OUTPUT_BYTES,
    );
    const raw = Option.getOrNull(decodeRawSongInfo(result));
    if (raw === null || raw.songs.length !== refs.length) {
      return yield* new MusicError({ operation: "queue", reason: "unavailable" });
    }
    const songs = refs.map((ref, i): MusicQueue.QueueSong | null => {
      const info = raw.songs[i];
      if (info === null || info === undefined || persistentId(info.id) !== ref.trackId) return null;
      if (!Number.isInteger(info.index) || info.index < 0) return null;
      return {
        playlistId: ref.playlistId,
        trackId: ref.trackId,
        index: info.index,
        meta: {
          name: text(info.name),
          artist: text(info.artist),
          durationSec: seconds(info.durationSec),
        },
      };
    });
    return { songs, playlistName: raw.playlistName, wraps: raw.wraps };
  });

  /** The whole order STEP_SCRIPT would walk for this pick, checked against the client's read. */
  const materialise = Effect.fn("MusicPlayer.materialiseQueue")(function* (
    state: QueueState,
    pick: PickedSong,
    sourceCount: number,
  ) {
    const result = yield* runScript(
      "queue",
      "JavaScript",
      MATERIALISE_SCRIPT,
      [
        pick.playlistId,
        pick.trackId,
        String(pick.index),
        String(pick.seed),
        shuffleArg(pick.shuffle),
        pick.shuffled ? "on" : "off",
        String(MusicQueue.MAX_QUEUE_ENTRIES),
      ],
      MAX_QUEUE_OUTPUT_BYTES,
    );
    if (result === "too-long") {
      return yield* new MusicError({ operation: "queue", reason: "queue-too-long" });
    }
    const raw = Option.getOrNull(decodeRawMaterialised(result));
    // A playlist that changed size, or moved the current song, is not the one the client read.
    if (
      raw === null ||
      raw.ids.length !== sourceCount ||
      raw.current !== pick.index ||
      raw.sequence.length !== raw.ids.length ||
      raw.ids.some((id) => persistentId(id) === null)
    ) {
      return yield* queueChanged();
    }
    const cursor = raw.sequence.indexOf(raw.current);
    const explicit = MusicQueue.materialise({
      id: state.id,
      revision: state.revision,
      playlistId: pick.playlistId,
      ids: raw.ids,
      sequence: raw.sequence,
      cursor,
      shuffleSeed: raw.shuffled ? pick.seed : null,
    });
    if (!MusicQueue.isConsistent(explicit)) return yield* queueChanged();
    musicShuffle = raw.shuffled;
    return explicit;
  });

  /** Reset turns shuffle off without touching playback; the formula waits for Music to agree. */
  const afterReset = Effect.fn("MusicPlayer.afterQueueReset")(function* (state: QueueState) {
    settle = null;
    const latestState = Option.getOrNull(yield* Ref.get(latest));
    const shuffleOn = musicShuffle ?? (latestState?._tag === "ready" ? latestState.shuffle : false);
    const now = yield* Clock.currentTimeMillis;
    resetAck = {
      id: state.id,
      revision: state.revision,
      confirmed: !shuffleOn,
      deadline: now + PICK_SETTLE_MS,
    };
    if (shuffleOn) {
      yield* runScript("control", "JavaScript", CONTROL_SCRIPT, ["shuffle-off"]).pipe(
        Effect.ignore,
      );
      sampleVersion++;
    } else {
      musicShuffle = false;
      yield* tryHandoff;
    }
  });

  const editQueue = Effect.fn("MusicPlayer.editQueue")(function* (input: MusicEditQueueInput) {
    const current = queue;
    const pick = yield* Ref.get(picked);
    if (
      current === null ||
      !current.active ||
      pick === null ||
      current.id !== input.queueId ||
      current.revision !== input.expectedRevision
    ) {
      return yield* queueChanged();
    }
    let edit: MusicQueue.QueueEdit;
    if (input.edit._tag === "play-next" || input.edit._tag === "add") {
      const { songs } = yield* readSongs(input.edit.songs, null);
      const found = songs.filter((song) => song !== null);
      if (found.length !== songs.length) {
        return yield* new MusicError({ operation: "queue", reason: "not-found" });
      }
      edit = { _tag: input.edit._tag, songs: found };
    } else {
      edit = input.edit;
    }
    let explicit = current.explicit;
    if (explicit === null) {
      if (input.sourceCount === undefined) return yield* queueChanged();
      explicit = yield* materialise(current, pick, input.sourceCount);
    }
    const result = MusicQueue.applyEdit(explicit, current.revision, edit);
    if (result._tag === "queue-changed") return yield* queueChanged();
    if (result._tag === "queue-too-long") {
      return yield* new MusicError({ operation: "queue", reason: "queue-too-long" });
    }
    if (current.explicit === null) yield* Ref.set(picked, { ...pick, shuffle: null });
    const next: QueueState = {
      ...current,
      explicit: result.queue,
      revision: result.queue.revision,
      currentKey: MusicQueue.entryKey(MusicQueue.currentValue(result.queue)),
    };
    yield* commit(next, "body");
    if (edit._tag === "reset") yield* afterReset(next);
    return { id: next.id, revision: next.revision } satisfies MusicQueueRef;
  }, pickLock.withPermits(1));

  const formulaView = Effect.fn("MusicPlayer.formulaQueueView")(function* (
    state: QueueState,
    pick: PickedSong,
  ) {
    const result = yield* runScript(
      "queue",
      "JavaScript",
      FORMULA_QUEUE_SCRIPT,
      [
        pick.playlistId,
        pick.trackId,
        String(pick.index),
        String(pick.seed),
        shuffleArg(pick.shuffle),
        pick.shuffled ? "on" : "off",
        String(QUEUE_PAGE),
      ],
      MAX_QUEUE_OUTPUT_BYTES,
    );
    if (result === "not-found") {
      return yield* new MusicError({ operation: "queue", reason: "not-found" });
    }
    const raw = Option.getOrNull(decodeRawFormulaQueue(result));
    const tracks = raw === null ? [] : playlistTracks(raw.tracks);
    const [head, ...rest] = tracks;
    if (raw === null || head === undefined) {
      return yield* new MusicError({ operation: "queue", reason: "unavailable" });
    }
    yield* pickLock.withPermits(1)(
      noteSourceName(state.id, pick.playlistId, raw.playlistName ?? undefined),
    );
    const entry = (track: MusicPlaylistTrack): MusicQueueEntry => ({
      key: `s${track.index}`,
      trackId: track.id,
      name: track.name,
      artist: track.artist,
      durationSec: track.durationSec,
      unavailable: false,
    });
    return {
      id: state.id,
      revision: state.revision,
      currentKey: `s${head.index}`,
      edited: false,
      sourceName: text(raw.playlistName) || (state.display.sourceName ?? "Playlist"),
      sourceCount: Math.max(0, Math.floor(raw.count)),
      current: entry(head),
      upcoming: rest.map(entry),
      totalUpcoming: Math.max(0, Math.floor(raw.total)),
      wraps: raw.wraps,
      shuffled: raw.shuffled,
    } satisfies MusicQueueView;
  });

  const explicitView = Effect.fn("MusicPlayer.explicitQueueView")(function* (
    state: QueueState,
    explicit: MusicQueue.ExplicitQueue,
  ) {
    const shown = explicit.order
      .slice(explicit.cursor, explicit.cursor + 1 + QUEUE_PAGE)
      .map((value) => ({ value, song: MusicQueue.songForValue(explicit, value)! }));
    const source = explicit.source.kind === "playlist" ? explicit.source.playlistId : null;
    const read = yield* readSongs(
      shown.map(({ song }) => ({
        playlistId: song.playlistId,
        trackId: song.trackId,
        index: song.index,
      })),
      source,
    );
    if (source !== null) {
      yield* pickLock.withPermits(1)(
        noteSourceName(state.id, source, read.playlistName ?? undefined),
      );
    }
    const entries = shown.map(({ value, song }, i): MusicQueueEntry => {
      const key = MusicQueue.entryKey(value);
      const found = read.songs[i] ?? null;
      const meta = song.meta ?? found?.meta ?? null;
      return meta === null
        ? {
            key,
            trackId: song.trackId,
            name: UNAVAILABLE_SONG,
            artist: "",
            durationSec: 0,
            unavailable: true,
          }
        : {
            key,
            trackId: song.trackId,
            name: meta.name,
            artist: meta.artist,
            durationSec: meta.durationSec,
            unavailable: found === null || unavailableKeys.has(key),
          };
    });
    const label =
      explicit.source.kind === "playlist"
        ? text(read.playlistName) || (state.display.sourceName ?? "Playlist")
        : LIST_LABELS[explicit.source.kind];
    return {
      id: state.id,
      revision: state.revision,
      currentKey: state.currentKey,
      edited: true,
      sourceName: label,
      current: entries[0] ?? null,
      upcoming: entries.slice(1),
      totalUpcoming: explicit.order.length - explicit.cursor - 1,
      wraps: read.wraps,
      shuffled: explicit.shuffle !== null,
    } satisfies MusicQueueView;
  });

  const getQueue = Effect.fn("MusicPlayer.getQueue")(function* (input: MusicGetQueueInput) {
    // Read outside the pick lock, so a slow Music never holds up a step; a change since the
    // snapshot publishes a new revision or key and the client reads again.
    const [state, pick] = yield* pickLock.withPermits(1)(
      Effect.all([Effect.sync(() => queue), Ref.get(picked)]),
    );
    if (state === null || !state.active || pick === null || state.id !== input.queueId) {
      return yield* queueChanged();
    }
    return state.explicit === null
      ? yield* formulaView(state, pick)
      : yield* explicitView(state, state.explicit);
  });

  /** The saved entry as a song to play; null when an explicit key no longer names one. */
  const savedSong = (state: QueueState): MusicQueue.QueueSong | null =>
    state.explicit !== null
      ? MusicQueue.songForKey(state.explicit, state.currentKey)
      : state.formula === null
        ? null
        : {
            playlistId: state.formula.playlistId,
            trackId: state.trackId,
            index: Number(state.currentKey.slice(1)),
            meta: null,
          };

  /** A formula queue keeps stepping its own order; an explicit one only needs a pick to follow. */
  const savedPick = (state: QueueState, song: MusicQueue.QueueSong, index: number, now: number) => {
    const formula = state.formula;
    return state.explicit === null && formula !== null
      ? Effect.succeed({
          ...pickSong(
            song.playlistId,
            song.trackId,
            index,
            now,
            formula.seed,
            formulaShuffle(formula),
          ),
          shuffled: formula.shuffled,
        })
      : newSeed.pipe(
          Effect.map((seed) => pickSong(song.playlistId, song.trackId, index, now, seed)),
        );
  };

  /**
   * After a clean restart, a queue T3 still played when the server stopped becomes T3's again without
   * touching Music, but only when the first sample naming a playlist shows that exact entry, once
   * in the queue, from the same playlist, where the last checkpoint left it. Anything else stays
   * a Resume card: the song may be Music's own now.
   */
  const adoptRestored = Effect.fn("MusicPlayer.adoptRestored")(function* (state: MusicPlayerState) {
    const current = queue;
    const mark = restored;
    if (mark === null || current === null) return;
    if (current.active || current.id !== mark.id || current.revision !== mark.revision) {
      restored = null;
      return;
    }
    if (state._tag !== "ready" || state.playback === "stopped" || state.track === null) return;
    // Music can briefly fail to name its playlist; wait for a sample that does.
    if (state.playlistId === null) return;
    restored = null;
    const track = state.track;
    const song = savedSong(current);
    if (song === null || track.id !== current.trackId || state.playlistId !== song.playlistId) {
      return;
    }
    // A song twice in the queue or in its playlist now: Music's position can't say which copy
    // is playing, so nothing short of exactly one of each is taken back. The count only reads.
    const explicit = current.explicit;
    if (
      explicit !== null &&
      explicit.order.filter(
        (value) => MusicQueue.songForValue(explicit, value)?.trackId === track.id,
      ).length !== 1
    ) {
      return;
    }
    const copies = yield* runScript("queue", "JavaScript", COPIES_SCRIPT, [
      song.playlistId,
      track.id,
    ]).pipe(Effect.orElseSucceed(() => "0"));
    if (copies !== "1") return;
    const drift = state.positionSec - current.positionSec;
    const holds =
      state.playback === "paused"
        ? Math.abs(drift) <= ADOPT_PAUSED_DRIFT_SECONDS
        : drift >= -ADOPT_PAUSED_DRIFT_SECONDS && drift <= ADOPT_PLAYING_DRIFT_SECONDS;
    if (!holds) return;
    const now = yield* Clock.currentTimeMillis;
    const pick = yield* savedPick(current, song, song.index, now);
    yield* Ref.set(picked, {
      ...pick,
      seen: true,
      musicPlaylistId: state.playlistId,
      positionSec: state.positionSec,
      durationSec: track.durationSec,
    });
    forgetPending();
    unavailableKeys = new Set();
    lastPlayback = state.playback;
    yield* commit({ ...current, active: true, positionSec: state.positionSec }, "position");
  });

  /** Plays the saved entry where it was. Used by Resume and by replacement Undo. */
  const resumeSaved = Effect.fn("MusicPlayer.resumeSaved")(function* (state: QueueState) {
    restored = null;
    const song = savedSong(state);
    if (song === null) return yield* queueChanged();
    // The saved index first, then the song by id if the playlist moved it; never another song.
    const result = yield* runScript("queue", "JavaScript", PLAY_TRACK_SCRIPT, [
      song.playlistId,
      song.trackId,
      String(song.index),
    ]);
    if (result === "not-found") {
      yield* commit({ ...state, sourceMissing: true }, "none");
      return yield* new MusicError({ operation: "queue", reason: "not-found" });
    }
    sampleVersion++;
    const played = Number(result.split(":")[1]);
    const index = Number.isInteger(played) ? played : song.index;
    const now = yield* Clock.currentTimeMillis;
    const pick = yield* savedPick(state, song, index, now);
    const durationSec = song.meta?.durationSec ?? 0;
    const wanted =
      state.positionSec > RESUME_MIN_SECONDS &&
      (durationSec === 0 || state.positionSec < durationSec - RESUME_TAIL_SECONDS);
    const placed = yield* runScript("control", "JavaScript", CONTROL_SCRIPT, [
      "seek-before-end",
      String(state.positionSec),
      String(RESUME_TAIL_SECONDS),
      song.trackId,
      song.playlistId,
      wanted ? "seek" : "check",
    ]);
    // Music moved on before Resume could seek: that song is someone else's; the queue stays saved.
    if (placed === "changed") return yield* queueChanged();
    forgetPending();
    unavailableKeys = new Set();
    const seek = placed === "ok";
    if (seek) yield* Ref.set(seekSinceSample, { positionSec: state.positionSec, atMs: now });
    yield* Ref.set(picked, seek ? { ...pick, positionSec: state.positionSec } : pick);
    yield* commit(
      {
        ...state,
        active: true,
        sourceMissing: false,
        currentKey: state.explicit === null ? `s${index}` : state.currentKey,
        positionSec: seek ? state.positionSec : 0,
      },
      "position",
    );
  });

  const savedQueue = (input: MusicSavedQueueInput) =>
    Effect.suspend(() => {
      const current = queue;
      return current === null ||
        current.active ||
        current.id !== input.queueId ||
        current.revision !== input.revision
        ? Effect.fail(queueChanged())
        : Effect.succeed(current);
    });

  const resumeQueue = Effect.fn("MusicPlayer.resumeQueue")(function* (input: MusicSavedQueueInput) {
    yield* resumeSaved(yield* savedQueue(input));
  }, pickLock.withPermits(1));

  const dismissSavedQueue = Effect.fn("MusicPlayer.dismissSavedQueue")(function* (
    input: MusicSavedQueueInput,
  ) {
    yield* savedQueue(input);
    queue = null;
    yield* store.clear;
    yield* publishQueue;
  }, pickLock.withPermits(1));

  const undoReplace = Effect.fn("MusicPlayer.undoReplace")(function* (
    input: MusicUndoReplaceInput,
  ) {
    const hold = replaced;
    if (
      hold === null ||
      hold.info.replacedId !== input.replacedId ||
      hold.info.replacedRevision !== input.replacedRevision ||
      hold.info.byId !== input.byId ||
      hold.info.byRevision !== input.byRevision
    ) {
      return yield* queueChanged();
    }
    const current = queue;
    const now = yield* Clock.currentTimeMillis;
    yield* clearReplaced;
    if (
      now >= hold.info.expiresAt ||
      current === null ||
      !current.active ||
      current.id !== hold.info.byId ||
      current.revision !== hold.info.byRevision
    ) {
      yield* publishQueue;
      return yield* queueChanged();
    }
    // The held body and position land in one writer turn, never the replacement's position.
    forgetPending();
    yield* commit(hold.held, "body");
    yield* resumeSaved(hold.held);
    return { id: hold.held.id, revision: hold.held.revision } satisfies MusicQueueRef;
  }, pickLock.withPermits(1));

  const listOperation = (source: MusicPlayListInput["source"]) =>
    source === "favourites" ? ("favorites" as const) : ("recent" as const);

  /** The list as the server holds it now, by library position; rows gone from it are left out. */
  const listSongs = Effect.fn("MusicPlayer.listSongs")(function* (
    source: MusicPlayListInput["source"],
  ) {
    const operation = listOperation(source);
    const snapshot = yield* library(operation);
    const meta = (song: MusicLibrarySong) => ({
      name: song.name,
      artist: song.artist,
      durationSec: song.durationSec,
    });
    if (source === "favourites") {
      const favorited = snapshot.favorited;
      if (favorited === null) return yield* new MusicError({ operation, reason: "unavailable" });
      return snapshot.entries.flatMap(({ song }): Array<MusicQueue.QueueSong> =>
        favorited.has(song.id)
          ? [
              {
                playlistId: snapshot.playlistId,
                trackId: song.id,
                index: song.index,
                meta: meta(song),
              },
            ]
          : [],
      );
    }
    return (yield* recent.list).flatMap((row): Array<MusicQueue.QueueSong> => {
      const entry = snapshot.byId.get(row.trackId);
      return entry === undefined
        ? []
        : [
            {
              playlistId: snapshot.playlistId,
              trackId: row.trackId,
              index: entry.song.index,
              meta: { name: row.name, artist: row.artist, durationSec: row.durationSec },
            },
          ];
    });
  });

  /** Plays a row of Favourites or Recently played and carries on through that list. */
  const playList = Effect.fn("MusicPlayer.playList")(function* (input: MusicPlayListInput) {
    const operation = listOperation(input.source);
    const original = yield* listSongs(input.source);
    if (original.length > MusicQueue.MAX_QUEUE_ENTRIES) {
      return yield* new MusicError({ operation: "queue", reason: "queue-too-long" });
    }
    const latestState = Option.getOrNull(yield* Ref.get(latest));
    // Like a playlist, an omitted shuffle follows Music's setting; Music's own flag is not written.
    const shuffle =
      input.shuffle ??
      (latestState?._tag === "ready" && latestState.playback !== "stopped" && latestState.shuffle);
    const start =
      input.startTrackId === null
        ? shuffle && original.length > 0
          ? yield* Random.nextIntBetween(0, original.length - 1)
          : 0
        : original.findIndex((song) => song.trackId === input.startTrackId);
    const first = original[start];
    if (first === undefined) return yield* new MusicError({ operation, reason: "not-found" });
    const result = yield* runScript(operation, "JavaScript", PLAY_TRACK_SCRIPT, [
      first.playlistId,
      first.trackId,
      String(first.index),
    ]);
    if (result === "not-found") return yield* new MusicError({ operation, reason: "not-found" });
    sampleVersion++;
    const played = Number(result.split(":")[1]);
    const seed = yield* newSeed;
    const pick = pickSong(
      first.playlistId,
      first.trackId,
      Number.isInteger(played) ? played : first.index,
      yield* Clock.currentTimeMillis,
      seed,
    );
    yield* Ref.set(picked, pick);
    yield* startQueue(pick, (id) =>
      MusicQueue.fromList({
        id,
        kind: input.source,
        original,
        start,
        shuffleSeed: shuffle ? seed : null,
      }),
    );
  }, pickLock.withPermits(1));

  const listFavorites = Effect.fn("MusicPlayer.listFavorites")(function* (
    input: MusicListFavoritesInput,
  ) {
    const page = listFavoriteSongs(yield* library("favorites"), input);
    if (page === null) {
      return yield* new MusicError({ operation: "favorites", reason: "unavailable" });
    }
    return page;
  });

  const setTrackFavorited = Effect.fn("MusicPlayer.setTrackFavorited")(function* (
    input: MusicSetTrackFavoritedInput,
  ) {
    const result = yield* runScript("favorites", "JavaScript", FAVORITE_TRACK_SCRIPT, [
      input.trackId,
      String(input.favorited),
    ]);
    if (result !== "ok") {
      return yield* new MusicError({ operation: "favorites", reason: "not-found" });
    }
    yield* noteFavoriteWrite(input.trackId, input.favorited);
  });

  const listRecent = Effect.fn("MusicPlayer.listRecent")(function* (input: MusicListRecentInput) {
    const songs = yield* recent.list;
    // Rows show without the library; they only need it to play.
    const snapshot =
      songs.length === 0 ? null : Option.getOrNull(yield* Effect.option(library("recent")));
    return {
      playlistId: snapshot?.playlistId ?? null,
      songs: songs.slice(input.offset, input.offset + input.limit).map((song) => ({
        ...song,
        index: snapshot?.byId.get(song.trackId)?.song.index ?? null,
      })),
      total: songs.length,
    } satisfies MusicRecent;
  });

  const clearRecent = recent.clear.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        recentRevision++;
        return publishQueue;
      }),
    ),
    Effect.withSpan("MusicPlayer.clearRecent"),
  );

  return MusicPlayer.of({
    stateStream,
    listPlaylists,
    playPlaylist,
    listTracks,
    playTrack,
    searchLibrary,
    upNext,
    // Keyed by song, so a song change never gets the previous song's snapshot.
    nativeQueue: Effect.fn("MusicPlayer.nativeQueue")(function* (input: MusicNativeQueueInput) {
      return yield* Cache.get(nativeQueueCache, input.trackId ?? "none");
    }),
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
    queueStream: SubscriptionRef.changes(queueStatus),
    getQueue,
    editQueue,
    undoReplace,
    resumeQueue,
    dismissSavedQueue,
    playList,
    listFavorites,
    setTrackFavorited,
    listRecent,
    clearRecent: supported
      ? clearRecent
      : Effect.fail(new MusicError({ operation: "recent", reason: "unsupported" })),
  });
});

export const layerWith = (options: { readonly upNextHelper: string }) =>
  Layer.effect(MusicPlayer, make(options));

export const layer = Layer.effect(
  MusicPlayer,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return yield* make({
      upNextHelper: path.join(NodeOS.homedir(), "Applications", "T3 Music Up Next.app"),
    });
  }),
);
