import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import {
  createGoalConfigUpdateValidator,
  createGoalConfigValidator,
} from "./goal-config-validation.js";
import { CONFIG, createGoalTestEnv, planBlock, task, type GoalTestEnv } from "./goal-test-env.js";

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

describe("limits and policies", () => {
  let env: GoalTestEnv;

  beforeEach(async () => {
    env = createGoalTestEnv();
    await env.init();
  });
  afterEach(() => env.cleanup());

  const h = () => env.harness;
  const withConfig = (extra: Partial<GoalConfig>): GoalConfig => ({ ...CONFIG, ...extra });

  async function start(config: GoalConfig) {
    const booted = await env.boot();
    await env.createGoal(booted.store, config);
    return booted;
  }

  // ---- time limits ------------------------------------------------------

  test("a turn that overruns its time limit is cancelled and counted as a failure", async () => {
    env.script([task("a")], () => "hold");
    const { store } = await start(
      withConfig({ maxAttempts: 1, limits: { runTimeoutMinutes: 1, retryBackoffSeconds: 0 } }),
    );
    await tick();
    expect(h().turns.filter((t) => t.provider === "codex")).toHaveLength(1);

    env.clock.advance(60_001);
    await tick();

    const g = env.goalOf(store);
    expect(g.runs[0]).toMatchObject({ status: "failed", error: "Turn timed out after 1 minutes" });
    expect(h().canceled).toContain(g.runs[0]?.agentId);
    expect(g.status).toBe("failed");
  });

  test("a goal that passes its overall time limit fails and its agents are stopped", async () => {
    env.script([task("a")], () => "hold");
    const { store } = await start(withConfig({ limits: { goalTimeoutMinutes: 1 } }));
    await tick();
    const agent = env.goalOf(store).runs[0]?.agentId;

    // Event times come from the real clock, a few milliseconds after the fake one started.
    env.clock.advance(61_000);
    await tick();

    const g = env.goalOf(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe("Time limit of 1 minutes reached");
    expect(h().canceled).toContain(agent);
    expect(g.runs[0]?.status).toBe("interrupted");
  });

  test("the overall time limit still applies after a restart", async () => {
    env.script([task("a")], () => "hold");
    const first = await start(withConfig({ limits: { goalTimeoutMinutes: 1 } }));
    await tick();
    first.manager.stop();

    // The daemon was down for longer than the goal was allowed to run.
    env.clock.advance(5 * 60_000);
    const second = await env.boot();
    // The deadline is already past, so a real clock fires it at once.
    env.clock.advance(0);
    await tick();

    expect(env.goalOf(second.store).status).toBe("failed");
    expect(env.goalOf(second.store).failureReason).toBe("Time limit of 1 minutes reached");
  });

  test("a finished goal no longer has a time limit pending", async () => {
    env.script([task("a")]);
    const { store, manager } = await start(
      withConfig({ limits: { goalTimeoutMinutes: 1, retryBackoffSeconds: 0 } }),
    );
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    env.clock.advance(10 * 60_000);
    await tick();
    expect(env.goalOf(store).status).toBe("completed");
  });

  // ---- retry backoff ----------------------------------------------------

  test("a failed task waits out a growing backoff before it is retried", async () => {
    let attempts = 0;
    env.script([task("a")], () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: "failed", error: "provider unavailable" }
        : { outcome: "completed", text: "ok" };
    });
    const { store, manager } = await start(
      withConfig({ maxAttempts: 2, limits: { retryBackoffSeconds: 10 } }),
    );
    await tick();
    expect(env.goalOf(store).runs.map((r) => r.id)).toEqual(["a-a1"]);

    env.clock.advance(9_999);
    await tick();
    expect(env.goalOf(store).runs).toHaveLength(1);

    env.clock.advance(2);
    await env.settle(manager);
    expect(env.goalOf(store).runs.map((r) => [r.id, r.status])).toEqual([
      ["a-a1", "failed"],
      ["a-a2", "succeeded"],
    ]);
  });

  test("stopping during a backoff does not lose the retry: the next start performs it", async () => {
    let attempts = 0;
    env.script([task("a")], () => {
      attempts += 1;
      return attempts === 1
        ? { outcome: "failed", error: "provider unavailable" }
        : { outcome: "completed", text: "ok" };
    });
    const first = await start(withConfig({ maxAttempts: 2, limits: { retryBackoffSeconds: 60 } }));
    await tick();
    first.manager.stop();
    await tick();
    expect(env.goalOf(first.store).tasks[0]?.status).toBe("failed");

    const second = await env.boot();
    await env.settle(second.manager);
    expect(env.goalOf(second.store).tasks[0]).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  // ---- run and plan limits ---------------------------------------------

  test("the goal fails when it would exceed its run limit", async () => {
    env.script([task("a"), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["b"] })]);
    const { store, manager } = await start(
      withConfig({ limits: { maxRuns: 2, retryBackoffSeconds: 0 } }),
    );
    await env.settle(manager);

    const g = env.goalOf(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe("Run limit of 2 reached");
    expect(g.runs).toHaveLength(2);
  });

  test("a plan over the task limit is sent back to the Lead", async () => {
    const prompts: string[] = [];
    let calls = 0;
    h().respond = (turn) => {
      if (turn.prompt.includes("You are the Lead") || turn.prompt.includes("could not be used")) {
        prompts.push(turn.prompt);
        calls += 1;
        return {
          outcome: "completed",
          text: planBlock(calls === 1 ? [task("a"), task("b"), task("c")] : [task("a"), task("b")]),
        };
      }
      if (turn.prompt.includes("independent reviewer")) return env.stageReplies.review(turn);
      if (turn.prompt.includes("You are the verifier")) return env.stageReplies.verify(turn);
      return { outcome: "completed", text: "ok" };
    };
    const { store, manager } = await start(
      withConfig({ limits: { maxTasks: 2, retryBackoffSeconds: 0 } }),
    );
    await env.settle(manager);

    expect(prompts[1]).toMatch(/at most 2 are allowed/);
    expect(env.goalOf(store).tasks).toHaveLength(2);
  });

  // ---- permissions ------------------------------------------------------

  test("under fail, or with no policy stored, a run that asks for a permission fails and its agent is stopped", async () => {
    env.script([task("a")], () => ({ outcome: "needs_permission" }));
    const { store, manager } = await start(withConfig({ maxAttempts: 1 }));
    await env.settle(manager);

    const g = env.goalOf(store);
    expect(g.runs[0]?.error).toMatch(/waiting for a permission approval/);
    expect(h().canceled).toContain(g.runs[0]?.agentId);
    expect(g.status).toBe("failed");
  });

  test("a run that stops on a question is not retried, and the goal fails naming the question", async () => {
    let turns = 0;
    let answered = false;
    env.script([task("a")], () => {
      turns += 1;
      // The person switched the goal to wait and answered the question this time.
      if (answered) return { outcome: "completed", text: "ok" };
      return {
        outcome: "needs_permission",
        request: {
          kind: "question",
          tool: "request_user_input_async",
          text: "No setup decision is recorded for this project. Configure or skip?",
        },
      };
    });
    const { store, manager } = await start(
      withConfig({ maxAttempts: 3, limits: { retryBackoffSeconds: 0 } }),
    );
    await env.settle(manager);

    const g = env.goalOf(store);
    // One attempt: a retry under the same policy would ask the same question again.
    expect(turns).toBe(1);
    expect(g.runs.map((r) => r.status)).toEqual(["failed"]);
    expect(g.runs[0]?.error).toBe(
      "Agent asked a question and the goal's permission policy (fail) cannot answer it: " +
        '"No setup decision is recorded for this project. Configure or skip?". ' +
        "Change the policy to wait or auto, or resolve what triggers the question, then retry.",
    );
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe(
      `No task can make progress. Failed or blocked: a. Task a stopped on a request (needs_permission): ${g.runs[0]?.error}`,
    );

    // A restart does not retry it either.
    manager.stop();
    const second = await env.boot();
    await env.settle(second.manager);
    expect(env.goalOf(second.store).runs).toHaveLength(1);

    await second.service.updateConfig("g1", { onPermissionRequest: "wait" });
    answered = true;
    await second.service.retry("g1", "a");
    await env.settle(second.manager);
    const retried = env.goalOf(second.store);
    expect(retried.runs.map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(retried.tasks[0]?.status).toBe("succeeded");
    // The retried run's agent started under the new policy.
    expect(h().agents.at(-1)?.permission).toBe("wait");
  });

  test("a run that stops on a request after the policy changed is retried in the new mode", async () => {
    let turns = 0;
    env.script([task("a")], () => {
      turns += 1;
      return turns === 1 ? "hold" : { outcome: "completed", text: "ok" };
    });
    const { store, manager, service } = await start(
      withConfig({ onPermissionRequest: "wait", limits: { retryBackoffSeconds: 0 } }),
    );
    await tick();
    // The worker waits on a question; the person switches the goal to fail, which ends that turn.
    await service.updateConfig("g1", { onPermissionRequest: "fail" });
    h()
      .turns.find((t) => t.provider === "codex")
      ?.resolve({
        outcome: "needs_permission",
        request: { kind: "question", tool: "request_user_input", text: "Which one?" },
      });
    await env.settle(manager);
    const g = env.goalOf(store);
    expect(g.runs.map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(h().agents.at(-1)?.permission).toBe("fail");
  });

  test("a run that stops on a permission names the tool and what it is for", async () => {
    env.script([task("a")], () => ({
      outcome: "needs_permission",
      request: { kind: "permission", tool: "Bash", text: "git push origin main" },
    }));
    const { store, manager } = await start(withConfig({ maxAttempts: 2 }));
    await env.settle(manager);
    const g = env.goalOf(store);
    expect(g.runs).toHaveLength(1);
    expect(g.runs[0]?.error).toBe(
      'Agent is waiting for permission to use Bash: "git push origin main" and the goal\'s ' +
        "permission policy (fail) cannot grant it. Change the policy to wait or auto, then retry.",
    );
  });

  test("the permission policy is handed to the agent layer for every turn", async () => {
    const seen: (string | undefined)[] = [];
    const runTurn = h().agentPort.runTurn;
    h().agentPort.runTurn = (agentId, prompt, options) => {
      const permission = options?.permission;
      seen.push(typeof permission === "function" ? permission() : permission);
      return runTurn(agentId, prompt, options);
    };
    env.script([task("a")]);
    const { manager } = await start(withConfig({ onPermissionRequest: "wait" }));
    await env.settle(manager);
    // Lead, worker, reviewer and verifier all run under the policy.
    expect(seen.length).toBeGreaterThanOrEqual(4);
    expect(new Set(seen)).toEqual(new Set(["wait"]));
  });

  // ---- provider boundaries ---------------------------------------------

  test("a plan cannot use a registered provider the goal does not allow", async () => {
    const prompts: string[] = [];
    let calls = 0;
    h().respond = (turn) => {
      if (turn.prompt.includes("You are the Lead") || turn.prompt.includes("could not be used")) {
        prompts.push(turn.prompt);
        calls += 1;
        return {
          outcome: "completed",
          text: planBlock([task("a", { provider: calls === 1 ? "opencode" : "codex" })]),
        };
      }
      if (turn.prompt.includes("independent reviewer")) return env.stageReplies.review(turn);
      if (turn.prompt.includes("You are the verifier")) return env.stageReplies.verify(turn);
      return { outcome: "completed", text: "ok" };
    };
    const { store, manager } = await start(
      withConfig({ allowedProviders: ["claude", "codex"], limits: { retryBackoffSeconds: 0 } }),
    );
    await env.settle(manager);

    expect(prompts[1]).toMatch(/unknown provider "opencode"/);
    expect(env.goalOf(store).runs[0]?.provider).toBe("codex");
  });

  test("config validation rejects unknown providers, providers outside the allow-list, and non-repositories", async () => {
    const validate = createGoalConfigValidator({
      git: {
        head: async (cwd) => {
          if (cwd === "/not-a-repo") throw new Error("fatal: not a git repository");
          return "abc";
        },
      },
      knownProviders: () => ["claude", "codex"],
    });
    // The base commit is recorded so every worktree starts from the checkout the goal began on.
    await expect(validate(CONFIG)).resolves.toMatchObject({ baseCommit: "abc" });
    await expect(validate({ ...CONFIG, defaultProvider: "mystery" })).rejects.toThrow(
      /defaultProvider "mystery" is not a registered provider/,
    );
    await expect(validate({ ...CONFIG, allowedProviders: ["claude"] })).rejects.toThrow(
      /defaultProvider "codex" is not in allowedProviders/,
    );
    await expect(validate({ ...CONFIG, cwd: "/not-a-repo" })).rejects.toThrow(
      /"\/not-a-repo" is not a git repository/,
    );
    // provider/model selects a model, not a different provider.
    await expect(
      validate({ ...CONFIG, defaultProvider: "codex/some-model" }),
    ).resolves.toBeDefined();
    await expect(
      validate({
        ...CONFIG,
        leadProvider: "claude/opus",
        reviewProvider: "codex/some-model",
        allowedProviders: ["claude", "codex"],
      }),
    ).resolves.toBeDefined();
  });

  test("config validation checks the verifier's provider and the absolute deadline", async () => {
    const validate = createGoalConfigValidator({
      git: { head: async () => "abc" },
      knownProviders: () => ["claude", "codex"],
      now: () => Date.parse("2026-06-01T00:00:00Z"),
    });
    await expect(validate({ ...CONFIG, verifyProvider: "mystery" })).rejects.toThrow(
      /verifyProvider "mystery" is not a registered provider/,
    );
    await expect(validate({ ...CONFIG, limits: { deadlineAt: "next tuesday" } })).rejects.toThrow(
      /is not a date/,
    );
    await expect(
      validate({ ...CONFIG, limits: { deadlineAt: "2026-05-01T00:00:00Z" } }),
    ).rejects.toThrow(/in the past/);
    await expect(
      validate({ ...CONFIG, limits: { deadlineAt: "2026-07-01T00:00:00Z" } }),
    ).resolves.toBeDefined();
  });

  test("the auto policy needs every role provider to list an auto mode", async () => {
    const modeCatalog = async (provider: string) => {
      if (provider === "opencode") throw new Error("catalog still loading");
      return (provider === "claude" ? ["default", "auto"] : ["read-only", "full-access"]).map(
        (id) => ({ id }),
      );
    };
    const validate = createGoalConfigValidator({
      git: { head: async () => "abc" },
      knownProviders: () => ["claude", "codex", "opencode"],
      modeCatalog,
    });
    const claudeOnly = { ...CONFIG, defaultProvider: "claude/opus" };
    await expect(validate({ ...claudeOnly, onPermissionRequest: "auto" })).resolves.toBeDefined();
    await expect(validate({ ...CONFIG, onPermissionRequest: "auto" })).rejects.toThrow(
      /defaultProvider "codex" has none. Available modes: read-only, full-access/,
    );
    await expect(
      validate({ ...claudeOnly, reviewProvider: "codex", onPermissionRequest: "auto" }),
    ).rejects.toThrow(/reviewProvider "codex"/);
    // A catalog that cannot be read does not block the goal; the agent falls back to wait.
    await expect(
      validate({ ...claudeOnly, reviewProvider: "opencode", onPermissionRequest: "auto" }),
    ).resolves.toBeDefined();
    await expect(validate({ ...CONFIG, onPermissionRequest: "wait" })).resolves.toBeDefined();

    // Changes are checked the same way, and only what changed.
    const update = createGoalConfigUpdateValidator({
      modeCatalog,
      now: () => Date.parse("2026-06-01T00:00:00Z"),
    });
    await expect(update({ ...CONFIG, onPermissionRequest: "auto" }, CONFIG)).rejects.toThrow(
      /needs an auto mode/,
    );
    await expect(
      update({ ...CONFIG, limits: { deadlineAt: "2026-05-01T00:00:00Z" } }, CONFIG),
    ).rejects.toThrow(/in the past/);
    // A deadline already stored is not re-checked when something else changes.
    const past = { ...CONFIG, limits: { deadlineAt: "2026-05-01T00:00:00Z" } };
    await expect(update({ ...past, maxParallel: 3 }, past)).resolves.toBeUndefined();
  });

  test("auto on Codex needs its auto-review mode; its Default Permissions mode does not count", async () => {
    const codexModes = ["auto", "auto-review", "full-access"];
    let modes = codexModes;
    const modeCatalog = async (provider: string) =>
      (provider === "claude" ? ["default", "auto", "bypassPermissions"] : modes).map((id) => ({
        id,
      }));
    const validate = createGoalConfigValidator({
      git: { head: async () => "abc" },
      knownProviders: () => ["claude", "codex"],
      modeCatalog,
    });
    const update = createGoalConfigUpdateValidator({ modeCatalog });
    await expect(validate({ ...CONFIG, onPermissionRequest: "auto" })).resolves.toBeDefined();
    await expect(update({ ...CONFIG, onPermissionRequest: "auto" }, CONFIG)).resolves.toBe(
      undefined,
    );
    // A Codex too old for the auto-reviewer lists `auto`, which asks for every command.
    modes = codexModes.filter((id) => id !== "auto-review");
    await expect(validate({ ...CONFIG, onPermissionRequest: "auto" })).rejects.toThrow(
      /defaultProvider "codex" has none/,
    );
    await expect(update({ ...CONFIG, onPermissionRequest: "auto" }, CONFIG)).rejects.toThrow(
      /needs an auto mode/,
    );
  });

  test("an absolute deadline earlier than the time limit fails the goal when it passes", async () => {
    env.script([task("a")], () => "hold");
    const deadlineAt = new Date(env.clock.now() + 10 * 60_000).toISOString();
    const { store } = await start(withConfig({ limits: { goalTimeoutMinutes: 60, deadlineAt } }));
    await tick();
    env.clock.advance(11 * 60_000);
    await tick();
    const g = env.goalOf(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe(`Deadline ${deadlineAt} reached`);
  });

  test("a goal retried fresh after its time limit runs the full limit again, then times out", async () => {
    // Event times follow the fake clock, so the new time base is the moment of the retry.
    env.logOptions.now = () => new Date(env.clock.now()).toISOString();
    env.script([task("a")], () => "hold");
    const { store, service } = await start(withConfig({ limits: { goalTimeoutMinutes: 1 } }));
    await tick();
    env.clock.advance(61_000);
    await tick();
    expect(env.goalOf(store).failureReason).toBe("Time limit of 1 minutes reached");

    // The goal sat failed for ten minutes; fresh does not count that.
    env.clock.advance(10 * 60_000);
    const retriedAt = env.clock.now();
    await service.retry("g1", undefined, undefined, "fresh");
    await tick();
    const reopened = env.goalOf(store);
    expect(reopened.status).toBe("executing");
    expect(reopened.timeBaseAt).toBe(new Date(retriedAt).toISOString());

    env.clock.advance(59_000);
    await tick();
    expect(env.goalOf(store).status).toBe("executing");
    env.clock.advance(2_000);
    await tick();
    const g = env.goalOf(store);
    expect(g.status).toBe("failed");
    expect(g.failureReason).toBe("Time limit of 1 minutes reached");
  });

  /** Task a fails at once, b holds, so the goal stays live with a task to retry. */
  async function liveGoalWithFailedTask(goalTimeoutMinutes: number) {
    env.logOptions.now = () => new Date(env.clock.now()).toISOString();
    env.script([task("a"), task("b")], (turn) =>
      turn.prompt.includes("do a") ? { outcome: "failed", error: "boom" } : "hold",
    );
    const booted = await start(withConfig({ maxAttempts: 1, limits: { goalTimeoutMinutes } }));
    await tick();
    const goal = env.goalOf(booted.store);
    expect(goal.status).toBe("executing");
    expect(goal.tasks.map((t) => t.status)).toEqual(["failed", "running"]);
    return booted;
  }

  test("a live goal's task retried fresh outlives its old deadline, then times out at the new one", async () => {
    const { store, service } = await liveGoalWithFailedTask(1);
    env.clock.advance(50_000);
    await service.retry("g1", "a", undefined, "fresh");
    await tick();

    // The timer armed for the old deadline fires, finds the new one and waits again.
    env.clock.advance(15_000);
    await tick();
    expect(env.goalOf(store).status).toBe("executing");
    env.clock.advance(44_000);
    await tick();
    expect(env.goalOf(store).status).toBe("executing");
    env.clock.advance(2_000);
    await tick();
    expect(env.goalOf(store)).toMatchObject({
      status: "failed",
      failureReason: "Time limit of 1 minutes reached",
    });
  });

  test("remaining on a running goal counts the time it ran, leaving out a pause", async () => {
    const { store, service } = await liveGoalWithFailedTask(10);
    const createdAt = Date.parse(env.goalOf(store).createdAt);
    env.clock.advance(10_000);
    await service.pause("g1");
    env.clock.advance(60_000);
    await service.resume("g1");
    env.clock.advance(20_000);
    await service.retry("g1", "a", undefined, "remaining");

    const retried = (await env.readEvents()).findLast((e) => e.type === "goal.retried");
    expect(retried).toMatchObject({ timeMode: "remaining", activeMs: 30_000, reopen: false });
    expect(env.goalOf(store).timeBaseAt).toBe(new Date(createdAt + 60_000).toISOString());
  });

  // ---- read-only roles --------------------------------------------------

  test("a reviewer that changes the worktree is undone and asked to review the original", async () => {
    env.script([task("a")]);
    const prompts: string[] = [];
    let reviews = 0;
    env.stageReplies.review = (turn) => {
      reviews += 1;
      prompts.push(turn.prompt);
      if (reviews === 1) {
        // The reviewer edited the author's worktree.
        const cwd = h().agents.find((a) => a.agentId === turn.agentId)?.cwd ?? "";
        h().git.heads.set(cwd, "reviewer-commit");
      }
      return {
        outcome: "completed",
        text: env.fenced(JSON.stringify({ verdict: "approve", findings: [] })),
      };
    };
    const { store, manager } = await start(CONFIG);
    await env.settle(manager);

    const g = env.goalOf(store);
    expect(reviews).toBe(2);
    expect(prompts[1]).toMatch(/must not modify anything/);
    expect(h().git.resets[0]).toMatchObject({ commit: g.changeSets[0]?.headCommit });
    expect(g.status).toBe("completed");
  });

  test("a reviewer that keeps changing the worktree gets the change rejected", async () => {
    env.script([task("a")]);
    env.stageReplies.review = (turn) => {
      const cwd = h().agents.find((a) => a.agentId === turn.agentId)?.cwd ?? "";
      h().git.heads.set(cwd, "reviewer-commit");
      return {
        outcome: "completed",
        text: env.fenced(JSON.stringify({ verdict: "approve", findings: [] })),
      };
    };
    const { store, manager } = await start(CONFIG);
    await env.settle(manager);

    const g = env.goalOf(store);
    expect(g.status).toBe("failed");
    expect(g.changeSets[0]?.status).toBe("rejected");
    expect(h().git.merges).toHaveLength(0);
  });
});
