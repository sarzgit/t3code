import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type MusicPlayerState, ProjectId } from "@t3tools/contracts";
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
) =>
  Effect.provide(
    MusicPlayer.layer.pipe(
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
  };
  const start = (playlistId: string, songId: string, label: string) => {
    played.push(label);
    player.current = songId;
    player.playlist = playlistId;
    player.state = "playing";
  };
  const playlist = (id: string, songs: ReadonlyArray<FakeSong>) => {
    const column = (pick: (song: FakeSong) => unknown) => () => songs.map(pick);
    const shifted = (i: number) => songs[id === LIBRARY_ID ? (i + 1) % songs.length : i]!;
    const tracks = Object.assign(
      // A specifier play records its row, so a repeated song's copies stay apart.
      songs.map((_, i) => ({ play: () => start(id, shifted(i).id, `${shifted(i).id}#${i}`) })),
      {
        persistentID: column((song) => song.id),
        mediaKind: column((song) => song.kind ?? "song"),
        name: column((song) => `name ${song.id}`),
        artist: column(() => "Artist"),
        duration: column(() => 200),
        whose: (query: { readonly persistentID: string }) => () =>
          songs
            .filter((song) => song.id === query.persistentID)
            .map((song) => ({ play: () => start(id, song.id, song.id) })),
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
    playerState: () => player.state,
    get playerPosition() {
      return () => player.position;
    },
    // Scripts assign the setting and call the same name to read it.
    set playerPosition(value: unknown) {
      player.position = Number(value);
    },
    get shuffleEnabled() {
      return () => player.shuffle;
    },
    set shuffleEnabled(value: unknown) {
      player.shuffle = value === true;
    },
    songRepeat: () => player.repeat,
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
      { Application: () => music, argv: args.slice(5) },
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
    ["another song after Music had time to switch", fresh, sample({ track: other }), 6_000, "drop"],
    ["the picked song playing", seen, sample(), 0, "follow"],
    ["Music stopped at the end of the song", nearEnd, stopped, 0, "advance"],
    ["Music stopped mid-song", seen, stopped, 0, "follow"],
    ["someone played another song", seen, sample({ track: other }), 0, "drop"],
    [
      "Music played the same song from another playlist",
      { ...seen, musicPlaylistId: "5CA38D01224697B3" },
      sample({ playlistId: "AAAAAAAAAAAAAAAA" }),
      0,
      "drop",
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
    ["Music quit", seen, { _tag: "not-running" }, 0, "drop"],
  ] as const)("%s", (_name, picked, state, nowMs, expected) => {
    const update = MusicPlayer.followPickedSong(picked, state, nowMs);
    assert.strictEqual(update._tag === "follow" && update.hide ? "hidden" : update._tag, expected);
  });

  it("follows Music's shuffle flag, shuffling on from the current song", () => {
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
    // Turned off, or a write Music ignored, follows Music.
    assert.strictEqual(shuffleOf(later, sample({ shuffle: false })), null);
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
          if (tail.length !== 7) return Effect.succeed(output({ stdout: "ok:2\n" }));
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
            if (tail.length === 7)
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
            if (tail.length === 7) {
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
      const { calls, runner } = yield* makeHarness({
        respond: (args) => runFakeScript(args, fake.music),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.playPlaylist({ playlistId: PLAYLIST_ID, shuffle: true });
        assert.strictEqual(fake.player.shuffle, true);
        const seed = Number((yield* Ref.get(calls))[0]!.slice(5)[1]);
        const first = Number(fake.played[0]!.split("#")[1]);
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
        yield* player.control({ _tag: "set-shuffle", enabled: true });
        assert.strictEqual(fake.player.shuffle, true);
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

  it.effect("leaves Next to Music when Music is playing something else", () =>
    Effect.gen(function* () {
      const fake = fakeMusic({ [PLAYLIST_ID]: [{ id: SONG_A }, { id: SONG_B }, { id: SONG_C }] });
      const { runner } = yield* makeHarness({ respond: (args) => runFakeScript(args, fake.music) });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.playTrack({ playlistId: PLAYLIST_ID, trackId: SONG_A, index: 0 });
        fake.player.current = VIDEO;
        yield* player.control({ _tag: "next" });
        // T3 let go: a later Next is Music's too.
        fake.player.current = SONG_A;
        yield* player.control({ _tag: "next" });
        assert.deepStrictEqual(fake.played, [`${SONG_A}#0`, "music next", "music next"]);
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
