import { MusicPersistentId, MusicQueueEntryKey, MusicQueueId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MusicJsonFile from "./MusicJsonFile.ts";
import * as MusicQueue from "./MusicQueue.ts";

/** Labels for the saved entry only, so a Resume card never has to ask Music. */
export interface QueueDisplay {
  readonly trackName?: string;
  readonly artist?: string;
  readonly sourceName?: string;
}

const MAX_HINT = 300;
const hint = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.slice(0, MAX_HINT) : undefined;

/** A missing or malformed hint is dropped alone; it never discards the queue. */
export function sanitizeDisplay(value: unknown): QueueDisplay {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const trackName = hint(raw.trackName);
  const artist = hint(raw.artist);
  const sourceName = hint(raw.sourceName);
  return {
    ...(trackName === undefined ? {} : { trackName }),
    ...(artist === undefined ? {} : { artist }),
    ...(sourceName === undefined ? {} : { sourceName }),
  };
}

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const StoredText = Schema.String.check(Schema.isMaxLength(500));

const StoredSong = Schema.Struct({
  playlistId: MusicPersistentId,
  trackId: MusicPersistentId,
  index: Index,
  meta: Schema.NullOr(
    Schema.Struct({ name: StoredText, artist: StoredText, durationSec: Schema.Number }),
  ),
});

const Formula = Schema.Struct({
  playlistId: MusicPersistentId,
  seed: Schema.Int,
  /** STEP_SCRIPT's shuffle start: a position, "free" for a whole shuffle, or null for none. */
  shuffleFirst: Schema.NullOr(Schema.Union([Schema.Literal("free"), Index])),
  shuffled: Schema.Boolean,
});
export type QueueFormula = typeof Formula.Type;

const QueueBodyFile = Schema.Struct({
  version: Schema.Literal(1),
  id: MusicQueueId,
  revision: Revision,
  currentKey: MusicQueueEntryKey,
  trackId: MusicPersistentId,
  display: Schema.optionalKey(Schema.Unknown),
  formula: Schema.optionalKey(Formula),
  source: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(["playlist", "favourites", "recent"]),
      playlistId: Schema.optionalKey(MusicPersistentId),
      ids: Schema.optionalKey(Schema.Array(MusicPersistentId)),
      original: Schema.optionalKey(Schema.Array(StoredSong)),
    }),
  ),
  order: Schema.optionalKey(Schema.Array(Schema.Int)),
  added: Schema.optionalKey(Schema.Array(StoredSong)),
  shuffle: Schema.optionalKey(Schema.NullOr(Schema.Struct({ seed: Schema.Int }))),
});
export type QueueBody = typeof QueueBodyFile.Type;

const QueuePositionFile = Schema.Struct({
  version: Schema.Literal(1),
  id: MusicQueueId,
  revision: Revision,
  currentKey: MusicQueueEntryKey,
  trackId: MusicPersistentId,
  positionSec: Schema.Number,
  savedAt: Schema.Number,
  display: Schema.optionalKey(Schema.Unknown),
  /** Whether T3 still played this queue when the checkpoint was written; absent in older files. */
  active: Schema.optionalKey(Schema.Boolean),
});
export type QueuePosition = typeof QueuePositionFile.Type;

const decodeBody = Schema.decodeUnknownOption(Schema.fromJsonString(QueueBodyFile));
const encodeBody = Schema.encodeEffect(Schema.fromJsonString(QueueBodyFile));
const decodePosition = Schema.decodeUnknownOption(Schema.fromJsonString(QueuePositionFile));
const encodePosition = Schema.encodeEffect(Schema.fromJsonString(QueuePositionFile));

export function bodyFromExplicit(
  queue: MusicQueue.ExplicitQueue,
  display: QueueDisplay,
): QueueBody {
  const current = MusicQueue.currentValue(queue);
  const { source } = queue;
  return {
    version: 1,
    id: queue.id,
    revision: queue.revision,
    currentKey: MusicQueue.entryKey(current),
    trackId: MusicQueue.songForValue(queue, current)!.trackId,
    display,
    source:
      source.kind === "playlist"
        ? { kind: "playlist", playlistId: source.playlistId, ids: source.ids }
        : { kind: source.kind, original: source.original },
    order: queue.order,
    added: queue.added,
    shuffle: queue.shuffle,
  };
}

