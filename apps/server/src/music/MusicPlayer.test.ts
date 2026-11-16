import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type MusicPlayerState, type MusicQueueStatus, ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import * as MusicListeningStats from "./MusicListeningStats.ts";
import * as MusicPlayer from "./MusicPlayer.ts";
import * as MusicQueueStore from "./MusicQueueStore.ts";
import * as MusicRecent from "./MusicRecent.ts";

const output = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const DENIED = output({
  code: ChildProcessSpawner.ExitCode(1),
  stderr: "execution error: Error: Not authorized to send Apple events to Music. (-1743)",
});

const sampleLine = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    running: true,
    state: "paused",
    shuffle: false,
    track: {
      id: "3BA40D4A07B97011",
      name: "Song",
      artist: "Artist",
      album: "Album",
      duration: 200,
    },
    position: 10,
    playlistId: "5CA38D01224697B3",
    ...overrides,
  });

interface WatchSession {
  readonly emit: (line: string) => void;
  readonly exit: (result: ProcessRunner.ProcessRunOutput) => Effect.Effect<void>;
  readonly interrupted: Deferred.Deferred<void>;
}

const makeHarness = Effect.fn("makeHarness")(function* (options?: {
  readonly respond?: (args: ReadonlyArray<string>) => Effect.Effect<ProcessRunner.ProcessRunOutput>;
}) {
  const sessions = yield* Queue.unbounded<WatchSession>();
  const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([]);
  const encoder = new TextEncoder();
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        const onStdoutChunk = input.onStdoutChunk;
        if (onStdoutChunk === undefined) {
          yield* Ref.update(calls, (all) => [...all, [input.command, ...input.args]]);
          return yield* (
            options?.respond?.([input.command, ...input.args]) ?? Effect.succeed(output())
          );
        }
        const result = yield* Deferred.make<ProcessRunner.ProcessRunOutput>();
        const interrupted = yield* Deferred.make<void>();
        yield* Queue.offer(sessions, {
          emit: (line) => onStdoutChunk(encoder.encode(`${line}\n`)),
          exit: (value) => Deferred.succeed(result, value).pipe(Effect.asVoid),
          interrupted,
        });
        return yield* Deferred.await(result).pipe(
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        );
      }),
  });
  return { sessions, calls, runner };
});

const providePlayer = (
  runner: ProcessRunner.ProcessRunner["Service"],
  platform: NodeJS.Platform = "darwin",
  upNextHelper = "/nonexistent/T3 Music Up Next.app",
  queueStore: Layer.Layer<MusicQueueStore.MusicQueueStore> = MusicQueueStore.layerMemory(),
  recent: Layer.Layer<MusicRecent.MusicRecent> = MusicRecent.layerMemory(),
) =>
  Effect.provide(
    MusicPlayer.layerWith({ upNextHelper }).pipe(
      Layer.provideMerge(queueStore),
      Layer.provide(recent),
      Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
      Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
      Layer.provide(MusicListeningStats.layerMemory),
      Layer.provide(NodeServices.layer),
    ),
  );

const subscribe = Effect.fn("subscribe")(function* (player: MusicPlayer.MusicPlayer["Service"]) {
  const received = yield* Queue.unbounded<MusicPlayerState>();
  const fiber = yield* player.stateStream.pipe(
    Stream.runForEach((state) => Queue.offer(received, state)),
    Effect.forkScoped,
  );
  return { received, fiber };
});

const LIBRARY_ID = "0000000000000005";
const PLAYLIST_ID = "5CA38D01224697B3";
const SONG_A = "3BA40D4A07B97011";
const SONG_B = "DD038AB38CFE38BB";
const SONG_C = "1111222233334444";
const VIDEO = "9999999999999999";

interface FakeSong {
  readonly id: string;
  readonly kind?: string;
  /** Left out everywhere, the library has no favourite column, like a Music that can't say. */
  readonly favorited?: boolean;
}

/** A Music app for scripts run in a VM. Like the real one, library `tracks[i]` is not bulk entry i. */
function fakeMusic(lists: Record<string, ReadonlyArray<FakeSong>>) {
  const played: Array<string> = [];
  const player = {
    position: 10,
    state: "playing",
    shuffle: false,
    repeat: "off",
    current: "",
    playlist: null as string | null,
    /** How many playerState reads a started song stays starting, like a streamed song. */
    startDelayReads: 0,
    startReads: 0,
  };
  // Without `once`, real Music carries on by itself after the song, so such a play is marked.
  const start = (
    playlistId: string,
    songId: string,
    label: string,
    options?: { once?: boolean },
  ) => {
    played.push(options?.once === true ? label : `${label} (carries on)`);
    player.current = songId;
    player.playlist = playlistId;
    // Like real Music, a started song reports playing only once it has begun.
    player.state = "starting";
    player.startReads = player.startDelayReads;
  };
  const playlist = (id: string, songs: ReadonlyArray<FakeSong>) => {
    const column = (pick: (song: FakeSong) => unknown) => () => songs.map(pick);
    const shifted = (i: number) => songs[id === LIBRARY_ID ? (i + 1) % songs.length : i]!;
    const tracks = Object.assign(
      // A specifier play records its row, so a repeated song's copies stay apart.
      songs.map((_, i) => ({
        play: (options?: { once?: boolean }) =>
          start(id, shifted(i).id, `${shifted(i).id}#${i}`, options),
      })),
      {
        persistentID: column((song) => song.id),
        mediaKind: column((song) => song.kind ?? "song"),
        name: column((song) => `name ${song.id}`),
        artist: column(() => "Artist"),
        album: column(() => "Album"),
        duration: column(() => 200),
        ...(songs.some((song) => song.favorited !== undefined)
          ? { favorited: column((song) => song.favorited === true) }
          : {}),
        whose: (query: { readonly persistentID: string }) => () =>
          songs
            .filter((song) => song.id === query.persistentID)
            .map((song) => ({
              play: (options?: { once?: boolean }) => start(id, song.id, song.id, options),
            })),
      },
    );
    return {
      persistentID: () => id,
      name: () => (id === LIBRARY_ID ? "Library" : "Mix"),
      tracks,
      play: () => played.push(`playlist ${id}`),
    };
  };
  const all = new Map(Object.entries(lists).map(([id, songs]) => [id, playlist(id, songs)]));
  const music = {
    running: () => true,
    playerState: () => {
      if (player.state === "starting" && player.startReads-- <= 0) player.state = "playing";
      return player.state;
    },
    get playerPosition() {
      return () => player.position;
    },
    // Scripts assign the setting and call the same name to read it.
    set playerPosition(value: unknown) {
      player.position = Number(value);
    },
    // Stopped, real Music reads its shuffle setting as off.
    get shuffleEnabled() {
      return () => player.state !== "stopped" && player.shuffle;
    },
    // Real Music ignores a shuffle change until a song is playing.
    set shuffleEnabled(value: unknown) {
      if (player.state === "playing") player.shuffle = value === true;
    },
    songRepeat: () => player.repeat,
    soundVolume: () => 50,
    pause: () => {
      player.state = "paused";
    },
    play: () => {
      player.state = "playing";
    },
    currentTrack: { persistentID: () => player.current },
    currentPlaylist: { persistentID: () => player.playlist },
    stop: () => {
      played.push("stop");
      player.state = "stopped";
    },
    nextTrack: () => played.push("music next"),
    backTrack: () => played.push("music previous"),
    libraryPlaylists: [all.get(LIBRARY_ID) ?? playlist(LIBRARY_ID, [])],
    playlists: {
      whose: (query: { readonly persistentID: string }) => () => {
        const found = all.get(query.persistentID);
        return found === undefined ? [] : [found];
      },
    },
  };
  return { music, played, player };
}

/** Runs the script osascript was given against a fake Music app. */
const runFakeScript = (args: ReadonlyArray<string>, music: unknown) =>
  Effect.sync(() => {
    const script = args[4]!;
    const result: unknown = NodeVM.runInNewContext(
      `${script.slice(MusicPlayer.JXA_NO_DOCK_ICON.length)}; run(argv)`,
      { Application: () => music, argv: args.slice(5), delay: () => {} },
    );
    return output({ stdout: String(result) });
  });

describe("decodeWatchLine", () => {
  it("maps watcher samples to player states", () => {
    assert.deepStrictEqual(MusicPlayer.decodeWatchLine('{"running":false}'), {
      _tag: "not-running",
    });
    assert.deepStrictEqual(
      MusicPlayer.decodeWatchLine(
        sampleLine({
          state: "fast forwarding",
          volume: 62.4,
          repeat: "one",
          track: {
            id: "3BA40D4A07B97011",
            name: "Song",
            artist: "Artist",
            album: "Album",
            duration: 200,
            favorited: true,
          },
        }),
      ),
      {
        _tag: "ready",
        playback: "playing",
        track: {
          id: "3BA40D4A07B97011",
          name: "Song",
          artist: "Artist",
          album: "Album",
          durationSec: 200,
          favorited: true,
        },
        positionSec: 10,
        shuffle: false,
        playlistId: "5CA38D01224697B3",
        volume: 62,
        repeat: "one",
      },
    );
    const odd = MusicPlayer.decodeWatchLine(
      sampleLine({
        track: { id: "not-an-id" },
        position: null,
        playlistId: "x",
        volume: null,
        repeat: "sometimes",
      }),
    );
    assert.deepStrictEqual(
      odd?._tag === "ready"
        ? [odd.track, odd.positionSec, odd.playlistId, odd.volume, odd.repeat]
        : odd,
      [null, 0, null, undefined, undefined],
    );
    assert.strictEqual(MusicPlayer.decodeWatchLine("osascript noise"), null);
  });
});

describe("musicStateChanged", () => {
  const ready = (overrides: Partial<Extract<MusicPlayerState, { _tag: "ready" }>> = {}) =>
    ({
      _tag: "ready",
      playback: "playing",
      track: { id: "3BA40D4A07B97011", name: "A", artist: "B", album: "C", durationSec: 200 },
      positionSec: 10,
      shuffle: false,
      playlistId: null,
      ...overrides,
    }) satisfies MusicPlayerState;

  it.each([
    ["first state", null, ready(), 0, true],
    ["tag change", { state: { _tag: "not-running" }, atMs: 0 }, ready(), 0, true],
    [
      "same tag without fields",
      { state: { _tag: "not-running" }, atMs: 0 },
      { _tag: "not-running" },
      0,
      false,
    ],
    ["playing on schedule", { state: ready(), atMs: 0 }, ready({ positionSec: 15 }), 5_000, false],
    ["seek while playing", { state: ready(), atMs: 0 }, ready({ positionSec: 60 }), 5_000, true],
    ["volume changed", { state: ready({ volume: 50 }), atMs: 0 }, ready({ volume: 20 }), 0, true],
    [
      "repeat changed",
      { state: ready({ repeat: "off" }), atMs: 0 },
      ready({ repeat: "all" }),
      0,
      true,
    ],
    [
      "paused does not advance",
      { state: ready({ playback: "paused" }), atMs: 0 },
      ready({ playback: "paused" }),
      60_000,
      false,
    ],
    [
      "paused then seek",
      { state: ready({ playback: "paused" }), atMs: 0 },
      ready({ playback: "paused", positionSec: 30 }),
      1_000,
      true,
    ],
    [
      "shuffle toggled",
      { state: ready(), atMs: 0 },
      ready({ shuffle: true, positionSec: 10 }),
      0,
      true,
    ],
    [
      "track changed",
      { state: ready(), atMs: 0 },
      ready({ track: null, positionSec: 10 }),
      0,
      true,
    ],
    [
      "T3 moved to another position in the playlist",
      { state: ready({ playingFrom: { playlistId: "5CA38D01224697B3", index: 2 } }), atMs: 0 },
      ready({ playingFrom: { playlistId: "5CA38D01224697B3", index: 4 } }),
      0,
      true,
    ],
    [
      "favorited",
      { state: ready(), atMs: 0 },
      ready({
        track: {
          id: "3BA40D4A07B97011",
          name: "A",
          artist: "B",
          album: "C",
          durationSec: 200,
          favorited: true,
        },
      }),
      0,
      true,
    ],
  ] as const)("%s", (_name, previous, next, nowMs, expected) => {
    assert.strictEqual(MusicPlayer.musicStateChanged(previous, next, nowMs), expected);
  });
});

