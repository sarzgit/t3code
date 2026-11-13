import { assert, describe, it } from "@effect/vitest";

import { decodeLibraryScan } from "./MusicLibrarySync.ts";

describe("decodeLibraryScan", () => {
  const scan = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      running: true,
      ids: ["0000000000000001", "not-an-id", "0000000000000003"],
      names: ["Song", "Other", null],
      artists: ["Artist", "Other", null],
      durations: [200, 100, null],
      counts: [3, 1, 0],
      playedAt: [1_000, null, null],
      ...overrides,
    });

  it("keeps valid tracks and drops ones Music reported without an id or count", () => {
    assert.deepStrictEqual(decodeLibraryScan(scan()), [
      {
        id: "0000000000000001",
        name: "Song",
        artist: "Artist",
        durationSec: 200,
        playedCount: 3,
        playedAtMs: 1_000,
      },
      {
        id: "0000000000000003",
        name: "",
        artist: "",
        durationSec: 0,
        playedCount: 0,
        playedAtMs: null,
      },
    ]);
    assert.deepStrictEqual(
      decodeLibraryScan(scan({ counts: [3, 1, -1] }))?.map((track) => track.id),
      ["0000000000000001"],
    );
  });

  it("rejects a closed Music, mismatched columns and noise", () => {
    assert.isNull(decodeLibraryScan(JSON.stringify({ running: false })));
    assert.isNull(decodeLibraryScan(scan({ counts: [3, 1] })));
    assert.isNull(decodeLibraryScan("osascript noise"));
  });
});