/** The stored explicit queue with its cursor on `currentKey`, or null if it does not hold up. */
function explicitFromBody(body: QueueBody, currentKey = body.currentKey, trackId = body.trackId) {
  const { source, order } = body;
  if (source === undefined || order === undefined) return null;
  const queueSource: MusicQueue.QueueSource | null =
    source.kind === "playlist"
      ? source.playlistId === undefined || source.ids === undefined
        ? null
        : { kind: "playlist", playlistId: source.playlistId, ids: source.ids }
      : source.original === undefined
        ? null
        : { kind: source.kind, original: source.original };
  const value = MusicQueue.keyValue(currentKey);
  if (queueSource === null || value === null) return null;
  const queue: MusicQueue.ExplicitQueue = {
    id: body.id,
    revision: body.revision,
    source: queueSource,
    order,
    added: body.added ?? [],
    cursor: order.indexOf(value),
    shuffle: body.shuffle ?? null,
    lastRemoved: null,
  };
  // Never search by track id: a duplicated song is a different entry.
  if (!MusicQueue.isConsistent(queue)) return null;
  return MusicQueue.songForValue(queue, value)?.trackId === trackId ? queue : null;
}

export interface SavedEntry {
  readonly currentKey: string;
  readonly trackId: string;
  readonly positionSec: number;
  readonly display: QueueDisplay;
  readonly explicit: MusicQueue.ExplicitQueue | null;
  /** The accepted checkpoint says T3 was still playing it: the server stopped, T3 never let go. */
  readonly wasActive: boolean;
}

/**
 * Where a saved queue resumes, from the files alone. The checkpoint counts only for the same
 * queue and revision and, for an explicit queue, an entry it holds with the same song. Otherwise
 * the body's own entry at 0:00 with the body's own labels.
 */
export function resolveSaved(body: QueueBody, position: QueuePosition | null): SavedEntry | null {
  const fromBody = (): SavedEntry | null => {
    if (body.formula === undefined) {
      const explicit = explicitFromBody(body);
      return explicit === null
        ? null
        : {
            currentKey: body.currentKey,
            trackId: body.trackId,
            positionSec: 0,
            display: sanitizeDisplay(body.display),
            explicit,
            wasActive: false,
          };
    }
    return body.currentKey.startsWith("s")
      ? {
          currentKey: body.currentKey,
          trackId: body.trackId,
          positionSec: 0,
          display: sanitizeDisplay(body.display),
          explicit: null,
          wasActive: false,
        }
      : null;
  };
  const base = fromBody();
  if (base === null) return null;
  if (position === null || position.id !== body.id || position.revision !== body.revision) {
    return base;
  }
  const positionSec = Number.isFinite(position.positionSec) ? Math.max(0, position.positionSec) : 0;
  const display = sanitizeDisplay(position.display);
  const wasActive = position.active === true;
  if (body.formula !== undefined) {
    return position.currentKey.startsWith("s")
      ? {
          ...base,
          currentKey: position.currentKey,
          trackId: position.trackId,
          positionSec,
          display,
          wasActive,
        }
      : base;
  }
  const explicit = explicitFromBody(body, position.currentKey, position.trackId);
  return explicit === null
    ? base
    : {
        currentKey: position.currentKey,
        trackId: position.trackId,
        positionSec,
        display,
        explicit,
        wasActive,
      };
}

export class MusicQueueStore extends Context.Service<
  MusicQueueStore,
  {
    /** Reads the files once; never contacts Music. */
    readonly load: Effect.Effect<{
      readonly body: QueueBody | null;
      readonly position: QueuePosition | null;
    }>;
    /** Queues a body write and its matching position write for one writer turn. */
    readonly saveBody: (body: QueueBody, position: QueuePosition) => Effect.Effect<void>;
    /** Dropped when it names another queue or an older revision than the last body. */
    readonly savePosition: (position: QueuePosition) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
    /** Waits for every queued write to land or fail. */
    readonly settled: Effect.Effect<void>;
  }
