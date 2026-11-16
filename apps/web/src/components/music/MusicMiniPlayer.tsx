import { useAtomValue } from "@effect/atom-react";
import { type MusicSeekAnchor, withSeekAnchor } from "@t3tools/client-runtime/state/music";
import type { EnvironmentId, MusicControlInput } from "@t3tools/contracts";
import {
  ExternalLinkIcon,
  PauseIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import { refreshClientSettingsFromOtherTab } from "~/hooks/useSettings";
import { useMusicShortcuts } from "~/shortcuts/useMusicShortcuts";
import { musicEnvironment, useMusicEnvironmentId, useReceivedMusicState } from "~/state/music";
import { useAtomCommand } from "~/state/use-atom-command";

import { FavoriteButton, MusicArtwork } from "../sidebar/MusicPlaylistPanel";
import { musicStateSummary, SeekBar } from "../sidebar/SidebarMusicPlayer";
import { Button } from "../ui/button";

/** The desktop floating player: one small always-on-top window on the primary environment. */
export function MusicMiniPlayer() {
  useMusicShortcuts();
  const bridge = window.desktopBridge?.musicMiniPlayer;
  const environmentId = useMusicEnvironmentId();
  const [pinned, setPinned] = useState<boolean | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the window's pin state from the desktop shell and re-reads settings when another window changes them
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.getState().then((state) => {
      if (active) setPinned(state.pinned);
    });
    const unsubscribe = bridge.onSettingsChanged(refreshClientSettingsFromOtherTab);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  const onPin = (next: boolean) => {
    setPinned(next);
    void bridge?.setPinned(next);
  };
  const windowControls = <WindowControls pinned={pinned} onPin={onPin} />;
  return (
    <main className="drag-region flex h-screen flex-col justify-center gap-1 overflow-hidden bg-background px-2.5 select-none">
      {environmentId === null ? (
        // Off macOS, or with the player turned off: the popover's not-available state.
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Music</p>
          {windowControls}
        </div>
      ) : (
        <MiniPlayerRow environmentId={environmentId} windowControls={windowControls} />
      )}
    </main>
  );
}

function WindowControls({
  pinned,
  onPin,
}: {
  pinned: boolean | null;
  onPin: (pinned: boolean) => void;
}) {
  return (
    <>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label="Keep on top"
        aria-pressed={pinned === true}
        data-pressed={pinned === true ? "" : undefined}
        disabled={pinned === null}
        onClick={() => onPin(pinned !== true)}
      >
        {pinned === false ? <PinOffIcon /> : <PinIcon />}
      </Button>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label="Open in T3 Code"
        onClick={() => void window.desktopBridge?.musicMiniPlayer.openMain()}
      >
        <ExternalLinkIcon />
      </Button>
    </>
  );
}

function MiniPlayerRow({
  environmentId,
  windowControls,
}: {
  environmentId: EnvironmentId;
  windowControls: ReactNode;
}) {
  const received = useReceivedMusicState(environmentId);
  const canControl = useAtomValue(musicEnvironment.control.permissionAtom(environmentId));
  const runControl = useAtomCommand(musicEnvironment.control);
  const [seekAnchor, setSeekAnchor] = useState<MusicSeekAnchor | null>(null);

  const state = received?.state ?? null;
  const ready = state?._tag === "ready" ? state : null;
  const track = ready?.track ?? null;
  const playing = ready?.playback === "playing";
  const controllable = canControl && state !== null && state._tag !== "permission-denied";
  // Music can take ten seconds or more to answer its first Apple event.
  const summary = state === null ? { title: "Music", detail: null } : musicStateSummary(state);

  const send = (input: MusicControlInput) => void runControl({ environmentId, input });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Space anywhere outside a control plays or pauses, a document-level key listener outside React
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat || event.defaultPrevented) return;
      if (event.target instanceof HTMLElement && event.target.closest("button, input")) return;
      if (!controllable) return;
      event.preventDefault();
      void runControl({ environmentId, input: { _tag: "play-pause" } });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [controllable, environmentId, runControl]);

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <MusicArtwork environmentId={environmentId} track={track} size="sm" />
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm text-foreground">{summary.title}</p>
          {summary.detail ? (
            <p className="truncate text-xs text-muted-foreground">{summary.detail}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Previous track"
            disabled={!controllable || track === null}
            onClick={() => send({ _tag: "previous" })}
          >
            <SkipBackIcon />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={playing ? "Pause" : "Play"}
            disabled={!controllable}
            onClick={() => send({ _tag: "play-pause" })}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Next track"
            disabled={!controllable || track === null}
            onClick={() => send({ _tag: "next" })}
          >
            <SkipForwardIcon />
          </Button>
          {track !== null && track.favorited !== undefined ? (
            <FavoriteButton
              environmentId={environmentId}
              track={track}
              favorited={track.favorited}
              disabled={!controllable}
            />
          ) : null}
          {windowControls}
        </div>
      </div>
      {received !== null && ready?.track ? (
        <SeekBar
          received={withSeekAnchor(received, seekAnchor)}
          ready={ready}
          disabled={!controllable}
          key={ready.track.id}
          onSeek={(positionSec) => {
            const anchor = { positionSec, atMs: Date.now() };
            setSeekAnchor(anchor);
            void runControl({ environmentId, input: { _tag: "seek", positionSec } }).then(
              (result) => {
                if (result._tag !== "Success") {
                  setSeekAnchor((current) => (current === anchor ? null : current));
                }
              },
            );
          }}
        />
      ) : null}
    </>
  );
}
