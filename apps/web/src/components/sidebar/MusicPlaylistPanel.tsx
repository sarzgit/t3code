import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { LegendList } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import {
  arrangeMusicPlaylists,
  formatMusicDuration,
  formatTrackTime,
  musicQueueViewRevision,
  musicUpNextSource,
} from "@t3tools/client-runtime/state/music";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type MusicPlayerState,
  type MusicPlaylist,
  type MusicPlaylistPlacement,
  type MusicPlaylistPreferences,
  type MusicPlaylistTrack,
  type MusicQueueActive,
  type MusicQueueEdit,
  type MusicQueueEntry,
  type MusicSavedQueue,
  type MusicTrack,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  AudioLinesIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EllipsisIcon,
  EyeOffIcon,
  GripVerticalIcon,
  HeartIcon,
  HistoryIcon,
  MusicIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  Repeat1Icon,
  ShuffleIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { musicEnvironment, useMusicQueueStatus } from "~/state/music";
import { useEnvironmentQuery } from "~/state/query";
import { revisionedQuery } from "~/state/revisionedQuery";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { FavoritesView, RecentView } from "./MusicListViews";
import { ListeningStats } from "./MusicListeningStats";
import { reportMusicFailure, useMusicQueueEdit } from "./musicQueueActions";
import {
  EMPTY_TEXT_CLASS,
  QueryProblem,
  ROW_MENU_REVEAL_CLASS,
  SONG_BUTTON_CLASS,
  SONG_LIST_MAX_HEIGHT,
  SONG_ROW_CLASS,
  SONG_ROW_HEIGHT,
  SongLine,
  SongMenu,
  useSongActions,
} from "./musicSongRows";

export function MusicArtwork({
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

type PanelView =
  | { readonly kind: "playlists"; readonly returnFocusTo: string | null }
  | { readonly kind: "songs"; readonly playlist: MusicPlaylist }
  | { readonly kind: "favourites" }
  | { readonly kind: "recent" }
  | { readonly kind: "up-next" }
  | { readonly kind: "stats" };

/** Popover content: what is playing, then playlists or one playlist's songs. */
export function MusicPanel({
  environmentId,
  state,
  controllable,
}: {
  environmentId: EnvironmentId;
  state: MusicPlayerState;
  controllable: boolean;
}) {
  const [view, setView] = useState<PanelView>({ kind: "playlists", returnFocusTo: null });
  const [playlistSearch, setPlaylistSearch] = useState("");
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
          <MusicArtwork environmentId={environmentId} track={track} size="lg" />
          <div className="min-w-0 flex-1 leading-tight">
            <p className="truncate text-sm font-medium">{track.name || "Untitled"}</p>
            <p className="truncate text-xs text-muted-foreground">
              {[track.artist, track.album].filter(Boolean).join(" · ")}
            </p>
          </div>
          {track.favorited !== undefined ? (
            <FavoriteButton
              environmentId={environmentId}
              track={track}
              favorited={track.favorited}
              disabled={!controllable}
            />
          ) : null}
        </div>
      ) : null}
      {view.kind === "playlists" || view.kind === "up-next" || view.kind === "stats" ? (
        <ToggleGroup
          aria-label="Music view"
          className="w-full *:flex-1"
          variant="segmented"
          value={[view.kind]}
          onValueChange={(next) => {
            if (next[0] === "stats") setView({ kind: "stats" });
            else if (next[0] === "up-next") setView({ kind: "up-next" });
            else if (next[0] === "playlists") setView({ kind: "playlists", returnFocusTo: null });
          }}
        >
          <Toggle value="playlists">Playlists</Toggle>
          <Toggle value="up-next">Up Next</Toggle>
          <Toggle value="stats">Stats</Toggle>
        </ToggleGroup>
      ) : null}
      {view.kind === "stats" ? (
        <ListeningStats environmentId={environmentId} />
      ) : view.kind === "up-next" ? (
        <UpNext environmentId={environmentId} state={state} controllable={controllable} />
      ) : view.kind === "favourites" ? (
        <FavoritesView
          environmentId={environmentId}
          playingTrackId={track?.id ?? null}
          controllable={controllable}
          onBack={() => setView({ kind: "playlists", returnFocusTo: "favourites" })}
        />
      ) : view.kind === "recent" ? (
        <RecentView
          environmentId={environmentId}
          playingTrackId={track?.id ?? null}
          controllable={controllable}
          onBack={() => setView({ kind: "playlists", returnFocusTo: "recent" })}
        />
      ) : view.kind === "songs" ? (
        <PlaylistSongs
          environmentId={environmentId}
          playlist={view.playlist}
          playingTrackId={ready?.playlistId === view.playlist.id ? (track?.id ?? null) : null}
          controllable={controllable}
          onBack={() => setView({ kind: "playlists", returnFocusTo: view.playlist.id })}
        />
      ) : (
        <PlaylistList
          environmentId={environmentId}
          currentPlaylistId={ready?.playlistId ?? null}
          playingTrackId={track?.id ?? null}
          controllable={controllable}
          search={playlistSearch}
          onSearchChange={setPlaylistSearch}
          returnFocusTo={view.returnFocusTo}
          onOpen={(playlist) => setView({ kind: "songs", playlist })}
          onOpenList={(kind) => setView({ kind })}
        />
      )}
    </div>
  );
}

