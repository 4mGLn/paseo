import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { Goal, GoalConfig, GoalEvent, TaskSpec } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import {
  MAX_PLAN_REJECTIONS,
  MAX_USAGE_BREAKDOWN_ENTRIES,
  applyGoalEvent,
} from "./goal-reducer.js";
import { CONFIG, createGoalTestEnv, task, type GoalTestEnv } from "./goal-test-env.js";

const AT = "2026-01-01T00:00:00.000Z";

function spec(id: string, dependsOn: string[] = []): TaskSpec {
  return { id, title: id, description: "", kind: "implement", dependsOn };
}

let counter = 0;
function ev(goal: Goal | null, partial: Record<string, unknown>, at = AT): GoalEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    goalId: "g1",
    seq: (goal?.lastSeq ?? 0) + 1,
    at,
    ...partial,
  } as GoalEvent;
}

function run(events: Record<string, unknown>[], start: Goal | null = null): Goal {
  let goal = start;
  for (const partial of events) goal = applyGoalEvent(goal, ev(goal, partial));
  if (!goal) throw new Error("no events");
  return goal;
}

const managed = (config: Partial<GoalConfig> = {}) => ({
  type: "goal.created",
  title: "T",
  objective: "O",
  criteria: [{ id: "c1", text: "works" }],
  config: { ...CONFIG, ...config },
});

const proposed = { type: "plan.proposed", tasks: [spec("a"), spec("b", ["a"])] };

/** A goal whose task a failed for good, which failed the goal. */
function failedGoal(config: Partial<GoalConfig> = {}): Goal {
  return run([
    managed(config),
    proposed,
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
    { type: "run.finished", runId: "a-a1", outcome: "failed", error: "boom" },
    { type: "task.failed", taskId: "a", error: "boom" },
    { type: "goal.failed", reason: "No task can make progress. Failed or blocked: a, b" },
  ]);
}

