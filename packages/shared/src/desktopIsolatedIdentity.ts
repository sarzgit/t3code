/**
 * A packaged desktop build that runs beside the installed app without sharing anything with it.
 * One id, chosen at build time, names every part of the identity macOS and Chromium key on, so
 * the build script and the app derive them from the same place and can never disagree.
 */
export interface DesktopIsolatedIdentity {
  readonly id: string;
  /** The bundle identifier; LaunchServices tells apps apart by it. */
  readonly appId: string;
  /** Bundle and package product name. */
  readonly productName: string;
  /** Electron's app name; the Keychain item for Chromium's encryption key is named after it. */
  readonly appName: string;
  /** The app origin, Clerk's OAuth callback and the only URL scheme the bundle advertises. */
  readonly scheme: string;
  /** The Chromium profile folder under the platform's application data folder. */
  readonly userDataName: string;
  /** The T3 home folder under the user's home when T3CODE_HOME is not set. */
  readonly homeName: string;
}

const ID_PATTERN = /^[a-z][a-z0-9]{2,23}$/;
const ORDINARY = "ordinary";
const MARKER_PREFIX = "t3code-desktop-build-identity:";

/** Throws for an id that can't name a scheme, bundle id and folder safely. */
export function desktopIsolatedIdentity(id: string): DesktopIsolatedIdentity {
  if (!ID_PATTERN.test(id) || id === ORDINARY) {
    throw new Error(
      `Isolated desktop id "${id}" must be 3 to 24 lowercase letters or digits, starting with a letter.`,
    );
  }
  return {
    id,
    appId: `com.t3tools.t3code.isolated.${id}`,
    productName: `T3 Code Isolated (${id})`,
    appName: `T3 Code Isolated ${id}`,
    scheme: `t3code-isolated-${id}`,
    userDataName: `t3code-isolated-${id}`,
    homeName: `.t3-isolated-${id}`,
  };
}

/**
 * The string compiled into the desktop main bundle naming the identity it was built for. The
 * packaging script requires exactly the marker it expects, so a bundle built for another identity,
 * or before markers existed, is never packaged as this one.
 */
export const desktopBuildIdentityMarker = (identity: DesktopIsolatedIdentity | null) =>
  `${MARKER_PREFIX}${identity?.id ?? ORDINARY}`;

/** The identity a marker names; throws for anything that isn't a marker. */
export function parseDesktopBuildIdentityMarker(marker: string): DesktopIsolatedIdentity | null {
  if (!marker.startsWith(MARKER_PREFIX)) {
    throw new Error(`"${marker}" is not a desktop build identity marker.`);
  }
  const id = marker.slice(MARKER_PREFIX.length);
  return id === ORDINARY ? null : desktopIsolatedIdentity(id);
}

/** Every distinct marker in a bundle's source, in order of first appearance. */
export function desktopBuildIdentityMarkersIn(source: string): ReadonlyArray<string> {
  const found = source.match(/t3code-desktop-build-identity:[a-z][a-z0-9]{2,23}/g) ?? [];
  return [...new Set(found)];
}
