import { useAtomValue } from "@effect/atom-react";
import {
  formatTrackTime,
  musicPositionAt,
  nextRepeatMode,
  type MusicSeekAnchor,
  type ReceivedMusicState,
  withSeekAnchor,
} from "@t3tools/client-runtime/state/music";
import type {
  EnvironmentId,
  MusicControlInput,
  MusicPlayback,
  MusicPlayerState,
  MusicRepeatMode,
} from "@t3tools/contracts";
import {
  MusicIcon,
  PauseIcon,
  PlayIcon,
  Repeat1Icon,
  RepeatIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
  Volume1Icon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { type CSSProperties, memo, useRef, useState } from "react";

import { useNowSecond } from "~/hooks/useNowSecond";
import { musicEnvironment, useMusicEnvironmentId, useReceivedMusicState } from "~/state/music";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { SidebarMenuButton } from "../ui/sidebar";
import { MusicArtwork, MusicPanel } from "./MusicPlaylistPanel";

export const SidebarMusicPlayer = memo(function SidebarMusicPlayer() {
  const environmentId = useMusicEnvironmentId();
  return environmentId === null ? null : <MusicPlayer environmentId={environmentId} />;
});

type ReadyState = Extract<MusicPlayerState, { _tag: "ready" }>;

function stateSummary(state: MusicPlayerState): { title: string; detail: string | null } {
  switch (state._tag) {
    case "ready":
      return state.track === null
        ? { title: "Not playing", detail: "Pick a playlist" }
        : { title: state.track.name || "Untitled", detail: state.track.artist || null };
    case "not-running":
      return { title: "Music", detail: "Pick a playlist" };
    case "permission-denied":
      return { title: "Music access needed", detail: "See System Settings" };
    case "unavailable":
      return { title: "Music isn't responding", detail: null };
    case "unsupported":
      return { title: "Music", detail: null };
  }
}

/** A clicked value shown until Music reports it, or for a few seconds if it never does. */
interface Pending {
  readonly playback?: { readonly value: MusicPlayback; readonly forReceivedAt: number };
  readonly shuffle?: boolean;
  readonly repeat?: MusicRepeatMode;
  readonly volume?: number;
}
const PENDING_TTL_MS = 3_000;
/** Slider changes settle for this long before one command goes out. */
const SLIDER_COMMIT_DELAY_MS = 250;

function MusicPlayer({ environmentId }: { environmentId: EnvironmentId }) {
  const received = useReceivedMusicState(environmentId);
  const canControl = useAtomValue(musicEnvironment.control.permissionAtom(environmentId));
  const runControl = useAtomCommand(musicEnvironment.control);
  const [pending, setPending] = useState<Pending>({});
  const [seekAnchor, setSeekAnchor] = useState<MusicSeekAnchor | null>(null);

  if (received === null) {
    // Music can take ten seconds or more to answer its first Apple event.
    return (
      <div className="flex h-14 items-center gap-2 rounded-lg border border-sidebar-border px-3 text-sm text-sidebar-muted-foreground">
        <MusicIcon className="size-4" />
        Music
      </div>
    );
  }
  if (received.state._tag === "unsupported") return null;
  const { state } = received;
  const ready = state._tag === "ready" ? state : null;
  const track = ready?.track ?? null;
  const playback =
    pending.playback !== undefined && pending.playback.forReceivedAt === received.receivedAtMs
      ? pending.playback.value
      : (ready?.playback ?? "stopped");
  const shuffle = pending.shuffle ?? ready?.shuffle ?? false;
  const repeat = pending.repeat ?? ready?.repeat;
  const volume = pending.volume ?? ready?.volume;
  const controllable = canControl && state._tag !== "permission-denied";
  const hasTrack = controllable && track !== null;

  const send = <K extends keyof Pending>(
    input: MusicControlInput,
    key?: K,
    optimistic?: Pending[K],
  ) => {
    if (key !== undefined) setPending((current) => ({ ...current, [key]: optimistic }));
    const clear = () =>
      setPending((current) => {
        if (key === undefined || current[key] !== optimistic) return current;
        const { [key]: _cleared, ...rest } = current;
        return rest;
      });
    void runControl({ environmentId, input }).then((result) => {
      if (result._tag !== "Success") clear();
      // The watcher reports a real change within a second; after that, show Music's own state.
      else if (key !== undefined) setTimeout(clear, PENDING_TTL_MS);
    });
  };

  const summary = stateSummary(state);
  const showControls = state._tag === "ready" || state._tag === "not-running";

  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-sidebar-border pb-1">
      <div className="p-1">
        <Popover>
          <PopoverTrigger
            render={<SidebarMenuButton size="lg" />}
            aria-label={`Music: ${summary.title}. Choose a playlist`}
          >
            <MusicArtwork environmentId={environmentId} track={track} size="sm" />
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-sm text-sidebar-foreground">
                {summary.title}
              </span>
              {summary.detail ? (
                <span className="block truncate text-xs text-sidebar-muted-foreground">
                  {summary.detail}
                </span>
              ) : null}
            </span>
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" width="md" padding="compact">
            <MusicPanel environmentId={environmentId} state={state} controllable={controllable} />
          </PopoverPopup>
        </Popover>
      </div>
      {ready?.track ? (
        <SeekBar
          received={withSeekAnchor(received, seekAnchor)}
          ready={ready}
          disabled={!controllable}
          onSeek={(positionSec) => {
            setSeekAnchor({ positionSec, atMs: Date.now() });
            send({ _tag: "seek", positionSec });
          }}
        />
      ) : null}
      {showControls ? (
        <div className="flex items-center justify-center gap-1 px-1">
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Shuffle"
            aria-pressed={shuffle}
            data-pressed={shuffle ? "" : undefined}
            disabled={!controllable || ready === null}
            onClick={() => send({ _tag: "set-shuffle", enabled: !shuffle }, "shuffle", !shuffle)}
          >
            <ShuffleIcon />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Previous track"
            disabled={!hasTrack}
            onClick={() => send({ _tag: "previous" })}
          >
            <SkipBackIcon />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={playback === "playing" ? "Pause" : "Play"}
            disabled={!controllable}
            onClick={() =>
              send({ _tag: "play-pause" }, "playback", {
                value: playback === "playing" ? "paused" : "playing",
                forReceivedAt: received.receivedAtMs,
              })
            }
          >
            {playback === "playing" ? <PauseIcon /> : <PlayIcon />}
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Next track"
            disabled={!hasTrack}
            onClick={() => send({ _tag: "next" })}
          >
            <SkipForwardIcon />
          </Button>
          {repeat !== undefined ? (
            <Button
              variant="ghost-muted"
              size="icon-xs"
              // Music ignores repeat changes until a song is loaded.
              aria-label={`Repeat: ${repeat === "one" ? "this song" : repeat === "all" ? "all" : "off"}`}
              aria-pressed={repeat !== "off"}
              data-pressed={repeat !== "off" ? "" : undefined}
              disabled={!hasTrack}
              onClick={() => {
                const mode = nextRepeatMode(repeat);
                send({ _tag: "set-repeat", mode }, "repeat", mode);
              }}
            >
              {repeat === "one" ? <Repeat1Icon /> : <RepeatIcon />}
            </Button>
          ) : null}
        </div>
      ) : null}
      {volume !== undefined && showControls ? (
        <VolumeSlider
          volume={volume}
          disabled={!controllable}
          onVolume={(next) => send({ _tag: "set-volume", volume: next }, "volume", next)}
        />
      ) : null}
    </div>
  );
}

