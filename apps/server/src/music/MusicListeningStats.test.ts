import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as Stats from "./MusicListeningStats.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
// Midday keeps the local day stable in every time zone the suite runs in.
const NOW = Date.UTC(2026, 10, 13, 12);

const credit = (dayOffset: number, trackId: string, artist: string, seconds: number) => ({
  day: Stats.localDayKey(NOW - dayOffset * DAY_MS),
  trackId,
  name: `Song ${trackId}`,
  artist,
  seconds,
  projectIds: dayOffset === 0 ? ["project-a"] : [],
});

describe("summarizeListening", () => {
  it("totals the range, ranks the top entries and leaves out older days", () => {
    const file = Stats.emptyListeningStats();
    Stats.creditListening(file, credit(0, "A", "Artist 1", 100));
    Stats.creditListening(file, credit(0, "B", "Artist 2", 300));
    Stats.creditListening(file, credit(3, "A", "Artist 1", 250));
    Stats.creditListening(file, credit(10, "C", "Artist 3", 999));

    const today = Stats.summarizeListening(file, 1, NOW);
    assert.strictEqual(today.totalSec, 400);
    assert.deepStrictEqual(today.days, [{ date: Stats.localDayKey(NOW), seconds: 400 }]);
    assert.deepStrictEqual(today.projects, [
      { projectId: ProjectId.make("project-a"), seconds: 400 },
    ]);

    const week = Stats.summarizeListening(file, 7, NOW);
    assert.strictEqual(week.totalSec, 650);
    assert.strictEqual(week.days.length, 7);
    assert.strictEqual(week.days[3]!.seconds, 250);
    assert.deepStrictEqual(
      week.artists.map((artist) => [artist.name, artist.seconds]),
      [
        ["Artist 1", 350],
        ["Artist 2", 300],
      ],
    );
    assert.deepStrictEqual(week.tracks[0], { name: "Song A", artist: "Artist 1", seconds: 350 });
  });

  it("drops days past the retention window", () => {
    const file = Stats.emptyListeningStats();
    Stats.creditListening(file, credit(Stats.RETAINED_DAYS + 5, "A", "Artist", 10));
    Stats.creditListening(file, credit(1, "A", "Artist", 10));
    Stats.pruneListening(file, NOW);
    assert.deepStrictEqual(Object.keys(file.days), [Stats.localDayKey(NOW - DAY_MS)]);
  });
});

describe("MusicListeningStats store", () => {
  const withStore = <A, E, R>(baseDir: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(
        Stats.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
  const statsPath = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return (yield* Path.Path).join(config.stateDir, "music-stats.json");
  });
  const listen = (artist: string, seconds: number) =>
    Effect.gen(function* () {
      const store = yield* Stats.MusicListeningStats;
      // it.effect's clock starts at zero, so that is "today" for the summary.
      yield* store.credit({ ...credit(0, artist, artist, seconds), day: Stats.localDayKey(0) });
      yield* store.flush;
    });

  it.effect("saves artists named like object built-ins and reads them back", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      yield* withStore(baseDir, Effect.all([listen("constructor", 30), listen("__proto__", 20)]));
      const stats = yield* withStore(
        baseDir,
        Effect.flatMap(Stats.MusicListeningStats, (store) => store.summary({ days: 1 })),
      );
      assert.deepStrictEqual(
        stats.artists.map((artist) => [artist.name, artist.seconds]),
        [
          ["constructor", 30],
          ["__proto__", 20],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never overwrites a stats file it could not read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const unreadable = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      // A directory where the file belongs fails every read.
      const blockedPath = yield* withStore(
        unreadable,
        Effect.gen(function* () {
          const path = yield* statsPath;
          yield* fileSystem.makeDirectory(path, { recursive: true });
          yield* listen("Artist", 10);
          return path;
        }),
      );
      assert.strictEqual((yield* fileSystem.stat(blockedPath)).type, "Directory");

      const corrupt = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      const { path, entries } = yield* withStore(
        corrupt,
        Effect.gen(function* () {
          const path = yield* statsPath;
          yield* fileSystem.makeDirectory((yield* Path.Path).dirname(path), { recursive: true });
          yield* fileSystem.writeFileString(path, "{ not json");
          yield* listen("Artist", 10);
          return {
            path,
            entries: yield* fileSystem.readDirectory((yield* Path.Path).dirname(path)),
          };
        }),
      );
      const kept = entries.find((name) => name.startsWith("music-stats.json.unreadable-"));
      assert.isDefined(kept);
      assert.strictEqual(
        yield* fileSystem.readFileString(
          (yield* Path.Path).join((yield* Path.Path).dirname(path), kept!),
        ),
        "{ not json",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
