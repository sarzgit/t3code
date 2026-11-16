import { MusicError, MusicPersistentId, type MusicPlayerState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MusicJsonFile from "./MusicJsonFile.ts";

/** Songs heard while T3 Code watched Music, newest first, one row per song. */
const MAX_RECENT = 200;
const QUALIFY_SECONDS = 30;
/** A song shorter than this counts once half of it is heard. */
const SHORT_SONG_SECONDS = 60;
/** A jump back to the first seconds of the same song is a new play (repeat one, a replay). */
const RESTART_SECONDS = 5;

const StoredText = Schema.String.check(Schema.isMaxLength(500));

const RecentSongFile = Schema.Struct({
  trackId: MusicPersistentId,
  name: StoredText,
  artist: StoredText,
  album: StoredText,
  durationSec: Schema.Number,
  lastPlayedAt: Schema.Number,
});
export type RecentSong = typeof RecentSongFile.Type;

const RecentFile = Schema.Struct({
  version: Schema.Literal(1),
  songs: Schema.Array(RecentSongFile),
});
type RecentFile = typeof RecentFile.Type;

const decodeRecentFile = Schema.decodeUnknownOption(Schema.fromJsonString(RecentFile));
const encodeRecentFile = Schema.encodeEffect(Schema.fromJsonString(RecentFile));
const emptyRecentFile = (): RecentFile => ({ version: 1, songs: [] });

/** Puts `song` on top; an older row for the same song goes. */
export function withRecentPlay(
  songs: ReadonlyArray<RecentSong>,
  song: RecentSong,
): ReadonlyArray<RecentSong> {
  return [song, ...songs.filter((entry) => entry.trackId !== song.trackId)].slice(0, MAX_RECENT);
}

/** How long a play of a song this long must be heard to count. */
const qualifyingSeconds = (durationSec: number) =>
  durationSec > 0 && durationSec < SHORT_SONG_SECONDS ? durationSec / 2 : QUALIFY_SECONDS;

/** The song being heard now and how much of this play has been heard. */
export interface RecentPlay {
  readonly trackId: string;
  readonly listenedSec: number;
  readonly positionSec: number;
  readonly recorded: boolean;
}

/**
 * Follows one watcher sample. Listening is the playing time between consecutive samples of the
 * same song, capped like listening stats; a play counts once, and a new play of the same song
 * (repeat one, a replay from the start) counts again.
 */
export function followRecentPlay(
  play: RecentPlay | null,
  previous: { readonly state: MusicPlayerState; readonly atMs: number } | null,
  state: MusicPlayerState,
  nowMs: number,
  maxCreditSec: number,
): { readonly play: RecentPlay | null; readonly qualified: RecentSong | null } {
  if (state._tag !== "ready" || state.playback === "stopped" || state.track === null) {
    return { play, qualified: null };
  }
  const track = state.track;
  const restarted =
    play !== null &&
    play.trackId === track.id &&
    state.positionSec < RESTART_SECONDS &&
    play.positionSec - state.positionSec > RESTART_SECONDS;
  const fresh = play === null || play.trackId !== track.id || restarted;
  let listenedSec = fresh ? 0 : play.listenedSec;
  const before = previous?.state;
  if (
    !fresh &&
    previous !== null &&
    before?._tag === "ready" &&
    before.playback === "playing" &&
    before.track?.id === track.id
  ) {
    const elapsed = (nowMs - previous.atMs) / 1000;
    if (elapsed > 0 && elapsed <= maxCreditSec) listenedSec += elapsed;
  }
  const recorded = fresh ? false : play.recorded;
  const qualifies = !recorded && listenedSec >= qualifyingSeconds(track.durationSec);
  return {
    play: {
      trackId: track.id,
      listenedSec,
      positionSec: state.positionSec,
      recorded: recorded || qualifies,
    },
    qualified: qualifies
      ? {
          trackId: track.id,
          name: track.name,
          artist: track.artist,
          album: track.album,
          durationSec: track.durationSec,
          lastPlayedAt: nowMs,
        }
      : null,
  };
}

export class MusicRecent extends Context.Service<
  MusicRecent,
  {
    readonly list: Effect.Effect<ReadonlyArray<RecentSong>>;
    /** Buffers in memory; `flush` writes. */
    readonly record: (song: RecentSong) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
    /** Empties memory and the file under the flush lock, so a pending flush can't restore rows. */
    readonly clear: Effect.Effect<void, MusicError>;
  }
>()("t3/music/MusicRecent") {}

const make = Effect.fn("MusicRecent.make")(function* <E>(file: {
  readonly load: Effect.Effect<RecentFile>;
  readonly replace: (next: RecentFile) => Effect.Effect<void, E>;
  readonly isReadOnly: () => boolean;
}) {
  const lock = yield* Semaphore.make(1);
  let songs: ReadonlyArray<RecentSong> = (yield* file.load).songs.slice(0, MAX_RECENT);
  let dirty = false;

  const flush = lock
    .withPermits(1)(
      Effect.suspend(() => {
        if (!dirty || file.isReadOnly()) return Effect.void;
        return file.replace({ version: 1, songs }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              dirty = false;
            }),
          ),
        );
      }),
    )
    .pipe(
      Effect.catchCause((cause) => Effect.logWarning("music recent flush failed", { cause })),
      Effect.withSpan("MusicRecent.flush"),
    );

  const clear = lock
    .withPermits(1)(
      Effect.gen(function* () {
        if (!file.isReadOnly()) yield* file.replace(emptyRecentFile());
        songs = [];
        dirty = false;
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new MusicError({ operation: "recent", reason: "unavailable", cause }),
      ),
      Effect.withSpan("MusicRecent.clear"),
    );

  yield* Effect.addFinalizer(() => flush);

  return MusicRecent.of({
    list: lock.withPermits(1)(Effect.sync(() => songs)),
    record: Effect.fn("MusicRecent.record")(function* (song: RecentSong) {
      yield* lock.withPermits(1)(
        Effect.sync(() => {
          songs = withRecentPlay(songs, song);
          dirty = true;
        }),
      );
    }),
    flush,
    clear,
  });
});

export const layer = Layer.effect(
  MusicRecent,
  Effect.gen(function* () {
    const file = yield* MusicJsonFile.make<RecentFile>({
      fileName: "music-recent.json",
      decode: decodeRecentFile,
      encode: encodeRecentFile,
      empty: emptyRecentFile,
    });
    return yield* make(file);
  }),
);

/** Keeps the file in memory, for tests and hosts that never persist. */
export const layerMemory = (initial: ReadonlyArray<RecentSong> = []) =>
  Layer.effect(
    MusicRecent,
    Effect.gen(function* () {
      let stored: RecentFile = { version: 1, songs: initial };
      return yield* make({
        load: Effect.sync(() => stored),
        replace: (next) =>
          Effect.sync(() => {
            stored = next;
          }),
        isReadOnly: () => false,
      });
    }),
  );
