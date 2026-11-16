import { useAtomValue } from "@effect/atom-react";
import type {
  ClientSettings,
  DesktopBridge,
  KeybindingShortcut,
  MusicGlobalShortcutAction,
  MusicGlobalShortcutStatus,
} from "@t3tools/contracts";
import { parseKeybindingShortcut } from "@t3tools/shared/keybindings";
import {
  MUSIC_GLOBAL_SHORTCUT_ACTIONS,
  musicGlobalShortcutCandidateIssue,
  musicGlobalShortcutIssues,
  type MusicGlobalShortcutIssue,
} from "@t3tools/shared/musicGlobalShortcuts";
import { XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { snapShotKeybindingConflict } from "../../lib/snapShotShortcut";
import { isMacPlatform } from "../../lib/utils";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useMusicEnvironmentId } from "../../state/music";
import { SnapShotShortcutKeys } from "../desktop/SnapShotShortcutKeys";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { commandLabel, keybindingFromKeyboardEvent } from "./KeybindingsSettings.logic";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const MUSIC_GLOBAL_SHORTCUT_LABELS: Record<MusicGlobalShortcutAction, string> = {
  playPause: "Play/pause",
  next: "Next",
  previous: "Previous",
  favorite: "Favourite current song",
  toggleMiniPlayer: "Toggle mini-player",
};

function issueMessage(issue: MusicGlobalShortcutIssue): string {
  switch (issue.kind) {
    case "needs-modifier":
      return "Include Control, Option or Command.";
    case "needs-key":
      return "Add a letter, number or function key.";
    case "media-key":
      return "Media keys can't be used.";
    case "duplicate":
      return `Already used for ${MUSIC_GLOBAL_SHORTCUT_LABELS[issue.action]}.`;
    case "snap-shot":
      return "Already used for SnapShots.";
  }
}

const selectSettings = (settings: ClientSettings) => ({
  musicGlobalShortcuts: settings.musicGlobalShortcuts,
  snapShotShortcut: settings.snapShotShortcut,
});

/** Desktop only, and only while the player drives a Mac; a remote browser never sees it. */
export function MusicGlobalShortcutSettings() {
  const bridge = window.desktopBridge?.musicGlobalShortcuts;
  const environmentId = useMusicEnvironmentId();
  if (!bridge || environmentId === null) return null;
  return <MusicGlobalShortcutRows bridge={bridge} />;
}

function MusicGlobalShortcutRows({ bridge }: { bridge: DesktopBridge["musicGlobalShortcuts"] }) {
  const settings = useClientSettings(selectSettings);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { enabled, bindings } = settings.musicGlobalShortcuts;
  const apple = isMacPlatform(navigator.platform);
  const [status, setStatus] = useState<MusicGlobalShortcutStatus>({});
  const [recording, setRecording] = useState<MusicGlobalShortcutAction | null>(null);
  const [refused, setRefused] = useState<{
    readonly action: MusicGlobalShortcutAction;
    readonly message: string;
  } | null>(null);
  const savedIssues = musicGlobalShortcutIssues(bindings, settings.snapShotShortcut, apple);

  const refreshStatus = () => bridge.getStatus().then(setStatus, () => setStatus({}));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads which keys the desktop shell holds; it registers them outside React
  useEffect(() => {
    let active = true;
    void bridge.getStatus().then(
      (next) => active && setStatus(next),
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [bridge]);

  const isRecording = recording !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell holds T3's global keys; it lets them go while a key is recorded so the press reaches this recorder
  useEffect(() => {
    if (!isRecording) return;
    void bridge.setRecording(true).catch(() => undefined);
    return () => {
      void bridge.setRecording(false).catch(() => undefined);
    };
  }, [bridge, isRecording]);

  const save = async (next: ClientSettings["musicGlobalShortcuts"]) => {
    await updateClientSettings({ musicGlobalShortcuts: next });
    await refreshStatus();
  };

  const record = (action: MusicGlobalShortcutAction, shortcut: KeybindingShortcut) => {
    setRecording(null);
    const issue = musicGlobalShortcutCandidateIssue(
      action,
      shortcut,
      bindings,
      settings.snapShotShortcut,
      apple,
    );
    if (issue) {
      setRefused({ action, message: issueMessage(issue) });
      return;
    }
    setRefused(null);
    void save({ enabled, bindings: { ...bindings, [action]: shortcut } });
  };

  const clear = (action: MusicGlobalShortcutAction) => {
    const rest = { ...bindings };
    delete rest[action];
    setRefused(null);
    void save({ enabled, bindings: rest });
  };

  const onKeyDown = (
    action: MusicGlobalShortcutAction,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (recording !== action || event.key === "Tab" || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setRecording(null);
      return;
    }
    const input = keybindingFromKeyboardEvent(event, navigator.platform);
    const shortcut = input ? parseKeybindingShortcut(input) : null;
    if (shortcut) record(action, shortcut);
  };

  const messageFor = (
    action: MusicGlobalShortcutAction,
    shortcut: KeybindingShortcut | undefined,
  ) => {
    if (recording === action) return { tone: "muted", text: "Press shortcut. Esc cancels." };
    if (refused?.action === action) return { tone: "error", text: refused.message };
    if (shortcut === undefined) return null;
    const issue = savedIssues[action];
    if (issue) return { tone: "error", text: issueMessage(issue) };
    if (status[action] === "unavailable") return { tone: "error", text: "Used by another app" };
    const inApp = snapShotKeybindingConflict(shortcut, keybindings);
    return inApp
      ? { tone: "warning", text: `Overrides "${commandLabel(inApp)}" in T3 Code.` }
      : null;
  };

  return (
    <SettingsRow
      {...searchableSetting("music-global-shortcuts")}
      description="Control Music from any app."
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => void save({ enabled: Boolean(checked), bindings })}
          aria-label="Use global music shortcuts"
        />
      }
    >
      {enabled ? (
        <ul className="divide-y divide-border/60 pb-2">
          {MUSIC_GLOBAL_SHORTCUT_ACTIONS.map((action) => {
            const shortcut = bindings[action];
            const label = MUSIC_GLOBAL_SHORTCUT_LABELS[action];
            const message = messageFor(action, shortcut);
            return (
              <li
                key={action}
                className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 py-1.5"
              >
                <span className="min-w-0 flex-1 text-sm text-foreground">{label}</span>
                {message ? (
                  <span
                    role={message.tone === "error" ? "alert" : undefined}
                    className={
                      message.tone === "error"
                        ? "text-xs text-destructive"
                        : message.tone === "warning"
                          ? "text-xs text-warning-foreground"
                          : "text-xs text-muted-foreground"
                    }
                  >
                    {message.text}
                  </span>
                ) : null}
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="xs"
                    variant={recording === action ? "secondary" : "outline"}
                    aria-label={`Record shortcut for ${label}`}
                    aria-pressed={recording === action}
                    data-keybinding-capture=""
                    onClick={() => {
                      setRefused(null);
                      setRecording(action);
                    }}
                    onKeyDown={(event) => onKeyDown(action, event)}
                    onBlur={() => setRecording((current) => (current === action ? null : current))}
                  >
                    {recording === action ? (
                      "Press shortcut…"
                    ) : shortcut ? (
                      <SnapShotShortcutKeys shortcut={shortcut} />
                    ) : (
                      "Set shortcut"
                    )}
                  </Button>
                  {shortcut ? (
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      aria-label={`Clear shortcut for ${label}`}
                      onClick={() => clear(action)}
                    >
                      <XIcon />
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </SettingsRow>
  );
}
