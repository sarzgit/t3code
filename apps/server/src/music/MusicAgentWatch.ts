import {
  isProviderNativeSubagentThread,
  type MusicAgentCue,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingRuntimeRequestSummary,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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

export type WatchedThread = Pick<
  AgentAwarenessThread,
  | "id"
  | "projectId"
  | "archivedAt"
  | "activityRunStatus"
  | "status"
  | "lineage"
  | "creationSource"
  | "pendingRuntimeRequest"
>;

interface ThreadActivity {
  readonly projectId: string;
  readonly requests: ReadonlyArray<{ readonly id: string; readonly createdAtMs: number }>;
  readonly working: boolean;
}

/**
 * What one thread contributes to the music cue and listening stats. `pending` is every open
 * request on the thread; the shell itself shows only one.
 */
export function threadActivity(
  thread: Omit<WatchedThread, "id" | "pendingRuntimeRequest">,
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

/** Requests created by `openSinceMs` predate the watch and never trigger the cue. */
export function summarizeActivity(
  threads: Iterable<ThreadActivity>,
  openSinceMs: number,
): AgentActivity {
  const requestIds = new Set<string>();
  const preexisting = new Set<string>();
  const workingProjectIds = new Set<string>();
  for (const thread of threads) {
    for (const request of thread.requests) {
      requestIds.add(request.id);
      if (request.createdAtMs <= openSinceMs) preexisting.add(request.id);
    }
    if (thread.working) workingProjectIds.add(thread.projectId);
  }
  return { requestIds, workingProjectIds, preexisting };
}

/** What the watch reads from orchestration; narrow so tests can drive it. */
export interface AgentSource {
  /** Listed, unarchived threads. */
  readonly listThreads: Effect.Effect<ReadonlyArray<WatchedThread>>;
  /** One thread, archived included; null once deleted. */
  readonly readThread: (threadId: string) => Effect.Effect<WatchedThread | null>;
  readonly pendingRequests: (threadId: string) => Effect.Effect<ReadonlyArray<PendingRequest>>;
  /** Ids of threads whose requests, runs or archive state changed, from when it starts. */
  readonly changes: Stream.Stream<string>;
}

type Work = { readonly _tag: "thread"; readonly id: string } | { readonly _tag: "reconcile" };

const RETRY_DELAY = "1 second";
const STREAM_SETTLE_DELAY = "2 seconds";

/**
 * One worker reads, updates and reports in order, so a stale read never overwrites a newer
 * one. The event stream only queues thread ids, so slow Music scripts never hold it up.
 */
export const runAgentWatch = Effect.fn("MusicAgentWatch.run")(function* (input: {
  readonly source: AgentSource;
  readonly observe: (activity: AgentActivity) => Effect.Effect<void>;
}) {
  const { source, observe } = input;
  // Fixed for the process: requests older than the watch never cue, however late they show up.
  const openSinceMs = yield* Clock.currentTimeMillis;
  const threads = new Map<string, ThreadActivity>();
  const work = yield* Queue.unbounded<Work>();

  const track = Effect.fnUntraced(function* (thread: WatchedThread) {
    const shellRequest = thread.pendingRuntimeRequest;
    const records = shellRequest === null ? [] : yield* source.pendingRequests(thread.id);
    // The shell's request may be a secret or link card, which has no runtime request row.
    const pending =
      shellRequest !== null && !records.some((request) => request.id === shellRequest.id)
        ? [...records, shellRequest]
        : records;
    const activity = threadActivity(thread, pending);
    if (activity === null) threads.delete(thread.id);
    else threads.set(thread.id, activity);
  });

  const refresh = Effect.fnUntraced(function* (threadId: string) {
    const thread = yield* source.readThread(threadId);
    if (thread === null) threads.delete(threadId);
    else yield* track(thread);
  });

  const processBatch = Effect.fnUntraced(function* (batch: ReadonlyArray<Work>) {
    const ids = new Set<string>();
    if (batch.some((item) => item._tag === "reconcile")) {
      const listed = yield* source.listThreads;
      yield* Effect.forEach(listed, track, { discard: true });
      const listedIds = new Set<string>(listed.map((thread) => thread.id));
      // Tracked threads the listing leaves out: subagents, or ones archived or deleted since.
      for (const id of threads.keys()) if (!listedIds.has(id)) ids.add(id);
    }
    for (const item of batch) if (item._tag === "thread") ids.add(item.id);
    yield* Effect.forEach(ids, refresh, { discard: true });
    yield* observe(summarizeActivity(threads.values(), openSinceMs));
  });

  const worker = Effect.forever(
    Queue.takeAll(work).pipe(
      Effect.flatMap((batch) =>
        processBatch(batch).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("music agent watch batch failed", { cause }).pipe(
              Effect.andThen(Effect.sleep(RETRY_DELAY)),
              // Keep lone answer events so a transient read failure cannot strand the cue.
              Effect.andThen(Queue.offerAll(work, batch)),
            ),
          ),
        ),
      ),
    ),
  );

  const watchOnce = Effect.gen(function* () {
    const consumer = yield* Effect.forkScoped(
      Stream.runForEach(source.changes, (id) => Queue.offer(work, { _tag: "thread", id })),
    );
    yield* Queue.offer(work, { _tag: "reconcile" });
    // The stream starts from the latest event when it first runs, which can land after the
    // first listing. One more pass covers that gap.
    yield* Effect.sleep(STREAM_SETTLE_DELAY);
    yield* Queue.offer(work, { _tag: "reconcile" });
    yield* Fiber.join(consumer);
  }).pipe(Effect.scoped);

  // A stream that ends or fails resubscribes and reconciles.
  const watchLoop = Effect.forever(
    watchOnce.pipe(
      Effect.catchCause((cause) => Effect.logWarning("music agent watch restarting", { cause })),
      Effect.andThen(Effect.sleep(RETRY_DELAY)),
    ),
  );

  yield* Effect.all([worker, watchLoop], { concurrency: 2, discard: true });
});

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

