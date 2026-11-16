import type { MusicPlayerState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeMusicPlaylists,
  formatTrackTime,
  musicListPages,
  musicPositionAt,
  musicQueueEditBase,
  musicUpNextSource,
  nextRepeatMode,
  parseMusicHistoryCsv,
  withSeekAnchor,
} from "./music.ts";

const ready = (
  overrides: Partial<Extract<MusicPlayerState, { _tag: "ready" }>> = {},
): MusicPlayerState => ({
  _tag: "ready",
  playback: "playing",
  track: { id: "3BA40D4A07B97011", name: "A", artist: "B", album: "C", durationSec: 100 },
  positionSec: 10,
  shuffle: false,
  playlistId: null,
  ...overrides,
});

describe("musicPositionAt", () => {
  it.each([
    ["advances from receipt while playing", ready(), 5_000, 15],
    ["holds still while paused", ready({ playback: "paused" }), 60_000, 10],
    ["stops at the end of the track", ready({ positionSec: 98 }), 10_000, 100],
    ["does not run backwards before receipt", ready(), -5_000, 10],
    ["is zero with no track", ready({ track: null }), 5_000, 0],
    ["is zero when Music is not running", { _tag: "not-running" } as const, 5_000, 0],
  ] as const)("%s", (_name, state, nowMs, expected) => {
    expect(musicPositionAt({ state, receivedAtMs: 0 }, nowMs)).toBe(expected);
  });

  it("restarts from a new state after a seek or reconnect", () => {
    const seeked = { state: ready({ positionSec: 60 }), receivedAtMs: 20_000 };
    expect(musicPositionAt(seeked, 22_000)).toBe(62);
  });
});

describe("musicUpNextSource", () => {
  const playingFrom = { playlistId: "5CA38D01224697B3", index: 4 };
  it.each([
    ["nothing when stopped", ready({ playback: "stopped", playingFrom }), "nothing-playing"],
    ["nothing without a song", ready({ track: null }), "nothing-playing"],
    ["Music's queue for a whole playlist", ready({ playlistId: playingFrom.playlistId }), "native"],
    ["Music's queue under Music's own shuffle", ready({ playingFrom, shuffle: true }), "native"],
    [
      "known under T3's shuffle",
      ready({ playingFrom: { ...playingFrom, shuffle: { seed: 9, first: 4 } }, shuffle: true }),
      "known",
    ],
    ["known while T3 steps", ready({ playingFrom, playback: "paused" }), "known"],
    ["the song again under repeat one", ready({ playingFrom, repeat: "one" }), "repeating"],
  ] as const)("%s", (_name, state, expected) => {
    expect(musicUpNextSource(state)._tag).toBe(expected);
  });

  it("lists an active T3 queue over Music's shuffle and repeat one", () => {
    const active = { id: "qabc123", revision: 2, edited: false, currentKey: "s4" };
    for (const state of [
      ready({ playingFrom, shuffle: true }),
      ready({ playingFrom, repeat: "one" }),
      ready({ playlistId: playingFrom.playlistId }),
    ]) {
      expect(musicUpNextSource(state, active)).toEqual({ _tag: "queue", active });
    }
    expect(musicUpNextSource(ready({ playingFrom, repeat: "one" }), null)._tag).toBe("repeating");
  });

  it("sends a formula queue's song count with its first edit only", () => {
    const view = { id: "qabc123", revision: 3, sourceCount: 120 };
    expect(musicQueueEditBase({ ...view, edited: false })).toEqual({
      queueId: "qabc123",
      expectedRevision: 3,
      sourceCount: 120,
    });
    expect(musicQueueEditBase({ ...view, edited: true })).toEqual({
      queueId: "qabc123",
      expectedRevision: 3,
    });
  });

  it("keeps Show more pages only while the library read behind them holds", () => {
    expect(musicListPages({ count: 3, snapshotAt: 100 }, 100)).toBe(3);
    expect(musicListPages({ count: 3, snapshotAt: 100 }, 160)).toBe(1);
    expect(musicListPages({ count: 3, snapshotAt: 100 }, null)).toBe(1);
    expect(musicListPages({ count: 1, snapshotAt: null }, 100)).toBe(1);
  });

  it("wraps only under repeat all", () => {
    expect(musicUpNextSource(ready({ playingFrom, repeat: "all" }))).toEqual({
      _tag: "known",
      input: {
        playlistId: playingFrom.playlistId,
        trackId: "3BA40D4A07B97011",
        index: 4,
        wrap: true,
      },
    });
    const once = musicUpNextSource(ready({ playingFrom, repeat: "off" }));
    expect(once._tag === "known" && once.input.wrap).toBe(false);
  });

  it("reads Music's own queue only when Music runs it", () => {
    expect(musicUpNextSource(ready({ shuffle: true }))).toEqual({
      _tag: "native",
      trackId: "3BA40D4A07B97011",
    });
    // A song T3 steps through never asks Music's panel, shuffled or not.
    const t3Shuffle = { ...playingFrom, shuffle: { seed: 9, first: null } };
    expect(musicUpNextSource(ready({ playingFrom: t3Shuffle, shuffle: true }))._tag).toBe("known");
    expect(musicUpNextSource(ready({ playingFrom }))._tag).toBe("known");
  });

  it("lists T3's shuffle only while Music's shuffle is on", () => {
    const shuffle = { seed: 9, first: null };
    const on = musicUpNextSource(
      ready({ playingFrom: { ...playingFrom, shuffle }, shuffle: true }),
    );
    expect(on._tag === "known" && on.input.shuffle).toEqual(shuffle);
    // Turned off in Music before T3 heard: the next step goes in playlist order.
    const off = musicUpNextSource(ready({ playingFrom: { ...playingFrom, shuffle } }));
    expect(off._tag === "known" && off.input.shuffle).toBe(undefined);
  });
});