>()("t3/music/MusicQueueStore") {}

interface Pending {
  readonly body?: QueueBody | null;
  readonly position?: QueuePosition | null;
}

/** One serialized writer: the latest pending value wins and a failed write is only logged. */
const makeWriter = Effect.fn("MusicQueueStore.makeWriter")(function* <E>(
  initial: QueueBody | null,
  write: (pending: Pending) => Effect.Effect<void, E>,
) {
  const lock = yield* Semaphore.make(1);
  const fibers = yield* FiberSet.make<void, never>();
  let pending: Pending | null = null;
  let lastBody: { readonly id: string; readonly revision: number } | null =
    initial === null ? null : { id: initial.id, revision: initial.revision };

  const drain = lock.withPermits(1)(
    Effect.suspend(() => {
      const next = pending;
      pending = null;
      if (next === null) return Effect.void;
      return write(next).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // The next write carries what failed; anything queued since is newer and wins.
            pending = { ...next, ...pending };
          }).pipe(Effect.andThen(Effect.logWarning("music queue write failed", { cause }))),
        ),
      );
    }),
  );
  const enqueue = (change: Pending) =>
    Effect.suspend(() => {
      pending = { ...pending, ...change };
      return FiberSet.run(fibers, drain).pipe(Effect.asVoid);
    });

  return {
    saveBody: (body: QueueBody, position: QueuePosition) =>
      Effect.suspend(() => {
        lastBody = { id: body.id, revision: body.revision };
        return enqueue({ body, position });
      }),
    savePosition: (position: QueuePosition) =>
      Effect.suspend(() =>
        lastBody === null || position.id !== lastBody.id || position.revision < lastBody.revision
          ? Effect.void
          : enqueue({ position }),
      ),
    clear: Effect.suspend(() => {
      lastBody = null;
      return enqueue({ body: null, position: null });
    }),
    settled: FiberSet.awaitEmpty(fibers),
  };
});

export const layer = Layer.effect(
  MusicQueueStore,
  Effect.gen(function* () {
    const bodyFile = yield* MusicJsonFile.make<QueueBody | null>({
      fileName: "music-queue.json",
      decode: (contents) => decodeBody(contents),
      encode: (value) => encodeBody(value!),
      empty: () => null,
    });
    const positionFile = yield* MusicJsonFile.make<QueuePosition | null>({
      fileName: "music-queue-position.json",
      decode: (contents) => decodePosition(contents),
      encode: (value) => encodePosition(value!),
      empty: () => null,
    });
    const body = yield* bodyFile.load;
    const position = yield* positionFile.load;
    // A checkpoint belongs to its body, so a run that must not write one writes neither.
    const readOnly = bodyFile.isReadOnly() || positionFile.isReadOnly();
    const writer = yield* makeWriter(body, (pending) =>
      Effect.gen(function* () {
        if (readOnly) return;
        if (pending.body !== undefined) {
          yield* pending.body === null ? bodyFile.remove : bodyFile.replace(pending.body);
        }
        if (pending.position !== undefined) {
          yield* pending.position === null
            ? positionFile.remove
            : positionFile.replace(pending.position);
        }
      }),
    );
    return MusicQueueStore.of({ load: Effect.succeed({ body, position }), ...writer });
  }),
);

/** Keeps the files in memory, for tests and hosts that never persist. */
export const layerMemory = (
  initial: {
    readonly body?: QueueBody | null;
    readonly position?: QueuePosition | null;
  } = {},
) =>
  Layer.effect(
    MusicQueueStore,
    Effect.gen(function* () {
      const files = { body: initial.body ?? null, position: initial.position ?? null };
      const writer = yield* makeWriter(files.body, (pending) =>
        Effect.sync(() => {
          if (pending.body !== undefined) files.body = pending.body;
          if (pending.position !== undefined) files.position = pending.position;
        }),
      );
      return MusicQueueStore.of({ load: Effect.sync(() => ({ ...files })), ...writer });
    }),
  );
