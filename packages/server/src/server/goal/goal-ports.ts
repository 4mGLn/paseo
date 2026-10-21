import type { Logger } from "pino";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import { ensureAgentLoaded } from "../agent/agent-loading.js";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import { startAgentRun } from "../agent/agent-prompt.js";
import { markPaseoWorktreeFirstAgentBranchAutoNameAttempted } from "../../utils/worktree-metadata.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { BoundCreateAgentCommand } from "../agent/create-agent/create.js";
import type { CreatePaseoWorktreeWorkflowResult } from "../worktree-session.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import type { ManagerAgentPort, ManagerWorkspacePort, TurnResult } from "./goal-manager.js";

interface DirectoryWorkspaceInput {
  cwd: string;
  firstAgentContext: FirstAgentContext;
}

interface WorktreeWorkspaceInput {
  cwd: string;
  firstAgentContext?: FirstAgentContext;
  branchName?: string;
  refName?: string;
  action?: "branch-off" | "checkout";
}

const PERMISSION_POLL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type TurnEnd =
  | { type: "turn_completed" }
  | { type: "turn_canceled" }
  | { type: "turn_failed"; error: string };

export interface TurnWatcher {
  /** How the turn ended according to the agent's own event stream, if it has. */
  end(): TurnEnd | null;
  stop(): void;
}

/**
 * Watches an agent's event stream for how its turn ends. The wait API reports a
 * cancelled turn as an agent that went idle, so a stop pressed in the app would
 * otherwise look like success.
 */
export function watchTurn(
  subscribe: (listener: (event: AgentManagerEvent) => void) => () => void,
): TurnWatcher {
  let end: TurnEnd | null = null;
  const unsubscribe = subscribe((event) => {
    if (end || event.type !== "agent_stream") return;
    const inner = event.event;
    if (inner.type === "turn_completed") end = { type: "turn_completed" };
    else if (inner.type === "turn_canceled") end = { type: "turn_canceled" };
    else if (inner.type === "turn_failed") end = { type: "turn_failed", error: inner.error };
  });
  return { end: () => end, stop: unsubscribe };
}

interface AgentWait {
  status: string;
  permission: unknown;
  lastMessage: string | null;
}

/**
 * Turns the next agent event into a turn result. Under the `wait` policy a
 * permission request stays pending in Paseo for a person to answer, and this
 * keeps polling while the agent is still running; the caller's turn timeout is
 * what ends a request nobody answers.
 */
export async function settleTurn(
  next: () => Promise<AgentWait>,
  policy: "fail" | "wait",
  agentId: string,
  pause: (ms: number) => Promise<void> = sleep,
  signal?: AbortSignal,
): Promise<TurnResult> {
  let wait = await next();
  if (policy === "wait") {
    while (wait.permission && wait.status === "running") {
      // The caller gave up on this turn: stop polling for a request nobody will answer.
      if (signal?.aborted) break;
      await pause(PERMISSION_POLL_MS);
      wait = await next();
    }
  }
  if (wait.permission) return { outcome: "needs_permission" };
  if (wait.status === "error") {
    return { outcome: "failed", error: wait.lastMessage ?? `Agent ${agentId} failed` };
  }
  return { outcome: "completed", text: wait.lastMessage?.trim() ?? "" };
}

export interface GoalPortDeps {
  logger: Logger;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  createAgent: BoundCreateAgentCommand;
  cancelAgentRun: (agentId: string) => Promise<unknown>;
  createDirectoryWorkspace: (input: DirectoryWorkspaceInput) => Promise<PersistedWorkspaceRecord>;
  createPaseoWorktreeWorkspace: (
    input: WorktreeWorkspaceInput,
  ) => Promise<CreatePaseoWorktreeWorkflowResult>;
  archiveWorkspace: (workspaceId: string) => Promise<void>;
  /** Resolves when the workspace's setup scripts have finished. */
  waitForWorkspaceSetup: (workspaceId: string) => Promise<void>;
}

/** A setup that never finishes must not hold a goal up forever. */
const SETUP_WAIT_MS = 5 * 60_000;

