import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { MusicPlayerState } from "@t3tools/contracts";
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
    assert.deepStrictEqual(MusicPlayer.decodeWatchLine(sampleLine({ state: "fast forwarding" })), {
      _tag: "ready",
      playback: "playing",
      track: {
        id: "3BA40D4A07B97011",
        name: "Song",
        artist: "Artist",
        album: "Album",
        durationSec: 200,
      },
      positionSec: 10,
      shuffle: false,
      playlistId: "5CA38D01224697B3",
    });
    const odd = MusicPlayer.decodeWatchLine(
      sampleLine({ track: { id: "not-an-id" }, position: null, playlistId: "x" }),
    );
    assert.deepStrictEqual(
      odd?._tag === "ready" ? [odd.track, odd.positionSec, odd.playlistId] : odd,
      [null, 0, null],
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
        assert.strictEqual(args.at(-1), playlistId);
        assert.isFalse(args.slice(0, -1).some((arg) => arg.includes(playlistId)));

        const next = yield* Effect.flip(player.control({ _tag: "next" }));
        assert.strictEqual(next.reason, "permission-denied");
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
});
