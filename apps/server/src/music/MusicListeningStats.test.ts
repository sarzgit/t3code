import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";

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
