import { assert, describe, it } from "@effect/vitest";

import * as MusicQueue from "./MusicQueue.ts";

const LIST = "5CA38D01224697B3";
const LIBRARY = "0000000000000005";
const id = (n: number) => `ABCDEF01234500${String(n).padStart(2, "0")}`;
const song = (n: number): MusicQueue.QueueSong => ({
  playlistId: LIBRARY,
  trackId: id(n),
  index: n,
  meta: { name: `Song ${n}`, artist: "Artist", durationSec: 200 },
});

/** A playlist queue of `count` songs, materialised in `sequence` with `current` playing. */
const playlistQueue = (
  ids: ReadonlyArray<string>,
  options: { readonly sequence?: ReadonlyArray<number>; readonly at?: number } = {},
) =>
  MusicQueue.materialise({
    id: "qtest01",
    revision: 3,
    playlistId: LIST,
    ids,
    sequence: options.sequence ?? ids.map((_, i) => i),
    cursor: options.at ?? 0,
    shuffleSeed: null,
  });

const ids = (count: number) => Array.from({ length: count }, (_, i) => id(i));
const keys = (queue: MusicQueue.ExplicitQueue) => queue.order.map(MusicQueue.entryKey);
const upcomingKeys = (queue: MusicQueue.ExplicitQueue) =>
  queue.order.slice(queue.cursor + 1).map(MusicQueue.entryKey);
const target = (queue: MusicQueue.ExplicitQueue, key: string) => ({
  key,
  trackId: MusicQueue.songForKey(queue, key)!.trackId,
});

const edited = (result: MusicQueue.EditResult) => {
  assert.strictEqual(result._tag, "ok");
  return (result as Extract<MusicQueue.EditResult, { _tag: "ok" }>).queue;
};

