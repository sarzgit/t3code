import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type AgentActivity, MusicPlayer } from "./MusicPlayer.ts";

interface ThreadActivity {
  readonly projectId: string;
  readonly requestId: string | null;
  readonly working: boolean;
}

/** What one thread contributes to the music cue and listening stats. */
export function threadActivity(
  thread: Pick<
    AgentAwarenessThread,
    "projectId" | "archivedAt" | "pendingRuntimeRequest" | "activityRunStatus" | "status"
  >,
): ThreadActivity | null {
  if (thread.archivedAt !== null) return null;
  const request = thread.pendingRuntimeRequest;
  const runStatus = thread.activityRunStatus ?? thread.status;
  return {
    projectId: thread.projectId,
    requestId: request !== null && request.kind !== "auth_refresh" ? request.id : null,
    working:
      runStatus === "preparing" ||
      runStatus === "starting" ||
      runStatus === "running" ||
      runStatus === "waiting",
  };
}

export function summarizeActivity(
  threads: Iterable<ThreadActivity>,
  initial: boolean,
): AgentActivity {
  const requestIds = new Set<string>();
  const workingProjectIds = new Set<string>();
  for (const thread of threads) {
    if (thread.requestId !== null) requestIds.add(thread.requestId);
    if (thread.working) workingProjectIds.add(thread.projectId);
  }
  return { requestIds, workingProjectIds, initial };
}

const isActivityEvent = (event: OrchestrationV2DomainEvent) => {
  switch (event.type) {
    case "runtime-request.updated":
    case "run.created":
    case "run.updated":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
      return true;
    default:
      return false;
  }
};

export class MusicAgentWatch extends Context.Service<
  MusicAgentWatch,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/music/MusicAgentWatch") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const engine = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const player = yield* MusicPlayer;
  const threads = new Map<string, ThreadActivity>();

  const report = Effect.fnUntraced(function* (initial: boolean) {
    const cue = yield* settings.getSettings.pipe(
      Effect.map((current) => current.musicAgentCue),
      Effect.orElseSucceed(() => "off" as const),
    );
    yield* player.observeAgents(summarizeActivity(threads.values(), initial), cue);
  });

  // Per event: one thread's shell, then the summary across all of them.
  const refresh = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const { threads: rows } = yield* engine.getAgentAwarenessSnapshot(event.threadId);
    const activity = rows[0] === undefined ? null : threadActivity(rows[0]);
    if (activity === null) threads.delete(event.threadId);
    else threads.set(event.threadId, activity);
    yield* report(false);
  });

  const run = Effect.gen(function* () {
    const snapshot = yield* engine.getAgentAwarenessSnapshot();
    for (const thread of snapshot.threads) {
      const activity = threadActivity(thread);
      if (activity !== null) threads.set(thread.id, activity);
    }
    yield* report(true);
    yield* Stream.runForEach(Stream.filter(engine.streamDomainEvents, isActivityEvent), (event) =>
      refresh(event).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("music agent watch refresh failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("music agent watch stopped", { cause })),
    Effect.withSpan("MusicAgentWatch.run"),
  );

  return MusicAgentWatch.of({
    start: Effect.fn("MusicAgentWatch.start")(function* () {
      if (platform === "darwin") yield* forkParked(run);
    }),
  });
});

export const layer = Layer.effect(MusicAgentWatch, make);
