import { useAtomValue } from "@effect/atom-react";
import { formatTrackTime } from "@t3tools/client-runtime/state/music";
import type { EnvironmentId, MusicQueueActive, MusicSongRef } from "@t3tools/contracts";
import {
  AudioLinesIcon,
  EllipsisIcon,
  HeartIcon,
  HeartOffIcon,
  ListEndIcon,
  ListStartIcon,
  Repeat1Icon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { musicEnvironment, useMusicQueueStatus } from "~/state/music";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { reportMusicFailure, useMusicQueueEdit } from "./musicQueueActions";

/** One song's name, detail and length; rows add the button or list semantics. */
export function SongLine({
  name,
  detail,
  durationSec,
  playing,
  repeating = false,
}: {
  name: string;
  detail: string;
  durationSec: number;
  playing: boolean;
  repeating?: boolean;
}) {
  return (
    <>
      <span className="min-w-0 flex-1 leading-tight">
        <span className={cn("block truncate text-sm", playing && "font-medium")}>
          {name || "Untitled"}
        </span>
        {detail ? (
          <span className="block truncate text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      {repeating ? (
        <Repeat1Icon className="size-3.5 shrink-0 text-muted-foreground" aria-label="Repeats" />
      ) : null}
      {playing ? <AudioLinesIcon className="size-3.5 shrink-0" aria-label="Playing" /> : null}
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatTrackTime(durationSec)}
      </span>
    </>
  );
}

export const SONG_BUTTON_CLASS =
  "flex h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60";

/** A song row: the play button plus its menu, which shows on hover or focus. */
export const SONG_ROW_CLASS =
  "group/song flex items-center rounded-md hover:bg-accent focus-within:bg-accent";
export const ROW_MENU_REVEAL_CLASS =
  "flex shrink-0 pe-1 opacity-0 group-hover/song:opacity-100 group-focus-within/song:opacity-100 has-[[data-popup-open]]:opacity-100 any-pointer-coarse:opacity-100";

export const SONG_ROW_HEIGHT = 44;
export const SONG_LIST_MAX_HEIGHT = 288;

export const EMPTY_TEXT_CLASS = "py-2 text-center text-xs text-muted-foreground";

export function QueryProblem({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return error ? (
    <div className="flex items-center justify-between gap-2 px-2 py-1 text-xs text-muted-foreground">
      <span>{error}</span>
      <Button variant="outline" size="xs" onClick={onRetry}>
        Retry
      </Button>
    </div>
  ) : (
    <div className="flex justify-center py-3">
      <Spinner />
    </div>
  );
}

type SongQueueAction = "play-next" | "add";

/** What a song row's menu can do here: queue into the active T3 queue, and favourite. */
export interface SongActions {
  /** Null when there is no T3 queue to add to, or no permission to edit it. */
  readonly active: MusicQueueActive | null;
  readonly onQueue: (action: SongQueueAction, song: MusicSongRef) => void;
  readonly canFavorite: boolean;
  readonly onFavorite: (trackId: string, favorited: boolean) => void;
}

export function useSongActions(environmentId: EnvironmentId, controllable: boolean): SongActions {
  const status = useMusicQueueStatus(environmentId);
  const canEdit = useAtomValue(musicEnvironment.editQueue.permissionAtom(environmentId));
  const canFavorite = useAtomValue(
    musicEnvironment.setTrackFavorited.permissionAtom(environmentId),
  );
  const edit = useMusicQueueEdit();
  const setFavorited = useAtomCommand(musicEnvironment.setTrackFavorited);
  const active = controllable && canEdit ? (status?.active ?? null) : null;
  const favorite = (trackId: string, favorited: boolean, undoable: boolean) =>
    void setFavorited({ environmentId, input: { trackId, favorited } }).then((result) => {
      if (result._tag !== "Success") return reportMusicFailure(result.cause);
      if (!undoable) return;
      const toastId = toastManager.add({
        type: favorited ? "success" : "info",
        title: favorited ? "Added to Favourites" : "Removed from Favourites",
        ...(favorited
          ? {}
          : {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(toastId);
                  favorite(trackId, true, false);
                },
              },
            }),
      });
    });
  return {
    active,
    onQueue: (action, song) => {
      if (active === null) return;
      void edit(environmentId, active, { _tag: action, songs: [song] }).then((ref) => {
        if (ref === null) return;
        toastManager.add({
          type: "success",
          title: action === "play-next" ? "Playing next" : "Added to Up Next",
        });
      });
    },
    canFavorite: controllable && canFavorite,
    onFavorite: (trackId, favorited) => favorite(trackId, favorited, true),
  };
}

const QUEUE_UNAVAILABLE_HINT = "Start playback from T3 Code to edit Up Next";

/**
 * Every song row's one menu. `song` is null for a song no longer in the library; `favorited`
 * is what the row knows, and an unknown flag offers Favourite.
 */
export function SongMenu({
  name,
  trackId,
  song,
  favorited,
  actions,
}: {
  name: string;
  trackId: string;
  song: MusicSongRef | null;
  favorited: boolean;
  actions: SongActions;
}) {
  const queueDisabled = actions.active === null || song === null;
  const item = (action: SongQueueAction, icon: ReactNode, label: string) => {
    const menuItem = (
      <MenuItem
        disabled={queueDisabled}
        onClick={() => {
          if (song !== null) actions.onQueue(action, song);
        }}
      >
        {icon}
        {label}
      </MenuItem>
    );
    return actions.active === null && song !== null ? (
      <Tooltip>
        <TooltipTrigger render={<div />}>{menuItem}</TooltipTrigger>
        <TooltipPopup side="left">{QUEUE_UNAVAILABLE_HINT}</TooltipPopup>
      </Tooltip>
    ) : (
      menuItem
    );
  };
  return (
    <span className={ROW_MENU_REVEAL_CLASS}>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost-muted" size="icon-xs" />}
          aria-label={`More for ${name || "Untitled"}`}
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {item("play-next", <ListStartIcon />, "Play next")}
          {item("add", <ListEndIcon />, "Add to Up Next")}
          <MenuSeparator />
          <MenuItem
            disabled={!actions.canFavorite || song === null}
            onClick={() => actions.onFavorite(trackId, !favorited)}
          >
            {favorited ? <HeartOffIcon /> : <HeartIcon />}
            {favorited ? "Unfavourite" : "Favourite"}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </span>
  );
}
