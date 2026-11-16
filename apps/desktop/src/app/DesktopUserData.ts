import type { DesktopIsolatedIdentity } from "@t3tools/shared/desktopIsolatedIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals([
      "validate-override",
      "validate-isolated",
      "inspect",
      "read",
      "create-directory",
      "write",
    ]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }

  static fromFileSystem(
    cause: PlatformError.PlatformError,
    operation: DesktopUserDataInitializationError["operation"],
    resourcePath: string,
  ) {
    return new DesktopUserDataInitializationError({
      operation,
      resourcePath,
      category: cause.reason._tag,
      cause,
    });
  }
}

/** A path equal to or inside `parent`. */
const isWithin = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const overlaps = (path: Path.Path, a: string, b: string) =>
  isWithin(path, a, b) || isWithin(path, b, a);

/** Development takes any absolute profile; an ordinary packaged build never takes one. */
const overrideProblem = (
  path: Path.Path,
  override: string,
  input: {
    readonly isDevelopment: boolean;
    readonly isolatedIdentity: Option.Option<DesktopIsolatedIdentity>;
  },
) => {
  if (!path.isAbsolute(override)) return "NotAbsolute";
  if (input.isDevelopment) return null;
  if (Option.isNone(input.isolatedIdentity)) return "PackagedBuild";
  return null;
};

/**
 * The real location a path names: its nearest existing ancestor with links resolved, plus the
 * rest. Only metadata is read; nothing is created.
 */
const canonical = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
) {
  const rest: Array<string> = [];
  let current = path.resolve(target);
  while (!(yield* fs.exists(current))) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    rest.unshift(path.basename(current));
    current = parent;
  }
  return path.join(yield* fs.realPath(current), ...rest);
});

/**
 * Why an isolated build's home or profile is refused, if it is. Checked on every start, before
 * the profile, its lock or Clerk's storage are touched: neither may be, contain or sit inside the
 * installed app's T3 home or Chromium profiles, by any link, nor overlap each other. A chosen
 * profile also stays outside the application data folder.
 */
const isolatedProblem = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  input: {
    readonly appDataDirectory: string;
    readonly homeDirectory: string;
    readonly baseDir: string;
    readonly platform: NodeJS.Platform;
  },
  profile: string,
  chosen: boolean,
) {
  if (!path.isAbsolute(input.baseDir)) return "PackagedNeedsOwnT3Home";
  // macOS and Windows volumes usually ignore case, also for folders that don't exist yet.
  const fold = input.platform === "darwin" || input.platform === "win32";
  const real = (target: string) =>
    canonical(fs, path, target).pipe(
      Effect.map((resolved) => (fold ? resolved.toLowerCase() : resolved)),
    );
  const shared: Array<string> = [yield* real(path.join(input.homeDirectory, ".t3"))];
  for (const name of SHARED_PROFILE_NAMES) {
    shared.push(yield* real(path.join(input.appDataDirectory, name)));
  }
  const home = yield* real(input.baseDir);
  if (shared.some((location) => overlaps(path, location, home))) return "SharedT3Home";
  const realProfile = yield* real(profile);
  if (
    shared.some((location) => overlaps(path, location, realProfile)) ||
    overlaps(path, home, realProfile) ||
    (chosen && isWithin(path, yield* real(input.appDataDirectory), realProfile))
  ) {
    return "SharedLocation";
  }
  return null;
});

// Every profile the installed app, development or an older version may use.
const SHARED_PROFILE_NAMES = [
  "t3code-v2",
  "t3code",
  "T3 Code (Alpha)",
  "t3code-dev",
  "T3 Code (Dev)",
];

