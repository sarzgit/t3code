import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { isElectron } from "./env";
import { startAppServices, startMusicMiniPlayerServices } from "./appInit";
import { AppRoot, MusicMiniPlayerAppRoot } from "./AppRoot";
import { whenLocaleReady } from "./i18n/runtime";
import { clearChunkReloadGuard, reloadOnceForChunkLoadError } from "./lib/chunkReloadGuard";
import { isMusicMiniPlayerWindow } from "./musicMiniPlayerWindow";

const miniPlayerWindow = isMusicMiniPlayerWindow();
const router = miniPlayerWindow ? startMusicMiniPlayerServices() : startAppServices();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

let chunkLoadFailed = false;
let reloadScheduled = false;
window.addEventListener("vite:preloadError", (event) => {
  chunkLoadFailed = true;
  if (reloadOnceForChunkLoadError()) {
    reloadScheduled = true;
    event.preventDefault();
  }
});

const app = miniPlayerWindow ? (
  <MusicMiniPlayerAppRoot router={router} />
) : (
  <AppRoot router={router} />
);

// Split by runtime to keep Clerk out of local startup and clerk-js out of browser builds.
// The mini-player talks only to the primary local environment, so it needs no cloud session.
const managedAuthShellModule =
  !miniPlayerWindow && clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  // Chained so settings have usually hydrated; English resolves without a chunk load.
  router.load().then(whenLocaleReady),
])
  .then(([ManagedAuthShell]) => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (reloadScheduled) return;
    if (!chunkLoadFailed) clearChunkReloadGuard();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (reloadScheduled) return;
    throw error;
  });
