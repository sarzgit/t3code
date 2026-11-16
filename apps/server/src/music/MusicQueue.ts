/**
 * The explicit T3 queue: a whole play order (played, current and upcoming) over a fixed source
 * plus songs the user added. Pure; MusicPlayer runs it under its pick lock. An unedited playlist
 * queue never becomes one; it keeps stepping by formula (STEP_SCRIPT).
 */

export const MAX_QUEUE_ENTRIES = 50_000;
/** Songs one step script tries before giving up on a direction. */
export const STEP_CANDIDATES = 10;

export interface QueueMeta {
  readonly name: string;
  readonly artist: string;
  readonly durationSec: number;
}

export interface QueueSong {
  readonly playlistId: string;
  readonly trackId: string;
  /** Position in its playlist, checked against the id when it plays. */
  readonly index: number;
  /** Captured when the song entered the queue; null for playlist songs read live. */
  readonly meta: QueueMeta | null;
}

export type QueueListKind = "favourites" | "recent";

export type QueueSource =
  | {
      readonly kind: "playlist";
      readonly playlistId: string;
      /** The playlist's songs as songs() read them; `s<n>` is `ids[n]`. */
      readonly ids: ReadonlyArray<string>;
    }
  | { readonly kind: QueueListKind; readonly original: ReadonlyArray<QueueSong> };

export interface ExplicitQueue {
  readonly id: string;
  readonly revision: number;
  readonly source: QueueSource;
  /** n >= 0 is source position n; n < 0 is the added song with ordinal -(n + 1). */
  readonly order: ReadonlyArray<number>;
  /** Indexed by ordinal. Songs Reset dropped stay here so keys are never reused. */
  readonly added: ReadonlyArray<QueueSong>;
  readonly cursor: number;
  readonly shuffle: { readonly seed: number } | null;
  /** The last removal, undoable while the revision it produced is current. */
  readonly lastRemoved: {
    readonly revision: number;
    readonly entries: ReadonlyArray<{ readonly at: number; readonly value: number }>;
  } | null;
}

export interface QueueTarget {
  readonly key: string;
  readonly trackId: string;
}

export type QueueEdit =
  | { readonly _tag: "play-next" | "add"; readonly songs: ReadonlyArray<QueueSong> }
  | { readonly _tag: "move"; readonly target: QueueTarget; readonly toIndex: number }
  | { readonly _tag: "remove"; readonly targets: ReadonlyArray<QueueTarget> }
  | { readonly _tag: "undo-remove"; readonly target: QueueTarget }
  | { readonly _tag: "clear-upcoming" }
  | { readonly _tag: "reset" };

export type EditResult =
  | { readonly _tag: "ok"; readonly queue: ExplicitQueue }
  | { readonly _tag: "queue-changed" }
  | { readonly _tag: "queue-too-long" };

const CHANGED: EditResult = { _tag: "queue-changed" };
const TOO_LONG: EditResult = { _tag: "queue-too-long" };

export const entryKey = (value: number) => (value >= 0 ? `s${value}` : `a${-(value + 1)}`);

export function keyValue(key: string): number | null {
  const match = /^([sa])(0|[1-9]\d{0,6})$/.exec(key);
  if (match === null) return null;
  const n = Number(match[2]);
  return match[1] === "s" ? n : -(n + 1);
}

const sourceCount = (source: QueueSource) =>
  source.kind === "playlist" ? source.ids.length : source.original.length;

export function songForValue(queue: ExplicitQueue, value: number): QueueSong | null {
  if (value < 0) return queue.added[-(value + 1)] ?? null;
  const { source } = queue;
  if (source.kind !== "playlist") return source.original[value] ?? null;
  const trackId = source.ids[value];
  return trackId === undefined
    ? null
    : { playlistId: source.playlistId, trackId, index: value, meta: null };
}

export function songForKey(queue: ExplicitQueue, key: string): QueueSong | null {
  const value = keyValue(key);
  return value === null ? null : songForValue(queue, value);
}

export const currentValue = (queue: ExplicitQueue) => queue.order[queue.cursor]!;