describe("arrangeMusicPlaylists", () => {
  const playlist = (id: string, name: string) => ({ id, name, durationSec: 60 });
  const a = playlist("AAAAAAAAAAAAAAAA", "Gym");
  const b = playlist("BBBBBBBBBBBBBBBB", "Chill");
  const c = playlist("CCCCCCCCCCCCCCCC", "Old gym mix");
  const library = [a, b, c];
  const names = (list: ReadonlyArray<{ name: string }>) => list.map(({ name }) => name);

  it("puts pins first in pin order and skips ids missing from the library", () => {
    const arranged = arrangeMusicPlaylists(
      library,
      { pinned: [c.id, "DDDDDDDDDDDDDDDD", a.id], hidden: [] },
      "",
    );
    expect(names(arranged.pinned)).toEqual(["Old gym mix", "Gym"]);
    expect(names(arranged.listed)).toEqual(["Chill"]);
  });

  it("searches pinned and listed playlists but always shows every hidden one", () => {
    const arranged = arrangeMusicPlaylists(library, { pinned: [a.id], hidden: [b.id] }, "gym");
    expect(names(arranged.pinned)).toEqual(["Gym"]);
    expect(names(arranged.listed)).toEqual(["Old gym mix"]);
    expect(names(arranged.hidden)).toEqual(["Chill"]);
  });
});

describe("player controls", () => {
  it.each([
    [0, "0:00"],
    [7.9, "0:07"],
    [187, "3:07"],
    [3729, "1:02:09"],
  ] as const)("formats %s seconds as %s", (seconds, expected) => {
    expect(formatTrackTime(seconds)).toBe(expected);
  });

  it("cycles repeat off, all, one, off", () => {
    expect([nextRepeatMode("off"), nextRepeatMode("all"), nextRepeatMode("one")]).toEqual([
      "all",
      "one",
      "off",
    ]);
  });

  it("keeps a sent seek until the server reports anything newer", () => {
    const received = { state: ready({ positionSec: 10 }), receivedAtMs: 1_000 };
    const anchor = { positionSec: 90, atMs: 5_000 };
    const anchored = withSeekAnchor(received, anchor);
    expect(musicPositionAt(anchored, 6_000)).toBe(91);
    const newer = { state: ready({ positionSec: 40 }), receivedAtMs: 7_000 };
    expect(withSeekAnchor(newer, anchor)).toBe(newer);
  });
});

describe("parseMusicHistoryCsv", () => {
  const HEADER =
    "Country,Track Identifier,Media type,Date Played,Hours,Play Duration Milliseconds,End Reason Type,Source Type,Play Count,Skip Count,Ignore For Recommendations,Track Reference,Track Description";
  const line = (date: string, ms: string, description: string) =>
    `US,1001,AUDIO,${date},"18, 19",${ms},NATURAL_END_OF_TRACK,IPHONE,1,0,,1001,${description}`;

  it("sums repeated rows for a day and song, and splits artist from title once", () => {
    const csv = [
      `\uFEFF${HEADER}`,
      line("20261101", "120000", '"Brian Eno - 1/2"'),
      line("20261101", "60000", '"brian eno - 1/2 "'),
      line("20261102", "30000", '"Artist - Song - Live, ""Remastered"""'),
      line("20261102", "45000", "Apple Music 1"),
    ].join("\r\n");
    expect(parseMusicHistoryCsv(csv)).toEqual({
      _tag: "parsed",
      rows: [
        { day: "2026-11-01", name: "1/2", artist: "Brian Eno", seconds: 180 },
        { day: "2026-11-02", name: 'Song - Live, "Remastered"', artist: "Artist", seconds: 30 },
        { day: "2026-11-02", name: "Apple Music 1", artist: "", seconds: 45 },
      ],
    });
  });

  it("skips malformed rows and caps a day at 24 hours", () => {
    const csv = [
      HEADER,
      line("2026-11-01", "1000", "A - B"),
      line("19991231", "1000", "A - B"),
      line("20261301", "1000", "A - B"),
      line("20261101", "abc", "A - B"),
      line("20261101", "0", "A - B"),
      line("20261101", "1000", '""'),
      line("20261101", "90000000", '"A - B"'),
      "truncated,row",
    ].join("\n");
    expect(parseMusicHistoryCsv(csv)).toEqual({
      _tag: "parsed",
      rows: [{ day: "2026-11-01", name: "B", artist: "A", seconds: 86_400 }],
    });
  });

  it("rejects other files and reports one with no listening", () => {
    expect(parseMusicHistoryCsv("")._tag).toBe("wrong-file");
    expect(parseMusicHistoryCsv("Song Name,Artist Name\nA,B")._tag).toBe("wrong-file");
    expect(parseMusicHistoryCsv(`${HEADER}\n`)._tag).toBe("empty");
  });
});
