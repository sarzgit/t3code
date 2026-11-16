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

/** Throws for an id that can't name a scheme, bundle id and folder safely. */
export function desktopIsolatedIdentity(id: string): DesktopIsolatedIdentity {
  if (!ID_PATTERN.test(id)) {
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
