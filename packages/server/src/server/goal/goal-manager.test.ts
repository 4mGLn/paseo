import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import {
  CONFIG,
  createGoalTestEnv,
  planBlock,
  task,
  type GoalTestEnv,
  type Harness,
} from "./goal-test-env.js";
import { extractPlan, PlanParseError } from "./plan-extract.js";
import type { GoalManager } from "./goal-manager.js";
import type { GoalStore } from "./goal-store.js";

describe("GoalManager", () => {
  let env: GoalTestEnv;
  let harness: Harness;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
    harness = env.harness;
  });
  afterEach(() => env.cleanup());

  const boot = (maxConcurrentRuns?: number) => env.boot(maxConcurrentRuns);
  const createGoal = (store: GoalStore, config?: GoalConfig | null, goalId?: string) =>
    env.createGoal(store, config, goalId);
  const script = (...args: Parameters<GoalTestEnv["script"]>) => env.script(...args);
  const goalOf = (...args: Parameters<GoalTestEnv["goalOf"]>) => env.goalOf(...args);
  const settle = (manager: GoalManager) => env.settle(manager);

  test("plans with the Lead, runs tasks in dependency order and passes results downstream", async () => {
    script(
      [task("a"), task("b", { dependsOn: ["a"], provider: "claude-review", kind: "review" })],
      (turn) => ({
        outcome: "completed",
        text: /Your task \(\w+\): Task a/.test(turn.prompt) ? "A is built" : "B reviewed",
      }),
    );
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);

    const goal = goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.leadAgentId).toBe("agent-2");
    expect(goal.tasks.map((t) => [t.id, t.status, t.summary])).toEqual([
      ["a", "succeeded", "A is built"],
      ["b", "succeeded", "B reviewed"],
    ]);
    expect(goal.runs.map((r) => [r.id, r.provider, r.status])).toEqual([
      ["a-a1", "codex", "succeeded"],
      ["b-a1", "claude-review", "succeeded"],
    ]);
    // b only starts after a, and its prompt carries a's report.
    const bPrompt = harness.agents.findIndex((a) => a.labels["paseo.goal-task"] === "b");
    expect(bPrompt).toBeGreaterThan(-1);
    // Lead, task a, the goal's integration worktree (made when a's work is captured), task b.
    // Every agent works in its own worktree; b's is disposable and archived.
    expect(harness.workspaces.map((w) => w.isolation)).toEqual([
      "worktree",
      "worktree",
      "worktree",
      "worktree",
    ]);
    expect(harness.archived).toEqual([harness.workspaces[3]?.workspaceId]);
    expect(harness.workspaces[2]?.branchName).toBe("paseo-goal/g1");
  });

  test("a dependent task's prompt includes the upstream summary", async () => {
    const prompts: string[] = [];
    script([task("a"), task("b", { dependsOn: ["a"] })], (turn) => {
      prompts.push(turn.prompt);
      return {
        outcome: "completed",
        text: /Your task \(\w+\): Task a/.test(turn.prompt) ? "A is built" : "ok",
      };
    });
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);
    expect(prompts.find((p) => p.includes("Task b"))).toContain("A is built");
  });

  test("never runs more tasks at once than maxParallel", async () => {
    script([task("a"), task("b"), task("c"), task("d")], () => "hold");
    const { store, manager } = await boot();
    await createGoal(store);
    await new Promise((r) => setTimeout(r, 50));
    // The manager runs in the background; hand-resolve each batch.
    for (let i = 0; i < 20 && goalOf(store).tasks.some((t) => t.status !== "succeeded"); i += 1) {
      const batch = harness.turns.splice(0);
      expect(goalOf(store).tasks.filter((t) => t.status === "running").length).toBeLessThanOrEqual(
        2,
      );
      for (const turn of batch) turn.resolve({ outcome: "completed", text: "ok" });
      await new Promise((r) => setTimeout(r, 30));
    }
    await settle(manager);
    expect(harness.peakActive).toBe(2);
    expect(goalOf(store).tasks.every((t) => t.status === "succeeded")).toBe(true);
  });

  test("waits for approval when autoApprovePlan is off", async () => {
    script([task("a")]);
    const { store, manager } = await boot();
    await createGoal(store, { ...CONFIG, autoApprovePlan: false });
    await settle(manager);
    expect(goalOf(store).status).toBe("awaiting_plan_approval");
    expect(harness.agents).toHaveLength(1);

    await store.dispatch("g1", { id: "approve", goalId: "g1", type: "plan.approved" });
    await settle(manager);
    expect(goalOf(store).tasks[0]?.status).toBe("succeeded");
  });

  test("retries a failed task in a fresh run and archives the failed attempt's workspace", async () => {
    let attempts = 0;
    script([task("a")], () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: "failed", error: "compile error" }
        : { outcome: "completed", text: "fixed" };
    });
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);

    const goal = goalOf(store);
    expect(goal.tasks[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(goal.runs.map((r) => [r.id, r.status, r.error])).toEqual([
      ["a-a1", "failed", "compile error"],
      ["a-a2", "succeeded", null],
    ]);
    const failedWorkspace = goal.runs[0]?.workspaceId;
    expect(harness.archived).toEqual([failedWorkspace]);
  });

  test("fails the goal and tells the Lead when a task exhausts its attempts", async () => {
    script([task("a"), task("b", { dependsOn: ["a"] })], () => ({
      outcome: "failed",
      error: "nope",
    }));
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);

    const goal = goalOf(store);
    expect(goal.status).toBe("failed");
    expect(goal.failureReason).toMatch(/a, b/);
    expect(goal.tasks.map((t) => t.status)).toEqual(["failed", "pending"]);
    expect(harness.notified.some((n) => n.text.includes("failed after 2 attempts"))).toBe(true);
  });

  test("completes the goal only after its criteria are verified, and tells the Lead", async () => {
    script([task("a")]);
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);
    const goal = goalOf(store);
    expect(goal.status).toBe("completed");
    expect(goal.criteria.map((c) => [c.id, c.evidence])).toEqual([["c1", "checked c1"]]);
    expect(goal.criteria[0]?.verifiedAt).toBeTruthy();
    expect(harness.notified.map((n) => n.text).join("\n")).toMatch(/completed/);
  });

  test("asks the Lead to fix an unusable plan, then gives up", async () => {
    const prompts: string[] = [];
    harness.respond = (turn) => {
      prompts.push(turn.prompt);
      return { outcome: "completed", text: "no json here" };
    };
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toMatch(/could not be used/);
    expect(goalOf(store)).toMatchObject({ status: "failed" });
    expect(goalOf(store).failureReason).toMatch(/valid plan/);
  });

  test("accepts a corrected plan on the second try", async () => {
    let calls = 0;
    harness.respond = (turn) => {
      if (turn.provider !== "claude") return { outcome: "completed", text: "ok" };
      calls += 1;
      return {
        outcome: "completed",
        text: calls === 1 ? "```json\n{not json}\n```" : planBlock([task("a")]),
      };
    };
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);
    expect(goalOf(store).tasks[0]?.status).toBe("succeeded");
  });

  test("cancelling a goal cancels in-flight agents and starts nothing new", async () => {
    script([task("a"), task("b", { dependsOn: ["a"] })], () => "hold");
    const { store, manager } = await boot();
    await createGoal(store);
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.turns).toHaveLength(1);

    await store.dispatch("g1", { id: "cancel", goalId: "g1", type: "goal.cancelled" });
    await new Promise((r) => setTimeout(r, 20));
    // The running worker and the Lead, which outlives planning, are both stopped.
    expect(new Set(harness.canceled)).toEqual(
      new Set([harness.turns[0]?.agentId, goalOf(store).leadAgentId]),
    );

    harness.turns[0]?.resolve({ outcome: "canceled" });
    await settle(manager);
    const goal = goalOf(store);
    expect(goal.status).toBe("cancelled");
    expect(goal.runs.map((r) => r.status)).toEqual(["interrupted"]);
    expect(harness.agents.filter((a) => a.labels["paseo.goal-task"] === "b")).toHaveLength(0);
  });

  test("the global run cap holds across goals and a waiting goal is started when a slot frees", async () => {
    script([task("a"), task("b")], () => "hold");
    const { store, manager } = await boot(2);
    await createGoal(store, CONFIG, "g1");
    await createGoal(store, CONFIG, "g2");
    await new Promise((r) => setTimeout(r, 80));
    expect(harness.peakActive).toBeLessThanOrEqual(2);

    const allSucceeded = (id: string) =>
      goalOf(store, id).tasks.every((t) => t.status === "succeeded");
    const finished = () => allSucceeded("g1") && allSucceeded("g2");
    for (let i = 0; i < 40 && !finished(); i += 1) {
      for (const turn of harness.turns.splice(0))
        turn.resolve({ outcome: "completed", text: "ok" });
      await new Promise((r) => setTimeout(r, 30));
    }
    await settle(manager);
    expect(finished()).toBe(true);
    expect(harness.peakActive).toBeLessThanOrEqual(2);
  });

  test("cancelling while a worker's workspace is still being created starts no agent and cleans up", async () => {
    script([task("a")], () => "hold");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = harness.workspacePort.create;
    harness.workspacePort.create = async (input) => {
      // Only the worker's workspace is slow; the Lead's must go through.
      if (input.title === "Task a") await gate;
      return create(input);
    };
    const { store, manager } = await boot();
    await createGoal(store);
    await new Promise((r) => setTimeout(r, 80));
    expect(goalOf(store).tasks[0]?.status).toBe("running");

    await store.dispatch("g1", { id: "cancel", goalId: "g1", type: "goal.cancelled" });
    release();
    await settle(manager);

    expect(harness.agents.filter((a) => a.labels["paseo.goal-task"] === "a")).toHaveLength(0);
    // The Lead's worktree and the half-built worker workspace are both released.
    expect(harness.archived).toHaveLength(2);
    expect(harness.archived).toContain(goalOf(store).leadWorkspaceId);
    expect(harness.turns.filter((t) => t.provider === "codex")).toHaveLength(0);
  });

  test("shutdown leaves in-flight runs for recovery instead of recording them as failures", async () => {
    script([task("a")], () => "hold");
    const first = await boot();
    await createGoal(first.store);
    await new Promise((r) => setTimeout(r, 80));
    const seqBefore = goalOf(first.store).lastSeq;

    first.manager.stop();
    // The daemon is closing agents: the in-flight turn ends in an error.
    harness.turns[0]?.resolve({ outcome: "failed", error: "agent closed" });
    await new Promise((r) => setTimeout(r, 50));
    expect(goalOf(first.store).lastSeq).toBe(seqBefore);
    expect(goalOf(first.store).runs[0]?.status).toBe("running");
    expect(harness.archived).toHaveLength(0);

    harness.respond = null;
    script([task("a")]);
    const second = await boot();
    await settle(second.manager);
    expect(goalOf(second.store).runs.map((r) => [r.id, r.status])).toEqual([
      ["a-a1", "interrupted"],
      ["a-a2", "succeeded"],
    ]);
  });

  test("a task stranded as failed with attempts left is retried after a restart", async () => {
    const seed = await boot();
    seed.manager.stop();
    await createGoal(seed.store, { ...CONFIG, maxAttempts: 3 });
    const d = (type: string, extra: Record<string, unknown> = {}) =>
      seed.store.dispatch("g1", {
        id: `seed-${type}-${Math.random()}`,
        goalId: "g1",
        type,
        ...extra,
      } as never);
    await d("plan.proposed", { tasks: [task("a")] });
    await d("plan.approved");
    await d("task.started", { taskId: "a" });
    await d("run.started", { runId: "a-a1", taskId: "a", provider: "codex" });
    await d("run.finished", { runId: "a-a1", outcome: "failed", error: "x" });
    await d("task.failed", { taskId: "a", error: "x" });

    script([task("a")]);
    const second = await boot();
    await settle(second.manager);
    const goal = goalOf(second.store);
    expect(goal.status).toBe("completed");
    expect(goal.tasks[0]).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  test("a task whose run finished just before a crash is not run again", async () => {
    const seed = await boot();
    seed.manager.stop();
    await createGoal(seed.store);
    const d = (type: string, extra: Record<string, unknown> = {}) =>
      seed.store.dispatch("g1", {
        id: `seed-${type}-${Math.random()}`,
        goalId: "g1",
        type,
        ...extra,
      } as never);
    await d("plan.proposed", { tasks: [task("a")] });
    await d("plan.approved");
    await d("task.started", { taskId: "a" });
    await d("run.started", { runId: "a-a1", taskId: "a", provider: "codex" });
    await d("task.succeeded", { taskId: "a", summary: "done before crash" });

    script([task("a")]);
    const second = await boot();
    await settle(second.manager);
    const goal = goalOf(second.store);
    expect(goal.runs.map((r) => [r.id, r.status])).toEqual([["a-a1", "succeeded"]]);
    expect(goal.tasks[0]).toMatchObject({
      status: "succeeded",
      attempts: 1,
      summary: "done before crash",
    });
    expect(harness.agents.filter((a) => a.labels["paseo.goal-task"] === "a")).toHaveLength(0);
  });

  test("the Lead is told about completion once, even across a restart", async () => {
    script([task("a")]);
    const first = await boot();
    await createGoal(first.store);
    await settle(first.manager);
    expect(harness.notified).toHaveLength(1);
    expect(goalOf(first.store).status).toBe("completed");

    first.manager.stop();
    const second = await boot();
    await settle(second.manager);
    expect(harness.notified).toHaveLength(1);
  });

  test("a plan naming an unknown provider is sent back to the Lead", async () => {
    const prompts: string[] = [];
    let calls = 0;
    harness.respond = (turn) => {
      if (turn.provider !== "claude") return { outcome: "completed", text: "ok" };
      prompts.push(turn.prompt);
      calls += 1;
      return {
        outcome: "completed",
        text: planBlock([task("a", { provider: calls === 1 ? "not-a-provider/x" : "opencode/m" })]),
      };
    };
    const { store, manager } = await boot();
    await createGoal(store);
    await settle(manager);
    expect(prompts[1]).toMatch(/unknown provider "not-a-provider"/);
    expect(goalOf(store).runs[0]?.provider).toBe("opencode/m");
  });

  test("cancelling during planning stops the Lead and records no plan", async () => {
    harness.respond = () => "hold";
    const { store, manager } = await boot();
    await createGoal(store);
    await new Promise((r) => setTimeout(r, 50));
    expect(harness.turns).toHaveLength(1);

    await store.dispatch("g1", { id: "cancel", goalId: "g1", type: "goal.cancelled" });
    await new Promise((r) => setTimeout(r, 20));
    expect(harness.canceled).toEqual([harness.turns[0]?.agentId]);

    harness.turns[0]?.resolve({ outcome: "completed", text: planBlock([task("a")]) });
    await settle(manager);
    expect(goalOf(store)).toMatchObject({ status: "cancelled", tasks: [] });
  });

  test("leaves a goal without config alone", async () => {
    const { store, manager } = await boot();
    await createGoal(store, null);
    await settle(manager);
    expect(goalOf(store).status).toBe("planning");
    expect(harness.agents).toHaveLength(0);
  });

  test("after a restart, interrupted runs are closed out and the task is retried", async () => {
    script([task("a")], () => "hold");
    const first = await boot();
    await createGoal(first.store);
    await new Promise((r) => setTimeout(r, 50));
    expect(goalOf(first.store).tasks[0]?.status).toBe("running");
    // Simulate a crash: the first manager and its in-flight agent just vanish.
    first.manager.stop();
    const stranded = goalOf(first.store).runs[0];

    harness.respond = null;
    script([task("a")]);
    const second = await boot();
    await settle(second.manager);

    const goal = goalOf(second.store);
    expect(goal.runs.map((r) => [r.id, r.status, r.error])).toEqual([
      ["a-a1", "interrupted", "Interrupted by daemon restart"],
      ["a-a2", "succeeded", null],
    ]);
    expect(goal.tasks[0]).toMatchObject({ status: "succeeded", attempts: 2 });
    expect(harness.archived).toContain(stranded?.workspaceId);
  });
});

