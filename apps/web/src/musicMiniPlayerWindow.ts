import { isElectron } from "./env";

export const MUSIC_MINI_PLAYER_PATH = "/music/mini";

/** The desktop mini-player window boots this app on its own route with a reduced set of services. */
export function isMusicMiniPlayerWindow(): boolean {
  return isElectron && window.location.hash.startsWith(`#${MUSIC_MINI_PLAYER_PATH}`);
}
