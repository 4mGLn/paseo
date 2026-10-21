import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Goal, GoalConfig } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import {
  GoalManager,
  type CreateGoalAgentInput,
  type CreateGoalWorkspaceInput,
  type ManagerAgentPort,
  type ManagerWorkspacePort,
  type TurnResult,
} from "./goal-manager.js";
import type { CapturedChange, CommandOutcome, GitPort, MergeOutcome } from "./git-ops.js";
import { GoalService } from "./goal-service.js";
import { GoalStore } from "./goal-store.js";
import type { Clock } from "./goal-limits.js";

export const CONFIG: GoalConfig = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: true,
  notifyLead: true,
  // Tests do not wait through retry backoff.
  limits: { retryBackoffSeconds: 0 },
};

export function planBlock(tasks: unknown[]): string {
  return `Here is the plan.\n\`\`\`json\n${JSON.stringify({ tasks })}\n\`\`\``;
}

export const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  description: `do ${id}`,
  kind: "implement",
  dependsOn: [],
  ...extra,
});

export interface Turn {
  agentId: string;
  prompt: string;
  provider: string;
  resolve(result: TurnResult): void;
}

/** Fake ports. Turns resolve through `respond`, or wait to be resolved by hand. */
/** A clock that only moves when a test advances it. */
export class FakeClock implements Clock {
  private time = Date.now();
  private timers: { at: number; fn: () => void; live: boolean }[] = [];

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { at: this.time + ms, fn, live: true };
    this.timers.push(timer);
    return () => {
      timer.live = false;
    };
  }

  /** Move time forward, firing every timer that comes due. */
  advance(ms: number): void {
    this.time += ms;
    for (const timer of this.timers.filter((t) => t.live && t.at <= this.time)) {
      timer.live = false;
      timer.fn();
    }
  }
}

/** A git stand-in. Every capture reports new work; merges and commands succeed unless queued otherwise. */
export class FakeGit implements GitPort {
  captured: { cwd: string; integrationCommit: string }[] = [];
  merges: { cwd: string; commit: string }[] = [];
  resets: { cwd: string; commit: string }[] = [];
  commands: { cwd: string; command: string }[] = [];
  mergeQueue: MergeOutcome[] = [];
  commandQueue: CommandOutcome[] = [];
  captureQueue: (CapturedChange | null)[] = [];
  /** Next synthetic commit number; a restarted test sets this past the commits already recorded. */
  counter = 1;

  /** Simulated HEAD per working directory. Directories not listed use `headValue`. */
  heads = new Map<string, string>();

  async capture(input: { cwd: string; integrationCommit: string }): Promise<CapturedChange | null> {
    this.captured.push(input);
    const next = this.captureQueue.length > 0 ? (this.captureQueue.shift() ?? null) : undefined;
    const n = this.counter++;
    const change =
      next === undefined
        ? {
            branch: `task-branch-${n}`,
            baseCommit: "base0",
            headCommit: `head-${n}`,
            files: [{ status: "A", path: `file-${n}.txt` }],
          }
        : next;
    if (change) this.heads.set(input.cwd, change.headCommit);
    return change;
  }
  killed: (string | undefined)[] = [];
  killCommands(key?: string): void {
    this.killed.push(key);
  }

