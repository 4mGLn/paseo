import { describe, expect, test } from "vitest";
import pino from "pino";
import {
  createGoalAgentPort,
  createGoalWorkspacePort,
  createTurnUsageMeter,
  goalPolicyModeId,
  settleTurn,
  toTurnUsage,
  watchTurn,
  type GoalPortDeps,
} from "./goal-ports.js";
import type { AgentManagerEvent } from "../agent/agent-manager.js";
import type { GoalMode } from "./goal-config-validation.js";

const done = (lastMessage: string) => ({ status: "idle", permission: null, lastMessage });
const asking = { status: "running", permission: { id: "p1" }, lastMessage: null };

function sequence<T>(...results: T[]): () => Promise<T> {
  let index = 0;
  return async () => results[Math.min(index++, results.length - 1)] as T;
}

describe("settleTurn", () => {
  test("a finished turn returns the agent's last message, trimmed", async () => {
    expect(await settleTurn(sequence(done("  built it \n")), "fail", "a1")).toEqual({
      outcome: "completed",
      text: "built it",
    });
  });

  test("an agent error becomes a failure carrying its message", async () => {
    const result = await settleTurn(
      sequence({ status: "error", permission: null, lastMessage: "quota exceeded" }),
      "fail",
      "a1",
    );
    expect(result).toEqual({ outcome: "failed", error: "quota exceeded" });
  });

  test("under the fail policy a permission request ends the turn at once", async () => {
    const pauses: number[] = [];
    const result = await settleTurn(sequence(asking), "fail", "a1", async (ms) => {
      pauses.push(ms);
    });
    expect(result).toEqual({ outcome: "needs_permission" });
    expect(pauses).toEqual([]);
  });

  test("under the wait policy it keeps waiting until a person has answered", async () => {
    const pauses: number[] = [];
    const result = await settleTurn(
      sequence(asking, asking, asking, done("finished after approval")),
      "wait",
      "a1",
      async (ms) => {
        pauses.push(ms);
      },
    );
    expect(result).toEqual({ outcome: "completed", text: "finished after approval" });
    expect(pauses).toEqual([1000, 1000, 1000]);
  });

  test("a waiting turn ends once the goal is switched to fail", async () => {
    let policy: "fail" | "wait" = "wait";
    let polls = 0;
    const result = await settleTurn(
      sequence(asking),
      () => policy,
      "a1",
      async () => {
        polls += 1;
        if (polls === 2) policy = "fail";
      },
    );
    expect(result).toEqual({ outcome: "needs_permission" });
    expect(polls).toBe(2);
  });

  test("a request left pending on an agent that has stopped does not loop forever", async () => {
    // After the caller cancels the agent, the request can still be reported.
    const stopped = { status: "idle", permission: { id: "p1" }, lastMessage: null };
    const result = await settleTurn(sequence(asking, stopped), "wait", "a1", async () => {});
    expect(result).toEqual({ outcome: "needs_permission" });
  });

  test("an abandoned turn stops polling for a request nobody will answer", async () => {
    const controller = new AbortController();
    let polls = 0;
    const result = await settleTurn(
      sequence(asking),
      "wait",
      "a1",
      async () => {
        polls += 1;
        if (polls === 2) controller.abort();
      },
      controller.signal,
    );
    expect(result).toEqual({ outcome: "needs_permission" });
    expect(polls).toBe(2);
  });
});

