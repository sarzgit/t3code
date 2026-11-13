import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { mergeReports, summarizeActivity, threadActivity } from "./MusicAgentWatch.ts";

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
) => ({ id: RuntimeRequestId.make(id), kind, createdAt: DateTime.makeUnsafe(createdAtMs) });

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
      null,
    );
    assert.deepStrictEqual([...activity.requestIds], ["command", "user_input", "child-approval"]);
    assert.deepStrictEqual([...activity.workingProjectIds], ["project-1", "project-3"]);
  });
});

describe("summarizeActivity", () => {
  it("treats only requests created before the watch began as already open", () => {
    const watched = threadActivity(thread(), [
      request("command", "before", 1_000),
      request("command", "during-startup", 2_500),
    ]);
    const startup = summarizeActivity([watched!], 2_000);
    assert.deepStrictEqual([...startup.preexisting], ["before"]);

    // A later report replacing the startup one before the cue ran keeps its baseline.
    const merged = mergeReports([startup, summarizeActivity([watched!], null)]);
    assert.deepStrictEqual([...merged.preexisting], ["before"]);
    assert.deepStrictEqual([...merged.requestIds], ["before", "during-startup"]);
  });
});