describe("followPickedSong", () => {
  const SONG = "3BA40D4A07B97011";
  const fresh = MusicPlayer.pickSong("5CA38D01224697B3", SONG, 2, 0, 7);
  const seen = { ...fresh, seen: true, positionSec: 100, durationSec: 200 };
  const nearEnd = { ...seen, positionSec: 197 };
  const sample = (overrides: Partial<Extract<MusicPlayerState, { _tag: "ready" }>> = {}) =>
    ({
      _tag: "ready",
      playback: "playing",
      track: { id: SONG, name: "A", artist: "B", album: "C", durationSec: 200 },
      positionSec: 101,
      shuffle: false,
      playlistId: "5CA38D01224697B3",
      repeat: "off",
      ...overrides,
    }) satisfies MusicPlayerState;
  const other = { id: "DD038AB38CFE38BB", name: "X", artist: "Y", album: "Z", durationSec: 90 };
  const stopped = sample({ playback: "stopped", track: null, positionSec: 0 });

  it.each([
    [
      "the old song plays on while Music switches",
      fresh,
      sample({ track: other }),
      1_000,
      "follow",
    ],
    ["the gap before the picked song starts", fresh, stopped, 1_000, "hidden"],
    [
      "another song after Music had time to switch",
      fresh,
      sample({ track: other }),
      6_000,
      "drop:never-started",
    ],
    ["the picked song playing", seen, sample(), 0, "follow"],
    ["Music stopped at the end of the song", nearEnd, stopped, 0, "advance"],
    ["Music stopped mid-song", seen, stopped, 0, "follow"],
    ["someone played another song", seen, sample({ track: other }), 0, "drop:other-song"],
    [
      "Music played the same song from another playlist",
      { ...seen, musicPlaylistId: "5CA38D01224697B3" },
      sample({ playlistId: "AAAAAAAAAAAAAAAA" }),
      0,
      "drop:other-playlist",
    ],
    [
      "repeat all looped the lone song",
      nearEnd,
      sample({ positionSec: 1, repeat: "all" }),
      0,
      "advance",
    ],
    ["repeat one looped the song", nearEnd, sample({ positionSec: 1, repeat: "one" }), 0, "follow"],
    ["watcher unavailable", seen, { _tag: "unavailable" }, 0, "follow"],
    ["permission temporarily denied", seen, { _tag: "permission-denied" }, 0, "follow"],
    ["Music quit", seen, { _tag: "not-running" }, 0, "drop:music-quit"],
  ] as const)("%s", (_name, picked, state, nowMs, expected) => {
    const update = MusicPlayer.followPickedSong(picked, state, nowMs);
    const outcome =
      update._tag === "drop"
        ? `drop:${update.reason}`
        : update._tag === "follow" && update.hide
          ? "hidden"
          : update._tag;
    assert.strictEqual(outcome, expected);
  });

  it("starts T3's order when Music's shuffle turns on, from the current song", () => {
    const shuffleOf = (picked: MusicPlayer.PickedSong, state: MusicPlayerState) => {
      const update = MusicPlayer.followPickedSong(picked, state, 0);
      return update._tag === "follow" ? update.picked.shuffle : "no follow";
    };
    assert.deepStrictEqual(shuffleOf(seen, sample({ shuffle: true })), { first: 2 });
    assert.deepStrictEqual(shuffleOf(seen, sample({ shuffle: true, playback: "paused" })), {
      first: 2,
    });
    // A later song in the same shuffle keeps its order's start.
    const later = { ...seen, index: 5, shuffle: { first: 2 } };
    assert.deepStrictEqual(shuffleOf(later, sample({ shuffle: true })), { first: 2 });
    // A sample may have read the flag before a change, so it never clears the order, only the mode.
    assert.deepStrictEqual(shuffleOf(later, sample({ shuffle: false })), { first: 2 });
    const off = MusicPlayer.followPickedSong(later, sample({ shuffle: false }), 0);
    assert.strictEqual(off._tag === "follow" && off.picked.shuffled, false);
    assert.strictEqual(shuffleOf(seen, sample({ shuffle: false })), null);
  });

  it("learns Music's playlist only once the pick has settled", () => {
    const early = MusicPlayer.followPickedSong(
      fresh,
      sample({ playlistId: "AAAAAAAAAAAAAAAA" }),
      1_000,
    );
    assert.strictEqual(early._tag, "follow");
    if (early._tag !== "follow") return;
    const settled = MusicPlayer.followPickedSong(early.picked, sample(), 6_000);
    assert.strictEqual(
      settled._tag === "follow" && settled.picked.musicPlaylistId,
      fresh.playlistId,
    );
  });
});

