import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as MusicQueue from "./MusicQueue.ts";
import * as Store from "./MusicQueueStore.ts";

const LIST = "5CA38D01224697B3";
const A = "ABCDEF0123450000";
const B = "ABCDEF0123450001";

/** A playlist with a duplicated song: s0 and s2 hold the same track. */
const explicitBody = (revision: number, currentKey = "s0"): Store.QueueBody =>
  Store.bodyFromExplicit(
    MusicQueue.moveCursor(
      MusicQueue.materialise({
        id: "qstore01",
        revision,
        playlistId: LIST,
        ids: [A, B, A],
        sequence: [0, 1, 2],
        cursor: 0,
        shuffleSeed: null,
      }),
      Number(currentKey.slice(1)),
    ),
    { trackName: "Saved: Été", sourceName: "Mix" },
  );

const position = (
  body: Store.QueueBody,
  overrides: Partial<Store.QueuePosition> = {},
): Store.QueuePosition => ({
  version: 1,
  id: body.id,
  revision: body.revision,
  currentKey: body.currentKey,
  trackId: body.trackId,
  positionSec: 30,
  savedAt: 1,
  ...overrides,
});

describe("resolveSaved", () => {
  it("uses a checkpoint only for the same queue, revision and entry", () => {
    const body = explicitBody(4);
    const later = position(body, { currentKey: "s1", trackId: B, display: { trackName: "Two" } });
    assert.deepStrictEqual(
      [Store.resolveSaved(body, later)].map((saved) => [
        saved?.currentKey,
        saved?.positionSec,
        saved?.display,
      ]),
      [["s1", 30, { trackName: "Two" }]],
    );
    // Another revision, or a key holding a different song (a duplicate elsewhere), falls back
    // to the body's own entry and labels at 0:00.
    for (const checkpoint of [
      position(body, { revision: 3, currentKey: "s1", trackId: B }),
      position(body, { currentKey: "s1", trackId: A }),
    ]) {
      const saved = Store.resolveSaved(body, checkpoint);
      assert.deepStrictEqual(
        [saved?.currentKey, saved?.positionSec, saved?.display.trackName],
        ["s0", 0, "Saved: Été"],
      );
    }
    // A malformed hint drops alone.
    const odd = Store.resolveSaved(
      body,
      position(body, { display: { trackName: 7, artist: "X" } }),
    );
    assert.deepStrictEqual(odd?.display, { artist: "X" });
  });
});

describe("MusicQueueStore", () => {
  const withStore = <A, E>(
    baseDir: string,
    effect: Effect.Effect<A, E, Store.MusicQueueStore | ServerConfig.ServerConfig | Path.Path>,
  ) =>
    effect.pipe(
      Effect.provide(
        Store.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  const files = Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    return {
      dir: config.stateDir,
      body: path.join(config.stateDir, "music-queue.json"),
      position: path.join(config.stateDir, "music-queue-position.json"),
    };
  });

  it.effect("checkpoints without the body, drops stale checkpoints and reloads both", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-queue-" });
      const body = explicitBody(2);
      yield* withStore(
        baseDir,
        Effect.gen(function* () {
          const store = yield* Store.MusicQueueStore;
          const paths = yield* files;
          yield* store.saveBody(body, position(body, { positionSec: 0 }));
          yield* store.settled;
          // A checkpoint never rewrites the body.
          yield* fileSystem.remove(paths.body);
          yield* store.savePosition(position(body, { positionSec: 20 }));
          yield* store.savePosition(position(body, { revision: 1, positionSec: 99 }));
          yield* store.savePosition(position(body, { id: "qother01", positionSec: 98 }));
          yield* store.settled;
          assert.isFalse(yield* fileSystem.exists(paths.body));
          yield* store.saveBody(body, position(body, { positionSec: 20 }));
          yield* store.settled;
        }),
      );
      const reloaded = yield* withStore(
        baseDir,
        Effect.flatMap(Store.MusicQueueStore, (store) => store.load),
      );
      assert.deepStrictEqual(reloaded.body, body);
      assert.strictEqual(reloaded.position?.positionSec, 20);

      yield* withStore(
        baseDir,
        Effect.flatMap(Store.MusicQueueStore, (store) =>
          Effect.andThen(store.clear, store.settled),
        ),
      );
      const paths = yield* withStore(baseDir, files);
      assert.isFalse(yield* fileSystem.exists(paths.body));
      assert.isFalse(yield* fileSystem.exists(paths.position));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves a corrupt or newer body aside and starts empty", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      for (const contents of ["{not json", JSON.stringify({ ...explicitBody(1), version: 2 })]) {
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-music-queue-" });
        const paths = yield* withStore(baseDir, files);
        yield* fileSystem.makeDirectory(paths.dir, { recursive: true });
        yield* fileSystem.writeFileString(paths.body, contents);
        const loaded = yield* withStore(
          baseDir,
          Effect.flatMap(Store.MusicQueueStore, (store) => store.load),
        );
        assert.strictEqual(loaded.body, null);
        const aside = (yield* fileSystem.readDirectory(paths.dir)).filter((name) =>
          name.startsWith("music-queue.json.unreadable-"),
        );
        assert.strictEqual(aside.length, 1);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
