import { LegendList } from "@legendapp/list/react";
import { useAtomValue } from "@effect/atom-react";
import {
  arrangeMusicPlaylists,
  formatMusicDuration,
  formatTrackTime,
} from "@t3tools/client-runtime/state/music";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type MusicPlayerState,
  type MusicPlaylist,
  type MusicPlaylistPlacement,
  type MusicPlaylistPreferences,
  type MusicPlaylistTrack,
  type MusicTrack,
  type ServerSettings,
} from "@t3tools/contracts";
import {
  AudioLinesIcon,
  ChevronLeftIcon,
  EyeOffIcon,
  MusicIcon,
  PinIcon,
  PinOffIcon,
  PlayIcon,
  ShuffleIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { musicEnvironment } from "~/state/music";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";

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
  | { readonly kind: "songs"; readonly playlist: MusicPlaylist };

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
        </div>
      ) : null}
      {view.kind === "songs" ? (
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
          search={playlistSearch}
          onSearchChange={setPlaylistSearch}
          returnFocusTo={view.returnFocusTo}
          onOpen={(playlist) => setView({ kind: "songs", playlist })}
        />
      )}
    </div>
  );
}

const SONG_ROW_HEIGHT = 44;
const SONG_LIST_MAX_HEIGHT = 288;

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
  const startPlaylist = (shuffle: boolean) =>
    void playPlaylist({ environmentId, input: { playlistId: playlist.id, shuffle } });

  const renderSong = (song: MusicPlaylistTrack) => {
    const playing = song.id === playingTrackId;
    return (
      <button
        type="button"
        disabled={!playable}
        aria-current={playing ? "true" : undefined}
        className="flex h-11 w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-60"
        onClick={() =>
          void playTrack({
            environmentId,
            input: { playlistId: playlist.id, trackId: song.id, index: song.index },
          })
        }
      >
        <span className="min-w-0 flex-1 leading-tight">
          <span className={cn("block truncate text-sm", playing && "font-medium")}>
            {song.name || "Untitled"}
          </span>
          {song.artist ? (
            <span className="block truncate text-xs text-muted-foreground">{song.artist}</span>
          ) : null}
        </span>
        {playing ? <AudioLinesIcon className="size-3.5 shrink-0" aria-label="Playing" /> : null}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatTrackTime(song.durationSec)}
        </span>
      </button>
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
      ) : songs.length === 0 ? (
        <p className="py-2 text-center text-xs text-muted-foreground">
          {needle === "" ? "No songs" : "No matches"}
        </p>
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
            // Rows only rerender for new data; the playing mark and permission live outside it.
            extraData={`${playingTrackId}:${playable}`}
            keyExtractor={(song) => `${song.id}:${song.index}`}
            renderItem={({ item }) => <div role="listitem">{renderSong(item)}</div>}
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

const EMPTY_MUSIC_PLAYLIST_PREFERENCES: MusicPlaylistPreferences = { pinned: [], hidden: [] };
const selectMusicPlaylistPreferences = (settings: ServerSettings | null) =>
  settings?.musicPlaylists ?? EMPTY_MUSIC_PLAYLIST_PREFERENCES;

function PlaylistList({
  environmentId,
  currentPlaylistId,
  search,
  onSearchChange,
  returnFocusTo,
  onOpen,
}: {
  environmentId: EnvironmentId;
  currentPlaylistId: string | null;
  search: string;
  onSearchChange: (search: string) => void;
  /** The playlist whose song view just closed; its row takes focus back. */
  returnFocusTo: string | null;
  onOpen: (playlist: MusicPlaylist) => void;
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
  const emptyMessage =
    needle !== ""
      ? "No matches"
      : library.length === 0
        ? "No playlists in your library"
        : "Every playlist is hidden";

  return (
    <div className="flex flex-col gap-2">
      <Input
        ref={searchRef}
        type="search"
        size="sm"
        placeholder="Search playlists"
        aria-label="Search playlists"
        value={search}
        onChange={(event) => onSearchChange(event.currentTarget.value)}
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
      ) : (
        <>
          {pinned.length + listed.length === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">{emptyMessage}</p>
          ) : (
            <ScrollArea className="max-h-64" scrollFade>
              <ul className="flex flex-col" aria-label="Playlists">
                {listItems}
              </ul>
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
