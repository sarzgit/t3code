import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { AgentActivity } from "./MusicPlayer.ts";
import {
  type AgentSource,
  runAgentWatch,
  summarizeActivity,
  threadActivity,
  type WatchedThread,
} from "./MusicAgentWatch.ts";

const ROOT = ThreadId.make("root");
const SUBAGENT = {
  parentThreadId: ROOT,
  relationshipToParent: "subagent" as const,
  rootThreadId: ROOT,
};

const thread = (overrides: Partial<Parameters<typeof threadActivity>[0]> = {}) =>
  ({
    projectId: ProjectId.make("project-1"),
    archivedAt: null,
    activityRunStatus: null,
    status: "completed",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ROOT },
    creationSource: "web",
    ...overrides,
  }) satisfies Parameters<typeof threadActivity>[0];

const request = (
  kind: "user_input" | "command" | "auth_refresh",
  id: string = kind,
  createdAtMs = 0,
) => ({
  id: RuntimeRequestId.make(id),
  kind,
  createdAt: DateTime.makeUnsafe(createdAtMs),
});

describe("threadActivity", () => {
  it("counts every open request the user must answer", () => {
    const activity = summarizeActivity(
      [
        // Two open requests on one thread both count, though its shell shows only one.
        threadActivity(thread({ status: "waiting" }), [
          request("command"),
          request("user_input"),
          request("auth_refresh"),
        ]),
        // The coordinating agent answers a subagent's question; its approval goes to the user.
        threadActivity(thread({ lineage: SUBAGENT, activityRunStatus: "waiting" }), [
          request("user_input", "child-question"),
          request("command", "child-approval"),
        ]),
        // A provider-native subagent asks on its parent.
        threadActivity(
          thread({ lineage: SUBAGENT, activityRunStatus: "waiting", creationSource: "provider" }),
          [request("command", "native-approval")],
        ),
        threadActivity(
          thread({
            projectId: ProjectId.make("project-2"),
            activityRunStatus: "running",
            archivedAt: DateTime.makeUnsafe(0),
          }),
          [request("command", "archived")],
        ),
        threadActivity(
          thread({ projectId: ProjectId.make("project-3"), activityRunStatus: "starting" }),
          [],
        ),
      ].flatMap((entry) => entry ?? []),
      -1,
    );
    assert.deepStrictEqual([...activity.requestIds], ["command", "user_input", "child-approval"]);
    assert.deepStrictEqual([...activity.workingProjectIds], ["project-1", "project-3"]);
  });
});

describe("runAgentWatch", () => {
  const watched = (id: string, overrides: Partial<WatchedThread> = {}): WatchedThread => ({
    ...thread(),
    id: ThreadId.make(id),
    pendingRuntimeRequest: null,
    ...overrides,
  });

  const makeWorld = Effect.gen(function* () {
    const listed = new Map<string, WatchedThread>();
    const all = new Map<string, WatchedThread>();
    const pending = new Map<string, ReadonlyArray<ReturnType<typeof request>>>();
    const changes = yield* Queue.unbounded<string>();
    const observed = yield* Queue.unbounded<AgentActivity>();
    const source: AgentSource = {
      listThreads: Effect.sync(() => [...listed.values()]),
      readThread: (id) => Effect.sync(() => all.get(id) ?? null),
      pendingRequests: (id) => Effect.sync(() => pending.get(id) ?? []),
      changes: Stream.fromQueue(changes),
    };
    const setThread = (
      next: WatchedThread,
      requests: ReadonlyArray<ReturnType<typeof request>>,
      options: { readonly listed: boolean },
    ) => {
      all.set(next.id, {
        ...next,
        pendingRuntimeRequest: requests[0] ?? null,
      });
      if (options.listed) listed.set(next.id, all.get(next.id)!);
      pending.set(next.id, requests);
    };
    const removeThread = (id: string) => {
      all.delete(id);
      listed.delete(id);
    };
    yield* Effect.forkScoped(
      runAgentWatch({ source, observe: (activity) => Queue.offer(observed, activity) }),
    );
    // The watch starts at clock zero and reports its first listing at once.
    yield* Queue.take(observed);
    return { changes, observed, setThread, removeThread };
  });

  it.effect("reports a lone new request and its answer without waiting for more events", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      world.setThread(watched("t1"), [request("command", "new", 5_000)], { listed: true });
      yield* Queue.offer(world.changes, "t1");
      const asked = yield* Queue.take(world.observed);
      assert.deepStrictEqual([...asked.requestIds], ["new"]);
      assert.strictEqual(asked.preexisting.size, 0);

      world.setThread(watched("t1"), [], { listed: true });
      yield* Queue.offer(world.changes, "t1");
      assert.strictEqual((yield* Queue.take(world.observed)).requestIds.size, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a request older than the watch quiet and drops threads that vanish", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      // A subagent the listing leaves out, found only through its event, asked before startup.
      world.setThread(
        watched("child", { lineage: SUBAGENT, activityRunStatus: "waiting" }),
        [request("command", "old", -1_000)],
        { listed: false },
      );
      yield* Queue.offer(world.changes, "child");
      const found = yield* Queue.take(world.observed);
      assert.deepStrictEqual([...found.requestIds], ["old"]);
      assert.deepStrictEqual([...found.preexisting], ["old"]);

      // Deleted with no event of its own: the next reconcile still notices.
      world.removeThread("child");
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* Queue.take(world.observed)).requestIds.size, 0);
    }).pipe(Effect.scoped),
  );
});
