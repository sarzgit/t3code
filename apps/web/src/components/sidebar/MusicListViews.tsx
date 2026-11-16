import { useAtomValue } from "@effect/atom-react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { musicListPages } from "@t3tools/client-runtime/state/music";
import type { EnvironmentId, MusicListSource } from "@t3tools/contracts";
import { ChevronLeftIcon, PlayIcon, ShuffleIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { musicEnvironment, useMusicQueueStatus } from "~/state/music";
import { useEnvironmentQuery } from "~/state/query";
import { revisionedQuery } from "~/state/revisionedQuery";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { reportMusicFailure } from "./musicQueueActions";
import {
  EMPTY_TEXT_CLASS,
  QueryProblem,
  SONG_BUTTON_CLASS,
  SONG_ROW_CLASS,
  SongLine,
  SongMenu,
  type SongActions,
  useSongActions,
} from "./musicSongRows";

const PAGE_SIZE = 100;
/** Favourites can change in Music without telling T3; the server reads Music at most this often. */
const FAVOURITES_REFRESH_MS = 60_000;
const SEARCH_WAIT_MS = 250;

interface ListViewProps {
  environmentId: EnvironmentId;
  playingTrackId: string | null;
  controllable: boolean;
  onBack: () => void;
}

/** Plays from a row and carries on through the list, as a T3 queue the server builds. */
function usePlayList(environmentId: EnvironmentId, controllable: boolean, source: MusicListSource) {
  const playList = useAtomCommand(musicEnvironment.playList);
  const canPlay = useAtomValue(musicEnvironment.playList.permissionAtom(environmentId));
  return {
    playable: controllable && canPlay,
    play: (startTrackId: string | null, shuffle?: boolean) =>
      void playList({
        environmentId,
        input: { source, startTrackId, ...(shuffle === undefined ? {} : { shuffle }) },
      }).then((result) => {
        if (result._tag !== "Success") reportMusicFailure(result.cause);
      }),
  };
}

function ListHeader({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children?: ReactNode;
}) {
  const focused = useRef(false);
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label="Back to playlists"
        ref={(element) => {
          // Opening the list removed the focused row, so focus lands here once.
          if (element && !focused.current) {
            focused.current = true;
            element.focus();
          }
        }}
        onClick={onBack}
      >
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {children}
    </div>
  );
}

/** Pages the user opened with Show more, kept only while they come from one library read. */
interface PageState {
  readonly count: number;
  readonly snapshotAt: number | null;
}