/** Every order value names a stored song exactly once and the cursor is inside the order. */
export function isConsistent(queue: ExplicitQueue): boolean {
  if (queue.order.length === 0 || queue.order.length > MAX_QUEUE_ENTRIES) return false;
  if (!Number.isInteger(queue.cursor) || queue.cursor < 0 || queue.cursor >= queue.order.length) {
    return false;
  }
  if (queue.added.length > MAX_QUEUE_ENTRIES) return false;
  const seen = new Set<number>();
  for (const value of queue.order) {
    if (!Number.isInteger(value) || seen.has(value) || songForValue(queue, value) === null) {
      return false;
    }
    seen.add(value);
  }
  return true;
}

export function materialise(input: {
  readonly id: string;
  readonly revision: number;
  readonly playlistId: string;
  readonly ids: ReadonlyArray<string>;
  /** Source positions in play order, as STEP_SCRIPT would walk them. */
  readonly sequence: ReadonlyArray<number>;
  /** Index of the current song in `sequence`. */
  readonly cursor: number;
  readonly shuffleSeed: number | null;
}): ExplicitQueue {
  return {
    id: input.id,
    revision: input.revision,
    source: { kind: "playlist", playlistId: input.playlistId, ids: input.ids },
    order: input.sequence,
    added: [],
    cursor: input.cursor,
    shuffle: input.shuffleSeed === null ? null : { seed: input.shuffleSeed },
    lastRemoved: null,
  };
}

/**
 * A Favourites or Recently played queue: in list order with the songs before `start` already
 * played, or shuffled with `start` first.
 */
export function fromList(input: {
  readonly id: string;
  readonly kind: QueueListKind;
  readonly original: ReadonlyArray<QueueSong>;
  readonly start: number;
  readonly shuffleSeed: number | null;
}): ExplicitQueue {
  const positions = input.original.map((_, i) => i);
  const seed = input.shuffleSeed;
  return {
    id: input.id,
    revision: 0,
    source: { kind: input.kind, original: input.original },
    order:
      seed === null
        ? positions
        : [
            input.start,
            ...shuffled(
              positions.filter((i) => i !== input.start),
              seed,
            ),
          ],
    added: [],
    cursor: seed === null ? input.start : 0,
    shuffle: seed === null ? null : { seed },
    lastRemoved: null,
  };
}

export const moveCursor = (queue: ExplicitQueue, cursor: number): ExplicitQueue => ({
  ...queue,
  cursor,
});

/** The index in the order of an upcoming entry that still holds `target.trackId`, or -1. */
function upcomingAt(queue: ExplicitQueue, target: QueueTarget): number {
  const value = keyValue(target.key);
  if (value === null) return -1;
  const at = queue.order.indexOf(value);
  if (at <= queue.cursor) return -1;
  return songForValue(queue, value)?.trackId === target.trackId ? at : -1;
}

/** Same generator as SONGS_JXA's playOrder, so a seed means one order everywhere. */
function shuffled<A>(values: ReadonlyArray<A>, seed: number): Array<A> {
  const out = [...values];
  let state = seed >>> 0 || 1;
  const random = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const swap = out[i]!;
    out[i] = out[j]!;
    out[j] = swap;
  }
  return out;
}

/** Added songs by ordinal, then source songs by position. */
const unshuffledOrder = (values: ReadonlyArray<number>) =>
  [...values].sort((a, b) => (a < 0 && b < 0 ? b - a : a < 0 ? -1 : b < 0 ? 1 : a - b));

/**
 * Shuffle on reshuffles upcoming songs with `seed`; off puts them back in unshuffled order. The
 * played songs and the current one never move.
 */
export function toggleShuffle(queue: ExplicitQueue, on: boolean, seed: number): ExplicitQueue {
  const head = queue.order.slice(0, queue.cursor + 1);
  const upcoming = queue.order.slice(queue.cursor + 1);
  return {
    ...queue,
    revision: queue.revision + 1,
    order: [...head, ...(on ? shuffled(upcoming, seed) : unshuffledOrder(upcoming))],
    shuffle: on ? { seed } : null,
  };
}

/**
 * Playlist order: every source song once in source order, with the current added song (if any)
 * right after the last source song played before it. Other added songs drop.
 */
function resetOrder(queue: ExplicitQueue): ExplicitQueue {
  const count = sourceCount(queue.source);
  const sourceOrder = Array.from({ length: count }, (_, i) => i);
  const current = currentValue(queue);
  if (current >= 0) {
    return { ...queue, order: sourceOrder, cursor: current, shuffle: null };
  }
  let anchor = -1;
  for (let i = queue.cursor - 1; i >= 0; i--) {
    const value = queue.order[i]!;
    if (value >= 0) {
      anchor = value;
      break;
    }
  }
  const order = [...sourceOrder.slice(0, anchor + 1), current, ...sourceOrder.slice(anchor + 1)];
  return { ...queue, order, cursor: anchor + 1, shuffle: null };
}

