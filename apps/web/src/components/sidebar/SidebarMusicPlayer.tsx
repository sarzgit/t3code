import { useAtomValue } from "@effect/atom-react";
import {
  formatMusicDuration,
  musicPositionAt,
  type ReceivedMusicState,
} from "@t3tools/client-runtime/state/music";
import type {
  EnvironmentId,
  MusicControlInput,
  MusicPlayback,
  MusicPlayerState,
  MusicTrack,
} from "@t3tools/contracts";
import {
  AudioLinesIcon,
  MusicIcon,
  PauseIcon,
  PlayIcon,
  ShuffleIcon,
  SkipBackIcon,
  SkipForwardIcon,
} from "lucide-react";
import { memo, useState } from "react";

import { useNowSecond } from "~/hooks/useNowSecond";
import { cn } from "~/lib/utils";
import { musicEnvironment, useMusicEnvironmentId, useReceivedMusicState } from "~/state/music";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarMenuButton } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";

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

function MusicPlayer({ environmentId }: { environmentId: EnvironmentId }) {
  const received = useReceivedMusicState(environmentId);
  const canControl = useAtomValue(musicEnvironment.control.permissionAtom(environmentId));
  const runControl = useAtomCommand(musicEnvironment.control);
  // A click shows its result at once; the next state from the server replaces it.
  const [pending, setPending] = useState<{
    readonly forReceivedAt: number;
    readonly playback: MusicPlayback;
  } | null>(null);

  if (received === null || received.state._tag === "unsupported") return null;
  const { state } = received;
  const ready = state._tag === "ready" ? state : null;
  const playback =
    pending !== null && pending.forReceivedAt === received.receivedAtMs
      ? pending.playback
      : (ready?.playback ?? "stopped");
  const controllable = canControl && state._tag !== "permission-denied";

  const control = (input: MusicControlInput) => {
    if (input._tag === "play-pause") {
      setPending({
        forReceivedAt: received.receivedAtMs,
        playback: playback === "playing" ? "paused" : "playing",
      });
    }
    void runControl({ environmentId, input }).then((result) => {
      if (result._tag !== "Success") setPending(null);
    });
  };

  const summary = stateSummary(state);
  const track = ready?.track ?? null;

  return (
    <div className="flex flex-col rounded-lg border border-sidebar-border">
      <div className="flex items-center gap-1 p-1">
        <Popover>
          <div className="min-w-0 flex-1">
            <PopoverTrigger
              render={<SidebarMenuButton size="lg" />}
              aria-label={`Music: ${summary.title}. Choose a playlist`}
            >
              <Artwork environmentId={environmentId} track={track} size="sm" />
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
          </div>
          <PopoverPopup side="top" align="start" width="md" padding="compact">
            <MusicPanel
              environmentId={environmentId}
              state={state}
              playback={playback}
              controllable={controllable}
              onControl={control}
            />
          </PopoverPopup>
        </Popover>
        {state._tag === "ready" || state._tag === "not-running" ? (
          <>
            <PlayPauseButton
              playback={playback}
              disabled={!controllable}
              onClick={() => control({ _tag: "play-pause" })}
            />
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Next track"
              disabled={!controllable || track === null}
              onClick={() => control({ _tag: "next" })}
            >
              <SkipForwardIcon />
            </Button>
          </>
        ) : null}
      </div>
      {ready?.track ? <MusicProgress received={received} ready={ready} /> : null}
    </div>
  );
}

function PlayPauseButton(props: {
  playback: MusicPlayback;
  disabled: boolean;
  onClick: () => void;
  size?: "icon-xs" | "icon-sm";
}) {
  const playing = props.playback === "playing";
  return (
    <Button
      variant="ghost-muted"
      size={props.size ?? "icon-xs"}
      aria-label={playing ? "Pause" : "Play"}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
    </Button>
  );
}

function MusicProgress({ received, ready }: { received: ReceivedMusicState; ready: ReadyState }) {
  return ready.playback === "playing" ? (
    <TickingProgressBar received={received} />
  ) : (
    <ProgressBar received={received} nowMs={received.receivedAtMs} />
  );
}

/** Re-renders once a second, and only while playing. */
function TickingProgressBar({ received }: { received: ReceivedMusicState }) {
  const nowMs = useNowSecond();
  return <ProgressBar received={received} nowMs={Math.max(nowMs, received.receivedAtMs)} />;
}

function ProgressBar({ received, nowMs }: { received: ReceivedMusicState; nowMs: number }) {
  const duration = received.state._tag === "ready" ? (received.state.track?.durationSec ?? 0) : 0;
  const fraction = duration > 0 ? musicPositionAt(received, nowMs) / duration : 0;
  return (
    <div className="mx-2 mb-1.5 h-0.5 overflow-hidden rounded-full bg-sidebar-border" aria-hidden>
      <div className="h-full bg-sidebar-foreground/70" style={{ width: `${fraction * 100}%` }} />
    </div>
  );
}