describe("goal control events in the reducer", () => {
  test("a rejected plan is kept with its feedback and planning starts over", () => {
    const goal = run([managed(), proposed, { type: "plan.rejected", reason: "split a" }]);
    expect(goal.status).toBe("planning");
    expect(goal.tasks).toEqual([]);
    expect(goal.planRejections).toEqual([
      { reason: "split a", tasks: [spec("a"), spec("b", ["a"])], at: AT },
    ]);
  });

  test("a plan can be rejected only a bounded number of times", () => {
    const rounds = Array.from({ length: MAX_PLAN_REJECTIONS }, () => [
      proposed,
      { type: "plan.rejected", reason: "" },
    ]).flat();
    const goal = run([managed(), ...rounds, proposed]);
    expect(goal.planRejections).toHaveLength(MAX_PLAN_REJECTIONS);
    expect(() => applyGoalEvent(goal, ev(goal, { type: "plan.rejected", reason: "" }))).toThrow(
      /limit is 5/,
    );
  });

  test("pause and resume toggle pausedAt and refuse to repeat", () => {
    const paused = run([managed(), { type: "goal.paused" }]);
    expect(paused.pausedAt).toBe(AT);
    expect(() => applyGoalEvent(paused, ev(paused, { type: "goal.paused" }))).toThrow(
      /already paused/,
    );
    const resumed = run([{ type: "goal.resumed" }], paused);
    expect(resumed.pausedAt).toBeNull();
    expect(() => applyGoalEvent(resumed, ev(resumed, { type: "goal.resumed" }))).toThrow(
      /not paused/,
    );
  });

  test("an ended goal cannot be paused", () => {
    const cancelled = run([managed(), { type: "goal.cancelled" }]);
    expect(() => applyGoalEvent(cancelled, ev(cancelled, { type: "goal.paused" }))).toThrow(
      /goal is cancelled/,
    );
  });

  test("retrying a failed goal reopens it and forgives the earlier failures", () => {
    const goal = run([{ type: "goal.retried", taskIds: ["a"], reopen: true }], failedGoal());
    expect(goal.status).toBe("executing");
    expect(goal.failureReason).toBeNull();
    expect(goal.reopens).toBe(1);
    expect(goal.tasks[0]).toMatchObject({ status: "pending", error: null, forgivenFailures: 1 });
  });

  test("reopening must name every failed task and must say it reopens", () => {
    const failed = failedGoal();
    expect(() =>
      applyGoalEvent(failed, ev(failed, { type: "goal.retried", taskIds: ["a"], reopen: false })),
    ).toThrow(/must reopen/);
    expect(() =>
      applyGoalEvent(failed, ev(failed, { type: "goal.retried", taskIds: ["b"], reopen: true })),
    ).toThrow(/task b is pending/);
  });

  test("a failed goal past its run limit or time limit is not reopened", () => {
    const limited = failedGoal({ limits: { maxRuns: 1 } });
    expect(() =>
      applyGoalEvent(limited, ev(limited, { type: "goal.retried", taskIds: ["a"], reopen: true })),
    ).toThrow(/run limit of 1/);
    const late = failedGoal({ limits: { goalTimeoutMinutes: 1 } });
    expect(() =>
      applyGoalEvent(
        late,
        ev(
          late,
          { type: "goal.retried", taskIds: ["a"], reopen: true },
          "2026-01-01T00:01:00.000Z",
        ),
      ),
    ).toThrow(/time limit/);
  });

  test("a failed goal with a rejected change set is not reopened", () => {
    const goal = run([
      managed(),
      { type: "plan.proposed", tasks: [spec("a"), spec("b")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "task.succeeded", taskId: "a" },
      { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
      {
        type: "changeset.captured",
        changeSetId: "cs1",
        taskId: "a",
        runId: "a-a1",
        round: 0,
        supersedes: null,
        workspaceId: "w",
        cwd: "/w",
        branch: "b",
        baseCommit: "x",
        headCommit: "y",
        files: [],
      },
      { type: "changeset.transitioned", changeSetId: "cs1", to: "in_review" },
      { type: "changeset.transitioned", changeSetId: "cs1", to: "rejected" },
      { type: "task.started", taskId: "b" },
      { type: "task.failed", taskId: "b", error: "boom" },
      { type: "goal.failed", reason: "x" },
    ]);
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "goal.retried", taskIds: ["b"], reopen: true })),
    ).toThrow(/cs1 was rejected/);
  });

  test("a manual goal has nothing to retry", () => {
    const goal = run([
      { ...managed(), config: undefined },
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
    ]);
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "goal.retried", taskIds: ["a"], reopen: false })),
    ).toThrow(/manual goal/);
  });

  test("usage adds up per goal and per run, and counts turns without usage", () => {
    const goal = run([
      managed(),
      { type: "usage.recorded", role: "lead", agentId: "lead", usage: { inputTokens: 10 } },
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      {
        type: "usage.recorded",
        role: "worker",
        agentId: "w1",
        runId: "a-a1",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20, costUsd: 0.5 },
      },
      { type: "usage.recorded", role: "reviewer", agentId: "r1" },
    ]);
    expect(goal.usage).toEqual({
      inputTokens: 110,
      cachedInputTokens: 40,
      outputTokens: 20,
      totalTokens: 130,
      costUsd: 0.5,
      reportedTurns: 2,
      totalTurns: 3,
      costReportedTurns: 1,
      tokenReportedTurns: 2,
    });
    expect(goal.runs[0]?.usage).toMatchObject({ totalTokens: 120, reportedTurns: 1 });
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "usage.recorded", role: "worker", agentId: "w" })),
    ).toThrow(/names its run/);
  });

  test("usage is broken down per role and per agent, naming each agent's provider", () => {
    const goal = run([
      managed({
        leadProvider: "claude/claude-opus-5-5",
        reviewProvider: "claude/claude-sonnet-5-5",
        leadThinking: "medium",
      }),
      { type: "usage.recorded", role: "lead", agentId: "lead", usage: { costUsd: 0.5 } },
      { type: "usage.recorded", role: "lead", agentId: "lead", usage: { inputTokens: 10 } },
      proposed,
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex/gpt-6-luna" },
      {
        type: "run.attached",
        runId: "a-a1",
        agentId: "w1",
        workspaceId: "ws",
        thinking: "max",
      },
      {
        type: "usage.recorded",
        role: "worker",
        agentId: "w1",
        runId: "a-a1",
        usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 },
      },
      { type: "usage.recorded", role: "verifier", agentId: "v1", thinking: "high" },
    ]);
    expect(goal.usageByRole?.lead).toMatchObject({
      inputTokens: 10,
      costUsd: 0.5,
      totalTurns: 2,
      costReportedTurns: 1,
      tokenReportedTurns: 1,
    });
    expect(goal.usageByRole?.worker).toMatchObject({ totalTokens: 120, costReportedTurns: 0 });
    expect(goal.usageByRole?.verifier).toMatchObject({ totalTurns: 1, reportedTurns: 0 });
    expect(goal.usageByRole?.reviewer).toBeUndefined();
    // One entry per agent, most recently active last.
    expect(goal.usageBreakdown).toEqual([
      expect.objectContaining({
        agentId: "lead",
        role: "lead",
        provider: "claude",
        model: "claude-opus-5-5",
        thinking: "medium",
        usage: expect.objectContaining({ totalTurns: 2, inputTokens: 10, costUsd: 0.5 }),
      }),
      expect.objectContaining({
        agentId: "w1",
        role: "worker",
        taskId: "a",
        runId: "a-a1",
        provider: "codex",
        model: "gpt-6-luna",
        thinking: "max",
        usage: expect.objectContaining({ cachedInputTokens: 40, totalTurns: 1 }),
      }),
      expect.objectContaining({
        agentId: "v1",
        role: "verifier",
        provider: "claude",
        model: "claude-sonnet-5-5",
        thinking: "high",
      }),
    ]);
    expect(goal.usageBreakdownTruncated).toBeUndefined();
  });

  test("the breakdown keeps the most recently active agents and counts the ones dropped", () => {
    const turns = Array.from({ length: MAX_USAGE_BREAKDOWN_ENTRIES + 2 }, (_, i) => ({
      type: "usage.recorded",
      role: "reviewer",
      agentId: `r${i}`,
      usage: { outputTokens: 1 },
    }));
    const goal = run([
      managed(),
      ...turns,
      { type: "usage.recorded", role: "reviewer", agentId: "r0", usage: { outputTokens: 1 } },
    ]);
    expect(goal.usageBreakdown).toHaveLength(MAX_USAGE_BREAKDOWN_ENTRIES);
    // r0 and r1 were dropped; r0 came back with only its later turn.
    expect(goal.usageBreakdownTruncated).toBe(3);
    expect(goal.usageBreakdown?.at(-1)).toMatchObject({ agentId: "r0", usage: { totalTurns: 1 } });
    expect(goal.usageBreakdown?.some((e) => e.agentId === "r1")).toBe(false);
    expect(goal.usage).toMatchObject({ outputTokens: MAX_USAGE_BREAKDOWN_ENTRIES + 3 });
  });

  test("a goal over its token budget is not reopened", () => {
    const goal = run([
      managed({ limits: { maxTotalTokens: 1000 } }),
      proposed,
      { type: "plan.approved" },
      { type: "usage.recorded", role: "lead", agentId: "l", usage: { inputTokens: 1000 } },
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "goal.failed", reason: "Token budget of 1000 reached (1000 reported)" },
    ]);
    expect(() =>
      applyGoalEvent(goal, ev(goal, { type: "goal.retried", taskIds: ["a"], reopen: true })),
    ).toThrow(/Token budget of 1000 reached/);
  });
});