export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
    readonly userDataDirectoryOverride: Option.Option<string>;
    readonly homeDirectory: string;
    readonly baseDir: string;
    readonly isolatedIdentity: Option.Option<DesktopIsolatedIdentity>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    if (Option.isSome(input.userDataDirectoryOverride)) {
      const override = input.userDataDirectoryOverride.value;
      // Never falls back to the shared profile or migrates a legacy one.
      const problem = overrideProblem(path, override, input);
      if (problem !== null) {
        return yield* new DesktopUserDataInitializationError({
          operation: "validate-override",
          resourcePath: override,
          category: problem,
          cause: undefined,
        });
      }
    }
    // Its own folder, never a migration from the installed app's profiles.
    if (Option.isSome(input.isolatedIdentity)) {
      const identity = input.isolatedIdentity.value;
      const profile = Option.getOrElse(input.userDataDirectoryOverride, () =>
        path.join(input.appDataDirectory, identity.userDataName),
      );
      const problem = yield* isolatedProblem(
        fs,
        path,
        input,
        profile,
        Option.isSome(input.userDataDirectoryOverride),
      ).pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "validate-isolated", profile),
        ),
      );
      if (problem !== null) {
        return yield* new DesktopUserDataInitializationError({
          operation: "validate-isolated",
          resourcePath: profile,
          category: problem,
          cause: undefined,
        });
      }
      return path.normalize(profile);
    }
    if (Option.isSome(input.userDataDirectoryOverride)) {
      return path.normalize(input.userDataDirectoryOverride.value);
    }
    const names = input.isDevelopment
      ? { current: "t3code-dev", legacy: "T3 Code (Dev)" }
      : { current: "t3code-v2", legacy: "T3 Code (Alpha)" };
    const destinationPath = path.join(input.appDataDirectory, names.current);
    const legacyPath = path.join(input.appDataDirectory, names.legacy);
    const inspect = (resourcePath: string) =>
      fs
        .exists(resourcePath)
        .pipe(
          Effect.mapError((cause) =>
            DesktopUserDataInitializationError.fromFileSystem(cause, "inspect", resourcePath),
          ),
        );
    if (input.isDevelopment) {
      return (yield* inspect(legacyPath)) ? legacyPath : destinationPath;
    }
    // Chromium databases require their own profile for each running version.
    if (input.platform !== "win32") return destinationPath;
    const destinationState = path.join(destinationPath, "Local State");
    if (yield* inspect(destinationState)) return destinationPath;
    const legacyState = path.join(legacyPath, "Local State");
    const sourceState = (yield* inspect(legacyState))
      ? legacyState
      : path.join(input.appDataDirectory, "t3code", "Local State");
    if (!(yield* inspect(sourceState))) return destinationPath;
    // Windows safeStorage keys live here. Copy only these preferences, never locked databases.
    const state = yield* fs
      .readFileString(sourceState)
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(cause, "read", sourceState),
        ),
      );
    yield* fs
      .makeDirectory(destinationPath, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          DesktopUserDataInitializationError.fromFileSystem(
            cause,
            "create-directory",
            destinationPath,
          ),
        ),
      );
    yield* fs.writeFileString(destinationState, state, { flag: "wx" }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.void,
      ),
      Effect.mapError((cause) =>
        DesktopUserDataInitializationError.fromFileSystem(cause, "write", destinationState),
      ),
    );
    return destinationPath;
  },
);

const GPU_CACHE_DIRECTORIES = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

// Keyed on Electron, not Chromium: Electron patches ship Chromium backports under the same Chrome version.
export const clearStaleGpuCaches = Effect.fn("desktop.userData.clearStaleGpuCaches")(
  function* (input: { readonly userDataPath: string; readonly electronVersion: string }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const markerPath = path.join(input.userDataPath, "gpu-cache-electron-version");
    const cachedVersion = yield* fs.readFileString(markerPath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (cachedVersion?.trim() === input.electronVersion) return;
    for (const name of GPU_CACHE_DIRECTORIES) {
      yield* fs.remove(path.join(input.userDataPath, name), { recursive: true, force: true });
    }
    yield* fs.makeDirectory(input.userDataPath, { recursive: true });
    yield* fs.writeFileString(markerPath, input.electronVersion);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catch((error) =>
        Effect.logWarning("could not clear stale GPU caches", {
          userDataPath: input.userDataPath,
          electronVersion: input.electronVersion,
          error: error.message,
        }),
      ),
    ),
);
