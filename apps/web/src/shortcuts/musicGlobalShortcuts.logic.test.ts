import type { MusicPlayerState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { musicGlobalShortcutControl } from "./musicGlobalShortcuts.logic";

const ready = (track: unknown) =>
  ({
    _tag: "ready",
    playback: "playing",
    track,
    positionSec: 0,
    shuffle: false,
    playlistId: null,
  }) as MusicPlayerState;

describe("musicGlobalShortcutControl", () => {
  it("flips the sampled track's favourite by its id", () => {
    const track = { id: "3BA40D4A07B97011", name: "A", artist: "B", album: "C", durationSec: 1 };
    expect(musicGlobalShortcutControl("favorite", ready({ ...track, favorited: true }))).toEqual({
      _tag: "set-favorited",
      trackId: "3BA40D4A07B97011",
      favorited: false,
    });
    // A server that cannot report the flag gets no guess.
    expect(musicGlobalShortcutControl("favorite", ready(track))).toBeNull();
  });

  it("does nothing for Favourite with no current track", () => {
    expect(musicGlobalShortcutControl("favorite", ready(null))).toBeNull();
    expect(musicGlobalShortcutControl("favorite", { _tag: "not-running" })).toBeNull();
    expect(musicGlobalShortcutControl("favorite", null)).toBeNull();
  });
});
