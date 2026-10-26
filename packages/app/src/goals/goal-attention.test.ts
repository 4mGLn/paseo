import { describe, expect, it } from "vitest";
import {
  buildGoalListSections,
  canAcknowledgeGoal,
  countGoalsBlockedOnUser,
  countGoalsByFilter,
  findNewGoalAttention,
  goalAttention,
  snapshotGoalAttention,
} from "./goal-attention";
import { makeChangeSet, makeGoal } from "./test-utils/goal-fixture";

const planReview = makeGoal({ id: "plan", status: "awaiting_plan_approval" });
const changeReview = makeGoal({
  id: "change",
  status: "executing",
  changeSets: [makeChangeSet("cs-1", "t1", { status: "awaiting_human" })],
});
const running = makeGoal({ id: "running", status: "executing" });
const failed = makeGoal({ id: "failed", status: "failed" });
const completed = makeGoal({ id: "completed", status: "completed" });

describe("goalAttention", () => {
  it("names what each goal waits on", () => {
    expect(goalAttention(planReview)).toBe("plan_review");
    expect(goalAttention(changeReview)).toBe("change_review");
    expect(goalAttention(failed)).toBe("failed");
    expect(goalAttention(running)).toBeNull();
    expect(goalAttention(completed)).toBeNull();
  });

  it("ignores a held change set once the goal has ended", () => {
    expect(goalAttention({ ...changeReview, status: "cancelled" })).toBeNull();
  });

  it("stops asking about a dismissed failure, and asks again once retry clears the mark", () => {
    const dismissed = { ...failed, acknowledgedAt: "2026-10-22T00:00:00Z" };
    expect(goalAttention(dismissed)).toBeNull();
    expect(goalAttention({ ...dismissed, acknowledgedAt: null })).toBe("failed");
  });
});

describe("canAcknowledgeGoal", () => {
  it("offers dismiss only for ended goals not dismissed yet", () => {
    expect(canAcknowledgeGoal(failed)).toBe(true);
    expect(canAcknowledgeGoal(completed)).toBe(true);
    expect(canAcknowledgeGoal(running)).toBe(false);
    expect(canAcknowledgeGoal({ ...failed, acknowledgedAt: "2026-10-22T00:00:00Z" })).toBe(false);
  });
});

describe("dismissed failures in the list", () => {
  const dismissed = makeGoal({
    id: "dismissed",
    status: "failed",
    acknowledgedAt: "2026-10-22T00:00:00Z",
  });

  it("leaves Needs you but stays under All and Done", () => {
    expect(countGoalsByFilter([failed, dismissed])).toEqual({
      needs_you: 1,
      running: 0,
      done: 2,
      all: 2,
    });
    const sections = buildGoalListSections([failed, dismissed], "all");
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["dismissed"]);
  });

  it("does not toast when a failure is dismissed, and toasts when it fails again", () => {
    const before = snapshotGoalAttention([failed]);
    const acked = { ...failed, acknowledgedAt: "2026-10-22T00:00:00Z" };
    expect(findNewGoalAttention(before, [acked])).toEqual([]);
    const reopened = { ...acked, status: "executing" as const, acknowledgedAt: null };
    const failedAgain = { ...reopened, status: "failed" as const };
    expect(
      findNewGoalAttention(snapshotGoalAttention([reopened]), [failedAgain]).map((t) => t.kind),
    ).toEqual(["failed"]);
  });
});

describe("goal list filters", () => {
  const goals = [planReview, changeReview, running, failed, completed];

  it("counts plans and changes awaiting approval, not failures", () => {
    expect(countGoalsBlockedOnUser(goals)).toBe(2);
  });

  it("counts every filter", () => {
    expect(countGoalsByFilter(goals)).toEqual({ needs_you: 3, running: 3, done: 2, all: 5 });
  });

  it("puts goals waiting on you first, each group by latest activity", () => {
    const older = makeGoal({ id: "older", status: "executing", updatedAt: "2026-10-20T00:00:00Z" });
    const sections = buildGoalListSections(
      [older, running, { ...planReview, updatedAt: "2026-10-19T00:00:00Z" }, failed],
      "all",
    );
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed", "plan"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["running", "older"]);
  });

  it("keeps only finished goals under done", () => {
    const sections = buildGoalListSections([running, completed, failed], "done");
    expect(sections.attention.map((goal) => goal.id)).toEqual(["failed"]);
    expect(sections.others.map((goal) => goal.id)).toEqual(["completed"]);
  });
});

describe("findNewGoalAttention", () => {
  it("is quiet on the first poll", () => {
    expect(findNewGoalAttention(null, [planReview])).toEqual([]);
  });

  it("reports a goal that started waiting since the last poll", () => {
    const previous = snapshotGoalAttention([{ ...planReview, status: "planning" }, running]);
    const transitions = findNewGoalAttention(previous, [planReview, running]);
    expect(transitions.map((entry) => [entry.goal.id, entry.kind])).toEqual([
      ["plan", "plan_review"],
    ]);
  });

  it("does not repeat a state it already reported", () => {
    const previous = snapshotGoalAttention([planReview, changeReview]);
    expect(findNewGoalAttention(previous, [planReview, changeReview])).toEqual([]);
  });

  it("reports another change set held for approval", () => {
    const previous = snapshotGoalAttention([changeReview]);
    const next = {
      ...changeReview,
      changeSets: [
        ...changeReview.changeSets,
        makeChangeSet("cs-2", "t2", { status: "awaiting_human" }),
      ],
    };
    expect(findNewGoalAttention(previous, [next]).map((entry) => entry.kind)).toEqual([
      "change_review",
    ]);
  });

  it("reports a goal first seen already waiting", () => {
    const previous = snapshotGoalAttention([running]);
    expect(findNewGoalAttention(previous, [running, failed]).map((e) => e.goal.id)).toEqual([
      "failed",
    ]);
  });
});