export function applyEdit(
  queue: ExplicitQueue,
  expectedRevision: number,
  edit: QueueEdit,
): EditResult {
  if (expectedRevision !== queue.revision) return CHANGED;
  const revision = queue.revision + 1;
  const head = queue.order.slice(0, queue.cursor + 1);
  switch (edit._tag) {
    case "play-next":
    case "add": {
      if (queue.order.length + edit.songs.length > MAX_QUEUE_ENTRIES) return TOO_LONG;
      const values = edit.songs.map((_, i) => -(queue.added.length + i + 1));
      const upcoming = queue.order.slice(queue.cursor + 1);
      return {
        _tag: "ok",
        queue: {
          ...queue,
          revision,
          added: [...queue.added, ...edit.songs],
          order:
            edit._tag === "play-next"
              ? [...head, ...values, ...upcoming]
              : [...head, ...upcoming, ...values],
        },
      };
    }
    case "move": {
      const at = upcomingAt(queue, edit.target);
      if (at < 0) return CHANGED;
      const upcoming = queue.order.slice(queue.cursor + 1);
      const [value] = upcoming.splice(at - queue.cursor - 1, 1);
      upcoming.splice(Math.min(edit.toIndex, upcoming.length), 0, value!);
      return { _tag: "ok", queue: { ...queue, revision, order: [...head, ...upcoming] } };
    }
    case "remove": {
      const ats = edit.targets.map((target) => upcomingAt(queue, target));
      if (ats.some((at) => at < 0) || new Set(ats).size !== ats.length) return CHANGED;
      const removed = new Set(ats);
      return {
        _tag: "ok",
        queue: {
          ...queue,
          revision,
          order: queue.order.filter((_, at) => !removed.has(at)),
          lastRemoved: {
            revision,
            entries: [...ats].sort((a, b) => a - b).map((at) => ({ at, value: queue.order[at]! })),
          },
        },
      };
    }
    case "undo-remove": {
      const last = queue.lastRemoved;
      const value = keyValue(edit.target.key);
      if (
        last === null ||
        last.revision !== queue.revision ||
        value === null ||
        !last.entries.some((entry) => entry.value === value) ||
        songForValue(queue, value)?.trackId !== edit.target.trackId ||
        last.entries.some((entry) => entry.at <= queue.cursor)
      ) {
        return CHANGED;
      }
      const order = [...queue.order];
      for (const entry of last.entries) order.splice(entry.at, 0, entry.value);
      return { _tag: "ok", queue: { ...queue, revision, order, lastRemoved: null } };
    }
    case "clear-upcoming":
      return { _tag: "ok", queue: { ...queue, revision, order: head } };
    case "reset":
      return { _tag: "ok", queue: { ...resetOrder(queue), revision } };
  }
}

export interface Candidate {
  readonly at: number;
  readonly value: number;
  readonly song: QueueSong;
}

/**
 * What a step may play, nearest first: `forward` stops at the end of the order, `wrapped` goes
 * round it (for repeat all) and ends on the current song.
 */
export function candidates(
  queue: ExplicitQueue,
  direction: "next" | "previous",
): { readonly forward: ReadonlyArray<Candidate>; readonly wrapped: ReadonlyArray<Candidate> } {
  const delta = direction === "next" ? 1 : -1;
  const length = queue.order.length;
  const at = (offset: number) => queue.cursor + delta * offset;
  const entry = (index: number): Candidate => {
    const value = queue.order[index]!;
    return { at: index, value, song: songForValue(queue, value)! };
  };
  const forward: Array<Candidate> = [];
  for (let offset = 1; forward.length < STEP_CANDIDATES; offset++) {
    const index = at(offset);
    if (index < 0 || index >= length) break;
    forward.push(entry(index));
  }
  const wrapped: Array<Candidate> = [];
  for (let offset = 1; offset <= length && wrapped.length < STEP_CANDIDATES; offset++) {
    wrapped.push(entry(((at(offset) % length) + length) % length));
  }
  return { forward, wrapped };
}