describe("re-planning", () => {
  test("a rejected plan sends the Lead back to work, and the earlier Lead is retired", async () => {
    const env = createGoalTestEnv();
    await env.init();
    try {
      let plans = 0;
      env.script([task("a")]);
      const respond = env.harness.respond;
      env.harness.respond = (turn) => {
        if (turn.prompt.includes("You are the Lead")) plans += 1;
        return respond?.(turn) ?? "hold";
      };
      const { store, manager } = await env.boot();
      await env.createGoal(store, { ...CONFIG, autoApprovePlan: false });
      await env.settle(manager);
      const first = env.goalOf(store);
      expect(first.status).toBe("awaiting_plan_approval");

      await store.dispatch("g1", {
        id: "reject",
        goalId: "g1",
        type: "plan.rejected",
        reason: "too big",
      });
      await env.settle(manager);

      const second = env.goalOf(store);
      expect(plans).toBe(2);
      expect(second.status).toBe("awaiting_plan_approval");
      expect(second.leadAgentId).not.toBe(first.leadAgentId);
      expect(env.harness.canceled).toContain(first.leadAgentId);
      expect(env.harness.archived).toContain(first.leadWorkspaceId);
    } finally {
      await env.cleanup();
    }
  });
});

describe("originating chat", () => {
  test("is told how the goal ended: completed, failed or cancelled", async () => {
    for (const ending of ["completed", "failed", "cancelled"] as const) {
      const env = createGoalTestEnv();
      await env.init();
      try {
        const config = { ...CONFIG, originAgentId: "chat-1", notifyLead: false };
        if (ending === "failed")
          env.script([task("a")], () => ({ outcome: "failed", error: "nope" }));
        else env.script([task("a")], ending === "cancelled" ? () => "hold" : undefined);
        const { store, manager } = await env.boot();
        await env.createGoal(store, config);
        if (ending === "cancelled") {
          await new Promise((r) => setTimeout(r, 80));
          await store.dispatch("g1", { id: "cancel", goalId: "g1", type: "goal.cancelled" });
        }
        await new Promise((r) => setTimeout(r, 80));
        await env.settle(manager).catch(() => undefined);
        const toChat = env.harness.notified.filter((n) => n.agentId === "chat-1");
        expect(toChat, ending).toHaveLength(1);
        expect(toChat[0]?.text).toContain(ending === "failed" ? "failed:" : ending);
      } finally {
        await env.cleanup();
      }
    }
  });

  test("a goal started without a chat notifies no one but its Lead", async () => {
    const env = createGoalTestEnv();
    await env.init();
    try {
      env.script([task("a")]);
      const { store, manager } = await env.boot();
      await env.createGoal(store, { ...CONFIG, notifyLead: false });
      await env.settle(manager);
      expect(env.harness.notified).toHaveLength(0);
    } finally {
      await env.cleanup();
    }
  });
});

