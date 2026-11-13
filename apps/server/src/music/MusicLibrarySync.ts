import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { type LibraryTrack, MusicListeningStats } from "./MusicListeningStats.ts";
import { JXA_NO_DOCK_ICON } from "./MusicPlayer.ts";

// Reads whole columns in one Apple event each (~0.2 s for 900 songs). `running()` never
// launches Music, so a scan while Music is closed costs one osascript.
const LIBRARY_SCRIPT = `function run() {
  const Music = Application("Music");
  if (!Music.running()) return JSON.stringify({ running: false });
  const tracks = Music.libraryPlaylists[0].tracks;
  return JSON.stringify({
    running: true,
    ids: tracks.persistentID(),
    names: tracks.name(),
    artists: tracks.artist(),
    durations: tracks.duration(),
    counts: tracks.playedCount(),
    playedAt: tracks.playedDate().map((date) => (date ? date.getTime() : null)),
  });
}`;

const FIRST_SCAN_DELAY = Duration.minutes(1);
const SCAN_INTERVAL = Duration.minutes(15);
const SCAN_TIMEOUT = Duration.minutes(1);
const MAX_SCAN_BYTES = 32 * 1024 * 1024;
const MAX_TEXT = 500;
const PERSISTENT_ID = /^[0-9A-F]{16}$/;

const RawLibrary = Schema.Union([
  Schema.Struct({ running: Schema.Literal(false) }),
  Schema.Struct({
    running: Schema.Literal(true),
    ids: Schema.Array(Schema.NullOr(Schema.String)),
    names: Schema.Array(Schema.NullOr(Schema.String)),
    artists: Schema.Array(Schema.NullOr(Schema.String)),
    durations: Schema.Array(Schema.NullOr(Schema.Number)),
    counts: Schema.Array(Schema.NullOr(Schema.Number)),
    playedAt: Schema.Array(Schema.NullOr(Schema.Number)),
  }),
]);
const decodeRawLibrary = Schema.decodeUnknownOption(Schema.fromJsonString(RawLibrary));

/** Library tracks from one scan; null when Music is closed or the output is not a scan. */
export function decodeLibraryScan(output: string): ReadonlyArray<LibraryTrack> | null {
  const raw = Option.getOrNull(decodeRawLibrary(output));
  if (raw === null || !raw.running) return null;
  const length = raw.ids.length;
  if (
    [raw.names, raw.artists, raw.durations, raw.counts, raw.playedAt].some(
      (column) => column.length !== length,
    )
  ) {
    return null;
  }
  return raw.ids.flatMap((id, index) => {
    const count = raw.counts[index];
    if (id === null || !PERSISTENT_ID.test(id)) return [];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return [];
    const duration = raw.durations[index];
    const playedAt = raw.playedAt[index];
    return [
      {
        id,
        name: (raw.names[index] ?? "").slice(0, MAX_TEXT),
        artist: (raw.artists[index] ?? "").slice(0, MAX_TEXT),
        durationSec: typeof duration === "number" && Number.isFinite(duration) ? duration : 0,
        playedCount: count,
        playedAtMs: typeof playedAt === "number" && Number.isFinite(playedAt) ? playedAt : null,
      },
    ];
  });
}

/** Keeps listening history current from Music's library play counts, which iCloud syncs. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;
    const runner = yield* ProcessRunner.ProcessRunner;
    const listening = yield* MusicListeningStats;

    const scan = Effect.gen(function* () {
      const output = yield* runner.run({
        command: "osascript",
        args: ["-l", "JavaScript", "-e", JXA_NO_DOCK_ICON + LIBRARY_SCRIPT],
        timeout: SCAN_TIMEOUT,
        maxOutputBytes: MAX_SCAN_BYTES,
      });
      if (output.code !== 0) return;
      const tracks = decodeLibraryScan(output.stdout.trim());
      // Music can answer before its library loads; an empty scan would wipe the baseline.
      if (tracks === null || tracks.length === 0) return;
      yield* listening.scanLibrary(tracks);
      yield* listening.flush;
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("music library scan failed", { cause })),
      Effect.withSpan("MusicLibrarySync.scan"),
    );

    yield* Effect.sleep(FIRST_SCAN_DELAY).pipe(
      Effect.andThen(Effect.forever(scan.pipe(Effect.andThen(Effect.sleep(SCAN_INTERVAL))))),
      Effect.forkScoped,
    );
  }),
);