describe("turn usage", () => {
  test("keeps the last usage the provider reported during the turn", () => {
    let emit: (event: AgentManagerEvent) => void = () => {};
    const watcher = watchTurn((listener) => {
      emit = listener;
      return () => {};
    });
    const stream = (event: unknown) =>
      emit({ type: "agent_stream", agentId: "a1", event } as unknown as AgentManagerEvent);
    stream({ type: "usage_updated", provider: "codex", usage: { inputTokens: 5 } });
    stream({
      type: "turn_completed",
      provider: "codex",
      usage: { inputTokens: 10, outputTokens: 2, totalCostUsd: 0.01, contextWindowMaxTokens: 9 },
    });
    // Reported after the turn ended: not this turn's.
    stream({ type: "usage_updated", provider: "codex", usage: { inputTokens: 99 } });
    expect(watcher.usage()).toEqual({ inputTokens: 10, outputTokens: 2, costUsd: 0.01 });
    expect(watcher.end()).toEqual({ type: "turn_completed" });
  });

  test("a turn without usage, or with only unusable numbers, reports none", () => {
    expect(toTurnUsage(undefined)).toBeUndefined();
    expect(toTurnUsage({ inputTokens: Number.NaN, outputTokens: -1 })).toBeUndefined();
  });

  test("a provider's whole-turn totals win over its context fields", () => {
    // Codex-like: the top level is the turn's last model call, input including cache reads.
    expect(
      toTurnUsage({
        inputTokens: 206_044,
        cachedInputTokens: 204_160,
        outputTokens: 1_372,
        turnTotals: { inputTokens: 31_000, cachedInputTokens: 2_400_000, outputTokens: 18_000 },
      }),
    ).toEqual({ inputTokens: 31_000, cachedInputTokens: 2_400_000, outputTokens: 18_000 });
    // Claude-like: tokens and the session's cost come as turn totals; the top level holds the
    // main loop's tokens and the running cost.
    expect(
      toTurnUsage({
        inputTokens: 8,
        cachedInputTokens: 174_852,
        outputTokens: 7_609,
        totalCostUsd: 1.2,
        turnTotals: {
          inputTokens: 21_000,
          cachedInputTokens: 180_000,
          outputTokens: 7_700,
          costUsd: 0.53,
        },
      }),
    ).toEqual({
      inputTokens: 21_000,
      cachedInputTokens: 180_000,
      outputTokens: 7_700,
      costUsd: 0.53,
    });
  });

  test("session totals count only their growth since the agent's previous turn", () => {
    const reading = {
      inputTokens: 999,
      sessionTotals: { inputTokens: 300, cachedInputTokens: 50, outputTokens: 40, costUsd: 0.3 },
    };
    expect(toTurnUsage(reading)).toEqual({
      inputTokens: 300,
      cachedInputTokens: 50,
      outputTokens: 40,
      costUsd: 0.3,
    });
    expect(
      toTurnUsage(reading, {
        inputTokens: 100,
        cachedInputTokens: 50,
        outputTokens: 10,
        costUsd: 0.1,
      }),
    ).toEqual({
      inputTokens: 200,
      cachedInputTokens: 0,
      outputTokens: 30,
      costUsd: expect.closeTo(0.2),
    });
    // A total below the baseline means the provider started counting again.
    expect(toTurnUsage(reading, { inputTokens: 5_000 })).toMatchObject({ inputTokens: 300 });
    // A field the totals lack falls back to the reading's own.
    expect(
      toTurnUsage({ outputTokens: 7, sessionTotals: { costUsd: 2 } }, { costUsd: 1.5 }),
    ).toEqual({ outputTokens: 7, costUsd: expect.closeTo(0.5) });
  });

  test("each turn of an agent is measured from where its previous turn ended", () => {
    const meter = createTurnUsageMeter();
    const reading = (sessionTotals: Record<string, number>) => ({ sessionTotals });
    expect(meter.measure("a1", reading({ inputTokens: 100, costUsd: 0.1 }))).toEqual({
      inputTokens: 100,
      costUsd: 0.1,
    });
    expect(meter.measure("a2", reading({ inputTokens: 40 }))).toEqual({ inputTokens: 40 });
    expect(meter.measure("a1", reading({ inputTokens: 250, costUsd: 0.25 }))).toEqual({
      inputTokens: 150,
      costUsd: expect.closeTo(0.15),
    });
    // A turn that reported nothing leaves the agent's baseline where it was.
    expect(meter.measure("a1", undefined)).toBeUndefined();
    expect(meter.measure("a1", reading({ inputTokens: 300, costUsd: 0.25 }))).toEqual({
      inputTokens: 50,
      costUsd: 0,
    });
  });
});

describe("workspace port", () => {
  function setup(waitForWorkspaceSetup: (id: string) => Promise<void> = async () => {}) {
    const worktreeCalls: Record<string, unknown>[] = [];
    const order: string[] = [];
    const deps = {
      logger: pino({ level: "silent" }),
      createDirectoryWorkspace: async () => ({ workspaceId: "dir-1", cwd: "/repo" }),
      createPaseoWorktreeWorkspace: async (input: Record<string, unknown>) => {
        worktreeCalls.push(input);
        order.push("created");
        return {
          workspace: { workspaceId: "wt-1", cwd: "/wt/1" },
          worktree: { worktreePath: "/nonexistent/wt/1" },
        };
      },
      archiveWorkspace: async () => {},
      waitForWorkspaceSetup: async (id: string) => {
        order.push("waiting");
        await waitForWorkspaceSetup(id);
        order.push("setup done");
      },
    } as unknown as GoalPortDeps;
    return { port: createGoalWorkspacePort(deps), worktreeCalls, order };
  }

  test("an ordinary worktree is offered to the branch auto-namer and waits for its setup", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port, worktreeCalls, order } = setup(() => gate);

    const pending = port.create({
      cwd: "/repo",
      isolation: "worktree",
      title: "Task a",
      baseRef: "abc",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(order).toEqual(["created", "waiting"]);
    release();

    expect(await pending).toEqual({ workspaceId: "wt-1", cwd: "/wt/1" });
    expect(worktreeCalls[0]).toMatchObject({
      firstAgentContext: { prompt: "Task a" },
      refName: "abc",
      action: "branch-off",
    });
  });

  test("a worktree whose branch name must stay is never offered to the auto-namer", async () => {
    const { port, worktreeCalls } = setup();
    await port.create({
      cwd: "/repo",
      isolation: "worktree",
      title: "Integration",
      branchName: "paseo-goal/g1",
      keepBranchName: true,
    });
    expect(worktreeCalls[0]).toMatchObject({ branchName: "paseo-goal/g1" });
    expect(worktreeCalls[0]).not.toHaveProperty("firstAgentContext");
  });
});

