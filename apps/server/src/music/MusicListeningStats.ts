import { MusicError, type MusicStats, type MusicStatsInput, ProjectId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";

export interface ListeningCredit {
  /** Server-local `YYYY-MM-DD`. */
  readonly day: string;
  readonly trackId: string;
  readonly name: string;
  readonly artist: string;
  readonly seconds: number;
  readonly projectIds: ReadonlyArray<string>;
}

const StatsTrack = Schema.Struct({
  name: Schema.String,
  artist: Schema.String,
  seconds: Schema.Number,
});
const StatsDay = Schema.Struct({
  seconds: Schema.Number,
  artists: Schema.Record(Schema.String, Schema.Number),
  tracks: Schema.Record(Schema.String, StatsTrack),
  projects: Schema.Record(Schema.String, Schema.Number),
});
const StatsFile = Schema.Struct({
  version: Schema.Literal(1),
  days: Schema.Record(Schema.String, StatsDay),
});
interface ListeningDay {
  seconds: number;
  artists: Record<string, number>;
  tracks: Record<string, { name: string; artist: string; seconds: number }>;
  projects: Record<string, number>;
}
export interface ListeningStatsFile {
  readonly version: 1;
  readonly days: Record<string, ListeningDay>;
}

const decodeStatsFile = Schema.decodeUnknownOption(Schema.fromJsonString(StatsFile));
const encodeStatsFile = Schema.encodeEffect(Schema.fromJsonString(StatsFile));

export const RETAINED_DAYS = 400;
const TOP_COUNT = 5;

/** Keys are song, artist and project names, so "constructor" or "__proto__" must stay plain keys. */
const dictionary = <A>(): Record<string, A> => Object.create(null);

export const emptyListeningStats = (): ListeningStatsFile => ({ version: 1, days: dictionary() });

function reviveDays(days: (typeof StatsFile.Type)["days"]): ListeningStatsFile["days"] {
  const revived = dictionary<ListeningDay>();
  for (const [date, day] of Object.entries(days)) {
    revived[date] = {
      seconds: day.seconds,
      artists: Object.assign(dictionary<number>(), day.artists),
      tracks: Object.assign(dictionary<ListeningDay["tracks"][string]>(), day.tracks),
      projects: Object.assign(dictionary<number>(), day.projects),
    };
  }
  return revived;
}

const localZone = DateTime.zoneMakeLocal();
const localDateTime = (ms: number) => DateTime.makeZonedUnsafe(ms, { timeZone: localZone });

export function localDayKey(ms: number): string {
  return DateTime.formatIsoDate(localDateTime(ms));
}

/** The `count` local day keys ending at `todayMs`, oldest first. */
function dayKeysEnding(todayMs: number, count: number): ReadonlyArray<string> {
  const today = localDateTime(todayMs);
  return Array.from({ length: count }, (_, index) =>
    DateTime.formatIsoDate(DateTime.subtract(today, { days: count - 1 - index })),
  );
}

/** Mutates `file`: it is the in-memory copy that the store flushes. */
export function creditListening(file: ListeningStatsFile, credit: ListeningCredit): void {
  if (!(credit.seconds > 0)) return;
  const day = (file.days[credit.day] ??= {
    seconds: 0,
    artists: dictionary(),
    tracks: dictionary(),
    projects: dictionary(),
  });
  day.seconds += credit.seconds;
  if (credit.artist !== "") {
    day.artists[credit.artist] = (day.artists[credit.artist] ?? 0) + credit.seconds;
  }
  const track = day.tracks[credit.trackId];
  day.tracks[credit.trackId] = {
    name: credit.name,
    artist: credit.artist,
    seconds: (track?.seconds ?? 0) + credit.seconds,
  };
  for (const projectId of credit.projectIds) {
    day.projects[projectId] = (day.projects[projectId] ?? 0) + credit.seconds;
  }
}

/** Mutates `file`, dropping days older than the retention window. */
export function pruneListening(file: ListeningStatsFile, todayMs: number): void {
  const oldest = dayKeysEnding(todayMs, RETAINED_DAYS)[0]!;
  for (const day of Object.keys(file.days)) {
    if (day < oldest) delete file.days[day];
  }
}

const top = <A>(entries: Map<string, A & { seconds: number }>) =>
  [...entries.values()].toSorted((left, right) => right.seconds - left.seconds).slice(0, TOP_COUNT);

export function summarizeListening(
  file: ListeningStatsFile,
  days: MusicStatsInput["days"],
  todayMs: number,
): MusicStats {
  const artists = new Map<string, { name: string; seconds: number }>();
  const tracks = new Map<string, { name: string; artist: string; seconds: number }>();
  const projects = new Map<string, { projectId: ProjectId; seconds: number }>();
  const dayTotals = dayKeysEnding(todayMs, days).map((date) => {
    const day = file.days[date];
    if (day === undefined) return { date, seconds: 0 };
    for (const [name, seconds] of Object.entries(day.artists)) {
      const entry = artists.get(name) ?? { name, seconds: 0 };
      entry.seconds += seconds;
      artists.set(name, entry);
    }
    for (const [id, track] of Object.entries(day.tracks)) {
      const entry = tracks.get(id) ?? { name: track.name, artist: track.artist, seconds: 0 };
      entry.seconds += track.seconds;
      tracks.set(id, entry);
    }
    for (const [projectId, seconds] of Object.entries(day.projects)) {
      const entry = projects.get(projectId) ?? { projectId: ProjectId.make(projectId), seconds: 0 };
      entry.seconds += seconds;
      projects.set(projectId, entry);
    }
    return { date, seconds: day.seconds };
  });
  return {
    totalSec: dayTotals.reduce((sum, day) => sum + day.seconds, 0),
    days: dayTotals,
    artists: top(artists),
    tracks: top(tracks),
    projects: top(projects),
  };
}

export class MusicListeningStats extends Context.Service<
  MusicListeningStats,
  {
    /** Buffers in memory; `flush` writes. */
    readonly credit: (credit: ListeningCredit) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
    readonly summary: (input: MusicStatsInput) => Effect.Effect<MusicStats, MusicError>;
  }
>()("t3/music/MusicListeningStats") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "music-stats.json");
  const lock = yield* Semaphore.make(1);
  let loaded: ListeningStatsFile | null = null;
  let dirty = false;
  // Set when the existing file could not be read or moved aside, so it is never overwritten.
  let readOnly = false;

  // Only a missing file starts empty. One that can't be read stays untouched and this run keeps
  // stats in memory; one that can't be decoded is moved aside before a fresh file replaces it.
  const load = Effect.gen(function* () {
    if (loaded !== null) return loaded;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.option);
    if (Option.isSome(exists) && !exists.value) {
      loaded = emptyListeningStats();
      return loaded;
    }
    const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
    if (Option.isNone(contents)) {
      readOnly = true;
      yield* Effect.logWarning("music stats file could not be read; not saving this run", {
        filePath,
      });
      loaded = emptyListeningStats();
      return loaded;
    }
    const decoded = decodeStatsFile(contents.value);
    if (Option.isNone(decoded)) {
      const aside = `${filePath}.unreadable-${yield* Clock.currentTimeMillis}`;
      yield* fileSystem.rename(filePath, aside).pipe(
        Effect.tap(() =>
          Effect.logWarning("music stats file was unreadable; kept it aside", { aside }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            readOnly = true;
          }).pipe(
            Effect.andThen(
              Effect.logWarning("music stats file could not be moved aside; not saving", { cause }),
            ),
          ),
        ),
      );
    }
    loaded = Option.isSome(decoded)
      ? { version: 1, days: reviveDays(decoded.value.days) }
      : emptyListeningStats();
    return loaded;
  });

  // Runs about once a second while music plays; the watcher run owns the span.
  const credit = Effect.fnUntraced(function* (entry: ListeningCredit) {
    yield* lock.withPermits(1)(
      load.pipe(
        Effect.map((file) => {
          creditListening(file, entry);
          dirty = true;
        }),
      ),
    );
  });

  const flush = lock.withPermits(1)(
    Effect.gen(function* () {
      if (!dirty || loaded === null || readOnly) return;
      pruneListening(loaded, yield* Clock.currentTimeMillis);
      const contents = yield* encodeStatsFile(loaded);
      yield* writeFileStringAtomically({ filePath, contents }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      dirty = false;
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("music stats flush failed", { cause })),
      Effect.withSpan("MusicListeningStats.flush"),
    ),
  );

  const summary = Effect.fn("MusicListeningStats.summary")(function* (input: MusicStatsInput) {
    const file = yield* lock.withPermits(1)(load);
    return summarizeListening(file, input.days, yield* Clock.currentTimeMillis);
  });

  yield* Effect.addFinalizer(() => flush);

  return MusicListeningStats.of({ credit, flush, summary });
});

export const layer = Layer.effect(MusicListeningStats, make);

/** In-memory store for tests and hosts that never persist. */
export const layerMemory = Layer.sync(MusicListeningStats, () => {
  const file = emptyListeningStats();
  return MusicListeningStats.of({
    credit: Effect.fnUntraced(function* (entry: ListeningCredit) {
      yield* Effect.sync(() => creditListening(file, entry));
    }),
    flush: Effect.void,
    summary: Effect.fnUntraced(function* (input: MusicStatsInput) {
      return summarizeListening(file, input.days, yield* Clock.currentTimeMillis);
    }),
  });
});
