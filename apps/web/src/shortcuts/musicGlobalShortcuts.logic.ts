import type {
  MusicControlInput,
  MusicGlobalShortcutAction,
  MusicPlayerState,
} from "@t3tools/contracts";

/** What a desktop-wide music key sends; null when there is nothing to act on. */
export function musicGlobalShortcutControl(
  action: MusicGlobalShortcutAction,
  state: MusicPlayerState | null,
): MusicControlInput | null {
  switch (action) {
    case "playPause":
      return { _tag: "play-pause" };
    case "next":
      return { _tag: "next" };
    case "previous":
      return { _tag: "previous" };
    case "favorite": {
      // Names the sampled track, so a key pressed as the song changes never favourites the next.
      const track = state?._tag === "ready" ? state.track : null;
      if (track === null || track.favorited === undefined) return null;
      return { _tag: "set-favorited", trackId: track.id, favorited: !track.favorited };
    }
    case "toggleMiniPlayer":
      // The desktop shell toggles the window itself.
      return null;
  }
}
