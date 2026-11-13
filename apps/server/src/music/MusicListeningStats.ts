import {
  MusicError,
  type MusicImportHistoryInput,
  type MusicImportHistoryResult,
  type MusicStats,
  type MusicStatsInput,
  ProjectId,
} from "@t3tools/contracts";
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

/** One library track as Music reports it; a scan compares play counts with the last one. */
export interface LibraryTrack {
  readonly id: string;
  readonly name: string;
  readonly artist: string;
  readonly durationSec: number;
  readonly playedCount: number;
  readonly playedAtMs: number | null;
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
const HistoryDays = Schema.Record(Schema.String, Schema.Record(Schema.String, StatsTrack));
const HistoryFile = Schema.Struct({
  version: Schema.Literal(1),
  importedThrough: Schema.NullOr(Schema.String),
  imported: HistoryDays,
  synced: HistoryDays,
  library: Schema.NullOr(
    Schema.Struct({
      scannedAtMs: Schema.Number,
      counts: Schema.Record(Schema.String, Schema.Number),
    }),
  ),
});

interface SongSeconds {
  name: string;
  artist: string;
  seconds: number;
}
interface ListeningDay {
  seconds: number;
  artists: Record<string, number>;
  tracks: Record<string, SongSeconds>;
  projects: Record<string, number>;
}
export interface ListeningStatsFile {
  readonly version: 1;
  readonly days: Record<string, ListeningDay>;
}
/** Song key → seconds, per day. */
type HistoryDays = Record<string, Record<string, SongSeconds>>;
/**
 * Listening from outside T3's own sampling: Apple's export (`imported`) and Music library
 * play counts (`synced`). Never pruned; it has no project attribution.
 */
export interface ListeningHistoryFile {
  version: 1;
  /** Last day any import covered. Imported data is authoritative up to and including it. */
  importedThrough: string | null;
  imported: HistoryDays;
  synced: HistoryDays;
  /** Play counts at the last library scan; null until the first scan sets a baseline. */
  library: { scannedAtMs: number; counts: Record<string, number> } | null;
}

const decodeStatsFile = Schema.decodeUnknownOption(Schema.fromJsonString(StatsFile));
const encodeStatsFile = Schema.encodeEffect(Schema.fromJsonString(StatsFile));
const decodeHistoryFile = Schema.decodeUnknownOption(Schema.fromJsonString(HistoryFile));
const encodeHistoryFile = Schema.encodeEffect(Schema.fromJsonString(HistoryFile));

export const RETAINED_DAYS = 400;
const TOP_COUNT = 5;
const DAY_SECONDS = 86_400;

/** Keys are song, artist and project names, so "constructor" or "__proto__" must stay plain keys. */
const dictionary = <A>(): Record<string, A> => Object.create(null);

export const emptyListeningStats = (): ListeningStatsFile => ({ version: 1, days: dictionary() });

export const emptyListeningHistory = (): ListeningHistoryFile => ({
  version: 1,
  importedThrough: null,
  imported: dictionary(),
  synced: dictionary(),
  library: null,
});

function reviveDays(days: (typeof StatsFile.Type)["days"]): ListeningStatsFile["days"] {
  const revived = dictionary<ListeningDay>();
  for (const [date, day] of Object.entries(days)) {
    revived[date] = {
      seconds: day.seconds,
      artists: Object.assign(dictionary<number>(), day.artists),
      tracks: Object.assign(dictionary<SongSeconds>(), day.tracks),
      projects: Object.assign(dictionary<number>(), day.projects),
    };
  }
  return revived;
}

function reviveHistoryDays(days: (typeof HistoryFile.Type)["imported"]): HistoryDays {
  const revived = dictionary<Record<string, SongSeconds>>();
  for (const [date, songs] of Object.entries(days)) {
    revived[date] = Object.assign(dictionary<SongSeconds>(), songs);
  }
  return revived;
}

function reviveHistory(file: typeof HistoryFile.Type): ListeningHistoryFile {
  return {
    version: 1,
    importedThrough: file.importedThrough,
    imported: reviveHistoryDays(file.imported),
    synced: reviveHistoryDays(file.synced),
    library:
      file.library === null
        ? null
        : {
            scannedAtMs: file.library.scannedAtMs,
            counts: Object.assign(dictionary<number>(), file.library.counts),
          },
  };
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

/**
 * Matches a song across T3's samples (keyed by Music persistent id), Apple's export (keyed by
 * its description) and library scans, so the same play from two sources is counted once.
 */
function songKey(name: string, artist: string): string {
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  return `${normalize(artist)}\u0000${normalize(name)}`;
}

const addSeconds = (
  songs: Record<string, SongSeconds>,
  key: string,
  song: { name: string; artist: string },
  seconds: number,
) => {
  const entry = songs[key];
  songs[key] =
    entry === undefined
      ? { name: song.name, artist: song.artist, seconds }
      : { ...entry, seconds: entry.seconds + seconds };
};

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

/** A real calendar day no later than tomorrow (Apple's export may date by UTC). */
function isImportableDay(day: string, todayMs: number): boolean {
  const date = DateTime.make(`${day}T00:00:00Z`);
  return (
    Option.isSome(date) &&
    DateTime.formatIsoDateUtc(date.value) === day &&
    day <= localDayKey(todayMs + 24 * 60 * 60 * 1000)
  );
}

/**
 * Returns a new file and leaves `file` untouched, so a failed save changes nothing. Rows for the
 * same day and song within a chunk add up (Apple's export repeats them); across chunks and
 * imports the larger value wins, so re-importing a full export, or one that overlaps an earlier
 * one, changes nothing. `coveredThrough` comes with the last chunk and can't pass imported rows.
 */
export function withImportedHistory(
  file: ListeningHistoryFile,
  input: MusicImportHistoryInput,
  todayMs: number,
): ListeningHistoryFile {
  const chunk = dictionary<Record<string, SongSeconds>>();
  for (const row of input.rows) {
    if (!(row.seconds > 0) || !isImportableDay(row.day, todayMs)) continue;
    addSeconds((chunk[row.day] ??= dictionary()), songKey(row.name, row.artist), row, row.seconds);
  }
  const imported = Object.assign(dictionary<Record<string, SongSeconds>>(), file.imported);
  for (const [day, songs] of Object.entries(chunk)) {
    const stored = Object.assign(dictionary<SongSeconds>(), imported[day]);
    for (const [key, song] of Object.entries(songs)) {
      const seconds = Math.min(song.seconds, DAY_SECONDS);
      if (seconds > (stored[key]?.seconds ?? 0)) stored[key] = { ...song, seconds };
    }
    imported[day] = stored;
  }
  let importedThrough = file.importedThrough;
  const covered = input.coveredThrough;
  if (
    covered !== undefined &&
    (importedThrough === null || covered > importedThrough) &&
    Object.keys(imported).some((day) => day >= covered)
  ) {
    importedThrough = covered;
  }
  return { ...file, imported, importedThrough };
}

/** Returns a new file without imported history; scans and the library baseline stay. */
export function withoutImportedHistory(file: ListeningHistoryFile): ListeningHistoryFile {
  return { ...file, imported: dictionary(), importedThrough: null };
}

/**
 * Mutates `file`; true when worth saving. Music counts a play once a song finishes, so a new
 * play earns the song's length on its last-played day. The first scan, a dropped count and an
 * unseen id (a rebuilt library) only set a baseline. Exported days are left to the export.
 */
export function scanLibrary(
  file: ListeningHistoryFile,
  tracks: ReadonlyArray<LibraryTrack>,
  nowMs: number,
): boolean {
  const counts = dictionary<number>();
  for (const track of tracks) counts[track.id] = track.playedCount;
  const previous = file.library;
  file.library = { scannedAtMs: nowMs, counts };
  if (previous === null) return true;
  let changed = Object.keys(previous.counts).length !== tracks.length;
  const increased = tracks.filter((track) => {
    const before = previous.counts[track.id];
    if (before !== track.playedCount) changed = true;
    return before !== undefined && track.playedCount > before && track.durationSec > 0;
  });
  // One budget for the whole scan: no more listening than fits since the last scan (plus the
  // song already playing then), so an iCloud merge of old counts can't flood the stats.
  let budgetSec =
    Math.max(0, nowMs - previous.scannedAtMs) / 1000 +
    Math.max(0, ...increased.map((track) => track.durationSec));
  const newestFirst = increased.toSorted(
    (left, right) => (right.playedAtMs ?? nowMs) - (left.playedAtMs ?? nowMs),
  );
  for (const track of newestFirst) {
    const day = localDayKey(track.playedAtMs ?? nowMs);
    if (file.importedThrough !== null && day <= file.importedThrough) continue;
    const plays = Math.min(
      track.playedCount - previous.counts[track.id]!,
      Math.floor(budgetSec / track.durationSec),
    );
    if (plays <= 0) continue;
    const seconds = plays * track.durationSec;
    budgetSec -= seconds;
    addSeconds(
      (file.synced[day] ??= dictionary()),
      songKey(track.name, track.artist),
      track,
      seconds,
    );
  }
  return changed;
}

const daySeconds = (songs: ReadonlyArray<SongSeconds>) =>
  songs.reduce((sum, song) => sum + song.seconds, 0);
const larger = (left: ReadonlyArray<SongSeconds>, right: ReadonlyArray<SongSeconds>) =>
  daySeconds(left) >= daySeconds(right) ? left : right;

/**
 * The export covers the whole account, so its days use it alone (it may date by UTC; mixing
 * local days in could count a midnight play twice). Later days take the source that saw most:
 * one play can sit in several under different names, so sources are never added together.
 */
function mergeDay(
  stats: ListeningStatsFile,
  history: ListeningHistoryFile,
  date: string,
): ReadonlyArray<SongSeconds> {
  const imported = Object.values(history.imported[date] ?? {});
  if (history.importedThrough !== null && date <= history.importedThrough) return imported;
  const local = Object.values(stats.days[date]?.tracks ?? {});
  const synced = Object.values(history.synced[date] ?? {});
  return larger(larger(imported, synced), local);
}

const top = <A>(entries: Map<string, A & { seconds: number }>) =>
  [...entries.values()].toSorted((left, right) => right.seconds - left.seconds).slice(0, TOP_COUNT);

export function summarizeListening(
  stats: ListeningStatsFile,
  history: ListeningHistoryFile,
  days: MusicStatsInput["days"],
  todayMs: number,
): MusicStats {
  const artists = new Map<string, { name: string; seconds: number }>();
  const tracks = new Map<string, SongSeconds>();
  const projects = new Map<string, { projectId: ProjectId; seconds: number }>();
  const dayTotals = dayKeysEnding(todayMs, days).map((date) => {
    const songs = mergeDay(stats, history, date);
    for (const song of songs) {
      const key = songKey(song.name, song.artist);
      const track = tracks.get(key) ?? { name: song.name, artist: song.artist, seconds: 0 };
      track.seconds += song.seconds;
      tracks.set(key, track);
      if (song.artist !== "") {
        const artistKey = song.artist.normalize("NFKC").trim().toLowerCase();
        const artist = artists.get(artistKey) ?? { name: song.artist, seconds: 0 };
        artist.seconds += song.seconds;
        artists.set(artistKey, artist);
      }
    }
    for (const [projectId, seconds] of Object.entries(stats.days[date]?.projects ?? {})) {
      const entry = projects.get(projectId) ?? { projectId: ProjectId.make(projectId), seconds: 0 };
      entry.seconds += seconds;
      projects.set(projectId, entry);
    }
    return { date, seconds: Math.min(daySeconds(songs), DAY_SECONDS) };
  });
  return {
    totalSec: dayTotals.reduce((sum, day) => sum + day.seconds, 0),
    days: dayTotals,
    ...(history.importedThrough === null ? {} : { importedThrough: history.importedThrough }),
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
    /** Buffers in memory; `flush` writes. */
    readonly scanLibrary: (tracks: ReadonlyArray<LibraryTrack>) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
    readonly summary: (input: MusicStatsInput) => Effect.Effect<MusicStats, MusicError>;
    /** Saved before it returns, so a success means the rows are on disk. */
    readonly importHistory: (
      input: MusicImportHistoryInput,
    ) => Effect.Effect<MusicImportHistoryResult, MusicError>;
    readonly clearHistory: Effect.Effect<void, MusicError>;
  }
>()("t3/music/MusicListeningStats") {}

/**
 * Loads a JSON file once. Only a missing file starts empty. One that can't be read stays
 * untouched and is never written this run; one that can't be decoded is moved aside first.
 */
const makeJsonFile = Effect.fn("MusicListeningStats.makeJsonFile")(function* <A>(options: {
  readonly fileName: string;
  readonly decode: (contents: string) => Option.Option<A>;
  readonly encode: (value: A) => Effect.Effect<string, Schema.SchemaError>;
  readonly empty: () => A;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, options.fileName);
  let loaded: A | null = null;
  let readOnly = false;

  const load = Effect.gen(function* () {
    if (loaded !== null) return loaded;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.option);
    if (Option.isSome(exists) && !exists.value) {
      loaded = options.empty();
      return loaded;
    }
    const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
    if (Option.isNone(contents)) {
      readOnly = true;
      yield* Effect.logWarning("music data file could not be read; not saving this run", {
        filePath,
      });
      loaded = options.empty();
      return loaded;
    }
    const decoded = options.decode(contents.value);
    if (Option.isNone(decoded)) {
      const aside = `${filePath}.unreadable-${yield* Clock.currentTimeMillis}`;
      yield* fileSystem.rename(filePath, aside).pipe(
        Effect.tap(() =>
          Effect.logWarning("music data file was unreadable; kept it aside", { aside }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            readOnly = true;
          }).pipe(
            Effect.andThen(
              Effect.logWarning("music data file could not be moved aside; not saving", {
                cause,
              }),
            ),
          ),
        ),
      );
    }
    loaded = Option.isSome(decoded) ? decoded.value : options.empty();
    return loaded;
  });

  /** Fails when the file must not be written this run or the write fails. */
  const save = Effect.fn("MusicListeningStats.save")(function* (value: A) {
    if (readOnly) return yield* Effect.fail("read-only" as const);
    const contents = yield* options.encode(value);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });
  const write = Effect.suspend(() => (loaded === null ? Effect.void : save(loaded)));
  /** Saves `next` and only then makes it the loaded value. */
  const replace = (next: A) =>
    save(next).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          loaded = next;
        }),
      ),
    );

  return { load, write, replace, isReadOnly: () => readOnly };
});

