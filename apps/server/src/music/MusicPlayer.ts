import {
  MusicError,
  type MusicArtwork,
  type MusicAgentCue,
  type MusicArtworkInput,
  type MusicControlInput,
  type MusicListTracksInput,
  type MusicPlayerState,
  type MusicPlaylists,
  type MusicPlaylistTracks,
  type MusicPlayPlaylistInput,
  type MusicPlayTrackInput,
  type MusicStats,
  type MusicStatsInput,
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
    readonly control: (input: MusicControlInput) => Effect.Effect<void, MusicError>;
    readonly artwork: (input: MusicArtworkInput) => Effect.Effect<MusicArtwork, MusicError>;
    readonly stats: (input: MusicStatsInput) => Effect.Effect<MusicStats, MusicError>;
    /** Agent requests drive the cue; working projects attribute listening time. */
    readonly observeAgents: (activity: AgentActivity, cue: MusicAgentCue) => Effect.Effect<void>;
  }
>()("t3/music/MusicPlayer") {}

export interface AgentActivity {
  /** Open approval and question requests across unarchived threads. */
  readonly requestIds: ReadonlySet<string>;
  readonly workingProjectIds: ReadonlySet<string>;
  /** The first report after startup: its requests predate this run and never trigger the cue. */
  readonly initial: boolean;
}

type CueApplied =
  | { readonly kind: "lower-volume"; readonly from: number; readonly to: number }
  | { readonly kind: "pause" };

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
  initial: boolean,
): { readonly next: CueState; readonly step: "apply" | "restore" | null } {
  const fresh = initial ? [] : [...requestIds].filter((id) => !state.known.has(id));
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
  if (result === "paused") return { kind: "pause" };
  const lowered = /^lowered (\d+) (\d+)$/.exec(result);
  return lowered === null
    ? null
    : { kind: "lower-volume", from: Number(lowered[1]), to: Number(lowered[2]) };
}

// Scripts are fixed text. Anything from a request reaches them only as osascript argv.

// Sending Music an Apple event registers osascript as a foreground app, which puts a
// second T3 Code icon in the Dock. Declaring no UI first keeps it background-only;
// ARTWORK_SCRIPT does the same inside its run handler.
const JXA_NO_DOCK_ICON = `ObjC.import("AppKit");
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

// A song can appear more than once, so it is found by position, checked against its id.
const PLAY_TRACK_SCRIPT = `function run(argv) {
  const found = Application("Music").playlists.whose({ persistentID: argv[0] })();
  if (found.length === 0) return "not-found";
  const tracks = found[0].tracks;
  const ids = tracks.persistentID();
  const index = Number(argv[2]);
  const target = ids[index] === argv[1] ? index : ids.indexOf(argv[1]);
  if (target < 0) return "not-found";
  tracks[target].play();
  return "ok";
}`;

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
    case "pause":
      if (Music.playerState() !== "playing") return "none";
      Music.pause();
      return "paused";
    case "restore-volume":
      // A volume the user changed meanwhile stays.
      if (Math.abs(Music.soundVolume() - Number(argv[2])) <= 1) Music.soundVolume = Number(argv[1]);
      return "ok";
    case "resume":
      if (Music.playerState() === "paused") Music.play();
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

const text = (value: string | null | undefined) => (value ?? "").slice(0, MAX_TEXT);
const seconds = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
const persistentId = (value: string | null | undefined) =>
  value !== undefined && value !== null && PERSISTENT_ID.test(value) ? value : null;

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
    JSON.stringify(before.track) !== JSON.stringify(next.track)
  ) {
    return true;
  }
  const expected =
    before.positionSec +
    (before.playback === "playing" ? Math.max(0, nowMs - previous.atMs) / 1000 : 0);
  return Math.abs(next.positionSec - expected) > POSITION_DRIFT_SECONDS;
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
  const workingProjectIds = yield* Ref.make<ReadonlySet<string>>(new Set());
  const cueState = yield* Ref.make<CueState>(INITIAL_CUE_STATE);
  const cueLock = yield* Semaphore.make(1);

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

  // Per-sample work, about once a second while anyone watches; the watcher run owns the span.
  const update = Effect.fnUntraced(function* (state: MusicPlayerState) {
    yield* updateLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* creditSample(state, now);
        yield* Ref.set(latest, Option.some(state));
        if (!musicStateChanged(yield* Ref.get(lastEmitted), state, now)) return;
        yield* Ref.set(lastEmitted, { state, atMs: now });
        yield* PubSub.publish(states, state);
      }),
    );
  });

  const runWatcherOnce = Effect.fn("MusicPlayer.watch")(function* () {
    const lines = yield* Queue.unbounded<string>();
    const split = makeLineSplitter((line) => {
      Queue.offerUnsafe(lines, line);
    });
    const consume = Effect.forever(
      Queue.take(lines).pipe(
        Effect.flatMap((line) => {
          const state = decodeWatchLine(line);
          return state === null ? Effect.void : update(state);
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
    const shuffle =
      input.shuffle === undefined ? "keep" : input.shuffle ? "shuffle-on" : "shuffle-off";
    const result = yield* runScript("play-playlist", "JavaScript", PLAY_SCRIPT, [
      input.playlistId,
      shuffle,
    ]);
    if (result === "not-found") {
      return yield* new MusicError({ operation: "play-playlist", reason: "not-found" });
    }
  });

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
      tracks: raw.tracks.flatMap((track) => {
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
      }),
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
    yield* runScript("control", "JavaScript", CONTROL_SCRIPT, controlArgs(input));
  });

  const applyCue = Effect.fn("MusicPlayer.applyCue")(function* (cue: "lower-volume" | "pause") {
    const result = yield* runScript("control", "JavaScript", CUE_SCRIPT, [cue, CUE_VOLUME_FACTOR]);
    return parseCueResult(result);
  });

  const restoreCue = Effect.fn("MusicPlayer.restoreCue")(function* (applied: CueApplied) {
    yield* runScript(
      "control",
      "JavaScript",
      CUE_SCRIPT,
      applied.kind === "pause"
        ? ["resume"]
        : ["restore-volume", String(applied.from), String(applied.to)],
    );
  });

  const observeAgents = Effect.fn("MusicPlayer.observeAgents")(function* (
    activity: AgentActivity,
    cue: MusicAgentCue,
  ) {
    yield* Ref.set(workingProjectIds, activity.workingProjectIds);
    if (!supported) return;
    yield* cueLock.withPermits(1)(
      Effect.gen(function* () {
        const { next, step } = planCue(
          yield* Ref.get(cueState),
          activity.requestIds,
          activity.initial,
        );
        let applied = next.applied;
        if (step === "apply" && cue !== "off") {
          applied = yield* applyCue(cue).pipe(Effect.orElseSucceed(() => null));
        } else if (step === "restore" && applied !== null) {
          yield* restoreCue(applied).pipe(Effect.ignore);
          applied = null;
        }
        yield* Ref.set(cueState, { ...next, applied });
      }),
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
    control,
    artwork,
    stats: Effect.fn("MusicPlayer.stats")(function* (input: MusicStatsInput) {
      if (!supported) return yield* new MusicError({ operation: "stats", reason: "unsupported" });
      return yield* listening.summary(input);
    }),
    observeAgents,
  });
});

export const layer = Layer.effect(MusicPlayer, make);
