import type { KeybindingShortcut } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  musicGlobalShortcutCandidateIssue,
  musicGlobalShortcutHolding,
  musicGlobalShortcutIssues,
} from "./musicGlobalShortcuts.ts";

const chord = (key: string, modifiers: Partial<KeybindingShortcut> = {}): KeybindingShortcut => ({
  key,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  modKey: false,
  ...modifiers,
});
const SNAP_SHOT = chord("2", { metaKey: true, shiftKey: true });
const BOTH_SHIFTS = { kind: "both-shift-keys" } as const;

describe("musicGlobalShortcutIssues", () => {
  it("refuses keys without Control, Option or Command, modifier-only keys and media keys", () => {
    expect(
      musicGlobalShortcutIssues(
        {
          playPause: chord("p"),
          next: chord("n", { shiftKey: true }),
          previous: chord("shift", { metaKey: true }),
          favorite: chord("mediaplaypause", { altKey: true }),
          toggleMiniPlayer: chord("m", { ctrlKey: true }),
        },
        BOTH_SHIFTS,
        true,
      ),
    ).toEqual({
      playPause: { kind: "needs-modifier" },
      next: { kind: "needs-modifier" },
      previous: { kind: "needs-key" },
      favorite: { kind: "media-key" },
    });
  });

  it("charges a duplicate to the later action and resolves Mod per platform", () => {
    const bindings = {
      playPause: chord("k", { modKey: true, altKey: true }),
      next: chord("k", { metaKey: true, altKey: true }),
    };
    expect(musicGlobalShortcutIssues(bindings, BOTH_SHIFTS, true)).toEqual({
      next: { kind: "duplicate", action: "playPause" },
    });
    // Mod is Control off Apple, so the same two bindings are different keys there.
    expect(musicGlobalShortcutIssues(bindings, BOTH_SHIFTS, false)).toEqual({});
  });

  it("checks Snap Shot's key from both sides", () => {
    const music = { favorite: chord("2", { modKey: true, shiftKey: true }) };
    expect(musicGlobalShortcutIssues(music, SNAP_SHOT, true)).toEqual({
      favorite: { kind: "snap-shot" },
    });
    expect(
      musicGlobalShortcutCandidateIssue(
        "next",
        chord("2", { metaKey: true, shiftKey: true }),
        {},
        SNAP_SHOT,
        true,
      ),
    ).toEqual({ kind: "snap-shot" });
    expect(musicGlobalShortcutHolding(SNAP_SHOT, music, true)).toBe("favorite");
    expect(musicGlobalShortcutHolding(BOTH_SHIFTS, music, true)).toBeNull();
  });
});

describe("musicGlobalShortcutCandidateIssue", () => {
  it("compares against the other actions only", () => {
    const bindings = { playPause: chord("p", { ctrlKey: true, altKey: true }) };
    const same = chord("p", { ctrlKey: true, altKey: true });
    expect(
      musicGlobalShortcutCandidateIssue("playPause", same, bindings, BOTH_SHIFTS, true),
    ).toBeNull();
    expect(musicGlobalShortcutCandidateIssue("next", same, bindings, BOTH_SHIFTS, true)).toEqual({
      kind: "duplicate",
      action: "playPause",
    });
  });
});