export class MusicAgentWatch extends Context.Service<
  MusicAgentWatch,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/music/MusicAgentWatch") {}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const engine = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const player = yield* MusicPlayer;

  // Read failures surface as defects; the worker logs them and carries on with the next batch.
  const source: AgentSource = {
    listThreads: engine.getAgentAwarenessSnapshot().pipe(
      Effect.map((snapshot) => snapshot.threads),
      Effect.orDie,
    ),
    readThread: (threadId) =>
      engine.getAgentAwarenessSnapshot(ThreadId.make(threadId)).pipe(
        Effect.map((snapshot) => snapshot.threads[0] ?? null),
        Effect.orDie,
      ),
    pendingRequests: (threadId) =>
      engine
        .getThreadRecords(ThreadId.make(threadId), ["runtimeRequests"], {
          runtimeRequestStatuses: ["pending"],
        })
        .pipe(
          Effect.map((records) =>
            records.runtimeRequests.filter((request) => request.status === "pending"),
          ),
          Effect.orDie,
        ),
    changes: engine.streamDomainEvents.pipe(
      Stream.filter(isActivityEvent),
      Stream.map((event): string => event.threadId),
      Stream.orDie,
    ),
  };

  const readCue = settings.getSettings.pipe(
    Effect.map((current): MusicAgentCue => current.musicAgentCue),
    Effect.orElseSucceed((): MusicAgentCue => "off"),
  );

  return MusicAgentWatch.of({
    start: Effect.fn("MusicAgentWatch.start")(function* () {
      if (platform !== "darwin") return;
      yield* forkParked(
        runAgentWatch({
          source,
          observe: (activity) =>
            readCue.pipe(Effect.flatMap((cue) => player.observeAgents(activity, cue))),
        }),
      );
    }),
  });
});

export const layer = Layer.effect(MusicAgentWatch, make);
