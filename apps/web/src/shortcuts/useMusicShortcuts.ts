import { useAtomValue } from "@effect/atom-react";
import type { MusicControlInput } from "@t3tools/contracts";
import { useEffect } from "react";

import { isMusicMiniPlayerWindow } from "../musicMiniPlayerWindow";
import { musicEnvironment, useMusicEnvironmentId } from "../state/music";
import { useAtomCommand } from "../state/use-atom-command";
import { registerCommands } from "./dispatcher";

/** Play/pause, next, previous and the desktop mini-player from the keyboard, wherever focus is. */
export function useMusicShortcuts(): void {
  const environmentId = useMusicEnvironmentId();
  const canControl = useAtomValue(musicEnvironment.control.permissionAtom(environmentId));
  const runControl = useAtomCommand(musicEnvironment.control);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers document key handlers, which live outside React
  useEffect(() => {
    if (environmentId === null || !canControl) return;
    const control =
      (tag: Extract<MusicControlInput, { _tag: "play-pause" | "next" | "previous" }>["_tag"]) =>
      (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        void runControl({ environmentId, input: { _tag: tag } });
      };
    const miniPlayer = window.desktopBridge?.musicMiniPlayer;
    return registerCommands({
      "music.playPause": control("play-pause"),
      "music.next": control("next"),
      "music.previous": control("previous"),
      ...(miniPlayer && {
        "music.toggleMiniPlayer": (event: KeyboardEvent) => {
          event.preventDefault();
          if (event.repeat) return;
          // Toggling is main-window only; inside the mini-player the binding closes it.
          void (isMusicMiniPlayerWindow() ? miniPlayer.close() : miniPlayer.toggle());
        },
      }),
    });
  }, [environmentId, canControl, runControl]);
}