describe("goal controls in the Manager", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a rejected plan goes to a fresh Lead with the feedback and the rejected plan", async () => {
    const prompts: string[] = [];
    let plans = 0;
    env.harness.respond = (turn) => {
      if (turn.prompt.includes("You are the Lead")) {
        prompts.push(turn.prompt);
        plans += 1;
        const tasks = plans === 1 ? [task("big")] : [task("small1"), task("small2")];
        return { outcome: "completed", text: `\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\`` };
      }
      return { outcome: "completed", text: "done" };
    };
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, autoApprovePlan: false });
    await env.settle(manager);
    const firstLead = env.goalOf(store).leadAgentId;

    await service.rejectPlan("g1", "Split it in two", "reject-1");
    // A resend with the same eventId changes nothing.
    await service.rejectPlan("g1", "Split it in two", "reject-1");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("awaiting_plan_approval");
    expect(goal.tasks.map((t) => t.id)).toEqual(["small1", "small2"]);
    expect(goal.planRejections).toHaveLength(1);
    expect(goal.leadAgentId).not.toBe(firstLead);
    expect(env.harness.canceled).toContain(firstLead);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Split it in two");
    expect(prompts[1]).toContain('"id": "big"');
  });

  test("a paused goal starts no runs, lets running ones finish, and resumes", async () => {
    env.script([task("a"), task("b", { dependsOn: ["a"] })], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store);
    await tick();
    expect(env.harness.turns).toHaveLength(1);

    await service.pause("g1");
    env.harness.turns[0]?.resolve({ outcome: "completed", text: "a done" });
    await env.settle(manager);
    const paused = env.goalOf(store);
    expect(paused.tasks.map((t) => t.status)).toEqual(["succeeded", "pending"]);
    // a's change was reviewed and merged; b did not start.
    expect(paused.changeSets.map((c) => c.status)).toEqual(["integrated"]);
    expect(env.harness.agents.filter((a) => a.labels["paseo.goal-task"] === "b")).toHaveLength(0);

    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    await service.resume("g1");
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("a goal paused before a restart stays paused after it", async () => {
    env.script([task("a")], () => "hold");
    const first = await env.boot();
    await env.createGoal(first.store);
    await tick();
    await first.service.pause("g1");
    first.manager.stop();

    env.script([task("a")]);
    const second = await env.boot();
    await env.settle(second.manager);
    const goal = env.goalOf(second.store);
    // The interrupted run is closed out and its task waits to run again.
    expect(goal.status).toBe("executing");
    expect(goal.pausedAt).toBeTruthy();
    expect(goal.runs.map((r) => r.status)).toEqual(["interrupted"]);
    expect(goal.tasks[0]?.status).toBe("pending");

    await second.service.resume("g1");
    await env.settle(second.manager);
    expect(env.goalOf(second.store).status).toBe("completed");
  });

  test("retrying a failed goal reopens it, grants fresh attempts and finishes", async () => {
    let failing = true;
    env.script([task("a"), task("b", { dependsOn: ["a"] })], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const config = { ...CONFIG, originAgentId: "chat-1" };
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, config);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("failed");

    failing = false;
    // Naming b, which is pending, is refused; naming nothing retries every failed task.
    await expect(service.retry("g1", "b")).rejects.toThrow(/b is pending/);
    await service.retry("g1", undefined, "retry-1");
    await service.retry("g1", undefined, "retry-1");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.reopens).toBe(1);
    expect(goal.tasks[0]).toMatchObject({ status: "succeeded", forgivenFailures: 2 });
    // The chat hears about both endings.
    const toChat = env.harness.notified.filter((n) => n.agentId === "chat-1").map((n) => n.text);
    expect(toChat).toHaveLength(2);
    expect(toChat[0]).toMatch(/failed/);
    expect(toChat[1]).toMatch(/completed/);
  });

  test("a goal reopened just before a restart finishes after it", async () => {
    let failing = true;
    env.script([task("a")], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const first = await env.boot();
    await env.createGoal(first.store);
    await env.settle(first.manager);
    first.manager.stop();
    // Written by hand, as if the daemon stopped right after recording it.
    await first.store.dispatch("g1", {
      id: "retry",
      goalId: "g1",
      type: "goal.retried",
      taskIds: ["a"],
      reopen: true,
    });

    failing = false;
    const second = await env.boot();
    await env.settle(second.manager);
    expect(env.goalOf(second.store).status).toBe("completed");
  });

  test("a goal that reports more tokens than its budget fails", async () => {
    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    const respond = env.harness.respond;
    env.harness.respond = (turn) => {
      const result = respond?.(turn) ?? "hold";
      if (result === "hold") return result;
      return { ...result, usage: { inputTokens: 600, outputTokens: 100, costUsd: 0.01 } };
    };
    const { store, manager } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      limits: { retryBackoffSeconds: 0, maxTotalTokens: 2000 },
    });
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toBe("Token budget of 2000 reached (2100 reported)");
    expect(goal.usage).toMatchObject({ totalTokens: 2100, reportedTurns: 3, totalTurns: 3 });
    // Lead, worker a, reviewer of a; b never started.
    expect(env.harness.agents.filter((a) => a.labels["paseo.goal-task"] === "b")).toHaveLength(0);
  });

  test("turns whose provider reports nothing count as unreported", async () => {
    env.script([task("a")]);
    const { store, manager } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);
    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    // Lead, worker, reviewer, verifier.
    expect(goal.usage).toMatchObject({ reportedTurns: 0, totalTurns: 4, totalTokens: 0 });
    expect(goal.runs[0]?.usage).toMatchObject({ reportedTurns: 0, totalTurns: 1 });
    const events = await new GoalEventLog({ dir: env.logDir() }).read("g1");
    expect(events.filter((e) => e.type === "usage.recorded").map((e) => e.role)).toEqual([
      "lead",
      "worker",
      "reviewer",
      "verifier",
    ]);
  });

  test("the integration branch and verifier follow the goal's settings", async () => {
    env.script([task("a")]);
    const { store, manager } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      branchPrefix: "goals/team-a",
      verifyProvider: "opencode",
    });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    expect(env.harness.workspaces.map((w) => w.branchName).filter(Boolean)).toEqual([
      "goals/team-a/g1",
    ]);
    const verifier = env.harness.agents.find((a) => a.labels["paseo.goal-role"] === "verifier");
    expect(verifier?.provider).toBe("opencode");
  });
});

