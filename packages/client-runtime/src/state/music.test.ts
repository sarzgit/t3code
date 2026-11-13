import type { MusicPlayerState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeMusicPlaylists,
  formatTrackTime,
  musicPositionAt,
  nextRepeatMode,
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
