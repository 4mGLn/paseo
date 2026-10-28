import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { diagnoseGoalFailure } from "@getpaseo/protocol/goal/diagnosis";
import { type Goal, type GoalEvent, GoalEventSchema } from "@getpaseo/protocol/goal/types";
import { goalForClient, withSlimPlanHistory } from "../session/goal/goal-session.js";
import { applyGoalEvent, replayGoal } from "./goal-reducer.js";

/** A goal log from this daemon's own goals, trimmed of long text; see test-fixtures. */
function fixture(name: string): Goal {
  const text = readFileSync(join(import.meta.dirname, "test-fixtures", name), "utf8");
  const events = text
    .trim()
    .split("\n")
    .map((line) => GoalEventSchema.parse(JSON.parse(line)));
  const goal = replayGoal(events);
  if (!goal) throw new Error(`empty fixture ${name}`);
  return goal;
}

const NEXT_DAY = Date.parse("2026-10-28T09:00:00.000Z");

describe("diagnosis of real failed goals", () => {
  test("b195cf6f: t3 stopped on a permission request, t5 and t6 blocked, past the limit now", () => {
    const goal = fixture("b195cf6f.jsonl");
    expect(goal).toMatchObject({ status: "failed", failedAt: "2026-10-27T11:37:06.135Z" });
    const diagnosis = diagnoseGoalFailure(goal, { now: NEXT_DAY });
    expect(diagnosis.kind).toBe("stuck");
    expect(diagnosis.findings.map((f) => f.kind)).toEqual(["stuck"]);
    // 720 minutes from 09:23Z had not passed at 11:37Z; it has the next morning.
    expect(diagnosis.timePassedAtFailure).toBe(false);
    expect(diagnosis.timePassedNow).toBe(true);
    expect(diagnosis.tasks).toEqual([
      expect.objectContaining({
        taskId: "t3",
        status: "failed",
        cause: "pending_request",
        failedRuns: 6,
        countedFailures: 3,
        interruptedRuns: 0,
        blockedDependents: ["t5", "t6"],
      }),
    ]);
    expect(diagnosis.blocked).toEqual(["t5", "t6"]);
    expect(diagnosis.merged).toEqual([
      { changeSetId: "cs-t2-a1", taskId: "t2" },
      { changeSetId: "cs-t1-a5", taskId: "t1" },
      { changeSetId: "cs-t4-a1", taskId: "t4" },
    ]);
    expect(diagnosis.openChangeSets).toEqual([]);
    expect(diagnosis.runs).toEqual({ used: 13, max: 60 });
    expect(diagnosis.blockingLimits).toEqual([
      expect.objectContaining({ limit: "goalTimeoutMinutes", current: 720 }),
    ]);
    expect(diagnosis.recoverable).toBe(true);
  });

  test("aff07ea6: t7 timed out three times and was interrupted twice, t8 to t10 blocked", () => {
    const goal = fixture("aff07ea6.jsonl");
    const diagnosis = diagnoseGoalFailure(goal, { now: NEXT_DAY });
    expect(diagnosis.kind).toBe("stuck");
    expect(diagnosis.timePassedAtFailure).toBe(false);
    expect(diagnosis.timePassedNow).toBe(true);
    expect(diagnosis.tasks).toEqual([
      expect.objectContaining({
        taskId: "t7",
        cause: "timeout",
        lastError: "Turn timed out after 90 minutes",
        failedRuns: 3,
        countedFailures: 3,
        interruptedRuns: 2,
        blockedDependents: ["t8", "t9", "t10"],
      }),
    ]);
    expect(diagnosis.blocked).toEqual(["t8", "t9", "t10"]);
    expect(diagnosis.merged.map((m) => m.changeSetId)).toEqual([
      "cs-t4-rw1-a1",
      "cs-t6-a3",
      "cs-t5-rw1-a1",
    ]);
    expect(diagnosis.runs).toEqual({ used: 17, max: 90 });
  });

  test("before the limit passed, no time limit blocks", () => {
    const goal = fixture("aff07ea6.jsonl");
    const diagnosis = diagnoseGoalFailure(goal, { now: Date.parse("2026-10-27T12:30:00.000Z") });
    expect(diagnosis.timePassedNow).toBe(false);
    expect(diagnosis.blockingLimits).toEqual([]);
  });

  test("the slim payload every client gets diagnoses the same as the full goal", () => {
    for (const name of ["b195cf6f.jsonl", "aff07ea6.jsonl"]) {
      const goal = fixture(name);
      const slim = withSlimPlanHistory(goalForClient(goal, {}));
      expect(diagnoseGoalFailure(slim, { now: NEXT_DAY })).toEqual(
        diagnoseGoalFailure(goal, { now: NEXT_DAY }),
      );
    }
  });
});

