import type { GoalEvent } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import { buildGoalEventFeed, describeGoalEvent } from "./goal-event-feed";
import { FIXTURE_AT, makeChangeSet, makeGoal, makeRun, makeTask } from "./test-utils/goal-fixture";

const goal = makeGoal({
  tasks: [makeTask("t1", { title: "Add tests" }), makeTask("t2", { title: "Fix bug" })],
  runs: [makeRun("r1", "t1")],
  changeSets: [makeChangeSet("c1", "t2")],
  criteria: [{ id: "k1", text: "Tests pass", verifiedAt: null, evidence: null }],
});

let seq = 0;
function event(body: Record<string, unknown>): GoalEvent {
  seq += 1;
  return { id: `e${seq}`, goalId: "goal-1", seq, at: FIXTURE_AT, ...body } as GoalEvent;
}

describe("describeGoalEvent", () => {
  it("names tasks, change sets and criteria by their titles", () => {
    expect(
      describeGoalEvent(event({ type: "task.failed", taskId: "t1", error: "boom" }), goal),
    ).toEqual({ key: "taskFailed", tone: "error", subject: "Add tests", detail: "boom" });
    expect(
      describeGoalEvent(
        event({ type: "changeset.transitioned", changeSetId: "c1", to: "awaiting_human" }),
        goal,
      ),
    ).toMatchObject({ key: "changeSetAwaitingYou", tone: "warning", subject: "Fix bug" });
    expect(
      describeGoalEvent(event({ type: "criterion.verified", criterionId: "k1" }), goal),
    ).toMatchObject({ key: "criterionVerified", subject: "Tests pass" });
    expect(
      describeGoalEvent(event({ type: "run.finished", runId: "r1", outcome: "interrupted" }), goal),
    ).toMatchObject({ key: "runInterrupted", subject: "Add tests" });
  });

  it("tells a dismissed goal", () => {
    expect(describeGoalEvent(event({ type: "goal.acknowledged" }), goal)).toEqual({
      key: "goalAcknowledged",
      tone: "default",
      subject: null,
    });
  });

  it("tells a settings change and a planning failure reopened", () => {
    expect(
      describeGoalEvent(event({ type: "goal.config_updated", config: goal.config }), goal),
    ).toMatchObject({ key: "goalConfigUpdated", tone: "default" });
    expect(describeGoalEvent(event({ type: "goal.reopened" }), goal)).toMatchObject({
      key: "goalReopened",
      tone: "default",
    });
  });

  it("falls back to the id for something it cannot find", () => {
    expect(describeGoalEvent(event({ type: "task.retried", taskId: "gone" }), goal)).toMatchObject({
      subject: "gone",
    });
  });

  it("hides bookkeeping", () => {
    const hidden = [
      event({ type: "run.attached", runId: "r1", agentId: "a", workspaceId: "w" }),
      event({ type: "task.started", taskId: "t1" }),
      event({ type: "run.finished", runId: "r1", outcome: "succeeded" }),
      event({ type: "lead.notified", key: "k" }),
      event({ type: "notification.queued", key: "k", target: "lead", text: "x" }),
      event({
        type: "notification.attempted",
        key: "k",
        target: "lead",
        attempt: 1,
        outcome: "delivered",
      }),
      event({ type: "usage.recorded", role: "worker", agentId: "a" }),
      event({ type: "changeset.transitioned", changeSetId: "c1", to: "superseded" }),
    ];
    for (const entry of hidden) {
      expect(describeGoalEvent(entry, goal)).toBeNull();
    }
  });

  it("names the reason for a rework task and the target of a failed notification", () => {
    expect(
      describeGoalEvent(
        event({
          type: "task.added",
          task: { id: "t2-rw1", title: "Fix", description: "", kind: "implement", dependsOn: [] },
          rework: { changeSetId: "c1", reason: "tests", round: 1 },
        }),
        goal,
      ),
    ).toMatchObject({ key: "reworkAdded_tests", subject: "Fix bug" });
    expect(
      describeGoalEvent(
        event({
          type: "notification.attempted",
          key: "k",
          target: "origin",
          attempt: 1,
          outcome: "failed",
          error: "offline",
        }),
        goal,
      ),
    ).toMatchObject({ key: "notifyFailed_origin", detail: "offline" });
  });
});

describe("buildGoalEventFeed", () => {
  it("lists newest first and folds repeats into one line", () => {
    const feed = buildGoalEventFeed(
      [
        event({ type: "goal.created", title: "G", objective: "", criteria: [] }),
        event({ type: "run.started", runId: "r1", taskId: "t1", provider: "codex" }),
        event({ type: "task.started", taskId: "t1" }),
        event({ type: "run.started", runId: "r2", taskId: "t2", provider: "codex" }),
        event({ type: "task.succeeded", taskId: "t1" }),
      ],
      goal,
    );
    expect(feed.map((entry) => [entry.key, entry.subjects, entry.count])).toEqual([
      ["taskSucceeded", ["Add tests"], 1],
      ["taskStarted", ["Add tests", "Fix bug"], 2],
      ["goalCreated", [], 1],
    ]);
  });

  it("keeps lines with different details apart", () => {
    const feed = buildGoalEventFeed(
      [
        event({ type: "task.failed", taskId: "t1", error: "a" }),
        event({ type: "task.failed", taskId: "t1", error: "b" }),
      ],
      goal,
    );
    expect(feed).toHaveLength(2);
  });
});