  dirty = false;
  /** Report the tree dirty for the next N isClean checks. */
  dirtyNext = 0;
  async isClean(): Promise<boolean> {
    if (this.dirtyNext > 0) {
      this.dirtyNext -= 1;
      return false;
    }
    return !this.dirty;
  }
  /** The simulated integration worktree head; a restarted test sets it to the recorded head. */
  headValue = "base0";
  async head(cwd?: string): Promise<string> {
    return (cwd ? this.heads.get(cwd) : undefined) ?? this.headValue;
  }
  async currentBranch(): Promise<string> {
    return "paseo-goal/integration";
  }
  async merge(input: { cwd: string; commit: string }): Promise<MergeOutcome> {
    this.merges.push(input);
    const outcome = this.mergeQueue.shift() ?? {
      ok: true,
      headCommit: `merged-${this.merges.length}`,
    };
    if (outcome.ok) {
      this.headValue = outcome.headCommit;
      this.heads.set(input.cwd, outcome.headCommit);
    }
    return outcome;
  }
  async resetHard(input: { cwd: string; commit: string }): Promise<void> {
    this.resets.push(input);
    this.headValue = input.commit;
    this.heads.set(input.cwd, input.commit);
  }
  async runCommand(input: { cwd: string; command: string; key?: string }): Promise<CommandOutcome> {
    this.commands.push(input);
    return this.commandQueue.shift() ?? { exitCode: 0, timedOut: false, output: "ok" };
  }
}

export class Harness {
  /** Make the next createAgent call fail. */
  failNextCreate: Error | null = null;
  /** Simulate a provider that keeps running after it is told to stop. */
  ignoreCancel = false;
  git = new FakeGit();
  agents: (CreateGoalAgentInput & { agentId: string })[] = [];
  workspaces: (CreateGoalWorkspaceInput & { workspaceId: string })[] = [];
  archived: string[] = [];
  canceled: string[] = [];
  notified: { agentId: string; text: string }[] = [];
  turns: Turn[] = [];
  active = 0;
  peakActive = 0;
  respond: ((turn: Omit<Turn, "resolve">) => TurnResult | "hold") | null = null;
  private nextId = 1;

  agentPort: ManagerAgentPort = {
    createAgent: async (input) => {
      if (this.failNextCreate) {
        const error = this.failNextCreate;
        this.failNextCreate = null;
        throw error;
      }
      const agentId = `agent-${this.nextId++}`;
      this.agents.push({ ...input, agentId });
      return { agentId };
    },
    runTurn: (agentId, prompt) => {
      const provider = this.agents.find((a) => a.agentId === agentId)?.provider ?? "?";
      const base = { agentId, prompt, provider };
      const decided = this.respond?.(base) ?? "hold";
      if (decided !== "hold") return Promise.resolve(decided);
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return new Promise<TurnResult>((resolve) => {
        let settled = false;
        this.turns.push({
          ...base,
          // Resolving twice is a no-op, as when a cancel and a reply race.
          resolve: (result) => {
            if (settled) return;
            settled = true;
            this.active -= 1;
            resolve(result);
          },
        });
      });
    },
    knownProviders: () => ["claude", "codex", "opencode", "claude-review"],
    cancel: async (agentId) => {
      this.canceled.push(agentId);
      if (this.ignoreCancel) return;
      // Cancelling a running agent ends its turn.
      for (const turn of this.turns) {
        if (turn.agentId === agentId) turn.resolve({ outcome: "canceled" });
      }
    },
    notify: async (agentId, text) => {
      this.notified.push({ agentId, text });
    },
  };

  workspacePort: ManagerWorkspacePort = {
    create: async (input) => {
      const workspaceId = `ws-${this.nextId++}`;
      this.workspaces.push({ ...input, workspaceId });
      return { workspaceId, cwd: `${input.cwd}/${workspaceId}` };
    },
    archive: async (workspaceId) => {
      this.archived.push(workspaceId);
    },
  };
}