/** Shows the click at once; Music's own value takes over once the watcher reports it. */
function FavoriteButton({
  environmentId,
  track,
  favorited,
  disabled,
}: {
  environmentId: EnvironmentId;
  track: MusicTrack;
  favorited: boolean;
  disabled: boolean;
}) {
  const runControl = useAtomCommand(musicEnvironment.control);
  const [sent, setSent] = useState<{ readonly trackId: string; readonly value: boolean } | null>(
    null,
  );
  const shown = sent !== null && sent.trackId === track.id ? sent.value : favorited;
  return (
    <Button
      variant="ghost-muted"
      size="icon-sm"
      aria-label="Favorite"
      aria-pressed={shown}
      data-pressed={shown ? "" : undefined}
      disabled={disabled}
      onClick={() => {
        const next = { trackId: track.id, value: !shown };
        setSent(next);
        const clear = () => setSent((current) => (current === next ? null : current));
        void runControl({
          environmentId,
          input: { _tag: "set-favorited", trackId: track.id, favorited: next.value },
        }).then((result) => {
          if (result._tag !== "Success") clear();
          else setTimeout(clear, 3_000);
        });
      }}
    >
      <HeartIcon className={cn(shown && "fill-current")} />
    </Button>
  );
}

function PlaylistSongs({
  environmentId,
  playlist,
  playingTrackId,
  controllable,
  onBack,
}: {
  environmentId: EnvironmentId;
  playlist: MusicPlaylist;
  playingTrackId: string | null;
  controllable: boolean;
  onBack: () => void;
}) {
  const query = useEnvironmentQuery(
    musicEnvironment.tracks({ environmentId, input: { playlistId: playlist.id } }),
  );
  const playTrack = useAtomCommand(musicEnvironment.playTrack);
  const playPlaylist = useAtomCommand(musicEnvironment.playPlaylist);
  const canPlay = useAtomValue(musicEnvironment.playTrack.permissionAtom(environmentId));
  const [search, setSearch] = useState("");
  const focused = useRef(false);
  const needle = search.trim().toLocaleLowerCase();
  const songs = (query.data?.tracks ?? []).filter(
    (song) =>
      needle === "" ||
      song.name.toLocaleLowerCase().includes(needle) ||
      song.artist.toLocaleLowerCase().includes(needle),
  );
  const playable = controllable && canPlay;
  const songActions = useSongActions(environmentId, controllable);
  const startPlaylist = (shuffle: boolean) =>
    void playPlaylist({ environmentId, input: { playlistId: playlist.id, shuffle } });

  const renderSong = (song: MusicPlaylistTrack) => {
    const playing = song.id === playingTrackId;
    const ref = { playlistId: playlist.id, trackId: song.id, index: song.index };
    return (
      <div role="listitem" className={SONG_ROW_CLASS}>
        <button
          type="button"
          disabled={!playable}
          aria-current={playing ? "true" : undefined}
          className={SONG_BUTTON_CLASS}
          onClick={() => void playTrack({ environmentId, input: ref })}
        >
          <SongLine
            name={song.name}
            detail={song.artist}
            durationSec={song.durationSec}
            playing={playing}
          />
        </button>
        <SongMenu
          name={song.name}
          trackId={song.id}
          song={ref}
          favorited={false}
          actions={songActions}
        />
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Back to playlists"
          ref={(element) => {
            // Opening a playlist removed the focused row, so focus lands here once.
            if (element && !focused.current) {
              focused.current = true;
              element.focus();
            }
          }}
          onClick={onBack}
        >
          <ChevronLeftIcon />
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{playlist.name}</span>
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="xs"
          disabled={!playable}
          onClick={() => startPlaylist(false)}
        >
          <PlayIcon />
          Play
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={!playable}
          onClick={() => startPlaylist(true)}
        >
          <ShuffleIcon />
          Shuffle
        </Button>
      </div>
      <Input
        type="search"
        size="sm"
        placeholder="Search songs"
        aria-label={`Search songs in ${playlist.name}`}
        value={search}
        onChange={(event) => setSearch(event.currentTarget.value)}
      />
      {query.data === null ? (
        <QueryProblem error={query.error} onRetry={query.refresh} />
      ) : songs.length === 0 ? (
        <p className={EMPTY_TEXT_CLASS}>{needle === "" ? "No songs" : "No matches"}</p>
      ) : (
        <div
          className="relative w-full overflow-hidden"
          role="list"
          aria-label={`Songs in ${playlist.name}`}
          style={{ height: Math.min(SONG_LIST_MAX_HEIGHT, songs.length * SONG_ROW_HEIGHT) }}
        >
          <LegendList<MusicPlaylistTrack>
            data={songs}
            dataKey={search}
            initialScrollOffset={0}
            // Rows only rerender for new data; the playing mark, permission and queue live outside it.
            extraData={`${playingTrackId}:${playable}:${songActions.active?.id ?? ""}:${songActions.active?.revision ?? ""}:${songActions.active?.edited ?? ""}`}
            keyExtractor={(song) => `${song.id}:${song.index}`}
            renderItem={({ item }) => renderSong(item)}
            estimatedItemSize={SONG_ROW_HEIGHT}
            drawDistance={SONG_ROW_HEIGHT * 8}
            style={{ height: "100%" }}
          />
        </div>
      )}
      {query.data !== null && query.data.total > query.data.tracks.length ? (
        <p className="text-xs text-muted-foreground">
          First {query.data.tracks.length.toLocaleString()} of {query.data.total.toLocaleString()}{" "}
          songs
        </p>
      ) : null}
    </div>
  );
}

/** Library search runs once typing pauses for this long. */
const SONG_SEARCH_WAIT_MS = 250;

const EMPTY_MUSIC_PLAYLIST_PREFERENCES: MusicPlaylistPreferences = { pinned: [], hidden: [] };
const selectMusicPlaylistPreferences = (settings: ServerSettings | null) =>
  settings?.musicPlaylists ?? EMPTY_MUSIC_PLAYLIST_PREFERENCES;

/** Library songs for a search; null until a typed query first settles. */
function LibrarySongs({
  environmentId,
  query,
  playingTrackId,
  controllable,
  afterPlaylists,
}: {
  environmentId: EnvironmentId;
  query: string | null;
  playingTrackId: string | null;
  controllable: boolean;
  afterPlaylists: boolean;
}) {
  const result = useEnvironmentQuery(
    query === null ? null : musicEnvironment.librarySearch({ environmentId, input: { query } }),
  );
  const playTrack = useAtomCommand(musicEnvironment.playTrack);
  const canPlay = useAtomValue(musicEnvironment.playTrack.permissionAtom(environmentId));
  const playable = controllable && canPlay;
  const songActions = useSongActions(environmentId, controllable);
  if (query === null || result.data === null) {
    return <QueryProblem error={query === null ? null : result.error} onRetry={result.refresh} />;
  }
  const { playlistId, songs, total } = result.data;
  if (songs.length === 0) {
    return afterPlaylists ? null : <p className={EMPTY_TEXT_CLASS}>No matches</p>;
  }
  return (
    <section
      aria-label="Songs"
      className={cn("flex flex-col", afterPlaylists && "mt-1 border-t border-border pt-1")}
    >
      <p className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">Songs</p>
      <ul className="flex flex-col">
        {songs.map((song) => {
          const ref = { playlistId, trackId: song.id, index: song.index };
          return (
            <li key={song.id} className={SONG_ROW_CLASS}>
              <button
                type="button"
                disabled={!playable}
                aria-current={song.id === playingTrackId ? "true" : undefined}
                className={SONG_BUTTON_CLASS}
                // The library is the context: next and previous move through it, not the results.
                onClick={() => void playTrack({ environmentId, input: ref })}
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
                song={ref}
                favorited={false}
                actions={songActions}
              />
            </li>
          );
        })}
      </ul>
      {total > songs.length ? (
        <p className="px-2 pt-1 text-xs text-muted-foreground">
          First {songs.length} of {total.toLocaleString()} songs
        </p>
      ) : null}
    </section>
  );
}

function UpNext({
  environmentId,
  state,
  controllable,
}: {
  environmentId: EnvironmentId;
  state: MusicPlayerState;
  controllable: boolean;
}) {
  const status = useMusicQueueStatus(environmentId);
  const canEdit = useAtomValue(musicEnvironment.editQueue.permissionAtom(environmentId));
  const source = musicUpNextSource(state, status?.active ?? null);
  const query = useEnvironmentQuery(
    source._tag === "known"
      ? musicEnvironment.upNext({ environmentId, input: source.input })
      : null,
  );
  if (source._tag === "queue") {
    return (
      <QueueUpNext
        environmentId={environmentId}
        active={source.active}
        repeatOne={state._tag === "ready" && state.repeat === "one"}
        editable={controllable && canEdit}
      />
    );
  }
  const saved =
    status?.saved != null ? (
      <SavedQueueCard
        environmentId={environmentId}
        saved={status.saved}
        controllable={controllable}
      />
    ) : null;
  let list: ReactNode;
  if (source._tag === "nothing-playing") {
    list = saved === null ? <p className={EMPTY_TEXT_CLASS}>Nothing playing</p> : null;
  } else if (source._tag === "repeating") {
    list = (
      <p className={cn(EMPTY_TEXT_CLASS, "flex items-center justify-center gap-1.5")}>
        <Repeat1Icon className="size-3.5 shrink-0" aria-hidden />
        This song repeats
      </p>
    );
  } else if (source._tag === "native") {
    list = <NativeUpNext environmentId={environmentId} trackId={source.trackId} />;
  } else if (query.data === null) {
    list = <QueryProblem error={query.error} onRetry={query.refresh} />;
  } else {
    const { playlistName, tracks } = query.data;
    const name = playlistName || "playlist";
    const label =
      tracks.length === 0
        ? `Last song in ${name}`
        : source.input.shuffle
          ? `Shuffling ${name}`
          : `Next in ${name}`;
    list = (
      <div className="flex flex-col gap-1">
        <p className="truncate px-2 text-xs text-muted-foreground">{label}</p>
        {tracks.length > 0 ? (
          <ScrollArea className="max-h-64" scrollFade>
            <ol className="flex flex-col" aria-label={label}>
              {tracks.map((song) => (
                <li key={`${song.id}:${song.index}`} className="flex h-11 items-center gap-2 px-2">
                  <SongLine
                    name={song.name}
                    detail={song.artist}
                    durationSec={song.durationSec}
                    playing={false}
                  />
                </li>
              ))}
            </ol>
          </ScrollArea>
        ) : null}
      </div>
    );
  }
  return saved === null ? (
    list
  ) : (
    <div className="flex flex-col gap-2">
      {saved}
      {list}
    </div>
  );
}

/** The queue T3 last ran, offered when nothing T3-managed plays. Never plays by itself. */
function SavedQueueCard({
  environmentId,
  saved,
  controllable,
}: {
  environmentId: EnvironmentId;
  saved: MusicSavedQueue;
  controllable: boolean;
}) {
  const resume = useAtomCommand(musicEnvironment.resumeQueue);
  const dismiss = useAtomCommand(musicEnvironment.dismissSavedQueue);
  const canResume = useAtomValue(musicEnvironment.resumeQueue.permissionAtom(environmentId));
  const canDismiss = useAtomValue(musicEnvironment.dismissSavedQueue.permissionAtom(environmentId));
  const [sending, setSending] = useState(false);
  const input = { queueId: saved.id, revision: saved.revision };
  const send = (command: typeof resume) => {
    setSending(true);
    void command({ environmentId, input }).then((result) => {
      setSending(false);
      if (result._tag !== "Success") reportMusicFailure(result.cause);
    });
  };
  const detail = saved.sourceMissing
    ? "Playlist no longer in your library"
    : [
        saved.artist,
        saved.sourceName,
        saved.positionSec > 0 ? formatTrackTime(saved.positionSec) : null,
      ]
        .filter(Boolean)
        .join(" · ");
  return (
    <section aria-label="Resume" className="flex flex-col gap-1">
      <p className="px-2 text-xs text-muted-foreground">Resume</p>
      <div className="flex items-center gap-1 rounded-md border border-border py-1 ps-2 pe-1">
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm">{saved.trackName}</span>
          {detail ? (
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          ) : null}
        </span>
        {saved.sourceMissing ? null : (
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={`Resume ${saved.trackName}`}
            disabled={!controllable || !canResume || sending}
            onClick={() => send(resume)}
          >
            <PlayIcon />
          </Button>
        )}
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label="Dismiss saved queue"
          disabled={!canDismiss || sending}
          onClick={() => send(dismiss)}
        >
          <XIcon />
        </Button>
      </div>
    </section>
  );
}

/** Where focus goes once the edit's new list lands: an entry's menu, or the header's (null). */
interface PendingQueueFocus {
  readonly key: string | null;
  readonly fromRevision: number;
}

/** T3's own queue: the list that will play, editable from each row's menu or by dragging. */
function QueueUpNext({
  environmentId,
  active,
  repeatOne,
  editable,
}: {
  environmentId: EnvironmentId;
  active: MusicQueueActive;
  repeatOne: boolean;
  editable: boolean;
}) {
  const query = useEnvironmentQuery(
    revisionedQuery(
      musicEnvironment.queueView({ environmentId, input: { queueId: active.id } }),
      musicQueueViewRevision(active),
    ),
  );
  const edit = useMusicQueueEdit();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // A drop shows its order at once; the server's next list replaces it.
  const [dropped, setDropped] = useState<{
    readonly revision: number;
    readonly keys: ReadonlyArray<string>;
  } | null>(null);
  const pendingFocus = useRef<PendingQueueFocus | null>(null);
  const view = query.data;
  // A failed refresh replaces the rows, so stale songs never stay listed as next.
  if (query.error !== null || view === null) {
    return <QueryProblem error={query.error} onRetry={query.refresh} />;
  }
  const upcoming =
    dropped !== null && dropped.revision === view.revision
      ? dropped.keys.flatMap((key) => view.upcoming.find((entry) => entry.key === key) ?? [])
      : view.upcoming;
  const name = view.sourceName || "playlist";
  const label =
    view.totalUpcoming === 0
      ? `Last song in ${name}`
      : view.shuffled
        ? `Shuffling ${name}`
        : `Next in ${name}`;

  const run = async (change: MusicQueueEdit, focusKey: string | null | undefined) => {
    if (focusKey !== undefined)
      pendingFocus.current = { key: focusKey, fromRevision: view.revision };
    const ref = await edit(environmentId, view, change);
    if (ref === null) {
      pendingFocus.current = null;
      setDropped(null);
      query.refresh();
    }
    return ref;
  };
  const claimFocus = (key: string | null) => (element: HTMLElement | null) => {
    const pending = pendingFocus.current;
    if (element === null || pending === null || pending.key !== key) return;
    if (pending.fromRevision === view.revision) return;
    pendingFocus.current = null;
    element.focus();
  };
  const move = (entry: MusicQueueEntry, toIndex: number) =>
    void run(
      { _tag: "move", target: { key: entry.key, trackId: entry.trackId }, toIndex },
      entry.key,
    );
  const remove = async (entry: MusicQueueEntry, index: number) => {
    const focusKey = upcoming[index + 1]?.key ?? upcoming[index - 1]?.key ?? null;
    const target = { key: entry.key, trackId: entry.trackId };
    const ref = await run({ _tag: "remove", targets: [target] }, focusKey);
    if (ref === null) return;
    const undoTo: MusicQueueActive = {
      id: ref.id,
      revision: ref.revision,
      edited: true,
      currentKey: view.currentKey,
    };
    const toastId = toastManager.add({
      type: "info",
      title: "Removed from Up Next",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void edit(environmentId, undoTo, { _tag: "undo-remove", target });
        },
      },
    });
  };
  const onDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const keys = upcoming.map((entry) => entry.key);
    const from = keys.indexOf(String(event.active.id));
    const to = keys.indexOf(String(event.over.id));
    const entry = upcoming[from];
    if (entry === undefined || to < 0) return;
    setDropped({ revision: view.revision, keys: arrayMove(keys, from, to) });
    void run(
      { _tag: "move", target: { key: entry.key, trackId: entry.trackId }, toIndex: to },
      undefined,
    );
  };

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1 ps-2">
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{label}</p>
        {editable ? (
          <Menu>
            <MenuTrigger
              render={<Button variant="ghost-muted" size="icon-xs" ref={claimFocus(null)} />}
              aria-label="Up Next options"
            >
              <EllipsisIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem
                disabled={view.totalUpcoming === 0}
                onClick={() => void run({ _tag: "clear-upcoming" }, null)}
              >
                Clear upcoming
              </MenuItem>
              {view.edited || view.shuffled ? (
                <MenuItem onClick={() => void run({ _tag: "reset" }, null)}>
                  Reset to playlist order
                </MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      <ScrollArea className="max-h-72" scrollFade>
        {view.current !== null ? (
          <div className="flex h-11 items-center gap-2 ps-2 pe-1" aria-current="true">
            <SongLine
              name={view.current.name}
              detail={view.current.artist}
              durationSec={view.current.durationSec}
              playing
              repeating={repeatOne}
            />
            {/* Keeps the length in line with the rows below, which end in a menu. */}
            {editable ? <span aria-hidden className="w-12 shrink-0" /> : null}
          </div>
        ) : null}
        {upcoming.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={upcoming.map((entry) => entry.key)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="flex flex-col" aria-label={label}>
                {upcoming.map((entry, index) => (
                  <QueueEntryRow
                    key={entry.key}
                    entry={entry}
                    editable={editable}
                    isFirst={index === 0}
                    isLast={index >= view.totalUpcoming - 1}
                    menuRef={claimFocus(entry.key)}
                    onMove={(toIndex) => move(entry, toIndex)}
                    onMoveBy={(steps) => move(entry, index + steps)}
                    onRemove={() => void remove(entry, index)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        ) : null}
      </ScrollArea>
      {view.totalUpcoming > upcoming.length ? (
        <p className="px-2 text-xs text-muted-foreground">
          {(view.totalUpcoming - upcoming.length).toLocaleString()} more
        </p>
      ) : null}
    </div>
  );
}

function QueueEntryRow({
  entry,
  editable,
  isFirst,
  isLast,
  menuRef,
  onMove,
  onMoveBy,
  onRemove,
}: {
  entry: MusicQueueEntry;
  editable: boolean;
  isFirst: boolean;
  isLast: boolean;
  menuRef: (element: HTMLElement | null) => void;
  onMove: (toIndex: number) => void;
  onMoveBy: (steps: number) => void;
  onRemove: () => void;
}) {
  const { listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } =
    useSortable({ id: entry.key, disabled: !editable });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      aria-disabled={entry.unavailable || undefined}
      className={cn(
        SONG_ROW_CLASS,
        "h-11 gap-1 ps-2",
        entry.unavailable && "text-muted-foreground",
        isDragging && "relative z-10 bg-accent shadow-md",
      )}
    >
      <SongLine
        name={entry.name}
        detail={entry.artist}
        durationSec={entry.durationSec}
        playing={false}
      />
      {editable ? (
        <>
          <span
            ref={setActivatorNodeRef}
            {...listeners}
            aria-hidden
            className="invisible flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 group-hover/song:visible hover:text-foreground active:cursor-grabbing any-pointer-coarse:visible"
          >
            <GripVerticalIcon className="size-3.5" />
          </span>
          <span className={ROW_MENU_REVEAL_CLASS}>
            <Menu>
              <MenuTrigger
                render={<Button variant="ghost-muted" size="icon-xs" ref={menuRef} />}
                aria-label={`Edit ${entry.name || "Untitled"} in Up Next`}
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem disabled={isFirst} onClick={() => onMove(0)}>
                  Move to top
                </MenuItem>
                <MenuItem disabled={isFirst} onClick={() => onMoveBy(-1)}>
                  Move up
                </MenuItem>
                <MenuItem disabled={isLast} onClick={() => onMoveBy(1)}>
                  Move down
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={onRemove}>
                  Remove
                </MenuItem>
              </MenuPopup>
            </Menu>
          </span>
        </>
      ) : null}
    </li>
  );
}

const NATIVE_QUEUE_MESSAGES = {
  "not-running": "Nothing playing",
  "panel-closed": "Open Up Next in Music to see what's next.",
  unrecognised: "T3 Code can't find Music's Up Next here. Open it in Music's Mini Player.",
  unreadable: "T3 Code found Music's Up Next but couldn't read its songs.",
  "no-upcoming-visible": "Scroll Music's Up Next to its upcoming songs.",
  "permission-needed":
    "Allow T3 Music Up Next in System Settings › Privacy & Security › Accessibility to show Music's Up Next.",
  "helper-missing": "Install the T3 Music Up Next helper to show Music's Up Next.",
} as const;

/** Keys for labels that can repeat: the label and how many times it came before. */
function keyedByOccurrence(labels: ReadonlyArray<string>) {
  const seen = new Map<string, number>();
  return labels.map((label) => {
    const count = seen.get(label) ?? 0;
    seen.set(label, count + 1);
    return { label, key: `${count}:${label}` };
  });
}

/** Music's own Up Next, as its panel shows it. T3 only reads it. */
function NativeUpNext({
  environmentId,
  trackId,
}: {
  environmentId: EnvironmentId;
  trackId: string;
}) {
  const query = useEnvironmentQuery(
    musicEnvironment.nativeQueue({ environmentId, input: { trackId } }),
  );
  // A failed refresh replaces the rows, so stale songs never stay listed as next.
  if (query.error !== null || query.data === null) {
    return <QueryProblem error={query.error} onRetry={query.refresh} />;
  }
  const queue = query.data;
  if (queue._tag !== "ok") {
    return <p className={EMPTY_TEXT_CLASS}>{NATIVE_QUEUE_MESSAGES[queue._tag]}</p>;
  }
  if (queue.sections.every((section) => section.songs.length === 0)) {
    return (
      <p className={EMPTY_TEXT_CLASS}>
        {queue.complete
          ? "Nothing up next in Music"
          : "T3 Code can't read Music's upcoming songs yet."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <ScrollArea className="max-h-64" scrollFade>
        {keyedByOccurrence(
          queue.sections.map((section) =>
            [section.title, section.source].filter(Boolean).join(" · "),
          ),
        ).map(({ label: heading, key }, sectionIndex) => {
          const songs = queue.sections[sectionIndex]!.songs;
          return (
            <section key={key} aria-label={heading} className="flex flex-col">
              <p className="truncate px-2 pt-1 pb-0.5 text-xs text-muted-foreground">{heading}</p>
              <ol className="flex flex-col">
                {keyedByOccurrence(songs).map(({ label, key: songKey }) => (
                  <li key={songKey} className="truncate px-2 py-1.5 text-sm">
                    {label}
                  </li>
                ))}
              </ol>
            </section>
          );
        })}
      </ScrollArea>
      {queue.complete ? null : (
        <p className="px-2 text-xs text-muted-foreground">More in Music's Up Next</p>
      )}
    </div>
  );
}

const LIST_ROWS = [
  { kind: "favourites", label: "Favourites", Icon: HeartIcon },
  { kind: "recent", label: "Recently played", Icon: HistoryIcon },
] as const;
const LIST_ROW_CLASS =
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function PlaylistList({
  environmentId,
  currentPlaylistId,
  playingTrackId,
  controllable,
  search,
  onSearchChange,
  returnFocusTo,
  onOpen,
  onOpenList,
}: {
  environmentId: EnvironmentId;
  currentPlaylistId: string | null;
  playingTrackId: string | null;
  controllable: boolean;
  search: string;
  onSearchChange: (search: string) => void;
  /** The playlist or list whose song view just closed; its row takes focus back. */
  returnFocusTo: string | null;
  onOpen: (playlist: MusicPlaylist) => void;
  onOpenList: (kind: "favourites" | "recent") => void;
}) {
  const query = useEnvironmentQuery(musicEnvironment.playlists({ environmentId, input: {} }));
  const pendingFocus = useRef(returnFocusTo);
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings);
  const canArrange = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const preferences = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    selectMusicPlaylistPreferences,
  );
  const [showHidden, setShowHidden] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const library = query.data?.playlists ?? [];
  const { pinned, listed, hidden } = arrangeMusicPlaylists(library, preferences, search);
  const pinnedIds = new Set(preferences.pinned);

  const place = (id: string, placement: MusicPlaylistPlacement) => {
    // Remove and Restore move the row to the other list, so keep focus inside the popover.
    const leavesList = placement === "hidden" || (placement === "listed" && !pinnedIds.has(id));
    if (leavesList) searchRef.current?.focus();
    void saveSettings({
      environmentId,
      input: { patch: { setMusicPlaylists: [{ id, placement }] } },
    });
  };

  const renderRow = (playlist: MusicPlaylist) => {
    const current = playlist.id === currentPlaylistId;
    const isPinned = pinnedIds.has(playlist.id);
    return (
      <li
        key={playlist.id}
        className="group/playlist flex items-center rounded-md hover:bg-accent focus-within:bg-accent"
      >
        <button
          type="button"
          aria-current={current ? "true" : undefined}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          ref={(element) => {
            if (element && pendingFocus.current === playlist.id) {
              pendingFocus.current = null;
              element.focus();
            }
          }}
          onClick={() => onOpen(playlist)}
        >
          <span className={cn("min-w-0 flex-1 truncate", current && "font-medium")}>
            {playlist.name}
          </span>
          {current ? <AudioLinesIcon className="size-3.5 shrink-0" aria-label="Playing" /> : null}
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {formatMusicDuration(playlist.durationSec)}
          </span>
        </button>
        {canArrange ? (
          <span className="flex shrink-0 items-center pe-1">
            <span
              className={cn(
                "group/pin flex",
                !isPinned &&
                  "opacity-0 group-hover/playlist:opacity-100 group-focus-within/playlist:opacity-100 any-pointer-coarse:opacity-100",
              )}
            >
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`${isPinned ? "Unpin" : "Pin"} ${playlist.name}`}
                aria-pressed={isPinned}
                onClick={() => place(playlist.id, isPinned ? "listed" : "pinned")}
              >
                {isPinned ? (
                  <>
                    <PinIcon className="group-hover/pin:hidden" />
                    <PinOffIcon className="hidden group-hover/pin:block" />
                  </>
                ) : (
                  <PinIcon />
                )}
              </Button>
            </span>
            <span className="flex opacity-0 group-hover/playlist:opacity-100 group-focus-within/playlist:opacity-100 any-pointer-coarse:opacity-100">
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Remove ${playlist.name} from list`}
                onClick={() => place(playlist.id, "hidden")}
              >
                <EyeOffIcon />
              </Button>
            </span>
          </span>
        ) : null}
      </li>
    );
  };

  // One flat keyed array: pinning moves a row instead of remounting it, so focus stays on it.
  const listItems = [
    ...(pinned.length > 0
      ? [
          <li key="pinned-label" className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">
            Pinned
          </li>,
        ]
      : []),
    ...pinned.map(renderRow),
    ...(pinned.length > 0 && listed.length > 0
      ? [<li key="pinned-divider" aria-hidden className="mx-2 my-1 border-t border-border" />]
      : []),
    ...listed.map(renderRow),
  ];

  const needle = search.trim();
  const [settledNeedle] = useDebouncedValue(needle, { wait: SONG_SEARCH_WAIT_MS });
  const emptyMessage =
    library.length === 0 ? "No playlists in your library" : "Every playlist is hidden";
  const playlistRows =
    listItems.length > 0 ? (
      <ul className="flex flex-col" aria-label="Playlists">
        {listItems}
      </ul>
    ) : null;

  return (
    <div className="flex flex-col gap-2">
      <Input
        ref={searchRef}
        type="search"
        size="sm"
        placeholder="Search playlists and songs"
        aria-label="Search playlists and songs"
        value={search}
        onChange={(event) => onSearchChange(event.currentTarget.value)}
      />
      {needle === "" ? (
        <ul className="flex flex-col" aria-label="Your music">
          {LIST_ROWS.map(({ kind, label, Icon }) => (
            <li key={kind}>
              <button
                type="button"
                className={LIST_ROW_CLASS}
                ref={(element) => {
                  if (element && pendingFocus.current === kind) {
                    pendingFocus.current = null;
                    element.focus();
                  }
                }}
                onClick={() => onOpenList(kind)}
              >
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {query.data === null ? (
        <QueryProblem error={query.error} onRetry={query.refresh} />
      ) : (
        <>
          {needle !== "" ? (
            <ScrollArea className="max-h-72" scrollFade>
              {playlistRows}
              <LibrarySongs
                environmentId={environmentId}
                // The last settled results stay up while typing; each query is its own request.
                query={settledNeedle === "" ? null : settledNeedle}
                playingTrackId={playingTrackId}
                controllable={controllable}
                afterPlaylists={playlistRows !== null}
              />
            </ScrollArea>
          ) : playlistRows === null ? (
            <p className={EMPTY_TEXT_CLASS}>{emptyMessage}</p>
          ) : (
            <ScrollArea className="max-h-64" scrollFade>
              {playlistRows}
            </ScrollArea>
          )}
          {canArrange && hidden.length > 0 ? (
            <div className="flex flex-col gap-1 border-t border-border pt-1">
              <Button
                variant="ghost-muted"
                size="xs"
                aria-expanded={showHidden}
                onClick={() => setShowHidden((open) => !open)}
              >
                Hidden ({hidden.length})
              </Button>
              {showHidden ? (
                <ul
                  className="flex max-h-40 flex-col overflow-y-auto"
                  aria-label="Hidden playlists"
                >
                  {hidden.map((playlist) => (
                    <li key={playlist.id} className="flex items-center gap-2 px-2 py-1 text-sm">
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {playlist.name}
                      </span>
                      <Button
                        variant="ghost"
                        size="xs"
                        aria-label={`Restore ${playlist.name}`}
                        onClick={() => place(playlist.id, "listed")}
                      >
                        Restore
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
