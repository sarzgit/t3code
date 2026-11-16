import {
  desktopIsolatedIdentity,
  type DesktopIsolatedIdentity,
} from "@t3tools/shared/desktopIsolatedIdentity";

declare const __T3CODE_BUILD_DESKTOP_ISOLATED_ID__: string | undefined;

const buildIsolatedId =
  typeof __T3CODE_BUILD_DESKTOP_ISOLATED_ID__ === "undefined"
    ? ""
    : __T3CODE_BUILD_DESKTOP_ISOLATED_ID__;

/**
 * The isolated identity this bundle was built with, or null for the ordinary app. An invalid id
 * throws while the main process loads, so a mislabelled build never starts as the ordinary app.
 */
export const BUILD_ISOLATED_IDENTITY: DesktopIsolatedIdentity | null =
  buildIsolatedId === "" ? null : desktopIsolatedIdentity(buildIsolatedId);