describe("agent port", () => {
  function setup(
    reported: { runtime?: string | null; config?: string } = {},
    modes: Record<string, string[]> = { claude: ["default", "auto", "bypassPermissions"] },
  ) {
    const calls: Record<string, unknown>[] = [];
    const deps = {
      logger: pino({ level: "silent" }),
      modeCatalog: async (provider: string) => {
        const ids = modes[provider];
        if (!ids) throw new Error(`no catalog for ${provider}`);
        return ids.map((id) => ({ id }));
      },
      createAgent: async (input: Record<string, unknown>) => {
        calls.push(input);
        return {
          snapshot: {
            id: "agent-1",
            config: { thinkingOptionId: reported.config ?? input.thinking },
            runtimeInfo:
              reported.runtime === undefined ? undefined : { thinkingOptionId: reported.runtime },
          },
        };
      },
    } as unknown as GoalPortDeps;
    return { port: createGoalAgentPort(deps), calls };
  }

  const base = { cwd: "/repo", workspaceId: "ws-1", title: "Lead", labels: {} };

  test("a provider/model value starts the provider with that model", async () => {
    const { port, calls } = setup();
    await port.createAgent({ ...base, provider: "codex/some-model" });
    expect(calls[0]).toMatchObject({
      provider: "codex/some-model",
      config: { provider: "codex", model: "some-model", cwd: "/repo" },
    });
  });

  test("a bare provider id leaves the model to the provider default", async () => {
    const { port, calls } = setup();
    await port.createAgent({ ...base, provider: "claude" });
    expect(calls[0]).toMatchObject({ provider: "claude", config: { provider: "claude" } });
    expect(calls[0]?.config).not.toHaveProperty("model");
  });

  test("a thinking id is passed to the create path the way a chat's is", async () => {
    const { port, calls } = setup();
    const created = await port.createAgent({ ...base, provider: "codex", thinking: "high" });
    expect(calls[0]).toMatchObject({ thinking: "high" });
    expect(created).toEqual({ agentId: "agent-1", thinking: "high" });
  });

  test("without a thinking id nothing is passed, and the agent reports what it runs with", async () => {
    const { port, calls } = setup({ runtime: "medium" });
    const created = await port.createAgent({ ...base, provider: "codex" });
    expect(calls[0]).not.toHaveProperty("thinking");
    expect(created).toEqual({ agentId: "agent-1", thinking: "medium" });
    const silent = setup();
    expect(await silent.port.createAgent({ ...base, provider: "codex" })).toEqual({
      agentId: "agent-1",
    });
  });

  test("each permission policy picks how the agent starts", async () => {
    const { port, calls } = setup({}, { claude: ["default", "auto"], codex: ["read-only"] });
    // Absent is the policy of goals stored before policies were recorded.
    await port.createAgent({ ...base, provider: "claude" });
    await port.createAgent({ ...base, provider: "claude", permission: "fail" });
    await port.createAgent({ ...base, provider: "claude", permission: "wait" });
    await port.createAgent({ ...base, provider: "claude/opus", permission: "auto" });
    // A provider without an auto mode, or whose modes cannot be read, starts as under wait.
    await port.createAgent({ ...base, provider: "codex", permission: "auto" });
    await port.createAgent({ ...base, provider: "opencode", permission: "auto" });
    expect(calls.map((c) => ({ unattended: c.unattended, mode: c.mode }))).toEqual([
      { unattended: true, mode: undefined },
      { unattended: true, mode: undefined },
      { unattended: false, mode: undefined },
      { unattended: false, mode: "auto" },
      { unattended: false, mode: undefined },
      { unattended: false, mode: undefined },
    ]);
  });

  test("auto picks each provider's own auto mode from its real mode list", async () => {
    const codexModes = CODEX_MODE_IDS;
    const { port, calls } = setup(
      {},
      {
        claude: ["default", "acceptEdits", "plan", "auto", "bypassPermissions"],
        codex: codexModes,
        // A provider without a preference entry keeps the `auto` id rule.
        other: ["ask", "auto"],
        none: ["ask", "yolo"],
      },
    );
    for (const provider of ["claude", "codex/gpt-6-luna", "other", "none"]) {
      await port.createAgent({ ...base, provider, permission: "auto" });
    }
    // A Codex too old for the auto-reviewer: its `auto` is Default Permissions, so it is not used.
    const old = setup({}, { codex: codexModes.filter((id) => id !== "auto-review") });
    await old.port.createAgent({ ...base, provider: "codex", permission: "auto" });
    expect([...calls, ...old.calls].map((c) => c.mode)).toEqual([
      "auto",
      "auto-review",
      "auto",
      undefined,
      undefined,
    ]);
  });
});