export function FavoritesView({
  environmentId,
  playingTrackId,
  controllable,
  onBack,
}: ListViewProps) {
  const status = useMusicQueueStatus(environmentId);
  const revision = String(status?.favouritesRevision ?? 0);
  const [search, setSearch] = useState("");
  const [query] = useDebouncedValue(search.trim(), { wait: SEARCH_WAIT_MS });
  const [pages, setPages] = useState<PageState & { readonly query: string }>({
    count: 1,
    snapshotAt: null,
    query: "",
  });
  const { playable, play } = usePlayList(environmentId, controllable, "favourites");
  const actions = useSongActions(environmentId, controllable);
  const input = (index: number) => ({
    environmentId,
    input: {
      ...(query === "" ? {} : { query }),
      offset: index * PAGE_SIZE,
      limit: PAGE_SIZE,
    },
  });
  const first = useEnvironmentQuery(
    revisionedQuery(musicEnvironment.favorites(input(0)), revision),
  );
  useLiveRefresh(first.refresh, {
    key: `music-favourites:${environmentId}`,
    intervalMs: FAVOURITES_REFRESH_MS,
  });
  const count = musicListPages(
    pages.query === query ? pages : { count: 1, snapshotAt: null },
    first.data?.snapshotAt ?? null,
  );
  return (
    <div className="flex flex-col gap-2">
      <ListHeader title="Favourites" onBack={onBack} />
      <div className="flex gap-2">
        <Button variant="outline" size="xs" disabled={!playable} onClick={() => play(null, false)}>
          <PlayIcon />
          Play
        </Button>
        <Button variant="outline" size="xs" disabled={!playable} onClick={() => play(null, true)}>
          <ShuffleIcon />
          Shuffle
        </Button>
      </div>
      <Input
        type="search"
        size="sm"
        placeholder="Search favourites"
        aria-label="Search favourites"
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {first.data === null ? (
        <QueryProblem error={first.error} onRetry={first.refresh} />
      ) : first.data.total === 0 ? (
        <p className={EMPTY_TEXT_CLASS}>{query === "" ? "No favourite songs" : "No matches"}</p>
      ) : (
        <ScrollArea className="max-h-72" scrollFade>
          <ul className="flex flex-col" aria-label="Favourites">
            {Array.from({ length: count }, (_, index) => (
              <FavoritesPage
                key={index}
                offset={index * PAGE_SIZE}
                query={musicEnvironment.favorites(input(index))}
                revision={revision}
                snapshotAt={first.data!.snapshotAt}
                playingTrackId={playingTrackId}
                playable={playable}
                onPlay={(trackId) => play(trackId)}
                actions={actions}
                showMore={
                  index === count - 1
                    ? () =>
                        setPages({ count: count + 1, snapshotAt: first.data!.snapshotAt, query })
                    : null
                }
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function FavoritesPage({
  offset,
  query,
  revision,
  snapshotAt,
  playingTrackId,
  playable,
  onPlay,
  actions,
  showMore,
}: {
  offset: number;
  query: ReturnType<typeof musicEnvironment.favorites>;
  revision: string;
  snapshotAt: number;
  playingTrackId: string | null;
  playable: boolean;
  onPlay: (trackId: string) => void;
  actions: SongActions;
  showMore: (() => void) | null;
}) {
  const page = useEnvironmentQuery(revisionedQuery(query, revision));
  // A page from another library read would mix two lists; the first page restarts the view.
  if (page.data === null || page.data.snapshotAt !== snapshotAt) {
    return page.error === null ? null : (
      <li>
        <QueryProblem error={page.error} onRetry={page.refresh} />
      </li>
    );
  }
  const { playlistId, songs, total } = page.data;
  return (
    <>
      {songs.map((song) => (
        <li key={song.id} className={SONG_ROW_CLASS}>
          <button
            type="button"
            disabled={!playable}
            aria-current={song.id === playingTrackId ? "true" : undefined}
            className={SONG_BUTTON_CLASS}
            onClick={() => onPlay(song.id)}
          >
            <SongLine
              name={song.name}
              detail={[song.artist, song.album].filter(Boolean).join(" · ")}
              durationSec={song.durationSec}
              playing={song.id === playingTrackId}
            />
          </button>
          <SongMenu
            name={song.name}
            trackId={song.id}
            song={{ playlistId, trackId: song.id, index: song.index }}
            favorited
            actions={actions}
          />
        </li>
      ))}
      {showMore !== null && offset + songs.length < total ? (
        <li className="flex justify-center py-1">
          <Button variant="ghost-muted" size="xs" onClick={showMore}>
            Show more
          </Button>
        </li>
      ) : null}
    </>
  );
}

const RECENT_EMPTY = "Songs you play while T3 Code is running show here.";

export function RecentView({ environmentId, playingTrackId, controllable, onBack }: ListViewProps) {
  const status = useMusicQueueStatus(environmentId);
  const revision = String(status?.recentRevision ?? 0);
  const [count, setCount] = useState(1);
  const [confirming, setConfirming] = useState(false);
  const clearRecent = useAtomCommand(musicEnvironment.clearRecent);
  const canClear = useAtomValue(musicEnvironment.clearRecent.permissionAtom(environmentId));
  const { playable, play } = usePlayList(environmentId, controllable, "recent");
  const actions = useSongActions(environmentId, controllable);
  const page = (index: number) =>
    musicEnvironment.recent({
      environmentId,
      input: { offset: index * PAGE_SIZE, limit: PAGE_SIZE },
    });
  const first = useEnvironmentQuery(revisionedQuery(page(0), revision));
  const empty = first.data !== null && first.data.total === 0;
  return (
    <div className="flex flex-col gap-2">
      <ListHeader title="Recently played" onBack={onBack} />
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            Clear Recently played?
          </span>
          <Button
            variant="destructive-outline"
            size="xs"
            ref={(element) => element?.focus()}
            onClick={() => {
              setConfirming(false);
              void clearRecent({ environmentId, input: {} }).then((result) => {
                if (result._tag !== "Success") reportMusicFailure(result.cause);
              });
            }}
          >
            Clear
          </Button>
          <Button variant="ghost-muted" size="xs" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex justify-between gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={!playable || empty || first.data?.playlistId == null}
            onClick={() => play(null, false)}
          >
            <PlayIcon />
            Play
          </Button>
          <Button
            variant="ghost-muted"
            size="xs"
            disabled={!controllable || !canClear || empty}
            onClick={() => setConfirming(true)}
          >
            Clear
          </Button>
        </div>
      )}
      {first.data === null ? (
        <QueryProblem error={first.error} onRetry={first.refresh} />
      ) : empty ? (
        <p className={EMPTY_TEXT_CLASS}>{RECENT_EMPTY}</p>
      ) : (
        <ScrollArea className="max-h-72" scrollFade>
          <ul className="flex flex-col" aria-label="Recently played">
            {Array.from({ length: count }, (_, index) => (
              <RecentPage
                key={index}
                offset={index * PAGE_SIZE}
                query={page(index)}
                revision={revision}
                playingTrackId={playingTrackId}
                playable={playable}
                onPlay={(trackId) => play(trackId)}
                actions={actions}
                showMore={index === count - 1 ? () => setCount(count + 1) : null}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}

function RecentPage({
  offset,
  query,
  revision,
  playingTrackId,
  playable,
  onPlay,
  actions,
  showMore,
}: {
  offset: number;
  query: ReturnType<typeof musicEnvironment.recent>;
  revision: string;
  playingTrackId: string | null;
  playable: boolean;
  onPlay: (trackId: string) => void;
  actions: SongActions;
  showMore: (() => void) | null;
}) {
  const page = useEnvironmentQuery(revisionedQuery(query, revision));
  if (page.data === null) {
    return page.error === null ? null : (
      <li>
        <QueryProblem error={page.error} onRetry={page.refresh} />
      </li>
    );
  }
  const { playlistId, songs, total } = page.data;
  return (
    <>
      {songs.map((song) => {
        // Gone from the library (or the library could not be read): shown, not playable.
        const ref =
          playlistId === null || song.index === null
            ? null
            : { playlistId, trackId: song.trackId, index: song.index };
        return (
          <li key={song.trackId} className={SONG_ROW_CLASS}>
            <button
              type="button"
              disabled={!playable || ref === null}
              aria-current={song.trackId === playingTrackId ? "true" : undefined}
              className={SONG_BUTTON_CLASS}
              onClick={() => onPlay(song.trackId)}
            >
              <SongLine
                name={song.name}
                detail={[song.artist, song.album].filter(Boolean).join(" · ")}
                durationSec={song.durationSec}
                playing={song.trackId === playingTrackId}
              />
            </button>
            <SongMenu
              name={song.name}
              trackId={song.trackId}
              song={ref}
              favorited={false}
              actions={actions}
            />
          </li>
        );
      })}
      {showMore !== null && offset + songs.length < total ? (
        <li className="flex justify-center py-1">
          <Button variant="ghost-muted" size="xs" onClick={showMore}>
            Show more
          </Button>
        </li>
      ) : null}
    </>
  );
}
