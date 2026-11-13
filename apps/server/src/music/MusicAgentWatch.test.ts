import { assert, describe, it } from "@effect/vitest";
import { ProjectId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { summarizeActivity, threadActivity } from "./MusicAgentWatch.ts";

const thread = (overrides: Partial<Parameters<typeof threadActivity>[0]> = {}) => ({
  projectId: ProjectId.make("project-1"),
  archivedAt: null,
  pendingRuntimeRequest: null,
  activityRunStatus: null,
  status: "completed" as const,
  ...overrides,
});

const request = (kind: "user_input" | "command" | "auth_refresh") => ({
  id: RuntimeRequestId.make(`request-${kind}`),
  kind,
  createdAt: DateTime.makeUnsafe(0),
});

describe("threadActivity", () => {
  it("counts open approvals and questions, skips sign-in refreshes and archived threads", () => {
    const activity = summarizeActivity(
      [
        thread({ pendingRuntimeRequest: request("command"), status: "waiting" }),
        thread({ pendingRuntimeRequest: request("user_input") }),
        thread({ pendingRuntimeRequest: request("auth_refresh") }),
        thread({
          projectId: ProjectId.make("project-2"),
          activityRunStatus: "running",
          archivedAt: DateTime.makeUnsafe(0),
        }),
        thread({ projectId: ProjectId.make("project-3"), activityRunStatus: "starting" }),
      ].flatMap((entry) => threadActivity(entry) ?? []),
      false,
    );
    assert.deepStrictEqual([...activity.requestIds], ["request-command", "request-user_input"]);
    assert.deepStrictEqual([...activity.workingProjectIds], ["project-1", "project-3"]);
  });
});