/** One test's isolated log directory, fakes and managers. */
export function createGoalTestEnv() {
  const harness = new Harness();
  const clock = new FakeClock();
  /** Extra GoalManager options for the next boot. */
  const managerOptions: Partial<ConstructorParameters<typeof GoalManager>[0]> = {};
  const managers: GoalManager[] = [];
  let dir = "";

  async function init(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-manager-"));
  }

  async function cleanup(): Promise<void> {
    for (const m of managers) m.stop();
    await rm(dir, { recursive: true, force: true });
  }

  async function boot(
    maxConcurrentRuns?: number,
  ): Promise<{ store: GoalStore; manager: GoalManager; service: GoalService }> {
    const log = new GoalEventLog({ dir });
    const store = new GoalStore(log);
    await store.recover();
    const manager = new GoalManager({
      store,
      agents: harness.agentPort,
      workspaces: harness.workspacePort,
      git: harness.git,
      clock,
      logger: pino({ level: "silent" }),
      ...managerOptions,
      ...(maxConcurrentRuns ? { maxConcurrentRuns } : {}),
    });
    managers.push(manager);
    await manager.start();
    return { store, manager, service: new GoalService(store, log) };
  }

  async function createGoal(
    store: GoalStore,
    config: GoalConfig | null = CONFIG,
    goalId = "g1",
  ): Promise<void> {
    await store.dispatch(goalId, {
      id: `${goalId}:created`,
      goalId,
      type: "goal.created",
      title: "Ship",
      objective: "obj",
      criteria: [{ id: "c1", text: "works" }],
      ...(config ? { config } : {}),
    });
  }

  const APPROVE = JSON.stringify({ verdict: "approve", findings: [] });
  const fenced = (json: string) => `Done.\n\`\`\`json\n${json}\n\`\`\``;

  /** Replies for the review and verification stages; override to simulate other outcomes. */
  const stageReplies = {
    review: (_turn: Omit<Turn, "resolve">): TurnResult => ({
      outcome: "completed",
      text: fenced(APPROVE),
    }),
    verify: (turn: Omit<Turn, "resolve">): TurnResult => {
      const ids = [...turn.prompt.matchAll(/^- (\w+): /gm)].map((m) => m[1]);
      const criteria = ids.map((id) => ({ id, met: true, evidence: `checked ${id}` }));
      return { outcome: "completed", text: fenced(JSON.stringify({ criteria })) };
    },
  };

  /**
   * Lead answers planning with `tasks`, the reviewer and verifier answer with
   * the replies above, and every other turn is decided by `work`.
   */
  function script(
    tasks: unknown[],
    work: (turn: Omit<Turn, "resolve">) => TurnResult | "hold" = () => ({
      outcome: "completed",
      text: "done",
    }),
  ): void {
    stageReplies.review = (_turn) => ({ outcome: "completed", text: fenced(APPROVE) });
    // An agent keeps its role across follow-up prompts such as corrections.
    const roles = new Map<string, "lead" | "reviewer" | "verifier">();
    harness.respond = (turn) => {
      if (turn.prompt.includes("You are the Lead")) roles.set(turn.agentId, "lead");
      else if (turn.prompt.includes("independent reviewer")) roles.set(turn.agentId, "reviewer");
      else if (turn.prompt.includes("You are the verifier")) roles.set(turn.agentId, "verifier");
      const role = roles.get(turn.agentId);
      if (role === "lead") return { outcome: "completed", text: planBlock(tasks) };
      if (role === "reviewer") return stageReplies.review(turn);
      if (role === "verifier") return stageReplies.verify(turn);
      return work(turn);
    };
  }

  const goalOf = (store: GoalStore, goalId = "g1"): Goal => {
    const goal = store.get(goalId);
    if (!goal) throw new Error("no goal");
    return goal;
  };

  async function settle(manager: GoalManager): Promise<void> {
    await manager.idle();
  }

  /** Every event recorded for a goal, as the log holds them. */
  async function readEvents(goalId = "g1") {
    return new GoalEventLog({ dir }).read(goalId);
  }

  /** Where this env keeps its goal logs. */
  const logDir = () => dir;

  return {
    harness,
    clock,
    managerOptions,
    init,
    cleanup,
    boot,
    createGoal,
    stageReplies,
    script,
    goalOf,
    settle,
    fenced,
    readEvents,
    logDir,
  };
}

export type GoalTestEnv = ReturnType<typeof createGoalTestEnv>;