const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const stats = yield* makeJsonFile({
    fileName: "music-stats.json",
    decode: (contents) =>
      Option.map(decodeStatsFile(contents), (file) => ({
        version: 1 as const,
        days: reviveDays(file.days),
      })),
    encode: encodeStatsFile,
    empty: emptyListeningStats,
  });
  const history = yield* makeJsonFile({
    fileName: "music-history.json",
    decode: (contents) => Option.map(decodeHistoryFile(contents), reviveHistory),
    encode: encodeHistoryFile,
    empty: emptyListeningHistory,
  });
  let statsDirty = false;
  let historyDirty = false;

  // Runs about once a second while music plays; the watcher run owns the span.
  const credit = Effect.fnUntraced(function* (entry: ListeningCredit) {
    yield* lock.withPermits(1)(
      stats.load.pipe(
        Effect.map((file) => {
          creditListening(file, entry);
          statsDirty = true;
        }),
      ),
    );
  });

  const scan = Effect.fn("MusicListeningStats.scanLibrary")(function* (
    tracks: ReadonlyArray<LibraryTrack>,
  ) {
    const now = yield* Clock.currentTimeMillis;
    yield* lock.withPermits(1)(
      history.load.pipe(
        Effect.map((file) => {
          if (scanLibrary(file, tracks, now)) historyDirty = true;
        }),
      ),
    );
  });

  // Each file flushes on its own, so one failing write never holds back the other.
  const flushStats = Effect.gen(function* () {
    if (!statsDirty || stats.isReadOnly()) return;
    pruneListening(yield* stats.load, yield* Clock.currentTimeMillis);
    yield* stats.write;
    statsDirty = false;
  });
  const flushHistory = Effect.gen(function* () {
    if (!historyDirty || history.isReadOnly()) return;
    yield* history.write;
    historyDirty = false;
  });
  const flush = lock
    .withPermits(1)(
      Effect.forEach([flushStats, flushHistory], (write) =>
        write.pipe(
          Effect.catchCause((cause) => Effect.logWarning("music stats flush failed", { cause })),
        ),
      ),
    )
    .pipe(Effect.asVoid, Effect.withSpan("MusicListeningStats.flush"));

  const summary = Effect.fn("MusicListeningStats.summary")(function* (input: MusicStatsInput) {
    const [statsFile, historyFile] = yield* lock.withPermits(1)(
      Effect.all([stats.load, history.load]),
    );
    return summarizeListening(statsFile, historyFile, input.days, yield* Clock.currentTimeMillis);
  });

  // An import or removal the user waits on is saved before it reports success, and a failed
  // save leaves both the file and what summaries show unchanged.
  const changeHistory = (change: (file: ListeningHistoryFile) => ListeningHistoryFile) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const next = change(yield* history.load);
          yield* history.replace(next);
          historyDirty = false;
          return next;
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.fail(
            new MusicError({ operation: "import-history", reason: "unavailable", cause }),
          ),
        ),
      );

  const importHistory = Effect.fn("MusicListeningStats.importHistory")(function* (
    input: MusicImportHistoryInput,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const next = yield* changeHistory((file) => withImportedHistory(file, input, now));
    return { importedThrough: next.importedThrough } satisfies MusicImportHistoryResult;
  });

  const clearHistory = changeHistory(withoutImportedHistory).pipe(
    Effect.asVoid,
    Effect.withSpan("MusicListeningStats.clearHistory"),
  );

  yield* Effect.addFinalizer(() => flush);

  return MusicListeningStats.of({
    credit,
    scanLibrary: scan,
    flush,
    summary,
    importHistory,
    clearHistory,
  });
});

export const layer = Layer.effect(MusicListeningStats, make);

/** In-memory store for tests and hosts that never persist. */
export const layerMemory = Layer.sync(MusicListeningStats, () => {
  const stats = emptyListeningStats();
  let history = emptyListeningHistory();
  return MusicListeningStats.of({
    credit: Effect.fnUntraced(function* (entry: ListeningCredit) {
      yield* Effect.sync(() => creditListening(stats, entry));
    }),
    scanLibrary: Effect.fnUntraced(function* (tracks: ReadonlyArray<LibraryTrack>) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sync(() => scanLibrary(history, tracks, now));
    }),
    flush: Effect.void,
    summary: Effect.fnUntraced(function* (input: MusicStatsInput) {
      return summarizeListening(stats, history, input.days, yield* Clock.currentTimeMillis);
    }),
    importHistory: Effect.fnUntraced(function* (input: MusicImportHistoryInput) {
      const now = yield* Clock.currentTimeMillis;
      return yield* Effect.sync(() => {
        history = withImportedHistory(history, input, now);
        return { importedThrough: history.importedThrough };
      });
    }),
    clearHistory: Effect.sync(() => {
      history = withoutImportedHistory(history);
    }),
  });
});