describe("MusicQueue edits", () => {
  it("plays next, adds to the end, moves and removes by entry, bumping the revision once each", () => {
    let queue = playlistQueue(ids(4), { at: 1 });
    queue = edited(MusicQueue.applyEdit(queue, 3, { _tag: "play-next", songs: [song(10)] }));
    assert.deepStrictEqual(upcomingKeys(queue), ["a0", "s2", "s3"]);
    assert.strictEqual(queue.revision, 4);
    queue = edited(MusicQueue.applyEdit(queue, 4, { _tag: "add", songs: [song(11), song(12)] }));
    assert.deepStrictEqual(upcomingKeys(queue), ["a0", "s2", "s3", "a1", "a2"]);
    queue = edited(
      MusicQueue.applyEdit(queue, 5, { _tag: "move", target: target(queue, "s3"), toIndex: 0 }),
    );
    assert.deepStrictEqual(upcomingKeys(queue), ["s3", "a0", "s2", "a1", "a2"]);
    queue = edited(
      MusicQueue.applyEdit(queue, 6, {
        _tag: "remove",
        targets: [target(queue, "a0"), target(queue, "a2")],
      }),
    );
    assert.deepStrictEqual(keys(queue), ["s0", "s1", "s3", "s2", "a1"]);
    queue = edited(MusicQueue.applyEdit(queue, 7, { _tag: "clear-upcoming" }));
    assert.deepStrictEqual(keys(queue), ["s0", "s1"]);
    assert.strictEqual(queue.revision, 8);
  });

  it("keeps duplicate songs apart by key", () => {
    const duplicated = [id(0), id(1), id(0), id(2)];
    let queue = playlistQueue(duplicated, { at: 0 });
    queue = edited(
      MusicQueue.applyEdit(queue, 3, {
        _tag: "remove",
        targets: [{ key: "s2", trackId: id(0) }],
      }),
    );
    assert.deepStrictEqual(keys(queue), ["s0", "s1", "s3"]);
    queue = edited(MusicQueue.applyEdit(queue, 4, { _tag: "add", songs: [song(1), song(1)] }));
    assert.deepStrictEqual(upcomingKeys(queue), ["s1", "s3", "a0", "a1"]);
  });

  it("refuses a stale revision, a played or current target, and a key holding another song", () => {
    const queue = MusicQueue.moveCursor(playlistQueue(ids(4), { at: 0 }), 2);
    // Cursor moves never change the revision.
    assert.strictEqual(queue.revision, 3);
    const changed = { _tag: "queue-changed" };
    assert.deepStrictEqual(MusicQueue.applyEdit(queue, 2, { _tag: "clear-upcoming" }), changed);
    for (const key of ["s1", "s2"]) {
      assert.deepStrictEqual(
        MusicQueue.applyEdit(queue, 3, { _tag: "remove", targets: [target(queue, key)] }),
        changed,
      );
    }
    assert.deepStrictEqual(
      MusicQueue.applyEdit(queue, 3, { _tag: "remove", targets: [{ key: "s3", trackId: id(9) }] }),
      changed,
    );
    assert.deepStrictEqual(
      MusicQueue.applyEdit(queue, 3, { _tag: "remove", targets: [{ key: "a0", trackId: id(0) }] }),
      changed,
    );
  });

  it("refuses to grow past the queue limit instead of truncating", () => {
    const queue = playlistQueue(ids(2), { at: 0 });
    const many = Array.from({ length: MusicQueue.MAX_QUEUE_ENTRIES }, () => song(1));
    assert.deepStrictEqual(MusicQueue.applyEdit(queue, 3, { _tag: "add", songs: many }), {
      _tag: "queue-too-long",
    });
  });

  it("undoes a removal with the same entry in the same place, until the order changes", () => {
    let queue = playlistQueue(ids(5), { at: 0 });
    queue = edited(
      MusicQueue.applyEdit(queue, 3, { _tag: "remove", targets: [target(queue, "s2")] }),
    );
    const removed = queue;
    queue = edited(
      MusicQueue.applyEdit(queue, 4, {
        _tag: "undo-remove",
        target: { key: "s2", trackId: id(2) },
      }),
    );
    assert.deepStrictEqual(keys(queue), ["s0", "s1", "s2", "s3", "s4"]);
    // Undo works once, and not after any other order change.
    assert.deepStrictEqual(
      MusicQueue.applyEdit(queue, 5, {
        _tag: "undo-remove",
        target: { key: "s2", trackId: id(2) },
      }),
      { _tag: "queue-changed" },
    );
    const moved = edited(
      MusicQueue.applyEdit(removed, 4, { _tag: "move", target: target(removed, "s4"), toIndex: 0 }),
    );
    assert.deepStrictEqual(
      MusicQueue.applyEdit(moved, 5, {
        _tag: "undo-remove",
        target: { key: "s2", trackId: id(2) },
      }),
      { _tag: "queue-changed" },
    );
    // Nor once its place has been played.
    assert.deepStrictEqual(
      MusicQueue.applyEdit(MusicQueue.moveCursor(removed, 2), 4, {
        _tag: "undo-remove",
        target: { key: "s2", trackId: id(2) },
      }),
      { _tag: "queue-changed" },
    );
  });
});