/** The mode ids the Codex provider lists when its version supports the auto-reviewer. */
const CODEX_MODE_IDS = ["auto", "auto-review", "full-access"];

describe("goalPolicyModeId", () => {
  const catalogs: Record<string, GoalMode[]> = {
    claude: [{ id: "default" }, { id: "auto" }, { id: "bypassPermissions", isUnattended: true }],
    codex: [{ id: "auto" }, { id: "auto-review" }, { id: "full-access", isUnattended: true }],
    plain: [{ id: "build" }],
  };
  const defaults: Record<string, string> = {
    claude: "default",
    codex: "auto-review",
    plain: "build",
  };
  const deps = {
    modeCatalog: async (provider: string) => catalogs[provider] ?? [],
    defaultModeId: async (provider: string) => defaults[provider] ?? null,
  };
  const target = (provider: string, permission: "fail" | "wait" | "auto") =>
    goalPolicyModeId(deps, { provider, cwd: "/repo", permission });

  test("fail is the unattended mode, auto the auto mode, wait the default mode", async () => {
    expect(await target("claude", "fail")).toBe("bypassPermissions");
    expect(await target("claude", "auto")).toBe("auto");
    expect(await target("claude", "wait")).toBe("default");
    expect(await target("codex", "fail")).toBe("full-access");
    expect(await target("codex", "auto")).toBe("auto-review");
    expect(await target("codex", "wait")).toBe("auto-review");
  });

  test("auto without an auto mode is the default mode; fail without an unattended mode is none", async () => {
    expect(await target("plain", "auto")).toBe("build");
    // A Codex too old for the auto-reviewer starts in Default Permissions, its default.
    const old = await goalPolicyModeId(
      {
        modeCatalog: async () => [{ id: "auto" }, { id: "full-access", isUnattended: true }],
        defaultModeId: async () => "auto",
      },
      { provider: "codex", cwd: "/repo", permission: "auto" },
    );
    expect(old).toBe("auto");
    expect(await target("plain", "fail")).toBeUndefined();
  });
});

describe("agent port setPermissionMode", () => {
  function setup(notice: { type: string; message: string } | null) {
    const setModes: { agentId: string; modeId: string }[] = [];
    const agent = { id: "agent-1", provider: "codex", cwd: "/repo/ws" };
    const deps = {
      logger: pino({ level: "silent" }),
      modeCatalog: async () => [
        { id: "auto" },
        { id: "auto-review" },
        { id: "full-access", isUnattended: true },
      ],
      defaultModeId: async () => "auto-review",
      agentManager: {
        getAgent: (agentId: string) => (agentId === agent.id ? agent : null),
        setAgentMode: async (agentId: string, modeId: string) => {
          setModes.push({ agentId, modeId });
          return notice;
        },
      },
    } as unknown as GoalPortDeps;
    return { port: createGoalAgentPort(deps), setModes };
  }

  test("sets the policy's mode the way the mode picker does, and reports a next-turn switch", async () => {
    const midTurn = setup({ type: "warning", message: "Permission mode applies next turn" });
    expect(await midTurn.port.setPermissionMode("agent-1", "fail")).toEqual({
      modeId: "full-access",
      nextTurn: true,
    });
    expect(midTurn.setModes).toEqual([{ agentId: "agent-1", modeId: "full-access" }]);

    const idle = setup(null);
    expect(await idle.port.setPermissionMode("agent-1", "auto")).toEqual({
      modeId: "auto-review",
      nextTurn: false,
    });
  });
});
