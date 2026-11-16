import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { MusicPlayerState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Recent from "./MusicRecent.ts";

const SONG = "3BA40D4A07B97011";
const OTHER = "DD038AB38CFE38BB";

const sample = (
  trackId: string,
  positionSec: number,
  overrides: { durationSec?: number; playback?: "playing" | "paused" | "stopped" } = {},
): MusicPlayerState => ({
  _tag: "ready",
  playback: overrides.playback ?? "playing",
  track: {
    id: trackId,
    name: `Song ${trackId}`,
    artist: "Artist",
    album: "Album",
    durationSec: overrides.durationSec ?? 200,
  },
  positionSec,
  shuffle: false,
  playlistId: null,
});

/** Feeds samples one second apart and returns every song that qualified. */
function run(states: ReadonlyArray<MusicPlayerState>) {
  let play: Recent.RecentPlay | null = null;
  let previous: { state: MusicPlayerState; atMs: number } | null = null;
  const qualified: Array<[string, number]> = [];
  states.forEach((state, i) => {
    const atMs = i * 1000;
    const next = Recent.followRecentPlay(play, previous, state, atMs, 5);
    play = next.play;
    if (next.qualified !== null) qualified.push([next.qualified.trackId, i]);
    previous = { state, atMs };
  });
  return qualified;
}

const playing = (trackId: string, from: number, count: number, durationSec = 200) =>
  Array.from({ length: count }, (_, i) => sample(trackId, from + i, { durationSec }));

describe("followRecentPlay", () => {
  it("counts a song after 30 seconds heard, or half of one shorter than a minute", () => {
    assert.deepStrictEqual(run(playing(SONG, 0, 31)), [[SONG, 30]]);
    assert.deepStrictEqual(run(playing(SONG, 0, 30)), []);
    assert.deepStrictEqual(run(playing(SONG, 0, 12, 20)), [[SONG, 10]]);
  });

  it("does not count paused time, and a new song starts its own count", () => {
    const paused = Array.from({ length: 40 }, () => sample(SONG, 10, { playback: "paused" }));
    assert.deepStrictEqual(run([...playing(SONG, 0, 20), ...paused]), []);
    assert.deepStrictEqual(run([...playing(SONG, 0, 20), ...playing(OTHER, 0, 20)]), []);
  });

  it("counts a play once, and a repeat of the same song again", () => {
    const loop = [...playing(SONG, 160, 40), ...playing(SONG, 0, 31)];
    assert.deepStrictEqual(run(loop), [
      [SONG, 30],
      [SONG, 70],
    ]);
  });
});

describe("withRecentPlay", () => {
  const song = (trackId: string, lastPlayedAt: number): Recent.RecentSong => ({
    trackId,
    name: "Song",
    artist: "Artist",
    album: "Album",
    durationSec: 200,
    lastPlayedAt,
  });

  it("keeps one row per song, newest first, and at most 200", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      song(`AAAAAAAAAAAA${String(i).padStart(4, "0")}`, i),
    );
    const moved = Recent.withRecentPlay(many, song(many[150]!.trackId, 999));
    assert.strictEqual(moved.length, 200);
    assert.deepStrictEqual(moved[0], song(many[150]!.trackId, 999));
    assert.strictEqual(moved.filter((entry) => entry.trackId === many[150]!.trackId).length, 1);
    const added = Recent.withRecentPlay(many, song(SONG, 1000));
    assert.strictEqual(added.length, 200);
    assert.strictEqual(added[0]!.trackId, SONG);
    assert.strictEqual(added.at(-1)!.trackId, many[198]!.trackId);
  });
});

describe("MusicRecent store", () => {
  const withStore = <A, E, R>(baseDir: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Recent.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  const recentPath = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return (yield* Path.Path).join(config.stateDir, "music-recent.json");
  });
  const row = (trackId: string, lastPlayedAt: number): Recent.RecentSong => ({
    trackId,
    name: "Été: Live",
    artist: "Ärtist",
    album: "Album",
    durationSec: 200,
    lastPlayedAt,
  });

  it.effect("buffers until a flush, and Clear empties memory and file for good", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-recent-" });
      yield* withStore(
        baseDir,
        Effect.gen(function* () {
          const store = yield* Recent.MusicRecent;
          const path = yield* recentPath;
          yield* store.record(row(SONG, 1));
          assert.isFalse(yield* fileSystem.exists(path));
          yield* store.flush;
          const saved = JSON.parse(yield* fileSystem.readFileString(path));
          assert.deepStrictEqual(saved, { version: 1, songs: [row(SONG, 1)] });
          // A row still waiting for the next flush must not bring the list back after Clear.
          yield* store.record(row(OTHER, 2));
          yield* store.clear;
          yield* store.flush;
          assert.deepStrictEqual(yield* store.list, []);
          assert.deepStrictEqual(JSON.parse(yield* fileSystem.readFileString(path)), {
            version: 1,
            songs: [],
          });
        }),
      );
      // A restart reads the cleared file, and rows recorded since survive one.
      yield* withStore(
        baseDir,
        Effect.gen(function* () {
          const store = yield* Recent.MusicRecent;
          assert.deepStrictEqual(yield* store.list, []);
          yield* store.record(row(OTHER, 3));
        }),
      );
      const reopened = yield* withStore(
        baseDir,
        Effect.flatMap(Recent.MusicRecent, (s) => s.list),
      );
      assert.deepStrictEqual(reopened, [row(OTHER, 3)]);

      // A file this run can't read can't be cleared: Clear says so and keeps what it shows.
      const path = yield* withStore(baseDir, recentPath);
      yield* fileSystem.chmod(path, 0o000);
      const refused = yield* withStore(
        baseDir,
        Effect.gen(function* () {
          const store = yield* Recent.MusicRecent;
          yield* store.record(row(SONG, 4));
          const error = yield* Effect.flip(store.clear);
          return { reason: error.reason, list: yield* store.list };
        }),
      );
      yield* fileSystem.chmod(path, 0o600);
      assert.deepStrictEqual(refused, { reason: "unavailable", list: [row(SONG, 4)] });
      assert.deepStrictEqual(
        JSON.parse(yield* fileSystem.readFileString(path)).songs.map(
          (song: Recent.RecentSong) => song.trackId,
        ),
        [OTHER],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
