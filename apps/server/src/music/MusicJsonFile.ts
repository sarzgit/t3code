import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

/**
 * Loads a JSON file in the state directory once. Only a missing file starts empty. One that can't
 * be read stays untouched and is never written this run; one that can't be decoded is moved aside.
 */
export const make = Effect.fn("MusicJsonFile.make")(function* <A>(options: {
  readonly fileName: string;
  readonly decode: (contents: string) => Option.Option<A>;
  readonly encode: (value: A) => Effect.Effect<string, Schema.SchemaError>;
  readonly empty: () => A;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, options.fileName);
  let loaded: A | null = null;
  let readOnly = false;

  const load = Effect.gen(function* () {
    if (loaded !== null) return loaded;
    const exists = yield* fileSystem.exists(filePath).pipe(Effect.option);
    if (Option.isSome(exists) && !exists.value) {
      loaded = options.empty();
      return loaded;
    }
    const contents = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
    if (Option.isNone(contents)) {
      readOnly = true;
      yield* Effect.logWarning("music data file could not be read; not saving this run", {
        filePath,
      });
      loaded = options.empty();
      return loaded;
    }
    const decoded = options.decode(contents.value);
    if (Option.isNone(decoded)) {
      const aside = `${filePath}.unreadable-${yield* Clock.currentTimeMillis}`;
      yield* fileSystem.rename(filePath, aside).pipe(
        Effect.tap(() =>
          Effect.logWarning("music data file was unreadable; kept it aside", { aside }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            readOnly = true;
          }).pipe(
            Effect.andThen(
              Effect.logWarning("music data file could not be moved aside; not saving", {
                cause,
              }),
            ),
          ),
        ),
      );
    }
    loaded = Option.isSome(decoded) ? decoded.value : options.empty();
    return loaded;
  });

  /** Fails when the file must not be written this run or the write fails. */
  const save = Effect.fn("MusicJsonFile.save")(function* (value: A) {
    if (readOnly) return yield* Effect.fail("read-only" as const);
    const contents = yield* options.encode(value);
    yield* writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });
  const write = Effect.suspend(() => (loaded === null ? Effect.void : save(loaded)));
  /** Saves `next` and only then makes it the loaded value. */
  const replace = (next: A) =>
    save(next).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          loaded = next;
        }),
      ),
    );
  /** Deletes the file; the loaded value becomes empty. */
  const remove = Effect.gen(function* () {
    if (readOnly) return yield* Effect.fail("read-only" as const);
    yield* fileSystem.remove(filePath, { force: true });
    loaded = options.empty();
  });

  return { load, write, replace, remove, isReadOnly: () => readOnly };
});
