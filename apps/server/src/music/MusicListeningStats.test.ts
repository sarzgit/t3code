import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

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

const libraryTrack = (playedCount: number, playedAtMs: number | null) => ({
  id: "0000000000000001",
  name: "Song",
  artist: "Artist",
  durationSec: 200,
  playedCount,
  playedAtMs,
});

describe("summarizeListening", () => {
  it("totals the range, ranks the top entries and leaves out older days", () => {
    const file = Stats.emptyListeningStats();
    Stats.creditListening(file, credit(0, "A", "Artist 1", 100));
    Stats.creditListening(file, credit(0, "B", "Artist 2", 300));
    Stats.creditListening(file, credit(3, "A", "Artist 1", 250));
    Stats.creditListening(file, credit(10, "C", "Artist 3", 999));

    const today = Stats.summarizeListening(file, Stats.emptyListeningHistory(), 1, NOW);
    assert.strictEqual(today.totalSec, 400);
    assert.deepStrictEqual(today.days, [{ date: Stats.localDayKey(NOW), seconds: 400 }]);
    assert.deepStrictEqual(today.projects, [
      { projectId: ProjectId.make("project-a"), seconds: 400 },
    ]);

    const week = Stats.summarizeListening(file, Stats.emptyListeningHistory(), 7, NOW);
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

describe("listening history", () => {
  const MINUTE_MS = 60 * 1000;
  const day = (offset: number) => Stats.localDayKey(NOW - offset * DAY_MS);
  const row = (offset: number, name: string, artist: string, seconds: number) => ({
    day: day(offset),
    name,
    artist,
    seconds,
  });
  const imported = (
    history: Stats.ListeningHistoryFile,
    rows: ReadonlyArray<ReturnType<typeof row>>,
    coveredThrough?: string,
  ) =>
    Stats.withImportedHistory(
      history,
      coveredThrough === undefined ? { rows } : { rows, coveredThrough },
      NOW,
    );
  const total = (history: Stats.ListeningHistoryFile, days: 1 | 7 = 7) =>
    Stats.summarizeListening(Stats.emptyListeningStats(), history, days, NOW).totalSec;

  it("imports idempotently: repeated rows add up within a chunk, overlaps keep the larger", () => {
    // Apple's export repeats a day and song; both rows are listening.
    const chunk = [row(2, "Song", "Artist", 100), row(2, "song ", "ARTIST", 50)];
    const empty = Stats.emptyListeningHistory();
    let history = imported(imported(empty, chunk), chunk);
    assert.strictEqual(total(history), 150);
    assert.deepStrictEqual(empty.imported, {});
    // A later export covering the same day (and a partial earlier one) never adds twice.
    history = imported(history, [row(2, "Song", "Artist", 120)]);
    history = imported(history, [row(2, "Song", "Artist", 200), row(1, "B", "X", 60)], day(1));
    const week = Stats.summarizeListening(Stats.emptyListeningStats(), history, 7, NOW);
    assert.strictEqual(week.totalSec, 260);
    assert.strictEqual(week.importedThrough, day(1));
    assert.deepStrictEqual(week.projects, []);
  });

  it("drops impossible and future days, and coverage past the imported rows", () => {
    let history = imported(Stats.emptyListeningHistory(), [
      { ...row(0, "A", "B", 10), day: "2026-02-31" },
      row(-5, "A", "B", 10),
    ]);
    assert.deepStrictEqual(Object.keys(history.imported), []);
    history = imported(history, [row(3, "A", "B", 10)]);
    history = imported(history, [], day(1));
    assert.isNull(history.importedThrough);
  });

  it("counts a play once across T3 samples, the export and library scans", () => {
    const stats = Stats.emptyListeningStats();
    // T3 saw the export's song under another name; it must not add to the export's day.
    Stats.creditListening(stats, { ...credit(3, "ID1", "Artist", 90), name: "Song (Remastered)" });
    Stats.creditListening(stats, { ...credit(0, "ID1", "Artist", 30), name: "Song" });
    let history = Stats.emptyListeningHistory();
    Stats.scanLibrary(history, [libraryTrack(1, null)], NOW - 5 * DAY_MS);
    Stats.scanLibrary(history, [libraryTrack(2, NOW - 3 * DAY_MS)], NOW - 2 * DAY_MS);
    Stats.scanLibrary(history, [libraryTrack(4, NOW)], NOW);
    history = imported(
      history,
      [row(3, "Song", "Artist", 180), row(2, "Other", "Artist", 60)],
      day(2),
    );

    const week = Stats.summarizeListening(stats, history, 7, NOW);
    // Days the export covers use it alone: not the scan (200) or T3's 90 on day 3.
    assert.strictEqual(week.days[3]!.seconds, 180);
    assert.strictEqual(week.days[4]!.seconds, 60);
    // Today, after the export: two scanned plays (400) cover T3's 30 seconds of the same song.
    assert.strictEqual(week.days[6]!.seconds, 400);
    assert.strictEqual(week.totalSec, 640);
    // T3's own samples still attribute projects.
    assert.deepStrictEqual(week.projects, [
      { projectId: ProjectId.make("project-a"), seconds: 30 },
    ]);

    const cleared = Stats.summarizeListening(stats, Stats.withoutImportedHistory(history), 7, NOW);
    assert.strictEqual(cleared.days[3]!.seconds, 200);
    assert.isUndefined(cleared.importedThrough);
  });

  it("lets a stopped import hide nothing until its last chunk names the covered day", () => {
    let history = Stats.emptyListeningHistory();
    Stats.scanLibrary(history, [libraryTrack(1, null)], NOW - 3 * DAY_MS);
    Stats.scanLibrary(history, [libraryTrack(3, NOW - 2 * DAY_MS)], NOW - 2 * DAY_MS);
    history = imported(history, [row(3, "Song", "Artist", 50), row(2, "Song", "Artist", 30)]);
    assert.isNull(history.importedThrough);
    const stats = Stats.emptyListeningStats();
    assert.strictEqual(Stats.summarizeListening(stats, history, 7, NOW).days[4]!.seconds, 400);
    history = imported(history, [row(1, "Song", "Artist", 10)], day(1));
    assert.strictEqual(Stats.summarizeListening(stats, history, 7, NOW).days[4]!.seconds, 30);
  });

  it("credits library plays only after a baseline, and never for a new or reset track", () => {
    const history = Stats.emptyListeningHistory();
    const other = (count: number) => ({ ...libraryTrack(count, NOW), id: "0000000000000002" });
    Stats.scanLibrary(history, [libraryTrack(10, NOW)], NOW - 30 * MINUTE_MS);
    Stats.scanLibrary(history, [libraryTrack(3, NOW), other(7)], NOW - 15 * MINUTE_MS);
    assert.deepStrictEqual(history.synced, {});
    Stats.scanLibrary(history, [libraryTrack(4, null), other(8)], NOW);
    assert.strictEqual(total(history, 1), 400);
    // Nothing changed: no reason to rewrite the file.
    assert.isFalse(Stats.scanLibrary(history, [libraryTrack(4, null), other(8)], NOW));
  });

  it("credits no more listening than fits since the last scan, across all songs", () => {
    const tracks = (count: number) =>
      Array.from({ length: 20 }, (_, index) => ({
        ...libraryTrack(count, NOW),
        id: String(index).padStart(16, "0"),
      }));
    const history = Stats.emptyListeningHistory();
    Stats.scanLibrary(history, tracks(1), NOW - 15 * MINUTE_MS);
    // An iCloud merge bumps 20 songs; 15 minutes plus the song playing then holds 5 plays.
    Stats.scanLibrary(history, tracks(2), NOW);
    assert.strictEqual(total(history, 1), 1_000);
  });

  it("leaves plays on exported days to the export", () => {
    let history = Stats.emptyListeningHistory();
    Stats.scanLibrary(history, [libraryTrack(1, null)], NOW - 2 * DAY_MS);
    history = imported(history, [row(1, "Song", "Artist", 100)], day(1));
    // Music was closed across the export's end: the count holds exported plays, so a scan
    // spanning that end only re-baselines, even though the last play came after it.
    Stats.scanLibrary(history, [libraryTrack(3, NOW)], NOW - 30 * MINUTE_MS);
    assert.deepStrictEqual(history.synced, {});
    // Apple may date by UTC: a play just before the UTC end of the exported day is the export's.
    Stats.scanLibrary(
      history,
      [libraryTrack(4, Date.parse(`${day(1)}T23:30:00Z`))],
      NOW - 15 * MINUTE_MS,
    );
    assert.deepStrictEqual(history.synced, {});
    assert.strictEqual(total(history), 100);
    // A later play, in a scan window wholly after the export, counts.
    Stats.scanLibrary(history, [libraryTrack(5, NOW)], NOW);
    assert.strictEqual(total(history), 300);
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

  it.effect("saves an import before reporting success, and refuses one it cannot save", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      const rows = [{ day: Stats.localDayKey(0), name: "Song", artist: "Artist", seconds: 90 }];
      const imported = yield* withStore(
        baseDir,
        Effect.flatMap(Stats.MusicListeningStats, (store) =>
          store.importHistory({ rows, coveredThrough: Stats.localDayKey(0) }),
        ),
      );
      assert.strictEqual(imported.importedThrough, Stats.localDayKey(0));
      const stats = yield* withStore(
        baseDir,
        Effect.flatMap(Stats.MusicListeningStats, (store) => store.summary({ days: 1 })),
      );
      assert.strictEqual(stats.totalSec, 90);

      const blocked = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      const failure = yield* withStore(
        blocked,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const historyPath = (yield* Path.Path).join(config.stateDir, "music-history.json");
          // A directory where the file belongs fails every read.
          yield* fileSystem.makeDirectory(historyPath, { recursive: true });
          const store = yield* Stats.MusicListeningStats;
          const error = yield* Effect.flip(
            store.importHistory({ rows, coveredThrough: rows[0]!.day }),
          );
          // A failed save shows nothing it could not keep.
          return { error, after: yield* store.summary({ days: 1 }) };
        }),
      );
      assert.strictEqual(failure.error.operation, "import-history");
      assert.strictEqual(failure.after.totalSec, 0);
      assert.isUndefined(failure.after.importedThrough);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the library baseline across restarts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      const scan = (playedCount: number) =>
        withStore(
          baseDir,
          Effect.gen(function* () {
            const store = yield* Stats.MusicListeningStats;
            yield* store.scanLibrary([libraryTrack(playedCount, 0)]);
            yield* store.flush;
            return yield* store.summary({ days: 1 });
          }),
        );
      yield* scan(1);
      // A fresh store reads the baseline back, so plays between runs still count.
      assert.strictEqual((yield* scan(2)).totalSec, 200);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("saves the scan clock at least hourly when counts stay the same", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-stats-" });
      const savedScanAt = yield* withStore(
        baseDir,
        Effect.gen(function* () {
          const store = yield* Stats.MusicListeningStats;
          yield* store.scanLibrary([libraryTrack(1, 0)]);
          yield* store.flush;
          yield* TestClock.adjust("2 hours");
          yield* store.scanLibrary([libraryTrack(1, 0)]);
          yield* store.flush;
          const config = yield* ServerConfig.ServerConfig;
          const contents = yield* fileSystem.readFileString(
            (yield* Path.Path).join(config.stateDir, "music-history.json"),
          );
          return (JSON.parse(contents) as { library: { scannedAtMs: number } }).library.scannedAtMs;
        }),
      );
      assert.strictEqual(savedScanAt, 2 * 60 * 60 * 1000);
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
