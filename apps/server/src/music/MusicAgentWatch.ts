import {
  isProviderNativeSubagentThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { type AgentActivity, MusicPlayer } from "./MusicPlayer.ts";

type PendingRequest = Pick<
  OrchestrationV2PendingRuntimeRequestSummary,
  "id" | "kind" | "createdAt"
>;

interface ThreadActivity {
  readonly projectId: string;
  readonly requests: ReadonlyArray<{ readonly id: string; readonly createdAtMs: number }>;
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
  pending: ReadonlyArray<PendingRequest>,
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
    requests: pending
      .filter(
        (request) =>
          request.kind !== "auth_refresh" &&
          (!isSubagent || (subagentAsksUser && request.kind !== "user_input")),
      )
      .map((request) => ({
        id: request.id,
        createdAtMs: DateTime.toEpochMillis(request.createdAt),
      })),
    working:
      runStatus === "preparing" ||
      runStatus === "starting" ||
      runStatus === "running" ||
      runStatus === "waiting",
  };
}

/** `openSinceMs`: requests created by then predate the watch and never trigger the cue. */
export function summarizeActivity(
  threads: Iterable<ThreadActivity>,
  openSinceMs: number | null,
): AgentActivity {
  const requestIds = new Set<string>();
  const preexisting = new Set<string>();
  const workingProjectIds = new Set<string>();
  for (const thread of threads) {
    for (const request of thread.requests) {
      requestIds.add(request.id);
      if (openSinceMs !== null && request.createdAtMs <= openSinceMs) preexisting.add(request.id);
    }
    if (thread.working) workingProjectIds.add(thread.projectId);
  }
  return { requestIds, workingProjectIds, preexisting };
}

/** Folds reports queued while the cue worked; the newest state wins. */
export function mergeReports(reports: ReadonlyArray<AgentActivity>): AgentActivity {
  const latest = reports.at(-1)!;
  const preexisting = new Set<string>();
  for (const report of reports) for (const id of report.preexisting) preexisting.add(id);
  return { ...latest, preexisting };
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
    // Secret and link cards ask the user through turn items rather than runtime requests.
    case "turn-item.updated":
      return event.payload.type === "secret_request" || event.payload.type === "link_request";
    default:
      return false;
  }
};

const RESUBSCRIBE_DELAY = "1 second";
const STREAM_SETTLE_DELAY = "2 seconds";

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
  // The cue runs Music scripts; a queue keeps them from holding up the event stream.
  const reports = yield* Queue.unbounded<AgentActivity>();
  const watchedOnce = yield* Ref.make(false);

  const track = Effect.fnUntraced(function* (thread: AgentAwarenessThread) {
    const records =
      thread.pendingRuntimeRequest === null
        ? []
        : (yield* engine.getThreadRecords(thread.id, ["runtimeRequests"], {
            runtimeRequestStatuses: ["pending"],
          })).runtimeRequests.filter((request) => request.status === "pending");
    // The shell's request may be a secret or link card, which has no runtime request row.
    const shellRequest = thread.pendingRuntimeRequest;
    const pending: ReadonlyArray<PendingRequest> =
      shellRequest !== null && !records.some((request) => request.id === shellRequest.id)
        ? [...records, shellRequest]
        : records;
    const activity = threadActivity(thread, pending);
    if (activity === null) threads.delete(thread.id);
    else threads.set(thread.id, activity);
  });

  const refresh = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { threads: rows } = yield* engine.getAgentAwarenessSnapshot(threadId);
    if (rows[0] === undefined) threads.delete(threadId);
    else yield* track(rows[0]);
    yield* Queue.offer(reports, summarizeActivity(threads.values(), null));
  });

  // Thread entries are only replaced here: subagent threads, which the snapshot leaves out,
  // stay tracked through their own events.
  const reconcile = Effect.fnUntraced(function* (openSinceMs: number | null) {
    const snapshot = yield* engine.getAgentAwarenessSnapshot();
    yield* Effect.forEach(snapshot.threads, track, { discard: true });
    yield* Queue.offer(reports, summarizeActivity(threads.values(), openSinceMs));
  });

  const watchOnce = Effect.gen(function* () {
    const consumer = yield* Effect.forkScoped(
      Stream.runForEach(Stream.filter(engine.streamDomainEvents, isActivityEvent), (event) =>
        refresh(event.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("music agent watch refresh failed", {
              threadId: event.threadId,
              cause,
            }),
          ),
        ),
      ),
    );
    // Only the first watch has requests that predate it; after a restart, anything this watch
    // has not seen before is new.
    const first = !(yield* Ref.getAndSet(watchedOnce, true));
    yield* reconcile(first ? yield* Clock.currentTimeMillis : null);
    // The event stream starts from the latest event when it first runs, which can land just
    // after that snapshot. One more pass covers the gap; creation times keep new requests new.
    yield* Effect.sleep(STREAM_SETTLE_DELAY);
    yield* reconcile(null);
    yield* Fiber.join(consumer);
  }).pipe(Effect.scoped, Effect.withSpan("MusicAgentWatch.watch"));

  const applyReports = Effect.forever(
    Effect.gen(function* () {
      const first = yield* Queue.take(reports);
      const rest = yield* Queue.takeAll(reports);
      const cue = yield* settings.getSettings.pipe(
        Effect.map((current) => current.musicAgentCue),
        Effect.orElseSucceed(() => "off" as const),
      );
      yield* player.observeAgents(mergeReports([first, ...rest]), cue);
    }),
  );

  // A stream that fails resubscribes and reconciles from a fresh snapshot.
  const watchLoop = Effect.forever(
    watchOnce.pipe(
      Effect.catchCause((cause) => Effect.logWarning("music agent watch restarting", { cause })),
      Effect.andThen(Effect.sleep(RESUBSCRIBE_DELAY)),
    ),
  );

  return MusicAgentWatch.of({
    start: Effect.fn("MusicAgentWatch.start")(function* () {
      if (platform !== "darwin") return;
      yield* forkParked(Effect.all([applyReports, watchLoop], { concurrency: 2, discard: true }));
    }),
  });
});

export const layer = Layer.effect(MusicAgentWatch, make);
