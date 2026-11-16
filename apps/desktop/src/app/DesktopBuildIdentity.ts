import {
  parseDesktopBuildIdentityMarker,
  type DesktopIsolatedIdentity,
} from "@t3tools/shared/desktopIsolatedIdentity";

declare const __T3CODE_BUILD_DESKTOP_IDENTITY__: string | undefined;

/**
 * The isolated identity this bundle was built with, or null for the ordinary app. Tests and
 * unbundled runs have no marker and are ordinary. A malformed marker throws while the main
 * process loads, so a mislabelled build never starts as the ordinary app.
 */
export const BUILD_ISOLATED_IDENTITY: DesktopIsolatedIdentity | null =
  typeof __T3CODE_BUILD_DESKTOP_IDENTITY__ === "undefined"
    ? null
    : parseDesktopBuildIdentityMarker(__T3CODE_BUILD_DESKTOP_IDENTITY__);
