import { describe, expect, test } from "vitest";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { formatDuration, formatUsage, goalElapsedMs, taskTimes, taskUsage } from "./progress.js";
import { toGoalRow } from "./shared.js";

const usage = (
  totalTokens: number,
  costUsd: number,
  reportedTurns: number,
  totalTurns: number,
) => ({
  inputTokens: totalTokens,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens,
  costUsd,
  reportedTurns,
  totalTurns,
});

const goal: Goal = {
  id: "g1",
  title: "Ship",
  objective: "",
  status: "executing",
  config: null,
  leadAgentId: null,
  leadWorkspaceId: null,
  criteria: [{ id: "c1", text: "works", verifiedAt: null, evidence: null }],
  tasks: [
    {
      id: "a",
      title: "A",
      description: "",
      kind: "implement",
      dependsOn: [],
      status: "succeeded",
      attempts: 2,
      error: null,
      summary: null,
    },
  ],
  runs: [
    {
      id: "a-a1",
      taskId: "a",
      provider: "codex",
      agentId: "x",
      workspaceId: null,
      status: "failed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      error: "boom",
      usage: usage(1000, 0.1, 1, 1),
    },
    {
      id: "a-a2",
      taskId: "a",
      provider: "codex",
      agentId: "y",
      workspaceId: null,
      status: "succeeded",
      startedAt: "2026-01-01T00:02:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
      error: null,
      usage: usage(0, 0, 0, 1),
    },
  ],
  changeSets: [],
  integration: null,
  usage: usage(12_345, 0.42, 3, 5),
  lastSeq: 9,
  failureReason: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
};

describe("goal progress formatting", () => {
  test("durations and usage read plainly", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(192_000)).toBe("3m 12s");
    expect(formatDuration(3_900_000)).toBe("1h 05m");
    expect(formatUsage(undefined)).toBe("-");
    expect(formatUsage(usage(0, 0, 0, 4))).toBe("not reported (0/4 turns)");
    expect(formatUsage(goal.usage)).toBe("12.3k tok $0.42 (3/5 turns)");
  });

  test("task times and usage come from the task's runs", () => {
    const task = goal.tasks[0];
    if (!task) throw new Error("no task");
    expect(taskTimes(goal, task)).toEqual({
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:05:00.000Z",
    });
    expect(taskUsage(goal, task)).toMatchObject({
      totalTokens: 1000,
      reportedTurns: 1,
      totalTurns: 2,
    });
  });

  test("a live goal's elapsed time runs to now; the row shows pause, usage and what it waits on", () => {
    const now = Date.parse("2026-01-01T00:10:00.000Z");
    expect(goalElapsedMs(goal, now)).toBe(600_000);
    expect(goalElapsedMs({ ...goal, status: "completed" }, now)).toBe(300_000);
    const row = toGoalRow({ ...goal, pausedAt: "2026-01-01T00:06:00.000Z" }, now);
    expect(row).toMatchObject({
      status: "executing (paused)",
      tasks: "1/1",
      elapsed: "10m 00s",
      usage: "12.3k tok $0.42 (3/5 turns)",
      waitingOn: "resume (paused)",
    });
  });
});
