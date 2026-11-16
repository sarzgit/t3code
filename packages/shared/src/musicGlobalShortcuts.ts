import {
  isModifierPairShortcut,
  MusicGlobalShortcutAction,
  type KeybindingShortcut,
  type MusicGlobalShortcuts,
  type SnapShotShortcut,
} from "@t3tools/contracts";

export const MUSIC_GLOBAL_SHORTCUT_ACTIONS: ReadonlyArray<MusicGlobalShortcutAction> =
  MusicGlobalShortcutAction.literals;

export type MusicGlobalShortcutIssue =
  | { readonly kind: "needs-modifier" }
  | { readonly kind: "needs-key" }
  | { readonly kind: "media-key" }
  | { readonly kind: "duplicate"; readonly action: MusicGlobalShortcutAction }
  | { readonly kind: "snap-shot" };

const MODIFIER_KEYS = new Set([
  "meta",
  "cmd",
  "command",
  "super",
  "os",
  "control",
  "ctrl",
  "shift",
  "alt",
  "option",
  "altgraph",
]);

/** One string per physical chord: `mod` resolves to Command on Apple and Control elsewhere. */
function musicShortcutChord(shortcut: KeybindingShortcut, apple: boolean): string {
  const meta = shortcut.metaKey || (shortcut.modKey && apple);
  const ctrl = shortcut.ctrlKey || (shortcut.modKey && !apple);
  return [
    shortcut.key.toLowerCase(),
    meta ? "meta" : "",
    ctrl ? "ctrl" : "",
    shortcut.altKey ? "alt" : "",
    shortcut.shiftKey ? "shift" : "",
  ].join("|");
}

function ownIssue(shortcut: KeybindingShortcut): MusicGlobalShortcutIssue | null {
  const key = shortcut.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return { kind: "needs-key" };
  if (/^(?:media|audio|volume)/.test(key)) return { kind: "media-key" };
  // Shift alone would take a typed character from every app.
  if (!shortcut.modKey && !shortcut.metaKey && !shortcut.ctrlKey && !shortcut.altKey) {
    return { kind: "needs-modifier" };
  }
  return null;
}

function snapShotChord(snapShot: SnapShotShortcut, apple: boolean): string | null {
  return isModifierPairShortcut(snapShot) ? null : musicShortcutChord(snapShot, apple);
}

/**
 * Why each saved binding cannot be registered. A duplicate is charged to the later action in
 * `MUSIC_GLOBAL_SHORTCUT_ACTIONS` order, so the earlier one still registers.
 */
export function musicGlobalShortcutIssues(
  bindings: MusicGlobalShortcuts["bindings"],
  snapShot: SnapShotShortcut,
  apple: boolean,
): Partial<Record<MusicGlobalShortcutAction, MusicGlobalShortcutIssue>> {
  const issues: Partial<Record<MusicGlobalShortcutAction, MusicGlobalShortcutIssue>> = {};
  const taken = new Map<string, MusicGlobalShortcutAction>();
  const snapShotKey = snapShotChord(snapShot, apple);
  for (const action of MUSIC_GLOBAL_SHORTCUT_ACTIONS) {
    const shortcut = bindings[action];
    if (shortcut === undefined) continue;
    const own = ownIssue(shortcut);
    if (own) {
      issues[action] = own;
      continue;
    }
    const chord = musicShortcutChord(shortcut, apple);
    if (chord === snapShotKey) {
      issues[action] = { kind: "snap-shot" };
      continue;
    }
    const owner = taken.get(chord);
    if (owner !== undefined) {
      issues[action] = { kind: "duplicate", action: owner };
      continue;
    }
    taken.set(chord, action);
  }
  return issues;
}

/** The issue a newly recorded binding for `action` would have against the other saved ones. */
export function musicGlobalShortcutCandidateIssue(
  action: MusicGlobalShortcutAction,
  candidate: KeybindingShortcut,
  bindings: MusicGlobalShortcuts["bindings"],
  snapShot: SnapShotShortcut,
  apple: boolean,
): MusicGlobalShortcutIssue | null {
  const own = ownIssue(candidate);
  if (own) return own;
  const chord = musicShortcutChord(candidate, apple);
  if (chord === snapShotChord(snapShot, apple)) return { kind: "snap-shot" };
  for (const other of MUSIC_GLOBAL_SHORTCUT_ACTIONS) {
    const shortcut = bindings[other];
    if (other !== action && shortcut && musicShortcutChord(shortcut, apple) === chord) {
      return { kind: "duplicate", action: other };
    }
  }
  return null;
}

/** The music action already holding a Snap Shot candidate's key, checked from Snap Shot's side. */
export function musicGlobalShortcutHolding(
  snapShot: SnapShotShortcut,
  bindings: MusicGlobalShortcuts["bindings"],
  apple: boolean,
): MusicGlobalShortcutAction | null {
  const chord = snapShotChord(snapShot, apple);
  if (chord === null) return null;
  return (
    MUSIC_GLOBAL_SHORTCUT_ACTIONS.find((action) => {
      const shortcut = bindings[action];
      return shortcut !== undefined && musicShortcutChord(shortcut, apple) === chord;
    }) ?? null
  );
}