describe("config edits and reopening a planning failure in the reducer", () => {
  test("a config update replaces the settings, even after the goal failed", () => {
    const goal = failedGoal();
    const next = { ...CONFIG, maxAttempts: 3, onPermissionRequest: "wait" as const };
    const updated = run([{ type: "goal.config_updated", config: next }], goal);
    expect(updated.config).toEqual(next);
    expect(updated.status).toBe("failed");
  });

  test("providers, the repository and the other fixed fields cannot change", () => {
    const goal = run([managed()]);
    for (const change of [
      { defaultProvider: "claude" },
      { cwd: "/elsewhere" },
      { leadThinking: "high" },
      { allowedProviders: ["codex"] },
    ]) {
      expect(() =>
        run([{ type: "goal.config_updated", config: { ...CONFIG, ...change } }], goal),
      ).toThrow(/cannot be changed after creation/);
    }
  });

  test("a manual or archived goal's settings cannot change", () => {
    const manual = run([{ type: "goal.created", title: "T", objective: "", criteria: [] }]);
    expect(() => run([{ type: "goal.config_updated", config: CONFIG }], manual)).toThrow(
      /manual goal/,
    );
    const archived = run([{ type: "goal.archived" }], failedGoal());
    expect(() => run([{ type: "goal.config_updated", config: CONFIG }], archived)).toThrow(
      /archived/,
    );
  });

  test("a goal that failed while planning reopens to planning", () => {
    const failed = run([
      managed(),
      { type: "goal.failed", reason: "Lead agent did not finish planning (needs_permission)." },
      { type: "goal.acknowledged" },
    ]);
    const reopened = run([{ type: "goal.reopened" }], failed);
    expect(reopened).toMatchObject({
      status: "planning",
      failureReason: null,
      reopens: 1,
      acknowledgedAt: null,
    });
    // Only a failed goal without tasks, within its limits.
    expect(() => run([{ type: "goal.reopened" }], reopened)).toThrow(/goal is planning/);
    expect(() => run([{ type: "goal.reopened" }], failedGoal())).toThrow(/retry its tasks/);
    const late = run([
      managed({ limits: { goalTimeoutMinutes: 1 } }),
      { type: "goal.failed", reason: "x" },
    ]);
    expect(() =>
      applyGoalEvent(late, ev(late, { type: "goal.reopened" }, "2026-01-01T00:05:00.000Z")),
    ).toThrow(/time limit has passed/);
  });
});