describe("MusicPlayer", () => {
  it.effect("moves a picked song on through its playlist", () =>
    Effect.gen(function* () {
      const playlistId = "5CA38D01224697B3";
      const first = "3BA40D4A07B97011";
      const second = "DD038AB38CFE38BB";
      const steps = yield* Queue.unbounded<ReadonlyArray<string>>();
      const { calls, sessions, runner } = yield* makeHarness({
        respond: (args) => {
          const tail = args.slice(5);
          if (tail.length !== 9) return Effect.succeed(output({ stdout: "ok:2\n" }));
          return Queue.offer(steps, tail).pipe(
            Effect.as(output({ stdout: `ok:${Number(tail[2]) + 1}:${second}\n` })),
          );
        },
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId, trackId: first, index: 2 });

        session.emit(sampleLine({ state: "playing", position: 197 }));
        const playing = yield* Queue.take(received);
        assert.deepStrictEqual(playing._tag === "ready" && playing.playingFrom, {
          playlistId,
          index: 2,
        });
        session.emit(sampleLine({ state: "stopped", track: null, position: 0 }));
        const transition = yield* Queue.take(steps).pipe(
          Effect.map((args) => ({ _tag: "step" as const, args })),
          Effect.raceFirst(
            Queue.take(received).pipe(Effect.map((state) => ({ _tag: "state" as const, state }))),
          ),
        );
        assert.strictEqual(transition._tag, "step");
        if (transition._tag === "step")
          assert.deepStrictEqual(transition.args.slice(0, 4), [playlistId, first, "2", "advance"]);

        // The stop between songs never reaches clients; the next song does.
        session.emit(sampleLine({ state: "playing", track: { id: second, name: "Next" } }));
        const next = yield* Queue.take(received);
        assert.strictEqual(next._tag === "ready" && next.track?.id, second);
        assert.deepStrictEqual(next._tag === "ready" && next.playingFrom, { playlistId, index: 3 });

        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual((yield* Queue.take(steps)).slice(0, 4), [
          playlistId,
          second,
          "3",
          "next",
        ]);

        // A whole playlist plays as Music's own queue again.
        yield* player.playPlaylist({ playlistId });
        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual((yield* Ref.get(calls)).at(-1)!.slice(5), ["next"]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect.each(["previous", "seek-back-playing", "seek-back-paused", "seek-end"] as const)(
    "tracks progress after %s without confusing a seek with a song ending",
    (action) =>
      Effect.gen(function* () {
        const playlistId = "5CA38D01224697B3";
        const first = "3BA40D4A07B97011";
        const steps = yield* Queue.unbounded<ReadonlyArray<string>>();
        const operationStarted = yield* Deferred.make<void>();
        const finishOperation = yield* Deferred.make<void>();
        const { sessions, runner } = yield* makeHarness({
          respond: (args) => {
            const tail = args.slice(5);
            if (tail[3] === "previous" || tail[0] === "seek")
              return Effect.gen(function* () {
                yield* Deferred.succeed(operationStarted, undefined);
                yield* Deferred.await(finishOperation);
                return output({ stdout: tail[0] === "seek" ? "ok" : "restart" });
              });
            if (tail.length === 9)
              return Queue.offer(steps, tail).pipe(Effect.as(output({ stdout: "end" })));
            return Effect.succeed(output({ stdout: "ok:2" }));
          },
        });
        yield* Effect.gen(function* () {
          const player = yield* MusicPlayer.MusicPlayer;
          const { received } = yield* subscribe(player);
          const session = yield* Queue.take(sessions);
          yield* player.playTrack({ playlistId, trackId: first, index: 2 });
          session.emit(
            sampleLine({
              state: "playing",
              position: action === "seek-end" ? 100 : 197,
              repeat: "all",
            }),
          );
          yield* Queue.take(received);
          const control = yield* player
            .control(
              action === "previous"
                ? { _tag: "previous" }
                : { _tag: "seek", positionSec: action === "seek-end" ? 200 : 1 },
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(operationStarted);
          session.emit(
            sampleLine({
              state: "playing",
              position: action === "seek-end" ? 100 : 197,
              repeat: "all",
            }),
          );
          yield* Deferred.succeed(finishOperation, undefined);
          yield* Fiber.join(control);
          session.emit(
            sampleLine(
              action === "seek-end"
                ? { state: "stopped", track: null, position: 0, repeat: "all" }
                : {
                    state: action === "seek-back-paused" ? "paused" : "playing",
                    position: 1,
                    repeat: "all",
                  },
            ),
          );
          const transition = yield* Queue.take(steps).pipe(
            Effect.as("step"),
            Effect.raceFirst(Queue.take(received).pipe(Effect.as("sample"))),
          );
          assert.strictEqual(transition, action === "seek-end" ? "step" : "sample");
        }).pipe(providePlayer(runner), Effect.scoped);
      }),
  );

  it.effect("does not advance a stale loop sample after the agent cue pauses Music", () =>
    Effect.gen(function* () {
      const first = "3BA40D4A07B97011";
      const second = "DD038AB38CFE38BB";
      const pauseStarted = yield* Deferred.make<void>();
      const releasePause = yield* Deferred.make<void>();
      const checkedAutomatic = yield* Deferred.make<void>();
      const played: string[] = [];
      let playback = "playing";
      const tracks = Object.assign(
        [first, second].map((id) => ({ play: () => played.push(id) })),
        { persistentID: () => [first, second] },
      );
      const music = {
        running: () => true,
        playerState: () => playback,
        playerPosition: () => 1,
        currentTrack: { persistentID: () => first },
        shuffleEnabled: () => false,
        songRepeat: () => "all",
        playlists: { whose: () => () => [{ tracks }] },
      };
      const { sessions, runner } = yield* makeHarness({
        respond: (args) =>
          Effect.gen(function* () {
            const tail = args.slice(5);
            if (tail[0] === "pause") {
              yield* Deferred.succeed(pauseStarted, undefined);
              yield* Deferred.await(releasePause);
              playback = "paused";
              return output({ stdout: `paused ${first} 1` });
            }
            if (tail.length === 9) {
              const script = args[4]!;
              const result: unknown = NodeVM.runInNewContext(
                script.slice(script.indexOf("function run(")) + "; run(argv)",
                { Application: () => music, argv: tail },
              );
              yield* Deferred.succeed(checkedAutomatic, undefined);
              return output({ stdout: String(result) });
            }
            return output({ stdout: "ok:0" });
          }),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: "5CA38D01224697B3", trackId: first, index: 0 });
        session.emit(sampleLine({ state: "playing", position: 197, repeat: "all" }));
        yield* Queue.take(received);
        const cue = yield* player
          .observeAgents(
            {
              requestIds: new Set(["request"]),
              workingProjectIds: new Set(),
              preexisting: new Set<string>(),
            },
            "pause",
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(pauseStarted);
        session.emit(sampleLine({ state: "playing", position: 1, repeat: "all" }));
        yield* Deferred.succeed(releasePause, undefined);
        yield* Fiber.join(cue);
        session.emit(sampleLine({ state: "playing", position: 1, repeat: "all" }));
        yield* Deferred.await(checkedAutomatic);
        assert.deepStrictEqual(played, []);
        assert.strictEqual(playback, "paused");
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("shares one watcher, gives late subscribers a snapshot, and stops with the last", () =>
    Effect.gen(function* () {
      const { sessions, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const first = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        session.emit(sampleLine());
        const firstState = yield* Queue.take(first.received);
        assert.strictEqual(firstState._tag, "ready");

        // Unchanged paused playback publishes nothing, so the late subscriber relies on the snapshot.
        const late = yield* subscribe(player);
        assert.deepStrictEqual(yield* Queue.take(late.received), firstState);
        assert.strictEqual(yield* Queue.size(sessions), 0);

        yield* Fiber.interrupt(first.fiber);
        assert.isFalse(Deferred.isDoneUnsafe(session.interrupted));
        yield* Fiber.interrupt(late.fiber);
        yield* Deferred.await(session.interrupted);

        const again = yield* subscribe(player);
        const next = yield* Queue.take(sessions);
        next.emit('{"running":false}');
        assert.deepStrictEqual(yield* Queue.take(again.received), { _tag: "not-running" });
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("re-sends a position the client would otherwise extrapolate past", () =>
    Effect.gen(function* () {
      const { sessions, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        session.emit(sampleLine({ state: "playing" }));
        const first = yield* Queue.take(received);

        // Playback stalled: five seconds later Music still reports the same position.
        yield* TestClock.adjust("5 seconds");
        session.emit(sampleLine({ state: "playing" }));
        assert.deepStrictEqual(yield* Queue.take(received), first);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("reports a denied permission and recovers after the user allows it", () =>
    Effect.gen(function* () {
      const { sessions, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const denied = yield* Queue.take(sessions);
        yield* denied.exit(DENIED);
        assert.deepStrictEqual(yield* Queue.take(received), { _tag: "permission-denied" });

        yield* TestClock.adjust("5 seconds");
        const retry = yield* Queue.take(sessions);
        retry.emit(sampleLine({ state: "playing" }));
        const recovered = yield* Queue.take(received);
        assert.strictEqual(recovered._tag === "ready" && recovered.playback, "playing");
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("never runs osascript off macOS", () =>
    Effect.gen(function* () {
      const { calls, sessions, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        assert.deepStrictEqual(yield* Queue.take(received), { _tag: "unsupported" });
        const error = yield* Effect.flip(player.control({ _tag: "next" }));
        assert.strictEqual(error.reason, "unsupported");
        assert.deepStrictEqual(yield* Ref.get(calls), []);
        assert.strictEqual(yield* Queue.size(sessions), 0);
      }).pipe(providePlayer(runner, "linux"), Effect.scoped);
    }),
  );

  it.effect("passes the playlist id as an argument and maps script failures", () =>
    Effect.gen(function* () {
      const playlistId = "5CA38D01224697B3";
      const { calls, runner } = yield* makeHarness({
        respond: (args) =>
          Effect.succeed(
            args.includes(playlistId)
              ? output({ stdout: "not-found\n" })
              : args.includes("next")
                ? DENIED
                : output({ stdout: "ok\n" }),
          ),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const play = yield* Effect.flip(player.playPlaylist({ playlistId }));
        assert.strictEqual(play.reason, "not-found");
        const [command, ...args] = (yield* Ref.get(calls))[0]!;
        assert.strictEqual(command, "osascript");
        assert.deepStrictEqual(args.slice(4), [playlistId, "keep"]);
        assert.isFalse(args.slice(0, 4).some((arg) => arg.includes(playlistId)));

        const next = yield* Effect.flip(player.control({ _tag: "next" }));
        assert.strictEqual(next.reason, "permission-denied");

        // Values reach the fixed scripts only as trailing argv.
        yield* player.control({ _tag: "seek", positionSec: 42.5 });
        yield* player.control({ _tag: "set-volume", volume: 30 });
        yield* player.control({ _tag: "set-repeat", mode: "one" });
        yield* player.playPlaylist({ playlistId: "AAAAAAAAAAAAAAAA", shuffle: false });
        yield* player.playTrack({
          playlistId: "AAAAAAAAAAAAAAAA",
          trackId: "BBBBBBBBBBBBBBBB",
          index: 3,
        });
        yield* player.control({
          _tag: "set-favorited",
          trackId: "BBBBBBBBBBBBBBBB",
          favorited: true,
        });
        const tails = (yield* Ref.get(calls)).slice(-6).map((call) => call.slice(5));
        assert.deepStrictEqual(tails, [
          ["seek", "42.5"],
          ["volume", "30"],
          ["repeat", "one"],
          ["AAAAAAAAAAAAAAAA", "shuffle-off"],
          ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB", "3"],
          ["favorite", "BBBBBBBBBBBBBBBB", "true"],
        ]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("lists a playlist's songs, keeping repeats apart and dropping malformed rows", () =>
    Effect.gen(function* () {
      const song = "BBBBBBBBBBBBBBBB";
      const reply = JSON.stringify({
        total: 7000,
        tracks: [
          { id: song, index: 0, name: "Song", artist: "Artist", durationSec: 200 },
          { id: song, index: 1, name: "Song", artist: null, durationSec: null },
          { id: "bad", index: 2, name: "Bad", artist: "", durationSec: 1 },
        ],
      });
      const { calls, runner } = yield* makeHarness({
        respond: (args) =>
          Effect.succeed(
            output({ stdout: args.includes("CCCCCCCCCCCCCCCC") ? "not-found\n" : reply }),
          ),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const listed = yield* player.listTracks({ playlistId: "AAAAAAAAAAAAAAAA" });
        assert.strictEqual(listed.total, 7000);
        assert.deepStrictEqual(
          listed.tracks.map((track) => [track.index, track.artist, track.durationSec]),
          [
            [0, "Artist", 200],
            [1, "", 0],
          ],
        );
        assert.deepStrictEqual((yield* Ref.get(calls))[0]!.slice(5), ["AAAAAAAAAAAAAAAA", "5000"]);
        const missing = yield* Effect.flip(player.listTracks({ playlistId: "CCCCCCCCCCCCCCCC" }));
        assert.deepStrictEqual([missing.operation, missing.reason], ["list-tracks", "not-found"]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("plays library songs by id, skipping other media, and playlist songs by row", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({
        [LIBRARY_ID]: [
          { id: SONG_A },
          { id: VIDEO, kind: "music video" },
          { id: SONG_B },
          { id: SONG_C },
        ],
        [PLAYLIST_ID]: [{ id: SONG_A }, { id: SONG_B }, { id: SONG_A }, { id: SONG_C }],
      });
      const { runner } = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.playTrack({ playlistId: LIBRARY_ID, trackId: SONG_B, index: 1 });
        yield* player.control({ _tag: "next" });
        fake.player.position = 1;
        yield* player.control({ _tag: "previous" });
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 2 });
        fake.player.position = 10;
        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual(fake.played, [SONG_B, SONG_C, SONG_B, `${SONG_A}#2`, `${SONG_C}#3`]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("plays a shuffled pick in exactly the order Up Next lists", () =>
    Effect.gen(function* () {
      const songs = Array.from({ length: 8 }, (_, i) => ({ id: `ABCDEF012345000${i}` }));
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      fake.player.shuffle = true;
      const stepped = yield* Queue.unbounded<void>();
      const { sessions, runner } = yield* makeHarness({
        respond: (args) =>
          runFakeScript(args, fake.music).pipe(
            Effect.tap(() =>
              args[8] === "advance" ? Queue.offer(stepped, undefined) : Effect.void,
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[2]!.id, index: 2 });
        const playing = { id: songs[2]!.id, duration: 200 };
        session.emit(
          sampleLine({ state: "playing", position: 197, shuffle: true, track: playing }),
        );
        const state = yield* Queue.take(received);
        const from = state._tag === "ready" ? state.playingFrom : undefined;
        assert.deepStrictEqual(from?.shuffle?.first, 2);
        const upNext = yield* player.upNext({
          playlistId: PLAYLIST_ID,
          trackId: songs[2]!.id,
          index: 2,
          wrap: false,
          shuffle: from!.shuffle!,
        });
        assert.strictEqual(upNext.tracks.length, 7);

        // A natural ending, then Next for the rest, plays the list in order and then stops.
        fake.player.state = "stopped";
        session.emit(sampleLine({ state: "stopped", track: null, position: 0, shuffle: true }));
        yield* Queue.take(stepped);
        for (let i = 0; i < 6; i++) yield* player.control({ _tag: "next" });
        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual(fake.played.slice(1), [
          ...upNext.tracks.map((track) => `${track.id}#${track.index}`),
          "stop",
        ]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("shuffles a whole playlist itself and steps through every song once", () =>
    Effect.gen(function* () {
      const songs = Array.from({ length: 6 }, (_, i) => ({ id: `ABCDEF012345000${i}` }));
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      // Music was stopped, so it ignores shuffle until T3's song is playing, a few seconds later.
      fake.player.state = "stopped";
      fake.player.startDelayReads = 30;
      const { calls, sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playPlaylist({ playlistId: PLAYLIST_ID, shuffle: true });
        assert.strictEqual(fake.player.shuffle, true);
        const seed = Number((yield* Ref.get(calls))[0]!.slice(5)[1]);
        const first = Number(fake.played[0]!.split("#")[1]);
        // Read the flag before Shuffle set it and the song after it started.
        const track = { id: songs[first]!.id, duration: 200 };
        session.emit(sampleLine({ state: "playing", position: 1, track, shuffle: false }));
        yield* Queue.take(received);
        const upNext = yield* player.upNext({
          playlistId: PLAYLIST_ID,
          trackId: songs[first]!.id,
          index: first,
          wrap: false,
          shuffle: { seed, first: null },
        });
        for (let i = 0; i < 5; i++) yield* player.control({ _tag: "next" });
        assert.deepStrictEqual(
          fake.played.slice(1),
          upNext.tracks.map((track) => `${track.id}#${track.index}`),
        );
        assert.deepStrictEqual(
          new Set(fake.played.map((label) => label.split("#")[0])),
          new Set(songs.map((song) => song.id)),
        );
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("plays T3's shuffle after a toggle even when a stale sample arrives late", () =>
    Effect.gen(function* () {
      const songs = Array.from({ length: 8 }, (_, i) => ({ id: `ABCDEF012345000${i}` }));
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      fake.player.repeat = "one";
      const { calls, sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[3]!.id, index: 3 });
        const track = { id: songs[3]!.id, duration: 200 };
        session.emit(sampleLine({ state: "playing", position: 20, track }));
        yield* Queue.take(received);
        fake.player.state = "playing";
        yield* player.control({ _tag: "set-shuffle", enabled: true });
        assert.strictEqual(fake.player.shuffle, true);
        // Up Next hears the new order at once, not at the next sample.
        const toggled = yield* Queue.take(received);
        assert.deepStrictEqual(
          toggled._tag === "ready" && [toggled.shuffle, toggled.playingFrom?.shuffle?.first],
          [true, 3],
        );
        // Read before the toggle, delivered after it.
        session.emit(sampleLine({ state: "playing", position: 21, track, shuffle: false }));
        // A published change marks that the stale sample before it was handled.
        session.emit(sampleLine({ state: "playing", position: 22, track, volume: 40 }));
        yield* Queue.take(received);
        yield* player.control({ _tag: "next" });
        const step = (yield* Ref.get(calls))
          .map((args) => args.slice(5))
          .find((tail) => tail[3] === "next")!;
        const upNext = yield* player.upNext({
          playlistId: PLAYLIST_ID,
          trackId: songs[3]!.id,
          index: 3,
          wrap: false,
          shuffle: { seed: Number(step[4]), first: 3 },
        });
        // Repeat one loops a song on its own, but Next still moves on.
        assert.strictEqual(
          fake.played.at(-1),
          `${upNext.tracks[0]!.id}#${upNext.tracks[0]!.index}`,
        );
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("leaves Next to Music only once Music has confirmed T3's song", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({ [PLAYLIST_ID]: [{ id: SONG_A }, { id: SONG_B }, { id: SONG_C }] });
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 0 });
        // Music has not switched yet: Next is still T3's.
        fake.player.current = VIDEO;
        yield* player.control({ _tag: "next" });
        session.emit(sampleLine({ state: "playing", position: 5, track: { id: SONG_B } }));
        yield* Queue.take(received);
        // Someone played other music in Music: T3 lets go, and a later Next is Music's too.
        fake.player.current = VIDEO;
        yield* player.control({ _tag: "next" });
        fake.player.current = SONG_B;
        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual(fake.played, [
          `${SONG_A}#0`,
          `${SONG_B}#1`,
          "music next",
          "music next",
        ]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("steps back through T3's order before Music has switched to the pick", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({ [PLAYLIST_ID]: [{ id: SONG_A }, { id: SONG_B }, { id: SONG_C }] });
      const { runner } = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_C, index: 2 });
        // Music still reports the song before, two minutes in; that is not T3's to restart.
        fake.player.current = VIDEO;
        fake.player.position = 120;
        yield* player.control({ _tag: "previous" });
        assert.deepStrictEqual(fake.played, [`${SONG_C}#2`, `${SONG_B}#1`]);
        assert.strictEqual(fake.player.position, 120);
        // At the start of the order there is nothing before it, and still nothing to restart.
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 0 });
        fake.player.current = VIDEO;
        yield* player.control({ _tag: "previous" });
        assert.deepStrictEqual(fake.played.slice(2), [`${SONG_A}#0`]);
        assert.strictEqual(fake.player.position, 120);
        // Stopped past three seconds mid-order, Previous restarts as it always has.
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_C, index: 2 });
        fake.player.state = "stopped";
        yield* player.control({ _tag: "previous" });
        assert.strictEqual(fake.player.position, 0);
        assert.deepStrictEqual(fake.played.slice(3), [`${SONG_C}#2`]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("keeps a seek when a shuffle toggle republishes the state", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({ [PLAYLIST_ID]: [{ id: SONG_A }, { id: SONG_B }, { id: SONG_C }] });
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 0 });
        session.emit(sampleLine({ state: "playing", position: 20, track: { id: SONG_A } }));
        yield* Queue.take(received);
        yield* player.control({ _tag: "seek", positionSec: 21 });
        yield* player.control({ _tag: "set-shuffle", enabled: true });
        const toggled = yield* Queue.take(received);
        assert.strictEqual(toggled._tag === "ready" && toggled.positionSec, 21);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("reads Music's own Up Next through the helper, after the header that opens it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const helper = `${yield* fileSystem.makeTempDirectoryScoped()}/T3 Music Up Next.app`;
      yield* fileSystem.makeDirectory(helper);
      const song = (label: string) => ({
        texts: [label],
        buttons: [{ id: "actionButton", label: "More" }],
      });
      const header = (title: string, buttons: ReadonlyArray<{ id: string; label?: string }>) => ({
        texts: [title],
        buttons,
      });
      const opener = header("Continue Playing", [
        { id: "from", label: "From musics!" },
        { id: "action", label: "Clear" },
      ]);
      const panel = (rows: ReadonlyArray<unknown>, lastVisibleIndex: number, rowCount: number) => ({
        kind: "panel",
        rows,
        lastVisibleIndex,
        rowCount,
      });
      // Each launch answers with the next read, the way the helper writes its file.
      const reads: Array<unknown> = [
        panel(
          [
            song("Distinto Beny Jr — 3O"),
            opener,
            song("Vacile Yan Block — Vacile - Single"),
            song("Fuma Bad Gyal — Fuma - Single"),
            song("Fuma Bad Gyal — Fuma - Single"),
          ],
          23,
          302,
        ),
        // Headers Music draws later (any language, any buttons) start sections; the list ends on screen.
        panel(
          [
            header("Als Nächstes", [{ id: "action" }]),
            song("A"),
            header("Autoplay", []),
            song("B"),
          ],
          3,
          4,
        ),
        panel([song("Old"), opener], 10, 302),
        panel([song("Old one"), header("History", []), song("Old two")], 10, 302),
        panel(
          [opener, song("Drawn"), { texts: [], buttons: [{ id: "actionButton" }] }, song("Later")],
          3,
          4,
        ),
        panel([], 0, 0),
        { kind: "closed" },
        { kind: "unrecognised" },
        { kind: "unreadable" },
        { kind: "permission-needed" },
        { kind: "not-running" },
        "wrong request",
        "oversize",
        "no answer",
      ];
      const launches: Array<ReadonlyArray<string>> = [];
      const { runner } = yield* makeHarness({
        respond: (args) =>
          Effect.gen(function* () {
            launches.push(args);
            const env = (name: string) =>
              args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
            const read = reads.shift();
            const out = env("T3_MUSIC_UP_NEXT_OUT");
            if (read === "no answer") return output();
            const files = yield* FileSystem.FileSystem;
            const request =
              read === "wrong request" ? "someone else" : env("T3_MUSIC_UP_NEXT_REQUEST");
            const body =
              read === "oversize"
                ? "x".repeat(600 * 1024)
                : JSON.stringify({
                    request,
                    read: read === "wrong request" ? { kind: "closed" } : read,
                  });
            yield* files.writeFileString(out, body);
            return output();
          }).pipe(Effect.provide(NodeServices.layer), Effect.orDie),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        let song_ = 0;
        // A new song each time, so each read reaches the helper.
        const read = Effect.suspend(() =>
          player.nativeQueue({ trackId: `AAAAAAAAAAAA${String(song_++).padStart(4, "0")}` }),
        );
        assert.deepStrictEqual(yield* read, {
          _tag: "ok",
          sections: [
            {
              title: "Continue Playing",
              source: "From musics!",
              songs: [
                "Vacile Yan Block — Vacile - Single",
                "Fuma Bad Gyal — Fuma - Single",
                "Fuma Bad Gyal — Fuma - Single",
              ],
            },
          ],
          complete: false,
        });
        // Launched through LaunchServices with its own request and output file.
        const first = launches[0]!;
        assert.deepStrictEqual(first.slice(0, 5), ["open", "-g", "-n", "-W", "--env"]);
        assert.strictEqual(first.at(-1), helper);
        assert.isTrue(first.includes("T3_MUSIC_UP_NEXT_PROMPT=1"));
        assert.deepStrictEqual(yield* read, {
          _tag: "ok",
          sections: [
            { title: "Als Nächstes", source: null, songs: ["A"] },
            { title: "Autoplay", source: null, songs: ["B"] },
          ],
          complete: true,
        });
        // The opening header is the last row on screen: nothing readable yet, and not "nothing next".
        assert.deepStrictEqual(yield* read, {
          _tag: "ok",
          sections: [{ title: "Continue Playing", source: "From musics!", songs: [] }],
          complete: false,
        });
        // A header without Music's Clear or From button never turns history into Up Next.
        assert.deepStrictEqual(yield* read, { _tag: "no-upcoming-visible" });
        assert.deepStrictEqual(yield* read, {
          _tag: "ok",
          sections: [{ title: "Continue Playing", source: "From musics!", songs: ["Drawn"] }],
          complete: false,
        });
        // An empty list is an empty queue.
        assert.deepStrictEqual(yield* read, { _tag: "ok", sections: [], complete: true });
        for (const tag of [
          "panel-closed",
          "unrecognised",
          "unreadable",
          "permission-needed",
          "not-running",
        ] as const) {
          assert.deepStrictEqual(yield* read, { _tag: tag });
        }
        for (let i = 0; i < 3; i++) {
          const failed = yield* Effect.flip(read);
          assert.deepStrictEqual(
            [failed.operation, failed.reason],
            ["native-queue", "unavailable"],
          );
        }
        // The same song within two seconds shares one launch; another song launches again.
        const before = launches.length;
        reads.push({ kind: "closed" }, { kind: "closed" });
        yield* player.nativeQueue({ trackId: "BBBBBBBBBBBBBBBB" });
        yield* player.nativeQueue({ trackId: "BBBBBBBBBBBBBBBB" });
        assert.strictEqual(launches.length, before + 1);
        yield* player.nativeQueue({ trackId: "CCCCCCCCCCCCCCCC" });
        assert.strictEqual(launches.length, before + 2);
      }).pipe(providePlayer(runner, "darwin", helper), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("says when the Up Next helper is not installed", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        assert.deepStrictEqual(yield* player.nativeQueue({ trackId: null }), {
          _tag: "helper-missing",
        });
        assert.strictEqual((yield* Ref.get(calls)).length, 0);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("lists what plays next by position, wrapping only for repeat all", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 40 }, (_, i) => ({
        id: `AAAAAAAAAAAA${String(i).padStart(4, "0")}`,
      }));
      const fake = fakeMusic({
        [PLAYLIST_ID]: [{ id: SONG_A }, { id: SONG_B }, { id: SONG_A }, { id: SONG_C }],
        [LIBRARY_ID]: [{ id: SONG_A }, { id: VIDEO, kind: "music video" }, { id: SONG_B }],
        AAAAAAAAAAAAAAAA: many,
        BBBBBBBBBBBBBBBB: [{ id: SONG_B }],
      });
      const { runner } = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const ids = (input: Parameters<typeof player.upNext>[0]) =>
          player.upNext(input).pipe(Effect.map((up) => up.tracks.map((t) => `${t.index}:${t.id}`)));
        // The second copy of a repeated song continues from its own position.
        assert.deepStrictEqual(
          yield* ids({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 2, wrap: false }),
          [`3:${SONG_C}`],
        );
        assert.deepStrictEqual(
          yield* ids({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 2, wrap: true }),
          [`3:${SONG_C}`, `0:${SONG_A}`, `1:${SONG_B}`, `2:${SONG_A}`],
        );
        assert.deepStrictEqual(
          yield* ids({ playlistId: PLAYLIST_ID, trackId: SONG_C, index: 3, wrap: false }),
          [],
        );
        assert.deepStrictEqual(
          yield* ids({ playlistId: LIBRARY_ID, trackId: SONG_A, index: 0, wrap: false }),
          [`1:${SONG_B}`],
        );
        const capped = yield* ids({
          playlistId: "AAAAAAAAAAAAAAAA",
          trackId: many[0]!.id,
          index: 0,
          wrap: true,
        });
        assert.deepStrictEqual(
          [capped.length, capped[0], capped.at(-1)],
          [25, `1:${many[1]!.id}`, `25:${many[25]!.id}`],
        );
        // Repeat all replays a lone song.
        assert.deepStrictEqual(
          yield* ids({ playlistId: "BBBBBBBBBBBBBBBB", trackId: SONG_B, index: 0, wrap: true }),
          [`0:${SONG_B}`],
        );
        const gone = yield* Effect.flip(
          player.upNext({ playlistId: PLAYLIST_ID, trackId: VIDEO, index: 0, wrap: false }),
        );
        assert.deepStrictEqual([gone.operation, gone.reason], ["up-next", "not-found"]);
        assert.strictEqual(
          (yield* player.upNext({ playlistId: LIBRARY_ID, trackId: SONG_A, index: 0, wrap: false }))
            .playlistName,
          "Library",
        );
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("searches one cached library read without passing the query to Music", () =>
    Effect.gen(function* () {
      const songs = [
        ["Halo", "Beyoncé", "I Am... Sasha Fierce"],
        ["Crazy in Love", "Beyonce", "Dangerously in Love"],
        ["Bad", null, "Halo Remixes"],
        ["Shallow Halo", "Someone", "Album"],
      ] as const;
      const filler = Array.from({ length: 60 }, (_, i) => `Filler ${i}`);
      const reply = JSON.stringify({
        playlistId: LIBRARY_ID,
        ids: [
          "nope",
          ...songs.map((_, i) => `BBBBBBBBBBBB000${i}`),
          ...filler.map((_, i) => `CCCCCCCCCCCC${String(i).padStart(4, "0")}`),
        ],
        names: [null, ...songs.map((song) => song[0]), ...filler],
        artists: [null, ...songs.map((song) => song[1]), ...filler.map(() => "Band")],
        albums: [null, ...songs.map((song) => song[2]), ...filler.map(() => "Album")],
        durations: [null, ...songs.map(() => 200), ...filler.map(() => null)],
      });
      const { calls, runner } = yield* makeHarness({
        respond: () => Effect.succeed(output({ stdout: reply })),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const names = (query: string) =>
          player
            .searchLibrary({ query })
            .pipe(Effect.map((found) => found.songs.map((s) => `${s.index}:${s.name}`)));
        // Accents and case fold; a name match ranks above an album match.
        assert.deepStrictEqual(yield* names("HALO"), ["1:Halo", "4:Shallow Halo", "3:Bad"]);
        assert.deepStrictEqual(yield* names("beyonce  love"), ["2:Crazy in Love"]);
        assert.deepStrictEqual(yield* names("   "), []);
        const capped = yield* player.searchLibrary({ query: "filler" });
        assert.deepStrictEqual(
          [capped.playlistId, capped.songs.length, capped.total],
          [LIBRARY_ID, 50, 60],
        );
        assert.deepStrictEqual(
          (yield* Ref.get(calls)).map((args) => args.slice(5)),
          [[]],
        );
        // A minute later the library is read again.
        yield* TestClock.adjust("61 seconds");
        yield* names("halo");
        assert.strictEqual((yield* Ref.get(calls)).length, 2);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("caches found artwork but not artwork for a track that changed mid-request", () =>
    Effect.gen(function* () {
      const trackId = "3BA40D4A07B97011";
      const fileSystem = yield* FileSystem.FileSystem;
      const artworkResult = yield* Ref.make("mismatch");
      const write = (path: string, bytes: ReadonlyArray<number>) =>
        fileSystem.writeFile(path, Uint8Array.from(bytes)).pipe(Effect.orDie);
      const { calls, runner } = yield* makeHarness({
        respond: (args) =>
          Effect.gen(function* () {
            if (args[0] === "sips") {
              yield* write(args.at(-1)!, [0xff, 0xd8, 0xff]);
              return output();
            }
            const result = yield* Ref.get(artworkResult);
            if (result === "ok") yield* write(args.at(-1)!, [1, 2, 3]);
            return output({ stdout: `${result}\n` });
          }),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        assert.deepStrictEqual(yield* player.artwork({ trackId }), { dataUrl: null });

        yield* Ref.set(artworkResult, "ok");
        const found = yield* player.artwork({ trackId });
        assert.strictEqual(found.dataUrl, "data:image/jpeg;base64,/9j/");
        const callsAfterFound = (yield* Ref.get(calls)).length;
        assert.deepStrictEqual(yield* player.artwork({ trackId }), found);
        assert.strictEqual((yield* Ref.get(calls)).length, callsAfterFound);
      }).pipe(providePlayer(runner), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("lowers Music for a new agent request and restores it once answered", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* makeHarness({
        respond: (args) =>
          Effect.succeed(
            output({ stdout: args.includes("lower-volume") ? "lowered 80 24\n" : "ok\n" }),
          ),
      });
      const activity = (
        requestIds: ReadonlyArray<string>,
        preexisting: ReadonlyArray<string> = [],
      ) => ({
        requestIds: new Set(requestIds),
        workingProjectIds: new Set<string>(),
        preexisting: new Set(preexisting),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const cueArgs = Effect.map(Ref.get(calls), (all) => all.map((call) => call.slice(5)));

        // A request already open at startup never lowers the volume.
        yield* player.observeAgents(activity(["stale"], ["stale"]), "lower-volume");
        yield* player.observeAgents(activity(["stale", "new"]), "lower-volume");
        // A second request while lowered does not lower again.
        yield* player.observeAgents(activity(["stale", "new", "other"]), "lower-volume");
        yield* player.observeAgents(activity(["stale", "other"]), "lower-volume");
        assert.deepStrictEqual(yield* cueArgs, [["lower-volume", "0.3"]]);

        // Restores only when every request that arrived since is answered; stale ones don't count.
        yield* player.observeAgents(activity(["stale"]), "lower-volume");
        assert.deepStrictEqual((yield* cueArgs).at(-1), ["restore-volume", "80", "24"]);

        yield* player.observeAgents(activity(["stale", "later"]), "off");
        assert.strictEqual((yield* cueArgs).length, 2);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("resumes music it paused when the server stops", () =>
    Effect.gen(function* () {
      const { calls, runner } = yield* makeHarness({
        respond: (args) =>
          Effect.succeed(
            output({ stdout: args.includes("pause") ? "paused 3BA40D4A07B97011 61.5\n" : "ok\n" }),
          ),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.observeAgents(
          {
            requestIds: new Set(["new"]),
            workingProjectIds: new Set(),
            preexisting: new Set<string>(),
          },
          "pause",
        );
      }).pipe(providePlayer(runner), Effect.scoped);
      assert.deepStrictEqual(
        (yield* Ref.get(calls)).map((call) => call.slice(5)),
        [
          ["pause", "0.3"],
          ["resume", "3BA40D4A07B97011", "61.5"],
        ],
      );
    }),
  );

  it.effect("samples Music while an agent works, with no client watching", () =>
    Effect.gen(function* () {
      const { sessions, runner } = yield* makeHarness();
      const working = (projectIds: ReadonlyArray<string>) => ({
        requestIds: new Set<string>(),
        workingProjectIds: new Set(projectIds),
        preexisting: new Set<string>(),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.observeAgents(working(["project-1"]), "off");
        const session = yield* Queue.take(sessions);
        yield* player.observeAgents(working(["project-1", "project-2"]), "off");
        assert.strictEqual(yield* Queue.size(sessions), 0);
        yield* player.observeAgents(working([]), "off");
        yield* Deferred.await(session.interrupted);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("credits playing time to the song and to projects with a working agent", () =>
    Effect.gen(function* () {
      const { sessions, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.observeAgents(
          {
            requestIds: new Set(),
            workingProjectIds: new Set(["project-1"]),
            preexisting: new Set<string>(),
          },
          "off",
        );
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        session.emit(sampleLine({ state: "playing" }));
        yield* Queue.take(received);
        yield* TestClock.adjust("1 second");
        session.emit(sampleLine({ state: "playing", position: 11 }));
        yield* TestClock.adjust("1 second");
        session.emit(sampleLine({ state: "paused", position: 12 }));
        yield* Queue.take(received);
        // Paused time and a gap longer than a few seconds are not listening.
        yield* TestClock.adjust("1 minute");
        session.emit(sampleLine({ state: "playing", position: 12 }));
        yield* Queue.take(received);
        yield* TestClock.adjust("30 seconds");
        session.emit(sampleLine({ state: "playing", position: 42 }));

        const stats = yield* player.stats({ days: 1 });
        assert.strictEqual(stats.totalSec, 2);
        assert.deepStrictEqual(stats.tracks, [{ name: "Song", artist: "Artist", seconds: 2 }]);
        assert.deepStrictEqual(stats.artists, [{ name: "Artist", seconds: 2 }]);
        assert.deepStrictEqual(stats.projects, [
          { projectId: ProjectId.make("project-1"), seconds: 2 },
        ]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );
});

const queueSongs = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ id: `ABCDEF01234500${String(i).padStart(2, "0")}` }));

const subscribeQueue = Effect.fn("subscribeQueue")(function* (
  player: MusicPlayer.MusicPlayer["Service"],
) {
  const statuses = yield* Queue.unbounded<MusicQueueStatus>();
  yield* player.queueStream.pipe(
    Stream.runForEach((status) => Queue.offer(statuses, status)),
    Effect.forkScoped,
  );
  return statuses;
});

const until = <A>(queue: Queue.Queue<A>, predicate: (value: A) => boolean): Effect.Effect<A> =>
  Queue.take(queue).pipe(Effect.filterOrElse(predicate, () => until(queue, predicate)));

const playingSample = (trackId: string, overrides: Record<string, unknown> = {}) =>
  sampleLine({
    state: "playing",
    position: 5,
    track: { id: trackId, duration: 200 },
    ...overrides,
  });

/** An edited playlist queue saved on s2 at 0:42, as files a restarted server would read. */
const savedEditedQueue = Effect.fn("savedEditedQueue")(function* () {
  const songs = queueSongs(4);
  const fake = fakeMusic({ [PLAYLIST_ID]: songs });
  const first = yield* makeHarness({
    respond: (args) =>
      args[4]!.includes("userPlaylists")
        ? Effect.succeed(
            output({
              stdout: JSON.stringify([{ id: PLAYLIST_ID, name: "Mix: Été", durationSec: 9 }]),
            }),
          )
        : runFakeScript(args, fake.music),
  });
  const files = yield* Effect.gen(function* () {
    const player = yield* MusicPlayer.MusicPlayer;
    const store = yield* MusicQueueStore.MusicQueueStore;
    const statuses = yield* subscribeQueue(player);
    const { received } = yield* subscribe(player);
    const session = yield* Queue.take(first.sessions);
    yield* player.listPlaylists;
    yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[0]!.id, index: 0 });
    const { id } = (yield* until(statuses, (status) => status.active !== null)).active!;
    session.emit(playingSample(songs[0]!.id));
    yield* Queue.take(received);
    yield* player.editQueue({
      queueId: id,
      expectedRevision: 0,
      sourceCount: 4,
      edit: { _tag: "remove", targets: [{ key: "s1", trackId: songs[1]!.id }] },
    });
    yield* player.control({ _tag: "next" });
    const track = { id: songs[2]!.id, name: "Été: Live", artist: "Ärtist", duration: 200 };
    session.emit(sampleLine({ state: "playing", position: 42, track }));
    yield* until(received, (state) => state._tag === "ready" && state.track?.id === track.id);
    yield* store.settled;
    return yield* store.load;
  }).pipe(providePlayer(first.runner), Effect.scoped);

  return { songs, fake, files };
});

describe("MusicPlayer queue", () => {
  it.effect(
    "names a playlist queue, makes it explicit on its first edit and steps through it",
    () =>
      Effect.gen(function* () {
        const songs = queueSongs(5);
        const fake = fakeMusic({ [PLAYLIST_ID]: songs });
        const { calls, sessions, runner } = yield* makeHarness({
          respond: (args) => runFakeScript(args, fake.music),
        });
        const stepCalls = Ref.get(calls).pipe(
          Effect.map((all) => all.filter((args) => args[4]!.includes('"exhausted:"')).length),
        );
        yield* Effect.gen(function* () {
          const player = yield* MusicPlayer.MusicPlayer;
          const statuses = yield* subscribeQueue(player);
          const { received } = yield* subscribe(player);
          const session = yield* Queue.take(sessions);
          yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[1]!.id, index: 1 });
          const active = (yield* until(statuses, (status) => status.active !== null)).active!;
          assert.deepStrictEqual(
            { revision: active.revision, edited: active.edited, currentKey: active.currentKey },
            { revision: 0, edited: false, currentKey: "s1" },
          );
          session.emit(playingSample(songs[1]!.id));
          yield* Queue.take(received);
          const view = yield* player.getQueue({ queueId: active.id });
          assert.strictEqual(view.sourceCount, 5);
          assert.deepStrictEqual(
            view.upcoming.map((entry) => entry.key),
            ["s2", "s3", "s4"],
          );

          const playNext = {
            _tag: "play-next" as const,
            songs: [{ playlistId: PLAYLIST_ID, trackId: songs[4]!.id, index: 4 }],
          };
          // A stale pair, or a playlist whose size changed since the read, changes nothing.
          for (const input of [
            { queueId: active.id, expectedRevision: 1, sourceCount: 5, edit: playNext },
            { queueId: active.id, expectedRevision: 0, sourceCount: 4, edit: playNext },
          ]) {
            assert.strictEqual(
              (yield* Effect.flip(player.editQueue(input))).reason,
              "queue-changed",
            );
          }
          const ref = yield* player.editQueue({
            queueId: active.id,
            expectedRevision: 0,
            sourceCount: 5,
            edit: playNext,
          });
          assert.deepStrictEqual(ref, { id: active.id, revision: 1 });
          yield* until(statuses, (status) => status.active?.edited === true);
          const edited = yield* player.getQueue({ queueId: active.id });
          assert.deepStrictEqual(
            edited.upcoming.map((entry) => [entry.key, entry.trackId]),
            [
              ["a0", songs[4]!.id],
              ["s2", songs[2]!.id],
              ["s3", songs[3]!.id],
              ["s4", songs[4]!.id],
            ],
          );
          assert.strictEqual(edited.upcoming[0]!.name, `name ${songs[4]!.id}`);

          yield* player.control({ _tag: "next" });
          assert.strictEqual(fake.played.at(-1), `${songs[4]!.id}#4`);
          yield* until(statuses, (status) => status.active?.currentKey === "a0");

          // A song gone from the playlist is skipped inside the same step script.
          songs[2]!.id = "FFFF000000000002";
          const before = yield* stepCalls;
          yield* player.control({ _tag: "next" });
          assert.strictEqual(yield* stepCalls, before + 1);
          assert.strictEqual(fake.played.at(-1), `${songs[3]!.id}#3`);
          yield* until(statuses, (status) => status.active?.currentKey === "s3");

          // With every candidate gone Music stops; T3 never hands Next to Music's own queue.
          songs[4]!.id = "FFFF000000000004";
          yield* player.control({ _tag: "next" });
          assert.deepStrictEqual(fake.played.slice(-1), ["stop"]);
          assert.isFalse(fake.played.includes("music next"));
          const saved = (yield* until(statuses, (status) => status.saved !== null)).saved!;
          assert.strictEqual(saved.id, active.id);
          assert.deepStrictEqual(
            [saved.trackName, saved.artist, saved.sourceName],
            ["Saved song", null, "Mix"],
          );
        }).pipe(providePlayer(runner), Effect.scoped);
      }),
  );

  it.effect("resumes a saved queue after a restart from its files alone", () =>
    Effect.gen(function* () {
      const { songs, fake, files } = yield* savedEditedQueue();

      const second = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const saved = (yield* Queue.take(statuses)).saved!;
        assert.deepStrictEqual(
          { ...saved, id: "" },
          {
            id: "",
            revision: 1,
            trackName: "Été: Live",
            artist: "Ärtist",
            sourceName: "Mix: Été",
            positionSec: 42,
            sourceMissing: false,
          },
        );
        // Starting up never asks Music anything.
        assert.deepStrictEqual(yield* Ref.get(second.calls), []);
        const stale = yield* Effect.flip(player.resumeQueue({ queueId: saved.id, revision: 0 }));
        assert.strictEqual(stale.reason, "queue-changed");
        yield* player.resumeQueue({ queueId: saved.id, revision: 1 });
        assert.strictEqual(fake.played.at(-1), `${songs[2]!.id}#2`);
        assert.deepStrictEqual((yield* Ref.get(second.calls)).at(-1)!.slice(5), ["seek", "42"]);
        const resumed = (yield* until(statuses, (status) => status.active !== null)).active;
        assert.deepStrictEqual(resumed, {
          id: saved.id,
          revision: 1,
          edited: true,
          currentKey: "s2",
        });
        const view = yield* player.getQueue({ queueId: saved.id });
        assert.deepStrictEqual(
          view.upcoming.map((entry) => entry.key),
          ["s3"],
        );
      }).pipe(
        providePlayer(second.runner, "darwin", undefined, MusicQueueStore.layerMemory(files)),
        Effect.scoped,
      );
    }),
  );

  it.effect("keeps T3's queue through a long pause, a watcher restart and a reconnect", () =>
    Effect.gen(function* () {
      const songs = queueSongs(4);
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const first = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[1]!.id, index: 1 });
        const active = (yield* until(statuses, (status) => status.active !== null)).active!;
        const song = { id: songs[1]!.id, duration: 200 };
        const ready =
          (playback: string, playlistId: string | null = PLAYLIST_ID) =>
          (state: MusicPlayerState) =>
            state._tag === "ready" &&
            state.playback === playback &&
            state.playlistId === playlistId;
        session.emit(playingSample(songs[1]!.id, { position: 30 }));
        yield* until(first.received, ready("playing"));
        yield* TestClock.adjust("6 seconds");
        session.emit(sampleLine({ state: "paused", position: 40, track: song }));
        yield* until(first.received, ready("paused"));
        yield* TestClock.adjust("3 hours");
        // Music can briefly fail to name its current playlist; that is not another playlist.
        session.emit(sampleLine({ state: "paused", position: 40, track: song, playlistId: null }));
        yield* until(first.received, ready("paused", null));
        // The watcher dies (sleep, a stuck Music) and comes back on its own.
        yield* session.exit(output());
        yield* TestClock.adjust("5 seconds");
        const restarted = yield* Queue.take(sessions);
        restarted.emit(sampleLine({ state: "paused", position: 40, track: song }));
        // Every client goes away and a new one connects.
        yield* Fiber.interrupt(first.fiber);
        const second = yield* subscribe(player);
        const reconnected = yield* Queue.take(sessions);
        reconnected.emit(sampleLine({ state: "playing", position: 41, track: song }));
        const resumed = yield* until(
          second.received,
          (state) => state._tag === "ready" && state.playback === "playing",
        );
        assert.deepStrictEqual(resumed._tag === "ready" ? resumed.playingFrom : null, {
          playlistId: PLAYLIST_ID,
          index: 1,
        });
        const now = yield* Queue.take(yield* subscribeQueue(player));
        assert.deepStrictEqual(now.active, active);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("resumes an unedited queue's song where its playlist moved it, never another", () =>
    Effect.gen(function* () {
      for (const change of ["moved", "missing"] as const) {
        const songs = queueSongs(4);
        const fake = fakeMusic({ [PLAYLIST_ID]: songs });
        const first = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
        const files = yield* Effect.gen(function* () {
          const player = yield* MusicPlayer.MusicPlayer;
          const store = yield* MusicQueueStore.MusicQueueStore;
          const statuses = yield* subscribeQueue(player);
          const { received } = yield* subscribe(player);
          const session = yield* Queue.take(first.sessions);
          yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[1]!.id, index: 1 });
          yield* until(statuses, (status) => status.active !== null);
          session.emit(playingSample(songs[1]!.id, { position: 60 }));
          yield* Queue.take(received);
          session.emit(playingSample(songs[1]!.id, { position: 61, state: "paused" }));
          yield* until(received, (state) => state._tag === "ready" && state.playback === "paused");
          yield* store.settled;
          return yield* store.load;
        }).pipe(providePlayer(first.runner), Effect.scoped);
        assert.strictEqual(files.body?.formula?.playlistId, PLAYLIST_ID);

        const saved = songs[1]!.id;
        if (change === "moved") {
          songs[1]!.id = songs[3]!.id;
          songs[3]!.id = saved;
        } else {
          songs[1]!.id = "FFFF000000000001";
        }
        const second = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
        yield* Effect.gen(function* () {
          const player = yield* MusicPlayer.MusicPlayer;
          const statuses = yield* subscribeQueue(player);
          const card = (yield* Queue.take(statuses)).saved!;
          const resume = player.resumeQueue({ queueId: card.id, revision: card.revision });
          if (change === "moved") {
            yield* resume;
            assert.strictEqual(fake.played.at(-1), `${saved}#3`);
            assert.deepStrictEqual((yield* Ref.get(second.calls)).at(-1)!.slice(5), ["seek", "61"]);
            const active = (yield* until(statuses, (status) => status.active !== null)).active!;
            assert.strictEqual(active.currentKey, "s3");
          } else {
            assert.strictEqual((yield* Effect.flip(resume)).reason, "not-found");
            assert.isFalse(fake.played.some((label) => label.startsWith("FFFF")));
            const missing = (yield* until(
              statuses,
              (status) => status.saved?.sourceMissing === true,
            )).saved!;
            assert.strictEqual(missing.id, card.id);
          }
        }).pipe(
          providePlayer(second.runner, "darwin", undefined, MusicQueueStore.layerMemory(files)),
          Effect.scoped,
        );
      }
    }),
  );

  it.effect("takes a restored queue back only when Music still holds its song where it was", () =>
    Effect.gen(function* () {
      const { songs, fake, files } = yield* savedEditedQueue();
      const current = { id: songs[2]!.id, duration: 200 };
      const cases = [
        { sample: { state: "paused", position: 42.4, track: current }, adopted: true },
        { sample: { state: "playing", position: 70, track: current }, adopted: true },
        // Started again from the top, from another playlist, or another song: Music's queue now.
        { sample: { state: "playing", position: 3, track: current }, adopted: false },
        {
          sample: { state: "paused", position: 42, track: current, playlistId: "x" },
          adopted: false,
        },
        {
          sample: { state: "paused", position: 42, track: { ...current, id: songs[3]!.id } },
          adopted: false,
        },
      ];
      for (const { sample, adopted } of cases) {
        const restarted = yield* makeHarness({
          respond: (args) => runFakeScript(args, fake.music),
        });
        yield* Effect.gen(function* () {
          const player = yield* MusicPlayer.MusicPlayer;
          const statuses = yield* subscribeQueue(player);
          const saved = (yield* Queue.take(statuses)).saved!;
          const { received } = yield* subscribe(player);
          const session = yield* Queue.take(restarted.sessions);
          session.emit(sampleLine(sample));
          const state = yield* until(received, (value) => value._tag === "ready");
          if (sample.state === "playing" && !adopted) {
            // Decided once: pausing later at the saved spot does not make it T3's again.
            session.emit(sampleLine({ state: "paused", position: 42, track: current }));
            yield* until(
              received,
              (value) => value._tag === "ready" && value.playback === "paused",
            );
          }
          const now = yield* Queue.take(yield* subscribeQueue(player));
          assert.deepStrictEqual(
            {
              active: now.active,
              saved: now.saved !== null,
              playingFrom: state._tag === "ready" ? state.playingFrom : undefined,
            },
            adopted
              ? {
                  active: { id: saved.id, revision: 1, edited: true, currentKey: "s2" },
                  saved: false,
                  playingFrom: { playlistId: PLAYLIST_ID, index: 2 },
                }
              : { active: null, saved: true, playingFrom: undefined },
            JSON.stringify(sample),
          );
          // Taking it back plays nothing and seeks nothing.
          assert.deepStrictEqual(yield* Ref.get(restarted.calls), []);
          if (!adopted) {
            yield* player.dismissSavedQueue({ queueId: saved.id, revision: saved.revision });
            assert.isNull((yield* Queue.take(yield* subscribeQueue(player))).saved);
            const store = yield* MusicQueueStore.MusicQueueStore;
            yield* store.settled;
            assert.isNull((yield* store.load).body);
          }
        }).pipe(
          providePlayer(restarted.runner, "darwin", undefined, MusicQueueStore.layerMemory(files)),
          Effect.scoped,
        );
      }
    }),
  );

  it.effect("holds a replaced edited queue for one Undo", () =>
    Effect.gen(function* () {
      const songs = queueSongs(4);
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      const { calls, sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[0]!.id, index: 0 });
        const replacedId = (yield* until(statuses, (status) => status.active !== null)).active!.id;
        session.emit(playingSample(songs[0]!.id, { position: 30 }));
        yield* Queue.take(received);
        yield* player.editQueue({
          queueId: replacedId,
          expectedRevision: 0,
          sourceCount: 4,
          edit: { _tag: "clear-upcoming" },
        });
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[3]!.id, index: 3 });
        const { replaced, active } = yield* until(statuses, (status) => status.replaced !== null);
        assert.deepStrictEqual(
          { ...replaced!, expiresAt: 0 },
          { replacedId, replacedRevision: 1, byId: active!.id, byRevision: 0, expiresAt: 0 },
        );
        const undo = { replacedId, replacedRevision: 1, byId: active!.id, byRevision: 0 };
        assert.deepStrictEqual(yield* player.undoReplace(undo), { id: replacedId, revision: 1 });
        assert.strictEqual(fake.played.at(-1), `${songs[0]!.id}#0`);
        assert.deepStrictEqual((yield* Ref.get(calls)).at(-1)!.slice(5), ["seek", "30"]);
        const restored = yield* until(statuses, (status) => status.active?.id === replacedId);
        assert.deepStrictEqual(restored.replaced, null);
        assert.strictEqual((yield* Effect.flip(player.undoReplace(undo))).reason, "queue-changed");

        // The hold lasts 30 s, then Undo changes nothing.
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[2]!.id, index: 2 });
        const late = (yield* until(statuses, (status) => status.replaced !== null)).replaced!;
        yield* TestClock.adjust("31 seconds");
        yield* until(statuses, (status) => status.replaced === null);
        const expired = yield* Effect.flip(player.undoReplace(late));
        assert.strictEqual(expired.reason, "queue-changed");
        const after = yield* Queue.take(yield* subscribeQueue(player));
        assert.strictEqual(after.active!.id, late.byId);

        // A replaced saved queue is gone for Resume and Dismiss alike.
        const stale = { queueId: replacedId, revision: 1 };
        assert.strictEqual((yield* Effect.flip(player.resumeQueue(stale))).reason, "queue-changed");
        assert.strictEqual(
          (yield* Effect.flip(player.dismissSavedQueue(stale))).reason,
          "queue-changed",
        );
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("resets to playlist order and hands back to the formula once Music confirms", () =>
    Effect.gen(function* () {
      const songs = queueSongs(6);
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      fake.player.shuffle = true;
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[2]!.id, index: 2 });
        const { id } = (yield* until(statuses, (status) => status.active !== null)).active!;
        session.emit(playingSample(songs[2]!.id, { shuffle: true }));
        yield* Queue.take(received);
        // Learning Music's shuffle is a new order, so the revision moves on.
        const shuffled = yield* until(statuses, (status) => status.active?.revision === 1);
        assert.strictEqual(shuffled.active!.edited, false);
        assert.isTrue((yield* player.getQueue({ queueId: id })).shuffled);
        yield* player.editQueue({
          queueId: id,
          expectedRevision: 1,
          sourceCount: 6,
          edit: {
            _tag: "play-next",
            songs: [{ playlistId: PLAYLIST_ID, trackId: songs[5]!.id, index: 5 }],
          },
        });
        const reset = yield* player.editQueue({
          queueId: id,
          expectedRevision: 2,
          edit: { _tag: "reset" },
        });
        assert.deepStrictEqual(reset, { id, revision: 3 });
        assert.isFalse(fake.player.shuffle);
        const view = yield* player.getQueue({ queueId: id });
        assert.deepStrictEqual(
          [view.edited, view.shuffled, view.upcoming.map((entry) => entry.key)],
          [true, false, ["s3", "s4", "s5"]],
        );
        // A sample read before the write landed is not a toggle; the confirming one hands off.
        session.emit(playingSample(songs[2]!.id, { shuffle: true, position: 6 }));
        session.emit(playingSample(songs[2]!.id, { shuffle: false, position: 7 }));
        const handed = (yield* until(statuses, (status) => status.active?.edited === false)).active;
        assert.deepStrictEqual(handed, { id, revision: 3, edited: false, currentKey: "s2" });
        const formula = yield* player.getQueue({ queueId: id });
        assert.deepStrictEqual(
          [formula.sourceCount, formula.upcoming.map((entry) => entry.key)],
          [6, ["s3", "s4", "s5"]],
        );
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );
  it.effect("steps an edited queue back, wraps it under repeat all and holds for an agent", () =>
    Effect.gen(function* () {
      const songs = queueSongs(3);
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[0]!.id, index: 0 });
        const { id } = (yield* until(statuses, (status) => status.active !== null)).active!;
        session.emit(playingSample(songs[0]!.id));
        yield* Queue.take(received);
        yield* player.editQueue({
          queueId: id,
          expectedRevision: 0,
          sourceCount: 3,
          edit: {
            _tag: "add",
            songs: [{ playlistId: PLAYLIST_ID, trackId: songs[1]!.id, index: 1 }],
          },
        });
        const at = (key: string) => until(statuses, (status) => status.active?.currentKey === key);
        yield* player.control({ _tag: "next" });
        yield* at("s1");
        // Early in a song Previous goes back an entry; later it restarts the song.
        fake.player.position = 1;
        yield* player.control({ _tag: "previous" });
        assert.strictEqual(fake.played.at(-1), `${songs[0]!.id}#0`);
        yield* at("s0");
        fake.player.position = 10;
        const before = fake.played.length;
        yield* player.control({ _tag: "previous" });
        assert.strictEqual(fake.played.length, before);
        assert.strictEqual(fake.player.position, 0);

        // Repeat all wraps from the last entry, the added copy of s1, back to the first.
        fake.player.repeat = "all";
        for (const key of ["s1", "s2", "a0"]) {
          yield* player.control({ _tag: "next" });
          yield* at(key);
        }
        yield* player.control({ _tag: "next" });
        assert.strictEqual(fake.played.at(-1), `${songs[0]!.id}#0`);
        yield* at("s0");

        // An agent's pause holds the queue even when a sample lands at the song's end.
        fake.player.state = "playing";
        session.emit(playingSample(songs[0]!.id, { position: 20, repeat: "all" }));
        yield* until(received, (state) => state._tag === "ready" && state.positionSec === 20);
        yield* player.observeAgents(
          {
            requestIds: new Set(["request"]),
            workingProjectIds: new Set(),
            preexisting: new Set(),
          },
          "pause",
        );
        assert.strictEqual(fake.player.state, "paused");
        const played = fake.played.length;
        session.emit(
          playingSample(songs[0]!.id, { state: "paused", position: 199, repeat: "all" }),
        );
        yield* until(received, (state) => state._tag === "ready" && state.playback === "paused");
        assert.strictEqual(fake.played.length, played);
        const now = yield* Queue.take(yield* subscribeQueue(player));
        assert.strictEqual(now.active?.currentKey, "s0");
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("materialises a large shuffled playlist in the order T3 was walking", () =>
    Effect.gen(function* () {
      const songs = queueSongs(5_200).map((_, i) => ({ id: `A${String(i).padStart(15, "0")}` }));
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      fake.player.shuffle = true;
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({
          playlistId: PLAYLIST_ID,
          trackId: songs[2_600]!.id,
          index: 2_600,
        });
        const { id } = (yield* until(statuses, (status) => status.active !== null)).active!;
        session.emit(playingSample(songs[2_600]!.id, { shuffle: true }));
        yield* Queue.take(received);
        yield* until(statuses, (status) => status.active?.revision === 1);
        const keys = (view: { readonly upcoming: ReadonlyArray<{ readonly key: string }> }) =>
          view.upcoming.map((entry) => entry.key);
        const listed = keys(yield* player.getQueue({ queueId: id }));
        // T3's own steps walk exactly what the formula listed.
        yield* player.control({ _tag: "next" });
        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual(
          fake.played.slice(-2).map((label) => `s${label.split("#")[1]}`),
          listed.slice(0, 2),
        );
        const formula = yield* player.getQueue({ queueId: id });
        assert.strictEqual(formula.totalUpcoming, 5_197);

        yield* player.editQueue({
          queueId: id,
          expectedRevision: 1,
          sourceCount: 5_200,
          edit: {
            _tag: "add",
            songs: [{ playlistId: PLAYLIST_ID, trackId: songs[0]!.id, index: 0 }],
          },
        });
        const explicit = yield* player.getQueue({ queueId: id });
        assert.deepStrictEqual(keys(explicit), keys(formula));
        assert.strictEqual(explicit.totalUpcoming, 5_198);
        // The songs already played stay behind the cursor for Previous.
        fake.player.position = 1;
        yield* player.control({ _tag: "previous" });
        yield* player.control({ _tag: "previous" });
        assert.strictEqual(fake.played.at(-1), `${songs[2_600]!.id}#2600`);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("refuses to materialise a playlist past the queue limit instead of truncating", () =>
    Effect.gen(function* () {
      const songs = Array.from({ length: 50_001 }, (_, i) => ({
        id: `B${String(i).padStart(15, "0")}`,
      }));
      const fake = fakeMusic({ [PLAYLIST_ID]: songs });
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[0]!.id, index: 0 });
        const { id } = (yield* until(statuses, (status) => status.active !== null)).active!;
        session.emit(playingSample(songs[0]!.id));
        yield* Queue.take(received);
        const error = yield* Effect.flip(
          player.editQueue({
            queueId: id,
            expectedRevision: 0,
            sourceCount: 50_001,
            edit: { _tag: "clear-upcoming" },
          }),
        );
        assert.strictEqual(error.reason, "queue-too-long");
        assert.isFalse((yield* player.getQueue({ queueId: id })).edited);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect(
    "settles shuffle on an edited queue: T3's writes, Music's toggles and a failed Reset",
    () =>
      Effect.gen(function* () {
        const songs = queueSongs(6);
        const fake = fakeMusic({ [PLAYLIST_ID]: songs });
        fake.player.shuffle = true;
        const { sessions, runner } = yield* makeHarness({
          respond: (args) => runFakeScript(args, fake.music),
        });
        yield* Effect.gen(function* () {
          const player = yield* MusicPlayer.MusicPlayer;
          const statuses = yield* subscribeQueue(player);
          const { received } = yield* subscribe(player);
          const session = yield* Queue.take(sessions);
          yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: songs[2]!.id, index: 2 });
          const { id } = (yield* until(statuses, (status) => status.active !== null)).active!;
          let position = 5;
          const sample = (shuffle: boolean) =>
            Effect.gen(function* () {
              // Alternating playback makes every sample a state the subscriber is sent.
              position += 1;
              const playback = position % 2 === 0 ? "playing" : "paused";
              session.emit(playingSample(songs[2]!.id, { shuffle, position, state: playback }));
              yield* until(
                received,
                (state) =>
                  state._tag === "ready" &&
                  state.playback === playback &&
                  state.shuffle === shuffle,
              );
            });
          yield* sample(true);
          yield* until(statuses, (status) => status.active?.revision === 1);
          yield* player.editQueue({
            queueId: id,
            expectedRevision: 1,
            sourceCount: 6,
            edit: {
              _tag: "play-next",
              songs: [{ playlistId: PLAYLIST_ID, trackId: songs[5]!.id, index: 5 }],
            },
          });
          const view = () => player.getQueue({ queueId: id });
          const order = Effect.map(view(), (queue) => ({
            revision: queue.revision,
            upcoming: queue.upcoming.map((entry) => entry.key),
          }));
          // Paused, Music ignores shuffle writes, so every write below fails to take.
          fake.player.state = "paused";

          // T3's own toggle reorders once; samples still showing the old flag are not a toggle.
          yield* player.control({ _tag: "set-shuffle", enabled: false });
          const off = yield* order;
          assert.strictEqual(off.revision, 3);
          yield* sample(true);
          assert.deepStrictEqual(yield* order, off);
          // The write never took: at the deadline Music's flag wins, with one corrective reorder.
          yield* TestClock.adjust("6 seconds");
          yield* sample(true);
          const corrected = yield* order;
          assert.strictEqual(corrected.revision, 4);
          yield* sample(true);
          assert.deepStrictEqual(yield* order, corrected);
          // A toggle made in Music between accepted samples reorders once.
          yield* sample(false);
          const musicOff = yield* order;
          // Off: added songs first by ordinal, then the rest in playlist order.
          assert.deepStrictEqual(musicOff, {
            revision: 5,
            upcoming: ["a0", "s0", "s1", "s3", "s4", "s5"],
          });
          yield* sample(false);
          assert.deepStrictEqual(yield* order, musicOff);
          yield* sample(true);
          assert.strictEqual((yield* order).revision, 6);

          // Reset with a write that never takes keeps plain source order and never reshuffles.
          const reset = yield* player.editQueue({
            queueId: id,
            expectedRevision: 6,
            edit: { _tag: "reset" },
          });
          assert.deepStrictEqual(reset, { id, revision: 7 });
          const sourceOrder = { revision: 7, upcoming: ["s3", "s4", "s5"] };
          assert.deepStrictEqual(yield* order, sourceOrder);
          // Off again only retries the Reset's write.
          yield* player.control({ _tag: "set-shuffle", enabled: false });
          assert.deepStrictEqual(yield* order, sourceOrder);
          yield* TestClock.adjust("6 seconds");
          yield* sample(true);
          assert.deepStrictEqual(yield* order, sourceOrder);
          assert.isTrue((yield* view()).edited);

          // An edit before the late acknowledgement revokes the handoff; the edit still stands.
          yield* player.editQueue({
            queueId: id,
            expectedRevision: 7,
            edit: { _tag: "remove", targets: [{ key: "s4", trackId: songs[4]!.id }] },
          });
          const edited = { revision: 8, upcoming: ["s3", "s5"] };
          assert.deepStrictEqual(yield* order, edited);
          yield* sample(false);
          assert.deepStrictEqual(yield* order, edited);
          assert.isTrue((yield* view()).edited);
          // That sample ended the Reset's wait, so the next change is an ordinary toggle.
          yield* sample(true);
          assert.strictEqual((yield* order).revision, 9);
        }).pipe(providePlayer(runner), Effect.scoped);
      }),
  );
});

const isLibraryRead = (args: ReadonlyArray<string>) => args[4]!.includes("favoritedColumn(");
const libraryReads = (calls: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>) =>
  Ref.get(calls).pipe(Effect.map((all) => all.filter(isLibraryRead).length));

describe("MusicPlayer favourites and recently played", () => {
  it.effect("records songs heard while only an agent watches, and Clear empties them", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({ [LIBRARY_ID]: [{ id: VIDEO, kind: "video" }, { id: SONG_A }] });
      const { sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        yield* player.observeAgents(
          {
            requestIds: new Set(),
            workingProjectIds: new Set(["project-1"]),
            preexisting: new Set<string>(),
          },
          "off",
        );
        const session = yield* Queue.take(sessions);
        const listen = (track: Record<string, unknown>, seconds: number) =>
          Effect.gen(function* () {
            for (let position = 0; position <= seconds; position += 5) {
              session.emit(sampleLine({ state: "playing", position, track }));
              yield* TestClock.adjust("5 seconds");
            }
          });
        const song = {
          id: SONG_A,
          name: "Été: Live",
          artist: "Ärtist",
          album: "Al",
          duration: 200,
        };
        yield* listen(song, 25);
        assert.strictEqual((yield* player.listRecent({ offset: 0, limit: 100 })).total, 0);
        yield* listen(song, 30);
        yield* until(statuses, (status) => status.recentRevision === 1);
        // A song no longer in the library still lists, with no place to play it from.
        const gone = { id: SONG_C, name: "Gone", artist: "Band", album: "", duration: 40 };
        yield* listen(gone, 20);
        yield* until(statuses, (status) => status.recentRevision === 2);
        const listed = yield* player.listRecent({ offset: 0, limit: 100 });
        assert.deepStrictEqual(
          listed.songs.map((row) => ({ ...row, lastPlayedAt: 0 })),
          [
            {
              trackId: SONG_C,
              name: "Gone",
              artist: "Band",
              album: "",
              durationSec: 40,
              lastPlayedAt: 0,
              index: null,
            },
            {
              trackId: SONG_A,
              name: "Été: Live",
              artist: "Ärtist",
              album: "Al",
              durationSec: 200,
              lastPlayedAt: 0,
              index: 0,
            },
          ],
        );
        assert.strictEqual(listed.playlistId, LIBRARY_ID);
        assert.deepStrictEqual(
          (yield* player.listRecent({ offset: 1, limit: 1 })).songs.map((row) => row.trackId),
          [SONG_A],
        );
        // Recording rides on the one watcher.
        assert.strictEqual(yield* Queue.size(sessions), 0);

        yield* player.clearRecent;
        yield* until(statuses, (status) => status.recentRevision === 3);
        assert.deepStrictEqual((yield* player.listRecent({ offset: 0, limit: 100 })).songs, []);
        const stats = yield* player.stats({ days: 1 });
        assert.isAbove(stats.totalSec, 0);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("lists favourites from the shared library read and patches T3's own changes", () =>
    Effect.gen(function* () {
      const songs = [
        { id: SONG_A, favorited: true },
        { id: VIDEO, kind: "video", favorited: true },
        { id: SONG_B, favorited: false },
        { id: SONG_C, favorited: true },
      ];
      const fake = fakeMusic({ [LIBRARY_ID]: songs });
      const { calls, sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const ids = (input: { query?: string; offset?: number; limit?: number }) =>
          player
            .listFavorites({ offset: input.offset ?? 0, limit: input.limit ?? 100, ...input })
            .pipe(Effect.map((page) => [page.songs.map((song) => song.id), page.total] as const));
        assert.deepStrictEqual(yield* ids({}), [[SONG_A, SONG_C], 2]);
        assert.deepStrictEqual(yield* ids({ query: `NAME ${SONG_C}` }), [[SONG_C], 1]);
        assert.deepStrictEqual(yield* ids({ offset: 1, limit: 1 }), [[SONG_C], 2]);
        const first = yield* player.listFavorites({ offset: 0, limit: 100 });
        assert.deepStrictEqual(
          [first.playlistId, first.songs.map((song) => song.index)],
          [LIBRARY_ID, [0, 2]],
        );
        // Search shares the same read.
        yield* player.searchLibrary({ query: "name" });
        assert.strictEqual(yield* libraryReads(calls), 1);

        yield* player.setTrackFavorited({ trackId: SONG_A, favorited: false });
        assert.deepStrictEqual((yield* Ref.get(calls)).at(-1)!.slice(5), [SONG_A, "false"]);
        yield* until(statuses, (status) => status.favouritesRevision === 1);
        const patched = yield* player.listFavorites({ offset: 0, limit: 100 });
        assert.deepStrictEqual(
          patched.songs.map((song) => song.id),
          [SONG_C],
        );
        assert.strictEqual(patched.snapshotAt, first.snapshotAt);
        assert.strictEqual(yield* libraryReads(calls), 1);
        const missing = yield* Effect.flip(
          player.setTrackFavorited({ trackId: "FFFF000000000000", favorited: true }),
        );
        assert.strictEqual(missing.reason, "not-found");

        // T3's heart on the current song: samples read before the write are not Music's change.
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        const current = (favorited: boolean, position: number) =>
          sampleLine({
            state: "playing",
            position,
            track: { id: SONG_C, duration: 200, favorited },
          });
        fake.player.current = SONG_C;
        session.emit(current(true, 1));
        yield* Queue.take(received);
        yield* player.control({ _tag: "set-favorited", trackId: SONG_C, favorited: false });
        yield* until(statuses, (status) => status.favouritesRevision === 2);
        session.emit(current(true, 2));
        session.emit(current(false, 3));
        yield* until(
          received,
          (state) => state._tag === "ready" && state.track?.favorited === false,
        );
        assert.deepStrictEqual(yield* ids({}), [[], 0]);
        assert.strictEqual(yield* libraryReads(calls), 1);

        // Favourited in Music itself: the next list reads the library again, from the top.
        yield* TestClock.adjust("10 seconds");
        session.emit(current(true, 13));
        const external = yield* until(statuses, (status) => status.favouritesRevision === 3);
        assert.strictEqual(external.favouritesRevision, 3);
        const reread = yield* player.listFavorites({ offset: 0, limit: 100 });
        assert.strictEqual(yield* libraryReads(calls), 2);
        assert.notStrictEqual(reread.snapshotAt, first.snapshotAt);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("keeps search working when Music can't report favourites", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({ [LIBRARY_ID]: [{ id: SONG_A }] });
      const { runner } = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const failed = yield* Effect.flip(player.listFavorites({ offset: 0, limit: 100 }));
        assert.deepStrictEqual([failed.operation, failed.reason], ["favorites", "unavailable"]);
        assert.strictEqual((yield* player.searchLibrary({ query: "name" })).total, 1);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("plays from Favourites as a T3 queue that continues through the list", () =>
    Effect.gen(function* () {
      const songs = queueSongs(4).map((song, i) => ({ ...song, favorited: i !== 1 }));
      const fake = fakeMusic({ [LIBRARY_ID]: songs });
      const { calls, sessions, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        const { received } = yield* subscribe(player);
        const session = yield* Queue.take(sessions);
        yield* player.playList({ source: "favourites", startTrackId: songs[2]!.id });
        assert.strictEqual(fake.played.at(-1), songs[2]!.id);
        const active = (yield* until(statuses, (status) => status.active !== null)).active!;
        assert.deepStrictEqual(
          { revision: active.revision, edited: active.edited, currentKey: active.currentKey },
          { revision: 0, edited: true, currentKey: "s1" },
        );
        session.emit(playingSample(songs[2]!.id));
        yield* Queue.take(received);
        const view = yield* player.getQueue({ queueId: active.id });
        assert.deepStrictEqual(
          [view.sourceName, view.current?.trackId, view.upcoming.map((entry) => entry.trackId)],
          ["Favourites", songs[2]!.id, [songs[3]!.id]],
        );

        // Clear, then Reset brings back the list as it was played.
        yield* player.editQueue({
          queueId: active.id,
          expectedRevision: 0,
          edit: { _tag: "clear-upcoming" },
        });
        yield* player.editQueue({
          queueId: active.id,
          expectedRevision: 1,
          edit: { _tag: "reset" },
        });
        const reset = yield* player.getQueue({ queueId: active.id });
        assert.deepStrictEqual(
          reset.upcoming.map((entry) => entry.key),
          ["s2"],
        );
        yield* player.control({ _tag: "previous" });
        yield* player.control({ _tag: "next" });
        assert.strictEqual(fake.played.at(-1), songs[3]!.id);
        yield* until(statuses, (status) => status.active?.currentKey === "s2");

        // A shuffled play of the whole list replaces it; the edited queue is held for Undo.
        yield* player.playList({ source: "favourites", startTrackId: null, shuffle: true });
        const shuffled = yield* until(statuses, (status) => status.replaced !== null);
        assert.strictEqual(shuffled.replaced!.replacedId, active.id);
        const whole = yield* player.getQueue({ queueId: shuffled.active!.id });
        assert.deepStrictEqual(
          [whole.shuffled, whole.totalUpcoming, whole.edited],
          [true, 2, true],
        );
        assert.sameMembers(
          [whole.current!.trackId, ...whole.upcoming.map((entry) => entry.trackId)],
          [songs[0]!.id, songs[2]!.id, songs[3]!.id],
        );
        // Music's own shuffle setting is never written for a list.
        assert.isFalse((yield* Ref.get(calls)).some((args) => args.at(-1) === "shuffle-on"));

        const gone = yield* Effect.flip(
          player.playList({ source: "favourites", startTrackId: songs[1]!.id }),
        );
        assert.deepStrictEqual([gone.operation, gone.reason], ["favorites", "not-found"]);
      }).pipe(providePlayer(runner), Effect.scoped);
    }),
  );

  it.effect("plays from Recently played, skipping songs gone from the library", () =>
    Effect.gen(function* () {
      const songs = queueSongs(3);
      const fake = fakeMusic({ [LIBRARY_ID]: songs });
      const { runner } = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      const row = (trackId: string, lastPlayedAt: number) => ({
        trackId,
        name: `Saved ${trackId}`,
        artist: "Artist",
        album: "Album",
        durationSec: 180,
        lastPlayedAt,
      });
      const recent = MusicRecent.layerMemory([
        row(songs[2]!.id, 3),
        row("FFFF000000000009", 2),
        row(songs[0]!.id, 1),
      ]);
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const statuses = yield* subscribeQueue(player);
        yield* player.playList({ source: "recent", startTrackId: songs[2]!.id });
        assert.strictEqual(fake.played.at(-1), songs[2]!.id);
        const active = (yield* until(statuses, (status) => status.active !== null)).active!;
        const view = yield* player.getQueue({ queueId: active.id });
        assert.deepStrictEqual(
          [view.sourceName, view.upcoming.map((entry) => [entry.trackId, entry.name])],
          ["Recently played", [[songs[0]!.id, `Saved ${songs[0]!.id}`]]],
        );
      }).pipe(providePlayer(runner, "darwin", undefined, undefined, recent), Effect.scoped);
    }),
  );
});
