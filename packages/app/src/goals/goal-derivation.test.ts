import type { Goal, GoalEvent, Task } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import {
  canApproveGoalPlan,
  goalEventSubject,
  isGoalTerminal,
  summarizeGoalProgress,
} from "./goal-derivation";

function makeTask(id: string, status: Task["status"]): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    kind: "implement",
    dependsOn: [],
    status,
    attempts: 0,
    summary: null,
    error: null,
  };
}

const AT = "2026-10-21T00:00:00.000Z";

describe("summarizeGoalProgress", () => {
  it("counts succeeded tasks and verified criteria", () => {
    const goal: Pick<Goal, "tasks" | "criteria"> = {
      tasks: [makeTask("a", "succeeded"), makeTask("b", "running"), makeTask("c", "failed")],
      criteria: [
        { id: "c1", text: "Tests pass", verifiedAt: AT, evidence: null },
        { id: "c2", text: "Docs updated", verifiedAt: null, evidence: null },
      ],
    };

    expect(summarizeGoalProgress(goal)).toEqual({
      tasksDone: 1,
      tasksTotal: 3,
      criteriaVerified: 1,
      criteriaTotal: 2,
    });
  });
});

describe("goal status policy", () => {
  it("offers approval only while the plan awaits approval", () => {
    expect(canApproveGoalPlan("awaiting_plan_approval")).toBe(true);
    expect(canApproveGoalPlan("planning")).toBe(false);
    expect(canApproveGoalPlan("executing")).toBe(false);
  });

  it("treats completed, failed and cancelled as terminal", () => {
    expect(isGoalTerminal("completed")).toBe(true);
    expect(isGoalTerminal("failed")).toBe(true);
    expect(isGoalTerminal("cancelled")).toBe(true);
    expect(isGoalTerminal("planning")).toBe(false);
    expect(isGoalTerminal("awaiting_plan_approval")).toBe(false);
    expect(isGoalTerminal("executing")).toBe(false);
  });
});

describe("goalEventSubject", () => {
  const envelope = { id: "e1", goalId: "g1", seq: 1, at: AT };

  it("names the task a task event is about", () => {
    const event: GoalEvent = { ...envelope, type: "task.failed", taskId: "a", error: "boom" };
    expect(goalEventSubject(event)).toBe("a: boom");
  });

  it("lists the task ids of a proposed plan", () => {
    const event: GoalEvent = {
      ...envelope,
      type: "plan.proposed",
      tasks: [
        { id: "a", title: "A", description: "", kind: "implement", dependsOn: [] },
        { id: "b", title: "B", description: "", kind: "review", dependsOn: ["a"] },
      ],
    };
    expect(goalEventSubject(event)).toBe("a, b");
  });

  it("has no subject for events that carry nothing beyond their type", () => {
    expect(goalEventSubject({ ...envelope, type: "plan.approved" })).toBeNull();
  });
});