describe("config edits and reopening in the Manager", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

  test("a goal whose Lead stopped for a permission is reopened by retry with a fresh Lead", async () => {
    let leadTurns = 0;
    env.script([task("a")]);
    const scripted = env.harness.respond;
    env.harness.respond = (turn) => {
      if (turn.prompt.includes("You are the Lead")) {
        leadTurns += 1;
        if (leadTurns === 1) return { outcome: "needs_permission" };
      }
      return scripted?.(turn) ?? "hold";
    };
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, onPermissionRequest: "fail" });
    await env.settle(manager);
    const failed = env.goalOf(store);
    expect(failed.status).toBe("failed");
    expect(failed.failureReason).toMatch(/did not finish planning \(needs_permission\)/);
    const firstLead = failed.leadAgentId;

    // Change the policy, then reopen; a resend with the same eventId does nothing more.
    await service.updateConfig("g1", { onPermissionRequest: "wait" });
    await expect(service.retry("g1", "a")).rejects.toThrow(/not found/);
    await service.retry("g1", undefined, "reopen-1");
    await service.retry("g1", undefined, "reopen-1");
    await env.settle(manager);

    const goal = env.goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.reopens).toBe(1);
    expect(goal.leadAgentId).not.toBe(firstLead);
    const leads = env.harness.agents.filter((a) => a.labels["paseo.goal-role"] === "lead");
    expect(leads.map((a) => a.permission)).toEqual(["fail", "wait"]);
    const events = await env.readEvents();
    expect(events.filter((e) => e.type === "goal.reopened")).toHaveLength(1);
    // The first Lead stays in the history.
    expect(events.filter((e) => e.type === "lead.attached")).toHaveLength(2);
  });

  test("a live goal picks up new settings: more parallel runs and the next turn's policy", async () => {
    const seen: (string | undefined)[] = [];
    const runTurn = env.harness.agentPort.runTurn;
    env.harness.agentPort.runTurn = (agentId, prompt, options) => {
      const permission = options?.permission;
      seen.push(typeof permission === "function" ? permission() : permission);
      return runTurn(agentId, prompt, options);
    };
    env.script([task("a"), task("b"), task("c")], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, maxParallel: 1, onPermissionRequest: "fail" });
    await tick();
    expect(env.harness.turns).toHaveLength(1);

    await service.updateConfig("g1", { maxParallel: 3, onPermissionRequest: "auto" });
    await tick();
    expect(env.harness.turns).toHaveLength(3);
    // The Lead and the first worker ran under fail; the turns after the change wait.
    expect(seen).toEqual(["fail", "fail", "wait", "wait"]);
    const workers = env.harness.agents.filter((a) => a.labels["paseo.goal-task"]);
    expect(workers.map((a) => a.permission)).toEqual(["fail", "auto", "auto"]);

    env.script([task("a"), task("b"), task("c")]);
    for (const turn of env.harness.turns) turn.resolve({ outcome: "completed", text: "ok" });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("a policy change switches the goal's running agents; one that cannot switch does not fail the edit", async () => {
    env.script([task("a"), task("b")], () => "hold");
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, { ...CONFIG, onPermissionRequest: "wait" });
    await tick();
    const lead = env.goalOf(store).leadAgentId;
    const workers = env.harness.agents
      .filter((a) => a.labels["paseo.goal-task"])
      .map((a) => a.agentId);
    expect(workers).toHaveLength(2);

    // Another setting leaves the agents' modes alone.
    await service.updateConfig("g1", { maxParallel: 3 });
    await tick();
    expect(env.harness.modeSwitches).toEqual([]);

    env.harness.failModeSwitch.add(workers[0] as string);
    const updated = await service.updateConfig("g1", { onPermissionRequest: "fail" });
    expect(updated.config?.onPermissionRequest).toBe("fail");
    await tick();
    expect(env.harness.modeSwitches).toEqual(
      expect.arrayContaining(
        [lead, ...workers].map((agentId) => ({ agentId, permission: "fail" })),
      ),
    );
    expect(env.harness.modeSwitches).toHaveLength(3);

    for (const turn of env.harness.turns) turn.resolve({ outcome: "completed", text: "ok" });
    env.script([task("a"), task("b")]);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    // An ended goal's agents are left alone.
    await service.updateConfig("g1", { onPermissionRequest: "wait" });
    await tick();
    expect(env.harness.modeSwitches).toHaveLength(3);
  });

  test("a goal that used up its runs can be given more and retried", async () => {
    let failing = true;
    env.script([task("a"), task("b", { dependsOn: ["a"] })], () =>
      failing ? { outcome: "failed", error: "flaky" } : { outcome: "completed", text: "ok" },
    );
    const { store, manager, service } = await env.boot();
    await env.createGoal(store, {
      ...CONFIG,
      maxAttempts: 1,
      limits: { maxRuns: 1, retryBackoffSeconds: 0 },
    });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("failed");
    await expect(service.retry("g1", undefined)).rejects.toThrow(/run limit of 1 is used up/);

    failing = false;
    await service.updateConfig("g1", { limits: { maxRuns: 10 } }, "more-runs");
    await service.retry("g1", undefined);
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
  });

  test("the service records the wait default, checks changes and ignores a repeat", async () => {
    const { store, service } = await env.boot();
    env.script([task("a")], () => "hold");
    expect(CONFIG.onPermissionRequest).toBeUndefined();
    const created = await service.create({
      goalId: "g2",
      title: "T",
      objective: "O",
      criteria: ["works"],
      config: CONFIG,
    });
    expect(created.config?.onPermissionRequest).toBe("wait");

    const before = env.goalOf(store, "g2").lastSeq;
    // The current settings again, or no changes, record nothing.
    await service.updateConfig("g2", { onPermissionRequest: "wait", maxParallel: 2 });
    await service.updateConfig("g2", {});
    expect(env.goalOf(store, "g2").lastSeq).toBe(before);

    // A cleared optional setting falls back to its default; a cleared last limit drops limits.
    const updated = await service.updateConfig("g2", {
      testCommand: "npm test",
      limits: { retryBackoffSeconds: null, maxCostUsd: 5 },
    });
    expect(updated.config?.limits).toEqual({ maxCostUsd: 5 });
    expect(updated.config?.testCommand).toBe("npm test");
    const cleared = await service.updateConfig("g2", {
      testCommand: null,
      limits: { maxCostUsd: null },
    });
    expect(cleared.config?.testCommand).toBeUndefined();
    expect(cleared.config?.limits).toBeUndefined();

    await expect(service.updateConfig("g2", { maxParallel: 99 })).rejects.toThrow(
      /Invalid goal settings/,
    );
    const manual = await service.create({ goalId: "m", title: "M", objective: "", criteria: [] });
    await expect(service.updateConfig(manual.id, { maxParallel: 3 })).rejects.toThrow(/manual/);
  });
});
