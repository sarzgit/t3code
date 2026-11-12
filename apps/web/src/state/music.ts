import { useAtomValue } from "@effect/atom-react";
import {
  createMusicEnvironmentAtoms,
  type ReceivedMusicState,
} from "@t3tools/client-runtime/state/music";
import type { ClientSettings, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { useClientSettings } from "../hooks/useSettings";
import { type EnvironmentPresentation, usePrimaryEnvironment } from "./environments";

export const musicEnvironment = createMusicEnvironmentAtoms(connectionAtomRuntime);

/** Stamps each state with this client's receive time; progress is measured from it. */
const receivedMusicStateAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReceivedMusicState | null => {
    const state = AsyncResult.getOrElse(
      get(musicEnvironment.state({ environmentId, input: {} })),
      () => null,
    );
    return state === null ? null : { state, receivedAtMs: Date.now() };
  }).pipe(Atom.withLabel(`music-received-state:${environmentId}`)),
);

export function useReceivedMusicState(environmentId: EnvironmentId): ReceivedMusicState | null {
  return useAtomValue(receivedMusicStateAtom(environmentId));
}

const selectMusicPlayerEnabled = (settings: ClientSettings) => settings.musicPlayerEnabled;

export function useMusicPlayerEnabled(): boolean {
  return useClientSettings(selectMusicPlayerEnabled);
}

/** The environment whose Music app the player drives, or null when the player is hidden. */
export function musicEnvironmentIdFor(
  enabled: boolean,
  primary: Pick<EnvironmentPresentation, "environmentId" | "serverConfig"> | null | undefined,
): EnvironmentId | null {
  return enabled && primary?.serverConfig?.environment.platform.os === "darwin"
    ? primary.environmentId
    : null;
}

export function useMusicEnvironmentId(): EnvironmentId | null {
  return musicEnvironmentIdFor(useMusicPlayerEnabled(), usePrimaryEnvironment());
}
