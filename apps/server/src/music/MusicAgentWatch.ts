import {
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type ThreadId,
} from "@t3tools/contracts";
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
  readonly requestIds: ReadonlyArray<string>;
  readonly working: boolean;
}

type ActivityThread = Pick<
  AgentAwarenessThread,
  "projectId" | "archivedAt" | "activityRunStatus" | "status" | "lineage" | "creationSource"
>;

/**
 * What one thread contributes to the music cue and listening stats. `pending` is every open
 * request on the thread; the shell itself shows only one.
 */
export function threadActivity(
  thread: ActivityThread,
  pending: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "id" | "kind">>,
): ThreadActivity | null {
  if (thread.archivedAt !== null) return null;
  const runStatus = thread.activityRunStatus ?? thread.status;
  const isSubagent = thread.lineage.relationshipToParent === "subagent";
  // The coordinating agent answers a subagent's questions; only its approvals reach the user,
  // and a provider-native subagent asks on its parent instead.
  const subagentAsksUser =
    !isProviderNativeSubagentThread(thread) && thread.activityRunStatus != null;
  return {
    projectId: thread.projectId,
    requestIds: pending
      .filter(
        (request) =>
          request.kind !== "auth_refresh" &&
          (!isSubagent || (subagentAsksUser && request.kind !== "user_input")),
      )
      .map((request) => request.id),
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
    for (const id of thread.requestIds) requestIds.add(id);
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

  const track = Effect.fnUntraced(function* (thread: AgentAwarenessThread) {
    const pending =
      thread.pendingRuntimeRequest === null
        ? []
        : (yield* engine.getThreadRecords(thread.id, ["runtimeRequests"], {
            runtimeRequestStatuses: ["pending"],
          })).runtimeRequests.filter((request) => request.status === "pending");
    const activity = threadActivity(thread, pending);
    if (activity === null) threads.delete(thread.id);
    else threads.set(thread.id, activity);
  });

  const report = Effect.fnUntraced(function* (initial: boolean) {
    const cue = yield* settings.getSettings.pipe(
      Effect.map((current) => current.musicAgentCue),
      Effect.orElseSucceed(() => "off" as const),
    );
    yield* player.observeAgents(summarizeActivity(threads.values(), initial), cue);
  });

  const refresh = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { threads: rows } = yield* engine.getAgentAwarenessSnapshot(threadId);
    if (rows[0] === undefined) threads.delete(threadId);
    else yield* track(rows[0]);
    yield* report(false);
  });

  const run = Effect.gen(function* () {
    const snapshot = yield* engine.getAgentAwarenessSnapshot();
    yield* Effect.forEach(snapshot.threads, track, { discard: true });
    yield* report(true);
    // From the snapshot's sequence, so nothing committed after it was read is missed.
    const events = engine.streamStoredEventsFrom({ afterSequence: snapshot.snapshotSequence }).pipe(
      Stream.map((stored) => stored.event),
      Stream.filter(isActivityEvent),
    );
    yield* Stream.runForEach(events, (event) =>
      refresh(event.threadId).pipe(
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