/** "codex/<model>" selects a provider and model; a bare id selects the provider only. */
function splitProviderModel(value: string): { provider: string; model?: string } {
  const slash = value.indexOf("/");
  return slash < 0
    ? { provider: value }
    : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/**
 * Worktree setup scripts start in the background just after the worktree exists.
 * Agents and merges must not run against a tree that setup is still writing to.
 */
async function waitForSetup(deps: GoalPortDeps, workspaceId: string): Promise<void> {
  // Setup is registered from a timer the worktree workflow has already queued.
  await sleep(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      deps.logger.warn({ workspaceId }, "Worktree setup did not finish in time; continuing");
      resolve();
    }, SETUP_WAIT_MS);
  });
  try {
    await Promise.race([deps.waitForWorkspaceSetup(workspaceId), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createGoalAgentPort(deps: GoalPortDeps): ManagerAgentPort {
  return {
    async createAgent(input) {
      const { provider, model } = splitProviderModel(input.provider);
      const created = await deps.createAgent({
        kind: "mcp",
        provider: input.provider,
        config: { provider, cwd: input.cwd, ...(model ? { model } : {}) },
        cwd: input.cwd,
        workspaceId: input.workspaceId,
        title: input.title,
        labels: input.labels,
        unattended: true,
        promptFailure: "return-error",
        notifyOnFinish: false,
      });
      return { agentId: created.snapshot.id };
    },

    async runTurn(agentId, prompt, options): Promise<TurnResult> {
      // runAgent would block on a pending permission; starting the turn and
      // waiting for the next agent event returns as soon as one is requested.
      const watcher = watchTurn((listener) => deps.agentManager.subscribe(listener, { agentId }));
      try {
        await startAgentRun(deps.agentManager, agentId, prompt, deps.logger);
        const result = await settleTurn(
          () => deps.agentManager.waitForAgentEvent(agentId, { waitForActive: true }),
          options?.permission ?? "fail",
          agentId,
          undefined,
          options?.signal,
        );
        const end = watcher.end();
        if (end?.type === "turn_canceled") return { outcome: "canceled" };
        if (end?.type === "turn_failed") return { outcome: "failed", error: end.error };
        return result;
      } finally {
        watcher.stop();
      }
    },

    knownProviders: () => deps.agentManager.getRegisteredProviderIds(),

    async cancel(agentId) {
      await deps.cancelAgentRun(agentId);
    },

    async notify(agentId, text) {
      const agent = await ensureAgentLoaded(agentId, {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
      });
      // Resolves once the prompt is steered into the running turn or has started a new one.
      const { disposition } = await startAgentRun(
        deps.agentManager,
        agent.id,
        formatSystemNotificationPrompt(text),
        deps.logger,
        { activeTurnBehavior: "steer" },
      );
      if (disposition === "out_of_band") {
        throw new Error(`Agent ${agentId} handled the notification as a command, not a prompt`);
      }
    },
  };
}

export function createGoalWorkspacePort(deps: GoalPortDeps): ManagerWorkspacePort {
  return {
    async create(input) {
      const firstAgentContext: FirstAgentContext = { prompt: input.title };
      if (input.isolation !== "worktree") {
        const workspace = await deps.createDirectoryWorkspace({
          cwd: input.cwd,
          firstAgentContext,
        });
        return { workspaceId: workspace.workspaceId, cwd: workspace.cwd };
      }
      const result = await deps.createPaseoWorktreeWorkspace({
        cwd: input.cwd,
        // Without a first-agent context the branch auto-namer is never scheduled.
        ...(input.keepBranchName ? {} : { firstAgentContext }),
        ...(input.branchName ? { branchName: input.branchName } : {}),
        ...(input.baseRef ? { refName: input.baseRef, action: "branch-off" as const } : {}),
      });
      if (input.keepBranchName) {
        // Creating an agent here later must not trigger a rename either.
        try {
          markPaseoWorktreeFirstAgentBranchAutoNameAttempted(result.worktree.worktreePath);
        } catch (error) {
          // The branch name is a convenience, not something worth failing the goal over.
          deps.logger.warn({ err: error }, "Could not pin the integration branch name");
        }
      }
      await waitForSetup(deps, result.workspace.workspaceId);
      return { workspaceId: result.workspace.workspaceId, cwd: result.workspace.cwd };
    },
    archive: (workspaceId) => deps.archiveWorkspace(workspaceId),
  };
}
