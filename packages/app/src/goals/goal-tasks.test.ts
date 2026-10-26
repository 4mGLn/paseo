import { describe, expect, it } from "vitest";
import {
  groupGoalTasks,
  latestTaskAgent,
  visibleChangeSets,
  type GoalTaskGroup,
} from "./goal-tasks";
import { makeChangeSet, makeGoal, makeRun, makeTask } from "./test-utils/goal-fixture";

function groupIds(group: GoalTaskGroup): [string, string[]] {
  return [group.id, group.tasks.map((task) => task.id)];
}

describe("groupGoalTasks", () => {
  it("groups by what each task needs and drops empty groups", () => {
    const goal = makeGoal({
      tasks: [
        makeTask("a", { status: "succeeded" }),
        makeTask("b", { status: "failed" }),
        makeTask("c", { status: "pending" }),
        makeTask("d", { status: "cancelled" }),
      ],
    });
    expect(groupGoalTasks(goal).map(groupIds)).toEqual([
      ["attention", ["b"]],
      ["pending", ["c"]],
      ["done", ["a", "d"]],
    ]);
    expect(groupGoalTasks(makeGoal())).toEqual([]);
  });
});

describe("latestTaskAgent", () => {
  it("returns the newest run's agent and skips runs without one", () => {
    const goal = makeGoal({
      runs: [
        makeRun("r1", "t1", { agentId: "old", workspaceId: "w1" }),
        makeRun("r2", "t2"),
        makeRun("r3", "t1", { agentId: "new", workspaceId: "w3" }),
        makeRun("r4", "t1", { agentId: null, workspaceId: null }),
      ],
    });
    expect(latestTaskAgent(goal, "t1")).toEqual({ agentId: "new", workspaceId: "w3" });
    expect(latestTaskAgent(goal, "missing")).toBeNull();
  });
});

describe("visibleChangeSets", () => {
  it("drops superseded rounds and puts ones waiting on you first", () => {
    const goal = makeGoal({
      changeSets: [
        makeChangeSet("merged", "t1", { status: "integrated" }),
        makeChangeSet("old", "t2", { status: "superseded" }),
        makeChangeSet("held", "t2", { status: "awaiting_human" }),
        makeChangeSet("review", "t3", { status: "in_review" }),
      ],
    });
    expect(visibleChangeSets(goal).map((c) => c.id)).toEqual(["held", "review", "merged"]);
  });
});
