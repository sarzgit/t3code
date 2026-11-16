import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** A Settings recorder that needs the OS to deliver key presses to the page. */
export type ShortcutRecorder = "music" | "snapShot";

// A recorder that never says it stopped (a crashed or reloaded renderer) gives the keys back.
const RECORDING_LEASE = Duration.seconds(60);

/**
 * While any Settings recorder is open, every global key T3 registers is let go: macOS delivers a
 * registered key to its action, so the recorder could never see it or refuse a clash. Each owner
 * releases and restores only its own keys.
 */
export class DesktopShortcutRecording extends Context.Service<
  DesktopShortcutRecording,
  {
    /** Starts or ends one recorder; owners have acted on the change when this returns. */
    readonly set: (recorder: ShortcutRecorder, recording: boolean) => Effect.Effect<void>;
    /** Called with whether any recorder is open, on every change, until the scope closes. */
    readonly onChange: (
      listener: (recording: boolean) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/app/DesktopShortcutRecording") {}

/** @public */
export const make = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);
  const leases = yield* FiberMap.make<ShortcutRecorder, void, never>();
  const open = new Set<ShortcutRecorder>();
  const listeners = new Set<(recording: boolean) => Effect.Effect<void>>();

  const update = (recorder: ShortcutRecorder, recording: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const before = open.size > 0;
        if (recording) open.add(recorder);
        else open.delete(recorder);
        const after = open.size > 0;
        if (before === after) return;
        for (const listener of listeners) yield* listener(after);
      }),
    );

  const set = Effect.fn("DesktopShortcutRecording.set")(function* (
    recorder: ShortcutRecorder,
    recording: boolean,
  ) {
    yield* FiberMap.remove(leases, recorder);
    yield* update(recorder, recording);
    if (recording) {
      yield* FiberMap.run(
        leases,
        recorder,
        Effect.sleep(RECORDING_LEASE).pipe(Effect.andThen(update(recorder, false))),
      );
    }
  });

  return DesktopShortcutRecording.of({
    set,
    onChange: Effect.fn("DesktopShortcutRecording.onChange")((listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          listeners.add(listener);
        }),
        () =>
          Effect.sync(() => {
            listeners.delete(listener);
          }),
      ),
    ),
  });
});

export const layer = Layer.effect(DesktopShortcutRecording, make);
