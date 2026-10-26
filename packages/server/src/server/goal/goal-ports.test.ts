import { describe, expect, test } from "vitest";
import pino from "pino";
import {
  createGoalAgentPort,
  createGoalWorkspacePort,
  settleTurn,
  toTurnUsage,
  watchTurn,
  type GoalPortDeps,
} from "./goal-ports.js";
import type { AgentManagerEvent } from "../agent/agent-manager.js";

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
  function setup(reported: { runtime?: string | null; config?: string } = {}) {
    const calls: Record<string, unknown>[] = [];
    const deps = {
      logger: pino({ level: "silent" }),
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
});
