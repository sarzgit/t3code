import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { desktopIsolatedIdentity } from "@t3tools/shared/desktopIsolatedIdentity";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import { clearStaleGpuCaches, resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "preserves Windows credential keys from %s without copying browser databases",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-profile-" });
      const source = path.join(directory, sourceName);
      const destination = path.join(directory, "t3code-v2");
      const state = '{"os_crypt":{"encrypted_key":"test-encrypted-key"}}';
      yield* fs.makeDirectory(path.join(directory, "T3 Code (Alpha)"), { recursive: true });
      yield* fs.makeDirectory(path.join(source, "IndexedDB"), { recursive: true });
      yield* fs.writeFileString(path.join(source, "Local State"), state);
      yield* fs.writeFileString(path.join(source, "IndexedDB", "LOCK"), "V1 owns this database");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
        userDataDirectoryOverride: Option.none(),
        homeDirectory: "/Users/alice",
        baseDir: "/Users/alice/.t3",
        isolatedIdentity: Option.none(),
      });
      assert.equal(yield* fs.readFileString(path.join(destination, "Local State")), state);
      assert.equal(yield* fs.readFileString(path.join(source, "Local State")), state);
      assert.isFalse(yield* fs.exists(path.join(destination, "IndexedDB")));
      yield* fs.writeFileString(path.join(destination, "Local State"), "existing V2 state");
      yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform: "win32",
        userDataDirectoryOverride: Option.none(),
        homeDirectory: "/Users/alice",
        baseDir: "/Users/alice/.t3",
        isolatedIdentity: Option.none(),
      });
      assert.equal(
        yield* fs.readFileString(path.join(destination, "Local State")),
        "existing V2 state",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gpuCacheDirectories = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

it.effect.each([
  { profile: "written by Electron 44.10.0", marker: "44.10.0" },
  { profile: "with no recorded Electron version", marker: undefined },
])("clears GPU caches $profile once when Electron 44.10.1 starts", ({ marker }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userDataPath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-gpu-cache-" });
    for (const name of gpuCacheDirectories) {
      yield* fs.makeDirectory(path.join(userDataPath, name), { recursive: true });
      yield* fs.writeFileString(path.join(userDataPath, name, "data_0"), "44.10.0 shaders");
    }
    yield* fs.makeDirectory(path.join(userDataPath, "Local Storage"), { recursive: true });
    yield* fs.writeFileString(path.join(userDataPath, "Local Storage", "LOCK"), "profile");
    yield* fs.writeFileString(path.join(userDataPath, "Local State"), "profile");
    if (marker !== undefined) {
      yield* fs.writeFileString(path.join(userDataPath, "gpu-cache-electron-version"), marker);
    }

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    const survivingCaches: Array<string> = [];
    for (const name of gpuCacheDirectories) {
      if (yield* fs.exists(path.join(userDataPath, name))) survivingCaches.push(name);
    }
    assert.deepStrictEqual(survivingCaches, []);
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "Local Storage", "LOCK")),
      "profile",
    );
    assert.equal(yield* fs.readFileString(path.join(userDataPath, "Local State")), "profile");

    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps GPU caches built on the first launch of a fresh install", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appData = yield* fs.makeTempDirectoryScoped({ prefix: "t3-v2-fresh-" });
    const userDataPath = path.join(appData, "t3code-v2");

    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });
    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data_0"), "44.10.1 shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.10.1" });

    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data_0")),
      "44.10.1 shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries on the next launch when a GPU cache cannot be removed", () =>
  Effect.gen(function* () {
    const writes: Array<string> = [];
    const fileSystem = FileSystem.makeNoop({
      remove: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: path,
          }),
        ),
      writeFileString: (path) =>
        Effect.sync(() => {
          writes.push(path);
        }),
    });

    yield* clearStaleGpuCaches({ userDataPath: "/profile", electronVersion: "44.10.1" }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    assert.deepStrictEqual(writes, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "keeps an isolated build's home and profile apart from the installed app's, by any link",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-isolated-paths-" });
      const home = path.join(root, "home");
      const appData = path.join(home, "Library", "Application Support");
      yield* fs.makeDirectory(path.join(home, ".t3", "userdata"), { recursive: true });
      yield* fs.makeDirectory(path.join(appData, "t3code-v2"), { recursive: true });
      yield* fs.makeDirectory(path.join(root, "task"), { recursive: true });
      yield* fs.symlink(path.join(home, ".t3"), path.join(root, "home-alias"));
      yield* fs.symlink(home, path.join(root, "ancestor-alias"));
      yield* fs.symlink(path.join(appData, "t3code-v2"), path.join(root, "profile-alias"));
      const resolve = (baseDir: string, override?: string) =>
        resolveUserDataPath({
          appDataDirectory: appData,
          isDevelopment: false,
          platform: "darwin",
          userDataDirectoryOverride: Option.fromNullishOr(override),
          homeDirectory: home,
          baseDir,
          isolatedIdentity: Option.some(desktopIsolatedIdentity("musictest")),
        }).pipe(
          Effect.map((profile) => ({ profile })),
          Effect.catchTags({
            DesktopUserDataInitializationError: (error) =>
              Effect.succeed({ refused: error.category }),
          }),
        );
      const ownProfile = path.join(appData, "t3code-isolated-musictest");
      assert.deepStrictEqual(
        [
          // Its own default home and profile, created later by the app.
          yield* resolve(path.join(home, ".t3-isolated-musictest")),
          // A separate task home and profile.
          yield* resolve(path.join(root, "task", "home"), path.join(root, "task", "profile")),
          // T3CODE_HOME inherited from the installed app, without any profile override.
          yield* resolve(path.join(home, ".t3")),
          yield* resolve(path.join(home, ".t3", "userdata")),
          // The same home reached through a link to it or to an ancestor.
          yield* resolve(path.join(root, "home-alias")),
          yield* resolve(path.join(root, "ancestor-alias", ".t3")),
          // A chosen profile that is the installed app's, through a link, or holds the home.
          yield* resolve(path.join(root, "task", "home"), path.join(root, "profile-alias")),
          yield* resolve(path.join(root, "task", "home"), path.join(root, "task")),
        ],
        [
          { profile: ownProfile },
          { profile: path.join(root, "task", "profile") },
          { refused: "SharedT3Home" },
          { refused: "SharedT3Home" },
          { refused: "SharedT3Home" },
          { refused: "SharedT3Home" },
          { refused: "SharedLocation" },
          { refused: "SharedLocation" },
        ],
      );
      // Its own default profile turned into a link to the installed app's.
      yield* fs.symlink(path.join(appData, "t3code-v2"), ownProfile);
      assert.deepStrictEqual(yield* resolve(path.join(home, ".t3-isolated-musictest")), {
        refused: "SharedLocation",
      });
      // Checking reads metadata only: nothing new was created.
      assert.isFalse(yield* fs.exists(path.join(home, ".t3-isolated-musictest")));
      assert.isFalse(yield* fs.exists(path.join(root, "task", "home")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses an isolated home or profile that names the installed app's in another case",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-isolated-case-" });
      const home = path.join(root, "home");
      const appData = path.join(home, "Library", "Application Support");
      yield* fs.makeDirectory(path.join(home, ".t3", "userdata"), { recursive: true });
      yield* fs.makeDirectory(path.join(appData, "t3code-v2"), { recursive: true });
      const resolve = (baseDir: string, override?: string) =>
        resolveUserDataPath({
          appDataDirectory: appData,
          isDevelopment: false,
          platform: "darwin",
          userDataDirectoryOverride: Option.fromNullishOr(override),
          homeDirectory: home,
          baseDir,
          isolatedIdentity: Option.some(desktopIsolatedIdentity("musictest")),
        }).pipe(
          // The synchronous filesystem the app uses before Electron is ready.
          Effect.provide(DesktopPreReadyFileSystem.layer),
          Effect.map((profile) => ({ profile })),
          Effect.catchTags({
            DesktopUserDataInitializationError: (error) =>
              Effect.succeed({ refused: error.category }),
          }),
        );
      // macOS volumes usually ignore case, so these name the installed app's own folders.
      assert.deepStrictEqual(
        [
          yield* resolve(path.join(home, ".T3")),
          yield* resolve(path.join(home, ".T3", "USERDATA", "new")),
          yield* resolve(
            path.join(root, "task", "home"),
            path.join(appData, "T3CODE-V2", "Profile"),
          ),
          yield* resolve(path.join(root, "task", "home"), path.join(root, "TASK", "HOME", "p")),
        ],
        [
          { refused: "SharedT3Home" },
          { refused: "SharedT3Home" },
          { refused: "SharedLocation" },
          { refused: "SharedLocation" },
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
