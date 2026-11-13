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

describe("MusicPlayer", () => {
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
      const activity = (requestIds: ReadonlyArray<string>, initial = false) => ({
        requestIds: new Set(requestIds),
        workingProjectIds: new Set<string>(),
        initial,
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        const cueArgs = Effect.map(Ref.get(calls), (all) => all.map((call) => call.slice(5)));

        // A request already open at startup never lowers the volume.
        yield* player.observeAgents(activity(["stale"], true), "lower-volume");
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
          Effect.succeed(output({ stdout: args.includes("pause") ? "paused\n" : "ok\n" })),
      });
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.observeAgents(
          { requestIds: new Set(["new"]), workingProjectIds: new Set(), initial: false },
          "pause",
        );
      }).pipe(providePlayer(runner), Effect.scoped);
      assert.deepStrictEqual(
        (yield* Ref.get(calls)).map((call) => call.slice(5)),
        [["pause", "0.3"], ["resume"]],
      );
    }),
  );

  it.effect("credits playing time to the song and to projects with a working agent", () =>
    Effect.gen(function* () {
      const { sessions, runner } = yield* makeHarness();
      yield* Effect.gen(function* () {
        const player = yield* MusicPlayer.MusicPlayer;
        yield* player.observeAgents(
          { requestIds: new Set(), workingProjectIds: new Set(["project-1"]), initial: true },
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