/** Runs `commit` once input has settled, however many change events a drag or held key fires. */
function useSettledCommit<T>(commit: (value: T) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [draft, setDraft] = useState<T | null>(null);
  const change = (value: T) => {
    setDraft(value);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setDraft(null);
      commit(value);
    }, SLIDER_COMMIT_DELAY_MS);
  };
  return { draft, change };
}

function sliderStyle(fraction: number): CSSProperties {
  const clamped = Math.min(1, Math.max(0, fraction));
  return {
    "--settings-slider-progress": `${clamped * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - clamped}rem`,
  } as CSSProperties;
}

/** Re-renders once a second so the position keeps up while playing. */
function SeekBar({
  received,
  ready,
  disabled,
  onSeek,
}: {
  received: ReceivedMusicState;
  ready: ReadyState;
  disabled: boolean;
  onSeek: (positionSec: number) => void;
}) {
  const nowMs = useNowSecond();
  const { draft, change } = useSettledCommit(onSeek);
  const duration = ready.track?.durationSec ?? 0;
  const position = draft ?? musicPositionAt(received, Math.max(nowMs, received.receivedAtMs));
  return (
    <div className="flex items-center gap-2 px-2 text-2xs text-sidebar-muted-foreground tabular-nums">
      <span className="w-9 shrink-0 text-right">{formatTrackTime(position)}</span>
      <input
        type="range"
        className="settings-slider min-w-0 flex-1"
        min={0}
        max={Math.max(1, Math.floor(duration))}
        step={1}
        value={Math.floor(position)}
        disabled={disabled || duration <= 0}
        aria-label="Seek"
        aria-valuetext={`${formatTrackTime(position)} of ${formatTrackTime(duration)}`}
        style={sliderStyle(duration > 0 ? position / duration : 0)}
        onChange={(event) => change(Number(event.currentTarget.value))}
      />
      <span className="w-9 shrink-0">{formatTrackTime(duration)}</span>
    </div>
  );
}

function VolumeSlider({
  volume,
  disabled,
  onVolume,
}: {
  volume: number;
  disabled: boolean;
  onVolume: (volume: number) => void;
}) {
  const { draft, change } = useSettledCommit(onVolume);
  const value = draft ?? volume;
  const Icon = value === 0 ? VolumeXIcon : value < 50 ? Volume1Icon : Volume2Icon;
  return (
    <div className="flex items-center gap-2 px-2 text-sidebar-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <input
        type="range"
        className="settings-slider min-w-0 flex-1"
        min={0}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-label="Music volume"
        aria-valuetext={`${value}%`}
        style={sliderStyle(value / 100)}
        onChange={(event) => change(Number(event.currentTarget.value))}
      />
    </div>
  );
}