describe("notification delivery", () => {
  let env: GoalTestEnv;
  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const leadNotice = (store: GoalStore) =>
    env.goalOf(store).notifications?.find((n) => n.target === "lead" && n.key === "goal-completed");
  const attemptEvents = async () =>
    (await env.readEvents()).filter((e) => e.type === "notification.attempted");

  test("a notice the agent layer accepts is recorded as delivered once", async () => {
    env.script([task("a")]);
    const { store, manager } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);

    expect(leadNotice(store)).toMatchObject({ status: "delivered", attempts: 1, lastError: null });
    expect(env.harness.notified).toHaveLength(1);
    expect(env.harness.notified[0]?.text).toBe(leadNotice(store)?.text);
    expect(await attemptEvents()).toHaveLength(1);
  });

  test("a failed attempt is retried after its backoff and then recorded as delivered", async () => {
    env.script([task("a")]);
    env.harness.notifyFailures = 1;
    const { store, manager } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);
    expect(leadNotice(store)).toMatchObject({
      status: "pending",
      attempts: 1,
      lastError: "agent agent-2 unavailable",
    });

    // Nothing is sent before the delay has passed.
    env.clock.advance(4_999);
    await env.settle(manager);
    expect(env.harness.notifyAttempts).toBe(1);
    expect(leadNotice(store)?.attempts).toBe(1);

    env.clock.advance(1);
    await env.settle(manager);
    expect(leadNotice(store)).toMatchObject({ status: "delivered", attempts: 2 });
    expect(env.harness.notified).toHaveLength(1);
    expect(
      (await attemptEvents()).map((e) => e.type === "notification.attempted" && e.outcome),
    ).toEqual(["failed", "delivered"]);
  });

  test("three failed attempts leave the notice failed with the last error", async () => {
    env.script([task("a")]);
    env.harness.notifyFailures = 5;
    const { store, manager } = await env.boot();
    await env.createGoal(store);
    await env.settle(manager);
    env.clock.advance(5_000);
    await env.settle(manager);
    expect(leadNotice(store)).toMatchObject({ status: "pending", attempts: 2 });
    env.clock.advance(29_999);
    await env.settle(manager);
    expect(env.harness.notifyAttempts).toBe(2);
    env.clock.advance(1);
    await env.settle(manager);

    expect(leadNotice(store)).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "agent agent-2 unavailable",
    });
    // No fourth attempt, however long it waits.
    env.clock.advance(600_000);
    await env.settle(manager);
    expect(env.harness.notifyAttempts).toBe(3);
    expect(env.harness.notified).toHaveLength(0);
  });

  test("the originating chat's notice is recorded after the goal ended and retried", async () => {
    env.script([task("a")], () => ({ outcome: "failed", error: "nope" }));
    env.harness.notifyFailures = 1;
    const { store, manager } = await env.boot();
    await env.createGoal(store, { ...CONFIG, originAgentId: "chat-1", notifyLead: false });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("failed");
    const origin = () => env.goalOf(store).notifications?.find((n) => n.target === "origin");
    expect(origin()).toMatchObject({ key: "goal-ended", status: "pending", attempts: 1 });
    const text = origin()?.text;
    expect(text).toContain("failed:");

    env.clock.advance(5_000);
    await env.settle(manager);
    expect(origin()).toMatchObject({ status: "delivered", attempts: 2 });
    // The retry sends exactly what was composed when the goal ended.
    expect(env.harness.notified).toEqual([{ agentId: "chat-1", text }]);
  });

  test("a stop during the backoff is resumed by the next start", async () => {
    env.script([task("a")]);
    env.harness.notifyFailures = 1;
    const first = await env.boot();
    await env.createGoal(first.store);
    await env.settle(first.manager);
    expect(leadNotice(first.store)).toMatchObject({ status: "pending", attempts: 1 });

    first.manager.stop();
    env.clock.advance(5_000);
    await env.settle(first.manager);
    // The stopped Manager neither sent nor recorded anything.
    expect(env.harness.notifyAttempts).toBe(1);
    expect(leadNotice(first.store)?.attempts).toBe(1);

    const second = await env.boot();
    await env.settle(second.manager);
    expect(leadNotice(second.store)).toMatchObject({ status: "delivered", attempts: 2 });
    expect(env.harness.notified).toHaveLength(1);
  });

  test("a delivered notice is not sent again after a restart", async () => {
    env.script([task("a")]);
    const first = await env.boot();
    await env.createGoal(first.store, { ...CONFIG, originAgentId: "chat-1" });
    await env.settle(first.manager);
    expect(env.goalOf(first.store).notifications?.map((n) => [n.target, n.status])).toEqual([
      ["origin", "delivered"],
      ["lead", "delivered"],
    ]);
    first.manager.stop();

    const second = await env.boot();
    await env.settle(second.manager);
    env.clock.advance(600_000);
    await env.settle(second.manager);
    expect(env.harness.notifyAttempts).toBe(2);
    expect(env.harness.notified).toHaveLength(2);
  });

  test("a notice queued just before a crash is sent by the next start", async () => {
    const seed = await env.boot();
    seed.manager.stop();
    await env.createGoal(seed.store, { ...CONFIG, originAgentId: "chat-1" });
    await seed.store.dispatch("g1", { id: "cancel", goalId: "g1", type: "goal.cancelled" });
    await seed.store.dispatch("g1", {
      id: "g1:notification:origin:goal-ended",
      goalId: "g1",
      type: "notification.queued",
      target: "origin",
      key: "goal-ended",
      text: "the goal was cancelled",
    });

    const second = await env.boot();
    await env.settle(second.manager);
    expect(env.harness.notified).toEqual([{ agentId: "chat-1", text: "the goal was cancelled" }]);
    expect(env.goalOf(second.store).notifications?.[0]).toMatchObject({
      status: "delivered",
      attempts: 1,
    });
  });
});

describe("extractPlan", () => {
  test("uses the last fenced block and accepts a bare array", () => {
    const text = `first\n\`\`\`json\n[{"id":"x","title":"X","description":"","kind":"read","dependsOn":[]}]\n\`\`\`\nrevised\n\`\`\`json\n[{"id":"y","title":"Y","description":"","kind":"read","dependsOn":[]}]\n\`\`\``;
    expect(extractPlan(text).map((t) => t.id)).toEqual(["y"]);
  });

  test.each([
    ["no block", "just prose", /No fenced/],
    ["invalid JSON", "```json\n{oops\n```", /not valid JSON/],
    ["wrong shape", '```json\n{"tasks":[{"id":"a"}]}\n```', /schema/],
    [
      "a cycle",
      '```json\n[{"id":"a","title":"A","description":"","kind":"read","dependsOn":["b"]},{"id":"b","title":"B","description":"","kind":"read","dependsOn":["a"]}]\n```',
      /cycle/,
    ],
  ])("rejects %s", (_name, text, message) => {
    expect(() => extractPlan(text)).toThrow(PlanParseError);
    expect(() => extractPlan(text)).toThrow(message);
  });
});