describe("MusicQueue shuffle and Reset", () => {
  it("reshuffles only upcoming songs, and shuffle off puts added songs first by ordinal", () => {
    let queue = playlistQueue(ids(8), { sequence: [5, 2, 7, 0, 1, 3, 4, 6], at: 2 });
    queue = edited(MusicQueue.applyEdit(queue, 3, { _tag: "add", songs: [song(20), song(21)] }));
    queue = edited(
      MusicQueue.applyEdit(queue, 4, { _tag: "move", target: target(queue, "a1"), toIndex: 0 }),
    );
    const on = MusicQueue.toggleShuffle(queue, true, 12345);
    assert.deepStrictEqual(keys(on).slice(0, 3), ["s5", "s2", "s7"]);
    assert.deepStrictEqual([...upcomingKeys(on)].sort(), [...upcomingKeys(queue)].sort());
    assert.deepStrictEqual(on.shuffle, { seed: 12345 });
    assert.strictEqual(on.revision, 6);
    const off = MusicQueue.toggleShuffle(on, false, 0);
    assert.deepStrictEqual(keys(off), ["s5", "s2", "s7", "a0", "a1", "s0", "s1", "s3", "s4", "s6"]);
    assert.strictEqual(off.shuffle, null);
  });

  it("resets to playlist order from a source song, bringing removed songs back", () => {
    let queue = playlistQueue(ids(6), { sequence: [4, 1, 5, 0, 2, 3], at: 1 });
    queue = edited(MusicQueue.applyEdit(queue, 3, { _tag: "add", songs: [song(30)] }));
    queue = edited(
      MusicQueue.applyEdit(queue, 4, { _tag: "remove", targets: [target(queue, "s2")] }),
    );
    queue = edited(MusicQueue.applyEdit(queue, 5, { _tag: "reset" }));
    assert.deepStrictEqual(keys(queue), ["s0", "s1", "s2", "s3", "s4", "s5"]);
    assert.strictEqual(MusicQueue.entryKey(queue.order[queue.cursor]!), "s1");
    assert.strictEqual(queue.shuffle, null);
  });

  it("resets around a playing added song after its anchor, or first when none played", () => {
    let queue = playlistQueue(ids(5), { sequence: [3, 0, 4, 1, 2], at: 1 });
    queue = edited(MusicQueue.applyEdit(queue, 3, { _tag: "play-next", songs: [song(40)] }));
    queue = MusicQueue.moveCursor(queue, 2);
    const reset = edited(MusicQueue.applyEdit(queue, 4, { _tag: "reset" }));
    // The last source song before it was s0, so it sits after s0 and s1 follows.
    assert.deepStrictEqual(keys(reset), ["s0", "a0", "s1", "s2", "s3", "s4"]);
    assert.strictEqual(MusicQueue.entryKey(reset.order[reset.cursor]!), "a0");

    let fresh = playlistQueue(ids(3), { at: 0 });
    fresh = edited(MusicQueue.applyEdit(fresh, 3, { _tag: "play-next", songs: [song(41)] }));
    const head: MusicQueue.ExplicitQueue = { ...fresh, order: [-1, 0, 1, 2], cursor: 0 };
    const resetHead = edited(MusicQueue.applyEdit(head, 4, { _tag: "reset" }));
    assert.deepStrictEqual(keys(resetHead), ["a0", "s0", "s1", "s2"]);
  });

  it("restores a list queue's original membership and order after Clear", () => {
    const original = [song(1), song(2), song(3), song(1)];
    const list = { id: "qlist01", kind: "favourites" as const, original, start: 1 };
    let queue = MusicQueue.fromList({ ...list, shuffleSeed: null });
    assert.deepStrictEqual(keys(queue), ["s0", "s1", "s2", "s3"]);
    queue = edited(MusicQueue.applyEdit(queue, 0, { _tag: "clear-upcoming" }));
    queue = edited(MusicQueue.applyEdit(queue, 1, { _tag: "reset" }));
    assert.deepStrictEqual(keys(queue), ["s0", "s1", "s2", "s3"]);
    assert.strictEqual(MusicQueue.songForKey(queue, "s3")!.trackId, id(1));
    // Shuffled, the chosen song plays first and nothing counts as played; Reset is list order.
    let shuffledList = MusicQueue.fromList({ ...list, shuffleSeed: 7 });
    assert.deepStrictEqual([shuffledList.cursor, keys(shuffledList)[0]], [0, "s1"]);
    assert.sameMembers(keys(shuffledList), ["s0", "s1", "s2", "s3"]);
    shuffledList = edited(MusicQueue.applyEdit(shuffledList, 0, { _tag: "reset" }));
    assert.deepStrictEqual(
      [shuffledList.cursor, keys(shuffledList), shuffledList.shuffle],
      [1, ["s0", "s1", "s2", "s3"], null],
    );
  });
});

describe("MusicQueue stepping", () => {
  it("offers the next entries to try, wrapping only for repeat all", () => {
    const queue = MusicQueue.moveCursor(playlistQueue(ids(4)), 2);
    const next = MusicQueue.candidates(queue, "next");
    assert.deepStrictEqual(
      next.forward.map((entry) => entry.at),
      [3],
    );
    assert.deepStrictEqual(
      next.wrapped.map((entry) => entry.at),
      [3, 0, 1, 2],
    );
    const previous = MusicQueue.candidates(MusicQueue.moveCursor(queue, 0), "previous");
    assert.deepStrictEqual(previous.forward, []);
    assert.deepStrictEqual(
      previous.wrapped.map((entry) => entry.at),
      [3, 2, 1, 0],
    );
    const long = MusicQueue.candidates(playlistQueue(ids(30)), "next");
    assert.strictEqual(long.forward.length, MusicQueue.STEP_CANDIDATES);
  });
});
