import { useAtomValue } from "@effect/atom-react";
import type { MusicControlInput } from "@t3tools/contracts";
import { useEffect } from "react";

import { musicEnvironment, useMusicEnvironmentId } from "../state/music";
import { useAtomCommand } from "../state/use-atom-command";
import { registerCommands } from "./dispatcher";

/** Play/pause, next and previous from the keyboard, wherever focus is in the app. */
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
    return registerCommands({
      "music.playPause": control("play-pause"),
      "music.next": control("next"),
      "music.previous": control("previous"),
    });
  }, [environmentId, canControl, runControl]);
}