const AT = "2026-01-01T00:00:00.000Z";
const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: true,
  notifyLead: false,
  limits: { goalTimeoutMinutes: 60 },
};

let seq = 0;
function build(events: Record<string, unknown>[]): Goal {
  let goal: Goal | null = null;
  for (const partial of events) {
    seq += 1;
    const event = {
      id: `d${seq}`,
      goalId: "g1",
      seq: (goal?.lastSeq ?? 0) + 1,
      at: AT,
      ...partial,
    } as GoalEvent;
    goal = applyGoalEvent(goal, event);
  }
  if (!goal) throw new Error("no events");
  return goal;
}

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id,
  description: "",
  kind: "implement",
  dependsOn,
});
const created = {
  type: "goal.created",
  title: "T",
  objective: "O",
  criteria: [{ id: "c1", text: "works" }],
  config,
};
const planned = [
  created,
  { type: "plan.proposed", tasks: [task("a"), task("b", ["a"])] },
  { type: "plan.approved" },
];
const failRun = (taskId: string, attempt: number, error: string) => [
  { type: "task.started", taskId },
  { type: "run.started", runId: `${taskId}-a${attempt}`, taskId, provider: "codex" },
  { type: "run.finished", runId: `${taskId}-a${attempt}`, outcome: "failed", error },
  { type: "task.failed", taskId, error },
];
const failedOn = (error: string, reason = "No task can make progress") =>
  build([...planned, ...failRun("a", 1, error), { type: "goal.failed", reason }]);
const NOW = Date.parse(AT);

