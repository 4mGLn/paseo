import { describe, expect, it } from "vitest";
import type { GoalSummary } from "@getpaseo/protocol/goal/types";
import { applyGoalUpdate, mergePolledGoals } from "./goal-updates";
import { makeGoal } from "./test-utils/goal-fixture";

function summary(id: string, lastSeq: number, overrides: Partial<GoalSummary> = {}): GoalSummary {
  return { ...makeGoal({ id, lastSeq }), ...overrides };
}

describe("applyGoalUpdate", () => {
  it("replaces the cached goal with a newer push and adds an unknown one first", () => {
    const list = [summary("a", 1), summary("b", 1)];
    const updated = applyGoalUpdate(list, summary("b", 2, { title: "B2" }));
    expect(updated.map((goal) => [goal.id, goal.lastSeq])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
    expect(applyGoalUpdate(list, summary("c", 1)).map((goal) => goal.id)).toEqual(["c", "a", "b"]);
  });

  it("drops a push older than the cached goal", () => {
    const list = [summary("a", 5)];
    expect(applyGoalUpdate(list, summary("a", 4))[0]?.lastSeq).toBe(5);
  });
});

describe("mergePolledGoals", () => {
  it("keeps a pushed goal that is newer than the poll", () => {
    const cached = [summary("a", 7), summary("b", 1)];
    const polled = [summary("a", 6), summary("b", 2), summary("c", 1)];
    expect(mergePolledGoals(cached, polled).map((goal) => [goal.id, goal.lastSeq])).toEqual([
      ["a", 7],
      ["b", 2],
      ["c", 1],
    ]);
  });

  it("takes the poll as it is without a cache", () => {
    const polled = [summary("a", 1)];
    expect(mergePolledGoals(undefined, polled)).toEqual(polled);
  });
});