function Artwork({
  environmentId,
  track,
  size,
}: {
  environmentId: EnvironmentId;
  track: MusicTrack | null;
  size: "sm" | "lg";
}) {
  const query = useEnvironmentQuery(
    track === null
      ? null
      : musicEnvironment.artwork({ environmentId, input: { trackId: track.id } }),
  );
  const dataUrl = query.data?.dataUrl ?? null;
  const box = size === "sm" ? "size-8 rounded-md" : "size-14 rounded-lg";
  return dataUrl ? (
    <img src={dataUrl} alt="" className={cn(box, "shrink-0 object-cover")} draggable={false} />
  ) : (
    <span className={cn(box, "grid shrink-0 place-items-center bg-muted text-muted-foreground")}>
      <MusicIcon className={size === "sm" ? "size-4" : "size-6"} />
    </span>
  );
}

function MusicPanel({
  environmentId,
  state,
  playback,
  controllable,
  onControl,
}: {
  environmentId: EnvironmentId;
  state: MusicPlayerState;
  playback: MusicPlayback;
  controllable: boolean;
  onControl: (input: MusicControlInput) => void;
}) {
  if (state._tag === "permission-denied") {
    return (
      <p className="py-1 text-sm text-muted-foreground">
        macOS blocked T3 Code from controlling Music. Turn it on in System Settings › Privacy &
        Security › Automation, under T3 Code.
      </p>
    );
  }
  const ready = state._tag === "ready" ? state : null;
  const track = ready?.track ?? null;
  return (
    <div className="flex flex-col gap-3">
      {track ? (
        <div className="flex items-center gap-3">
          <Artwork environmentId={environmentId} track={track} size="lg" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium">{track.name || "Untitled"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[track.artist, track.album].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
      ) : null}
      {state._tag === "ready" || state._tag === "not-running" ? (
        <div className="flex items-center justify-center gap-1">
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Shuffle"
            aria-pressed={ready?.shuffle ?? false}
            data-pressed={ready?.shuffle ? "" : undefined}
            disabled={!controllable || ready === null}
            onClick={() => onControl({ _tag: "set-shuffle", enabled: !(ready?.shuffle ?? false) })}
          >
            <ShuffleIcon />
          </Button>
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Previous track"
            disabled={!controllable || track === null}
            onClick={() => onControl({ _tag: "previous" })}
          >
            <SkipBackIcon />
          </Button>
          <PlayPauseButton
            size="icon-sm"
            playback={playback}
            disabled={!controllable}
            onClick={() => onControl({ _tag: "play-pause" })}
          />
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label="Next track"
            disabled={!controllable || track === null}
            onClick={() => onControl({ _tag: "next" })}
          >
            <SkipForwardIcon />
          </Button>
        </div>
      ) : null}
      <PlaylistList
        environmentId={environmentId}
        currentPlaylistId={ready?.playlistId ?? null}
        controllable={controllable}
      />
    </div>
  );
}

function PlaylistList({
  environmentId,
  currentPlaylistId,
  controllable,
}: {
  environmentId: EnvironmentId;
  currentPlaylistId: string | null;
  controllable: boolean;
}) {
  const query = useEnvironmentQuery(musicEnvironment.playlists({ environmentId, input: {} }));
  const play = useAtomCommand(musicEnvironment.playPlaylist);
  const [search, setSearch] = useState("");
  const needle = search.trim().toLocaleLowerCase();
  const playlists = (query.data?.playlists ?? []).filter(
    (playlist) => needle === "" || playlist.name.toLocaleLowerCase().includes(needle),
  );

  return (
    <div className="flex flex-col gap-2">
      <Input
        type="search"
        size="sm"
        placeholder="Search playlists"
        aria-label="Search playlists"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {query.data === null ? (
        query.error ? (
          <div className="flex items-center justify-between gap-2 py-1 text-xs text-muted-foreground">
            <span>{query.error}</span>
            <Button variant="outline" size="xs" onClick={query.refresh}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex justify-center py-3">
            <Spinner />
          </div>
        )
      ) : playlists.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">
          {needle === "" ? "No playlists in your library" : "No matches"}
        </p>
      ) : (
        <ScrollArea className="max-h-64" scrollFade>
          <ul className="flex flex-col">
            {playlists.map((playlist) => {
              const current = playlist.id === currentPlaylistId;
              return (
                <li key={playlist.id}>
                  <button
                    type="button"
                    disabled={!controllable}
                    aria-current={current ? "true" : undefined}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60"
                    onClick={() => void play({ environmentId, input: { playlistId: playlist.id } })}
                  >
                    <span className={cn("min-w-0 flex-1 truncate", current && "font-medium")}>
                      {playlist.name}
                    </span>
                    {current ? (
                      <AudioLinesIcon className="size-3.5 shrink-0" aria-label="Playing" />
                    ) : null}
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatMusicDuration(playlist.durationSec)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