describe("diagnosis kinds", () => {
  test("a goal without tasks failed while planning", () => {
    const goal = build([created, { type: "goal.failed", reason: "no plan" }]);
    expect(diagnoseGoalFailure(goal, { now: NOW }).kind).toBe("planning");
  });

  test("each task cause is read from its last failed run", () => {
    const causes = [
      ["Turn timed out after 60 minutes", "timeout"],
      ['Agent asked a question: "which?"', "pending_request"],
      ["Agent is waiting for permission to run Bash", "pending_request"],
      [
        "Agent is waiting for a permission approval; unattended runs cannot continue",
        "pending_request",
      ],
      ["Stopped by the Lead: stuck", "lead_stopped"],
      ["Agent run was canceled", "canceled"],
      ["exit 1", "worker_error"],
    ] as const;
    for (const [error, cause] of causes) {
      const diagnosis = diagnoseGoalFailure(failedOn(error), { now: NOW });
      expect(diagnosis.tasks[0]).toMatchObject({ taskId: "a", cause, blockedDependents: ["b"] });
    }
  });

  test("a task running when the goal ended reads as interrupted", () => {
    const goal = build([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "goal.failed", reason: "Time limit of 60 minutes reached" },
    ]);
    expect(diagnoseGoalFailure(goal, { now: NOW }).tasks).toEqual([
      expect.objectContaining({
        taskId: "a",
        status: "cancelled",
        cause: "interrupted",
        interruptedRuns: 1,
        lastError: null,
      }),
    ]);
  });

  test("a review rejection comes first, then time when the limit had passed at failure", () => {
    const late = "2026-01-01T02:00:00.000Z";
    const goal = build([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "task.succeeded", taskId: "a" },
      { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
      {
        type: "integration.prepared",
        branch: "g",
        workspaceId: "w",
        cwd: "/i",
        baseCommit: "base",
      },
      ...captured("cs-a", "a", "a-a1"),
      { type: "changeset.transitioned", changeSetId: "cs-a", to: "in_review" },
      { type: "changeset.transitioned", changeSetId: "cs-a", to: "rejected" },
      { type: "goal.failed", reason: "Time limit of 60 minutes reached", at: late },
    ]);
    const diagnosis = diagnoseGoalFailure(goal, { now: Date.parse(late) });
    expect(diagnosis.timePassedAtFailure).toBe(true);
    expect(diagnosis.findings.map((f) => f.kind)).toEqual(["review_rejected", "time"]);
    expect(diagnosis.recoverable).toBe(false);

    const open = {
      ...goal,
      changeSets: [{ ...goal.changeSets[0]!, status: "in_review" as const }],
    };
    expect(diagnoseGoalFailure(open, { now: Date.parse(late) }).openChangeSets).toEqual([
      { id: "cs-a", taskId: "a", status: "in_review" },
    ]);
  });

  test("a cancelled task reads its last run: its failure, interrupted, or never run", () => {
    const failedThenCancelled = build([
      ...planned,
      ...failRun("a", 1, "Turn timed out after 60 minutes"),
      { type: "task.retried", taskId: "a" },
      { type: "task.cancelled", taskId: "a" },
      { type: "goal.failed", reason: "x" },
    ]);
    expect(diagnoseGoalFailure(failedThenCancelled, { now: NOW }).tasks[0]).toMatchObject({
      taskId: "a",
      status: "cancelled",
      cause: "timeout",
    });
    const neverRan = build([
      ...planned,
      { type: "task.cancelled", taskId: "a" },
      { type: "goal.failed", reason: "x" },
    ]);
    expect(diagnoseGoalFailure(neverRan, { now: NOW }).tasks[0]).toMatchObject({
      taskId: "a",
      cause: "cancelled",
      interruptedRuns: 0,
    });
  });

  test("a time limit passed now has no minutes used unless the time the goal ran is known", () => {
    const goal = failedOn("exit 1");
    const later = NOW + 2 * 3_600_000;
    expect(diagnoseGoalFailure(goal, { now: later }).blockingLimits).toEqual([
      { limit: "goalTimeoutMinutes", current: 60 },
    ]);
    expect(diagnoseGoalFailure(goal, { now: later, activeMs: 10 * 60_000 }).blockingLimits).toEqual(
      [{ limit: "goalTimeoutMinutes", current: 60, used: 10 }],
    );
  });

  test("a time mode the person chose resolves a passed time limit, unless remaining leaves nothing", () => {
    const timedOut = build([
      ...planned,
      {
        type: "goal.failed",
        reason: "Time limit of 60 minutes reached",
        at: "2026-01-01T01:00:00.000Z",
      },
    ]);
    const later = NOW + 2 * 3_600_000;
    const fresh = diagnoseGoalFailure(timedOut, { now: later, timeMode: "fresh" });
    expect(fresh.blockingLimits).toEqual([]);
    expect(fresh.findings[0]).toMatchObject({
      kind: "time",
      personNeeded: "no",
      remedy: expect.stringContaining("Resolved by the person's time mode fresh"),
    });
    const remaining = { now: later, timeMode: "remaining", activeMs: 30 * 60_000 };
    expect(diagnoseGoalFailure(timedOut, remaining).blockingLimits).toEqual([]);
    const nothingLeft = { now: later, timeMode: "remaining", activeMs: 60 * 60_000 };
    expect(diagnoseGoalFailure(timedOut, nothingLeft).blockingLimits).toEqual([
      { limit: "goalTimeoutMinutes", current: 60, used: 60, minimum: 61 },
    ]);
  });

  test("failedAt says whether time had passed at failure; without it, past the limit now", () => {
    const goal = failedOn("exit 1");
    const later = NOW + 2 * 3_600_000;
    expect(diagnoseGoalFailure(goal, { now: later })).toMatchObject({
      failedAt: AT,
      timePassedAtFailure: false,
      timePassedNow: true,
    });
    // A goal from a daemon without goalRecovery has no failedAt.
    const { failedAt: _failedAt, ...older } = goal;
    expect(diagnoseGoalFailure(older, { now: later })).toMatchObject({
      failedAt: null,
      timePassedAtFailure: null,
      timePassedNow: true,
    });
    const timedOut = { ...older, failureReason: "Time limit of 60 minutes reached" };
    expect(diagnoseGoalFailure(timedOut, { now: later })).toMatchObject({
      kind: "time",
      timePassedAtFailure: true,
    });
    const deadline = { ...older, failureReason: "Deadline 2026-01-01T00:30:00.000Z reached" };
    expect(diagnoseGoalFailure(deadline, { now: later }).timePassedAtFailure).toBe(true);
  });

  test("budget, run limit and their minimum new values", () => {
    const base = failedOn("exit 1");
    const spent: Goal = {
      ...base,
      config: { ...base.config!, limits: { maxTotalTokens: 1000, maxCostUsd: 1, maxRuns: 1 } },
      usage: {
        inputTokens: 900,
        cachedInputTokens: 0,
        outputTokens: 200,
        totalTokens: 1100,
        costUsd: 1.5,
        reportedTurns: 1,
        totalTurns: 1,
      },
    };
    const diagnosis = diagnoseGoalFailure(spent, { now: NOW });
    expect(diagnosis.findings.map((f) => f.kind)).toEqual(["budget", "run_limit", "stuck"]);
    expect(diagnosis.blockingLimits).toEqual([
      // One run used; a and b remain with 2 attempts each.
      { limit: "maxRuns", current: 1, used: 1, minimum: 5 },
      expect.objectContaining({
        limit: "maxTotalTokens",
        current: 1000,
        used: 1100,
        minimum: 1101,
      }),
      expect.objectContaining({ limit: "maxCostUsd", current: 1, used: 1.5, minimum: 1.51 }),
    ]);
  });

  test("remaining time that leaves nothing names the smallest limit, up to the 7-day cap", () => {
    const goal = failedOn("exit 1");
    const later = NOW + 3 * 3_600_000;
    const limits = diagnoseGoalFailure(goal, { now: later, activeMs: 90 * 60_000 }).blockingLimits;
    expect(limits).toEqual([{ limit: "goalTimeoutMinutes", current: 60, used: 90, minimum: 91 }]);
    const week = 10_080 * 60_000;
    const capped = diagnoseGoalFailure(goal, { now: NOW + 2 * week, activeMs: week });
    expect(capped.blockingLimits[0]).toMatchObject({
      limit: "goalTimeoutMinutes",
      note: expect.stringContaining("7 days"),
    });
    expect(capped.blockingLimits[0]).not.toHaveProperty("minimum");
  });

  test("a passed deadline blocks on its own", () => {
    const base = failedOn("exit 1");
    const goal: Goal = {
      ...base,
      config: { ...base.config!, limits: { deadlineAt: "2026-01-01T00:10:00.000Z" } },
    };
    expect(diagnoseGoalFailure(goal, { now: NOW + 20 * 60_000 }).blockingLimits).toEqual([
      expect.objectContaining({ limit: "deadlineAt", current: "2026-01-01T00:10:00.000Z" }),
    ]);
  });

  test("a merge that failed, verification, capture and a failed restart", () => {
    const base = failedOn("exit 1");
    const integration: Goal = {
      ...base,
      changeSets: [
        {
          ...changeSet("cs-a", "a"),
          status: "rejected",
          rejectionReason: "integration_failed",
        },
      ],
    };
    expect(diagnoseGoalFailure(integration, { now: NOW }).kind).toBe("integration_failed");

    const verified: Goal = {
      ...base,
      tasks: [
        { ...base.tasks[0]!, status: "succeeded" as const },
        { ...base.tasks[1]!, status: "succeeded" as const },
      ],
    };
    expect(diagnoseGoalFailure(verified, { now: NOW }).kind).toBe("verification");

    const capture = {
      ...verified,
      criteria: [],
      failureReason: "Could not capture changes of a: x",
    };
    expect(diagnoseGoalFailure(capture, { now: NOW }).kind).toBe("capture");
    const restart = { ...verified, criteria: [], failureReason: "Recovery failed: x" };
    expect(diagnoseGoalFailure(restart, { now: NOW }).kind).toBe("recovery_failed");
    const unknown = { ...verified, criteria: [], failureReason: "something else" };
    expect(diagnoseGoalFailure(unknown, { now: NOW }).kind).toBe("unknown");
  });

  test("a recovery that ended without applying leaves the reason it started from", () => {
    const base = failedOn("exit 1", "Could not capture changes of a: x");
    const ended = "2026-10-27T12:00:00.000Z";
    const goal: Goal = {
      ...base,
      failureReason: "Recovery needs a person: raise maxRuns",
      // Ending the recovery is the goal's latest failure.
      failedAt: ended,
      recovery: {
        id: "r1",
        status: "ended",
        outcome: "needs_person",
        startedAt: AT,
        startedBy: "person",
        failureReason: "Could not capture changes of a: x",
        resolvedAt: ended,
      },
    };
    const diagnosis = diagnoseGoalFailure(goal, { now: NOW });
    expect(diagnosis.failureReason).toBe("Could not capture changes of a: x");
    expect(diagnosis.findings.map((f) => f.kind)).toEqual(["stuck", "capture"]);
    // A retry since then failed on its own: the recovery's copy is stale.
    const failedAgain = {
      ...goal,
      failureReason: "No task can make progress. Failed or blocked: a",
      failedAt: "2026-10-27T13:00:00.000Z",
    };
    expect(diagnoseGoalFailure(failedAgain, { now: NOW }).failureReason).toBe(
      "No task can make progress. Failed or blocked: a",
    );
  });

  test("a recovery that ended after the deadline keeps the time the goal failed", () => {
    // The goal failed stuck at minute 10 of a 60-minute limit; the Lead answered needs_person
    // at minute 70, which rewrote the goal's reason and failure time.
    const ended = build([
      ...planned,
      ...failRun("a", 1, "Agent asked a question: which?"),
      { type: "goal.failed", reason: "No task can make progress", at: "2026-01-01T00:10:00.000Z" },
      {
        type: "recovery.started",
        recoveryId: "r1",
        startedBy: "person",
        at: "2026-01-01T00:30:00.000Z",
      },
      { type: "lead.attached", agentId: "lead-r1", at: "2026-01-01T00:30:00.000Z" },
      {
        type: "intervention.requested",
        interventionId: "recovery-r1",
        trigger: "recovery",
        error: "",
        at: "2026-01-01T00:30:00.000Z",
      },
      {
        type: "recovery.decided",
        recoveryId: "r1",
        decision: { decision: "needs_person", reason: "answer the question" },
        at: "2026-01-01T01:10:00.000Z",
      },
    ]);
    expect(ended.failedAt).toBe("2026-01-01T01:10:00.000Z");
    const diagnosis = diagnoseGoalFailure(ended, { now: NOW + 80 * 60_000 });
    expect(diagnosis).toMatchObject({
      kind: "stuck",
      failedAt: "2026-01-01T00:10:00.000Z",
      timePassedAtFailure: false,
      timePassedNow: true,
      failureReason: "No task can make progress",
    });
  });
});

function changeSet(id: string, taskId: string) {
  return {
    id,
    taskId,
    runId: `${taskId}-a1`,
    round: 0,
    supersedes: null,
    workspaceId: "w",
    cwd: "/w",
    branch: "b",
    baseCommit: "base",
    headCommit: "head",
    files: [],
    status: "captured" as const,
    findings: null,
    testSummary: null,
    integratedCommit: null,
    error: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function captured(changeSetId: string, taskId: string, runId: string) {
  return [
    {
      type: "changeset.captured",
      changeSetId,
      taskId,
      runId,
      round: 0,
      supersedes: null,
      workspaceId: "w",
      cwd: "/w",
      branch: "b",
      baseCommit: "base",
      headCommit: "head",
      files: [],
    },
  ];
}
