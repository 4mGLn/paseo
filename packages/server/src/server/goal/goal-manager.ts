import type pino from "pino";
import type {
  Goal,
  GoalEvent,
  GoalEventInput,
  NotificationTarget,
  Task,
  TurnUsage,
  UsageRole,
} from "@getpaseo/protocol/goal/types";
import {
  budgetExceeded,
  goalDeadlineMs,
  resolveLimits,
  systemClock,
  type Clock,
} from "./goal-limits.js";
import {
  GoalTransitionError,
  MAX_NOTIFICATION_ATTEMPTS,
  NOTIFICATION_BACKOFF_MS,
  countedFailures,
  isTerminalGoalStatus,
} from "./goal-reducer.js";
import type { GoalStore } from "./goal-store.js";
import { ChangeSetPipeline } from "./change-set-pipeline.js";
import type { GitPort } from "./git-ops.js";
import { PlanParseError, extractPlan } from "./plan-extract.js";
import { buildReworkPrompt } from "./review.js";
import {
  buildLeadNotification,
  buildLeadPlanningPrompt,
  buildPlanCorrectionPrompt,
  buildTaskPrompt,
  truncateSummary,
} from "./prompts.js";
import { blockedTasks, readyTasks } from "./task-graph.js";

export type TurnResult = (
  | { outcome: "completed"; text: string }
  | { outcome: "failed"; error: string }
  | { outcome: "canceled" }
  | { outcome: "needs_permission" }
) & {
  /** What the provider reported for the turn; absent when it reported nothing. */
  usage?: TurnUsage;
};

export interface CreateGoalAgentInput {
  provider: string;
  cwd: string;
  workspaceId: string;
  title: string;
  labels: Record<string, string>;
}

/** What the Manager needs from Paseo's agent layer. */
export interface ManagerAgentPort {
  createAgent(input: CreateGoalAgentInput): Promise<{ agentId: string }>;
  /**
   * Sends the prompt and resolves when the agent's turn ends. When the agent asks
   * for a permission, `fail` returns `needs_permission` and `wait` keeps waiting
   * until a person has answered in Paseo.
   */
  runTurn(
    agentId: string,
    prompt: string,
    options?: { permission?: "fail" | "wait"; signal?: AbortSignal },
  ): Promise<TurnResult>;
  cancel(agentId: string): Promise<void>;
  /**
   * Tell an agent something without waiting for it to answer. Resolves once the
   * agent layer has accepted the prompt; rejects with the reason it did not.
   */
  notify(agentId: string, text: string): Promise<void>;
  /** Provider ids a plan may name. */
  knownProviders(): string[];
}

export interface CreateGoalWorkspaceInput {
  cwd: string;
  /** "reference" shares the repository checkout; "worktree" cuts an isolated one. */
  isolation: "reference" | "worktree";
  title: string;
  /** Name for the new worktree's branch. */
  branchName?: string;
  /** Branch or commit a new worktree starts from; defaults to the repository's default branch. */
  baseRef?: string;
  /** Keep the branch name given: do not let Paseo's first-agent auto-namer rename it. */
  keepBranchName?: boolean;
}

export interface ManagerWorkspacePort {
  create(input: CreateGoalWorkspaceInput): Promise<{ workspaceId: string; cwd: string }>;
  archive(workspaceId: string): Promise<void>;
}

export interface GoalManagerOptions {
  store: GoalStore;
  agents: ManagerAgentPort;
  workspaces: ManagerWorkspacePort;
  git: GitPort;
  logger: pino.Logger;
  /** Ceiling on simultaneous runs across all goals. */
  maxConcurrentRuns?: number;
  /** Time allowed for a goal's test command. */
  testTimeoutMs?: number;
  /** Time source for timeouts and retry backoff. */
  clock?: Clock;
  /** How long a cancelled turn may take to stop before it is abandoned. */
  cancelGraceMs?: number;
}

const MAX_PLAN_ATTEMPTS = 3;

/** The longest delay a Node timer accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type DispatchOutcome = "new" | "duplicate" | "rejected";

/** A live execution attempt in this process. */
interface LiveRun {
  goalId: string;
  agentId: string | null;
  workspaceId: string | null;
  /** False for rework, which continues in a worktree that belongs to the change set. */
  ownsWorkspace: boolean;
  /** Read and review tasks leave nothing behind, so their worktree is removed on success. */
  disposable: boolean;
  cwd?: string;
  /** Set when the goal ended while the run was being set up or running. */
  canceled: boolean;
}

interface LiveLead {
  agentId: string | null;
  canceled: boolean;
}

/**
 * The Manager. It reacts to committed Goal events and answers with new events;
 * the agents it drives do the reasoning, it only schedules, records, retries and
 * recovers. Event ids are derived from run and task ids so a repeated reaction
 * is a no-op in the log.
 *
 * Shutdown contract: after stop(), nothing is recorded about runs that were in
 * flight. They stay `running` in the log and the next start() closes them out as
 * interrupted, so a restart is never mistaken for an agent failure.
 */
export class GoalManager {
  private readonly store: GoalStore;
  private readonly agents: ManagerAgentPort;
  private readonly workspaces: ManagerWorkspacePort;
  private readonly logger: pino.Logger;
  private readonly maxConcurrentRuns: number;
  private readonly inFlight = new Map<string, LiveRun>();
  private readonly leads = new Map<string, LiveLead>();
  private readonly pipeline: ChangeSetPipeline;
  private readonly pumpQueues = new Map<string, Promise<unknown>>();
  private readonly settled = new Set<Promise<unknown>>();
  private readonly clock: Clock;
  private readonly deadlines = new Map<string, () => void>();
  /** Retries waiting out their backoff, keyed `<goal>:<task>`. A restart re-creates them. */
  private readonly retries = new Map<string, () => void>();
  /** Notifications waiting out their backoff, keyed `<goal>:<target>:<key>`. A restart re-creates them. */
  private readonly notificationRetries = new Map<string, () => void>();
  /** Notifications with an attempt in progress, so one is never sent twice at once. */
  private readonly delivering = new Set<string>();
  private readonly cancelGraceMs: number;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;

  constructor(options: GoalManagerOptions) {
    this.store = options.store;
    this.agents = options.agents;
    this.workspaces = options.workspaces;
    this.logger = options.logger.child({ module: "goal-manager" });
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 4;
    this.clock = options.clock ?? systemClock;
    this.cancelGraceMs = options.cancelGraceMs ?? 30_000;
    this.pipeline = new ChangeSetPipeline({
      store: options.store,
      agents: options.agents,
      workspaces: options.workspaces,
      git: options.git,
      logger: options.logger,
      testTimeoutMs: options.testTimeoutMs,
      host: {
        dispatchOutcome: (goalId, input) => this.dispatchOutcome(goalId, input),
        dispatch: (goalId, input) => this.dispatch(goalId, input),
        track: (work) => this.track(work),
        isStopped: () => this.stopped,
        failGoal: (goalId, reason) => this.failGoal(goalId, reason),
        requestPump: (goalId) => this.track(this.pump(goalId)),
        discard: (agentId, workspaceId) => this.discard(agentId, workspaceId),
        runTurn: (goalId, agentId, prompt, role) => this.turn(goalId, agentId, prompt, { role }),
        notifyLeadFinal: (goal, text) => this.track(this.notifyLeadFinal(goal, text)),
      },
    });
  }

  /** Begin reacting to events, then repair and resume every live goal. */
  async start(): Promise<void> {
    this.stopped = false;
    this.unsubscribe = this.store.subscribe((goal, event) => this.onEvent(goal, event));
    for (const goal of this.store.list()) {
      if (goal.config && !isTerminalGoalStatus(goal.status)) {
        this.armDeadline(goal);
        // One goal's trouble must not keep the daemon, and every other goal, from starting.
        await this.recover(goal.id).catch(async (error) => {
          this.logger.error({ err: error, goalId: goal.id }, "Goal recovery failed");
          await this.failGoal(goal.id, `Recovery failed: ${errorMessage(error)}`);
        });
      }
    }
    // Ended goals too: their outcome may still be on its way to the Lead or the chat.
    for (const goal of this.store.list()) this.resumeNotifications(goal);
  }

  /**
   * Stop reacting. In-flight agent turns are not awaited and nothing more is
   * recorded for them; see the shutdown contract above.
   */
  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const cancel of this.deadlines.values()) cancel();
    this.deadlines.clear();
    // Retries still backing off are found again by the next start.
    for (const cancel of this.retries.values()) cancel();
    this.retries.clear();
    for (const cancel of this.notificationRetries.values()) cancel();
    this.notificationRetries.clear();
    this.pipeline.shutdown();
  }

  // ---- time -------------------------------------------------------------

  /** Fail the goal when its overall time limit passes. */
  private armDeadline(goal: Goal): void {
    if (!goal.config || this.deadlines.has(goal.id)) return;
    const remaining = goalDeadlineMs(goal) - this.clock.now();
    const cancel = this.clock.setTimeout(
      () => {
        this.deadlines.delete(goal.id);
        const current = this.store.get(goal.id);
        if (!current || isTerminalGoalStatus(current.status) || this.stopped) return;
        // Timers cannot wait longer than about 24 days; if the clock jumped, look again.
        if (goalDeadlineMs(current) - this.clock.now() > 0) {
          this.armDeadline(current);
          return;
        }
        this.track(this.failGoal(goal.id, describeDeadline(current)));
      },
      Math.min(Math.max(0, remaining), MAX_TIMER_MS),
    );
    this.deadlines.set(goal.id, cancel);
  }

  private clearDeadline(goalId: string): void {
    this.deadlines.get(goalId)?.();
    this.deadlines.delete(goalId);
  }

  /**
   * Retry a failed task after its backoff. The task waits as `failed` with no run
   * and no slot held; a restart finds it and retries it at once.
   */
  private async scheduleRetry(
    goalId: string,
    taskId: string,
    runId: string,
    delayMs: number,
  ): Promise<void> {
    const retry = () =>
      this.dispatch(goalId, {
        id: `${runId}:task-retried`,
        goalId,
        type: "task.retried",
        taskId,
      });
    if (delayMs <= 0) {
      await retry();
      return;
    }
    const key = `${goalId}:${taskId}`;
    const cancel = this.clock.setTimeout(() => {
      this.retries.delete(key);
      if (!this.stopped) this.track(retry());
    }, delayMs);
    this.retries.set(key, cancel);
  }

  private cancelRetry(goalId: string, taskId: string): void {
    const key = `${goalId}:${taskId}`;
    this.retries.get(key)?.();
    this.retries.delete(key);
  }

  private cancelRetries(goalId: string): void {
    for (const [key, cancel] of this.retries) {
      if (!key.startsWith(`${goalId}:`)) continue;
      cancel();
      this.retries.delete(key);
    }
  }

  /**
   * One agent turn under the goal's time limit and permission policy. A turn
   * that overruns is cancelled and reported as a failure.
   */
  private async turn(
    goalId: string,
    agentId: string,
    prompt: string,
    usage: { role: UsageRole; runId?: string },
  ): Promise<TurnResult> {
    // Keyed by the goal's position when the turn started: one agent never starts two turns there.
    const usageEventId = `${goalId}:usage:${agentId}:${this.store.get(goalId)?.lastSeq ?? 0}`;
    const result = await this.timedTurn(goalId, agentId, prompt);
    if (!this.stopped) {
      await this.dispatch(goalId, {
        id: usageEventId,
        goalId,
        type: "usage.recorded",
        role: usage.role,
        agentId,
        ...(usage.runId ? { runId: usage.runId } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
      });
    }
    return result;
  }

  private async timedTurn(goalId: string, agentId: string, prompt: string): Promise<TurnResult> {
    const config = this.store.get(goalId)?.config;
    const { runTimeoutMs } = resolveLimits(config);
    const minutes = Math.round(runTimeoutMs / 60_000);
    const abort = new AbortController();
    let timedOut = false;
    let cancelGrace: () => void = () => {};
    let giveUp: (result: TurnResult) => void = () => {};
    // An agent that ignores a cancel must not hold its slot forever: after a grace
    // period the turn is abandoned and reported as a failure.
    const abandoned = new Promise<TurnResult>((resolve) => {
      giveUp = resolve;
    });
    const cancelTimer = this.clock.setTimeout(() => {
      timedOut = true;
      this.agents.cancel(agentId).catch((error) => {
        this.logger.warn({ err: error, agentId }, "Failed to cancel a timed-out agent");
      });
      cancelGrace = this.clock.setTimeout(() => {
        abort.abort();
        giveUp({
          outcome: "failed",
          error: `Turn timed out after ${minutes} minutes and the agent did not stop`,
        });
      }, this.cancelGraceMs);
    }, runTimeoutMs);
    const running = this.agents.runTurn(agentId, prompt, {
      permission: config?.onPermissionRequest ?? "fail",
      signal: abort.signal,
    });
    // If the turn is abandoned, its eventual outcome is of no interest.
    running.catch(() => {});
    try {
      const result = await Promise.race([running, abandoned]);
      return timedOut && result.outcome !== "failed"
        ? { outcome: "failed", error: `Turn timed out after ${minutes} minutes` }
        : result;
    } finally {
      cancelTimer();
      cancelGrace();
      abort.abort();
    }
  }

  /** Resolves when no reaction work is outstanding, including running agent turns. For tests. */
  async idle(): Promise<void> {
    while (this.settled.size > 0) {
      await Promise.allSettled(this.settled);
    }
  }

  private track(work: Promise<unknown>): void {
    const tracked = work.catch((error) => {
      this.logger.error({ err: error }, "Goal manager task failed");
    });
    this.settled.add(tracked);
    void tracked.finally(() => this.settled.delete(tracked));
  }

  private onEvent(goal: Goal, event: GoalEvent): void {
    if (!goal.config || this.stopped) return;
    this.pipeline.onEvent(goal, event);
    switch (event.type) {
      case "goal.created":
        this.armDeadline(goal);
        this.track(this.plan(goal.id));
        break;
      case "plan.rejected":
        this.track(this.plan(goal.id));
        break;
      case "plan.proposed":
        if (goal.config.autoApprovePlan) {
          this.track(
            this.dispatch(goal.id, {
              id: `${goal.id}:auto-approve:${event.id}`,
              goalId: goal.id,
              type: "plan.approved",
            }),
          );
        }
        break;
      case "plan.approved":
      case "task.added":
      case "task.succeeded":
      case "task.retried":
      case "task.failed":
      case "task.cancelled":
        this.track(this.pump(goal.id));
        break;
      case "goal.completed":
        this.clearDeadline(goal.id);
        this.track(this.notifyOrigin(goal, "completed"));
        break;
      case "goal.cancelled":
      case "goal.failed":
        this.clearDeadline(goal.id);
        this.track(
          this.notifyOrigin(
            goal,
            event.type === "goal.failed"
              ? `failed: ${goal.failureReason ?? "unknown reason"}`
              : "cancelled",
          ),
        );
        this.track(this.abortGoalWork(goal.id));
        this.track(this.pipeline.abort(goal.id));
        break;
      default:
        this.onControlEvent(goal, event);
        break;
    }
  }

  /** Reactions to a person's controls and to recorded usage. */
  private onControlEvent(goal: Goal, event: GoalEvent): void {
    if (event.type === "goal.resumed") {
      this.track(this.pump(goal.id));
    } else if (event.type === "goal.retried") {
      for (const taskId of event.taskIds) this.cancelRetry(goal.id, taskId);
      if (event.reopen) {
        this.armDeadline(goal);
        this.track(this.resumeReopened(goal.id));
      } else {
        this.track(this.pump(goal.id));
      }
    } else if (event.type === "usage.recorded") {
      const overBudget = budgetExceeded(goal);
      if (overBudget) this.track(this.failGoal(goal.id, overBudget));
    }
  }

  private async dispatchOutcome(goalId: string, input: GoalEventInput): Promise<DispatchOutcome> {
    try {
      const { duplicate } = await this.store.dispatch(goalId, input);
      return duplicate ? "duplicate" : "new";
    } catch (error) {
      // The goal was cancelled or failed while this work was in flight.
      if (error instanceof GoalTransitionError) {
        this.logger.debug({ goalId, type: input.type, reason: error.message }, "Event dropped");
        return "rejected";
      }
      throw error;
    }
  }

  /** True when the event is recorded, whether now or on an earlier delivery. */
  private async dispatch(goalId: string, input: GoalEventInput): Promise<boolean> {
    return (await this.dispatchOutcome(goalId, input)) !== "rejected";
  }

  // ---- planning ---------------------------------------------------------

  private async plan(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (this.stopped || !goal?.config || goal.status !== "planning" || this.leads.has(goalId)) {
      return;
    }
    const { config } = goal;
    const lead: LiveLead = { agentId: null, canceled: false };
    this.leads.set(goalId, lead);
    try {
      // Planning again (the plan was rejected): the earlier Lead and its worktree are done.
      if (goal.leadAgentId || goal.leadWorkspaceId) {
        await this.discard(goal.leadAgentId, goal.leadWorkspaceId);
      }
      const workspace = await this.workspaces.create({
        cwd: config.cwd,
        // The Lead reads the repository in its own worktree, so no agent works in your checkout.
        isolation: "worktree",
        title: `${goal.title} (lead)`,
        ...(config.baseCommit ? { baseRef: config.baseCommit } : {}),
      });
      const { agentId } = await this.agents
        .createAgent({
          provider: config.leadProvider,
          cwd: workspace.cwd,
          workspaceId: workspace.workspaceId,
          title: `Lead: ${goal.title}`,
          labels: { "paseo.goal-id": goalId, "paseo.goal-role": "lead" },
        })
        .catch(async (error) => {
          // Do not strand the worktree made for an agent that never started.
          await this.discard(null, workspace.workspaceId);
          throw error;
        });
      lead.agentId = agentId;
      const attached =
        !lead.canceled &&
        !this.stopped &&
        (await this.dispatch(goalId, {
          id: `${goalId}:lead:${goal.lastSeq}`,
          goalId,
          type: "lead.attached",
          agentId,
          workspaceId: workspace.workspaceId,
        }));
      if (!attached) {
        if (!this.stopped) await this.discard(agentId, workspace.workspaceId);
        return;
      }
      await this.planWithLead(goal, agentId, lead);
    } catch (error) {
      if (!this.stopped && !lead.canceled) {
        await this.failGoal(goalId, `Planning failed: ${errorMessage(error)}`);
      }
    } finally {
      this.leads.delete(goalId);
    }
  }

  private async planWithLead(goal: Goal, agentId: string, lead: LiveLead): Promise<void> {
    let prompt = buildLeadPlanningPrompt(goal);
    let problem = "";
    for (let attempt = 0; attempt < MAX_PLAN_ATTEMPTS; attempt += 1) {
      const result = await this.turn(goal.id, agentId, prompt, { role: "lead" });
      if (this.stopped || lead.canceled || this.store.get(goal.id)?.status !== "planning") return;
      if (result.outcome !== "completed") {
        await this.failGoal(goal.id, `Lead agent did not finish planning (${result.outcome}).`);
        return;
      }
      try {
        const tasks = extractPlan(
          result.text,
          this.providersFor(goal),
          resolveLimits(goal.config).maxTasks,
        );
        await this.dispatch(goal.id, {
          id: `${goal.id}:plan-proposed:${goal.lastSeq}:${attempt}`,
          goalId: goal.id,
          type: "plan.proposed",
          tasks,
        });
        return;
      } catch (error) {
        if (!(error instanceof PlanParseError)) throw error;
        problem = error.message;
        prompt = buildPlanCorrectionPrompt(problem);
      }
    }
    await this.failGoal(goal.id, `Lead did not produce a valid plan: ${problem}`);
  }

  /** Providers a plan may name: the registered ones, narrowed by the goal's allow-list. */
  private providersFor(goal: Goal): string[] {
    const allowed = goal.config?.allowedProviders;
    const known = this.agents.knownProviders();
    return allowed ? known.filter((p) => allowed.includes(p)) : known;
  }

  // ---- execution --------------------------------------------------------

  private pumpAllExecuting(): void {
    for (const goal of this.store.list()) {
      if (goal.config && goal.status === "executing") this.track(this.pump(goal.id));
    }
  }

  /** Start every task that is ready and fits under the parallelism limits. */
  private pump(goalId: string): Promise<void> {
    const previous = this.pumpQueues.get(goalId) ?? Promise.resolve();
    const run = previous.then(() => this.pumpNow(goalId));
    this.pumpQueues.set(
      goalId,
      run.catch(() => undefined),
    );
    return run;
  }

  /** Ready tasks whose implement dependencies are already on the integration branch. */
  private launchable(goal: Goal): Task[] {
    return readyTasks(goal.tasks).filter((task) =>
      this.pipeline.dependenciesIntegrated(goal, task),
    );
  }

  private liveRunsFor(goalId: string): number {
    let count = 0;
    for (const run of this.inFlight.values()) if (run.goalId === goalId) count += 1;
    return count;
  }

  private async pumpNow(goalId: string): Promise<void> {
    if (this.stopped) return;
    const goal = this.store.get(goalId);
    if (!goal?.config || goal.status !== "executing") return;
    // A paused goal starts nothing, and is neither completed nor failed for being stuck.
    if (goal.pausedAt) return;

    for (const task of this.launchable(goal)) {
      // Capacity is re-read on every pass: a launch claims its slot before it
      // first awaits, so concurrent pumps for other goals cannot oversubscribe.
      if (
        this.inFlight.size >= this.maxConcurrentRuns ||
        this.liveRunsFor(goalId) >= goal.config.maxParallel
      ) {
        break;
      }
      await this.launch(goalId, task);
    }

    const latest = this.store.get(goalId);
    if (latest) await this.settleIfStuck(latest);
  }

  private async launch(goalId: string, task: Task): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal?.config) return;
    const { maxRuns } = resolveLimits(goal.config);
    if (goal.runs.length >= maxRuns) {
      await this.failGoal(goalId, `Run limit of ${maxRuns} reached`);
      return;
    }
    const overBudget = budgetExceeded(goal);
    if (overBudget) {
      await this.failGoal(goalId, overBudget);
      return;
    }
    const runId = `${task.id}-a${task.attempts + 1}`;
    const provider = task.provider ?? goal.config.defaultProvider;
    // Claim the slot before the first await.
    const live: LiveRun = {
      goalId,
      agentId: null,
      workspaceId: null,
      ownsWorkspace: !task.rework,
      disposable: task.kind !== "implement",
      canceled: false,
    };
    // Run ids are only unique within a goal, so the slot key includes the goal.
    const slot = `${goalId}:${runId}`;
    this.inFlight.set(slot, live);
    try {
      const started =
        (await this.dispatch(goalId, {
          id: `${goalId}:${runId}:task-started`,
          goalId,
          type: "task.started",
          taskId: task.id,
        })) &&
        (await this.dispatch(goalId, {
          id: `${goalId}:${runId}:run-started`,
          goalId,
          type: "run.started",
          runId,
          taskId: task.id,
          provider,
        }));
      if (!started) {
        this.inFlight.delete(slot);
        return;
      }
    } catch (error) {
      this.inFlight.delete(slot);
      throw error;
    }
    this.track(
      this.executeRun(goalId, task.id, runId, provider, live).finally(() => {
        this.inFlight.delete(slot);
        // A freed slot may unblock this goal or any other waiting for capacity.
        this.pumpAllExecuting();
      }),
    );
  }

  private isGoalLive(goalId: string): boolean {
    return this.store.get(goalId)?.status === "executing";
  }

  private async executeRun(
    goalId: string,
    taskId: string,
    runId: string,
    provider: string,
    live: LiveRun,
  ): Promise<void> {
    try {
      const goal = this.store.get(goalId);
      const task = goal?.tasks.find((t) => t.id === taskId);
      if (!goal?.config || !task) return;
      const alive = () => !live.canceled && !this.stopped && this.isGoalLive(goalId);

      const workspace = await this.workspaceFor(goal, task);
      live.workspaceId = workspace.workspaceId;
      live.cwd = workspace.cwd;
      if (!alive()) return await this.abandon(live, this.stopped);

      const { agentId } = await this.agents.createAgent({
        provider,
        cwd: workspace.cwd,
        workspaceId: workspace.workspaceId,
        title: `${goal.title}: ${task.title}`,
        labels: {
          "paseo.goal-id": goalId,
          "paseo.goal-task": taskId,
          "paseo.goal-run": runId,
        },
      });
      live.agentId = agentId;
      if (!alive()) return await this.abandon(live, this.stopped);
      const attached = await this.dispatch(goalId, {
        id: `${runId}:attached`,
        goalId,
        type: "run.attached",
        runId,
        agentId,
        workspaceId: workspace.workspaceId,
        cwd: workspace.cwd,
      });
      if (!attached || !alive()) return await this.abandon(live, this.stopped);

      const result = await this.turn(goalId, agentId, this.promptFor(goal, task), {
        role: "worker",
        runId,
      });
      if (this.stopped) return;
      if (live.canceled || !this.isGoalLive(goalId)) return await this.abandon(live, false);

      if (result.outcome === "completed") {
        // The task is settled first: a crash after this point leaves a run that
        // recovery closes as succeeded, not a finished task that gets re-run.
        await this.completeRun(goalId, task, runId, live, result.text);
        return;
      }
      await this.failRun(goalId, taskId, runId, live, describeFailure(result));
    } catch (error) {
      if (this.stopped) return;
      await this.failRun(goalId, taskId, runId, live, errorMessage(error));
    }
  }

  /** Reuse the worktree of the change a rework task fixes; otherwise make a new workspace. */
  private async workspaceFor(
    goal: Goal,
    task: Task,
  ): Promise<{ workspaceId: string; cwd: string }> {
    const changeSet = goal.changeSets.find((c) => c.id === task.rework?.changeSetId);
    if (changeSet) return { workspaceId: changeSet.workspaceId, cwd: changeSet.cwd };
    // Every task gets its own worktree, so an unattended agent never works in the
    // user's checkout. Read and review tasks get theirs too, at the latest integrated
    // commit so they see the work they are asked about. Commits are used, not the
    // branch name, which Paseo may rename.
    return this.workspaces.create({
      cwd: goal.config?.cwd ?? "",
      isolation: "worktree",
      title: task.title,
      ...baseRefFor(goal),
    });
  }

  private promptFor(goal: Goal, task: Task): string {
    const changeSet = goal.changeSets.find((c) => c.id === task.rework?.changeSetId);
    return changeSet
      ? buildReworkPrompt(goal, task, changeSet, goal.integration?.headCommit ?? null)
      : buildTaskPrompt(goal, task);
  }

  /**
   * The task is settled first, so a crash after it leaves a run recovery closes
   * as succeeded. An implement task's work is then captured as a change set
   * before dependents are allowed to start.
   */
  private async completeRun(
    goalId: string,
    task: Task,
    runId: string,
    live: LiveRun,
    text: string,
  ): Promise<void> {
    const captures = task.kind === "implement" && live.workspaceId !== null;
    if (captures) this.pipeline.beginCapture(goalId, task.id);
    try {
      await this.dispatch(goalId, {
        id: `${runId}:task-succeeded`,
        goalId,
        type: "task.succeeded",
        taskId: task.id,
        summary: truncateSummary(text),
      });
      await this.dispatch(goalId, {
        id: `${runId}:finished`,
        goalId,
        type: "run.finished",
        runId,
        outcome: "succeeded",
      });
      if (live.disposable && live.ownsWorkspace) await this.discard(null, live.workspaceId);
      if (captures && live.workspaceId) {
        const current = this.store.get(goalId)?.tasks.find((t) => t.id === task.id) ?? task;
        const cwd = await this.cwdOf(goalId, current, live);
        await this.pipeline.capture({
          goalId,
          task: current,
          runId,
          workspaceId: live.workspaceId,
          cwd,
        });
      }
    } catch (error) {
      if (!this.stopped) {
        await this.failGoal(
          goalId,
          `Could not capture changes of ${task.id}: ${errorMessage(error)}`,
        );
      }
    } finally {
      this.pipeline.endCapture(goalId, task.id);
    }
  }

  private async cwdOf(goalId: string, task: Task, live: LiveRun): Promise<string> {
    const goal = this.store.get(goalId);
    const reused = goal?.changeSets.find((c) => c.id === task.rework?.changeSetId);
    if (reused) return reused.cwd;
    if (!live.cwd) throw new Error(`No working directory recorded for run of ${task.id}`);
    return live.cwd;
  }

  /** Release what an aborted run created. A stopping daemon leaves it for recovery. */
  private async abandon(live: LiveRun, leaveForRecovery: boolean): Promise<void> {
    if (leaveForRecovery) return;
    await this.discard(live.agentId, live.ownsWorkspace ? live.workspaceId : null);
  }

  private async discard(agentId: string | null, workspaceId: string | null): Promise<void> {
    if (agentId) {
      await this.agents.cancel(agentId).catch((error) => {
        this.logger.warn({ err: error, agentId }, "Failed to cancel agent");
      });
    }
    if (workspaceId) {
      await this.workspaces.archive(workspaceId).catch((error) => {
        this.logger.warn({ err: error, workspaceId }, "Failed to archive workspace");
      });
    }
  }

  private async failRun(
    goalId: string,
    taskId: string,
    runId: string,
    live: LiveRun,
    error: string,
  ): Promise<void> {
    await this.dispatch(goalId, {
      id: `${runId}:finished`,
      goalId,
      type: "run.finished",
      runId,
      outcome: "failed",
      error,
    });
    await this.dispatch(goalId, {
      id: `${runId}:task-failed`,
      goalId,
      type: "task.failed",
      taskId,
      error,
    });
    const goal = this.store.get(goalId);
    const task = goal?.tasks.find((t) => t.id === taskId);
    if (goal?.config && task) {
      // Only attempts that failed count against the limit: a restart interrupts a
      // run without the provider having failed.
      const failed = countedFailures(goal, taskId);
      if (failed < goal.config.maxAttempts) {
        // Give a struggling provider a moment before trying again, longer each time.
        await this.scheduleRetry(
          goalId,
          taskId,
          runId,
          resolveLimits(goal.config).retryBackoffMs * failed,
        );
      } else {
        // A task retried by hand can fail for good again; that is a new notice.
        const forgiven = task.forgivenFailures ?? 0;
        await this.notifyLeadOnce(
          goal,
          `task-${task.id}-failed${forgiven > 0 ? `-after-${forgiven}` : ""}`,
          `task ${task.id} failed after ${failed} attempts: ${error}`,
        );
      }
    }
    await this.discard(live.agentId, live.ownsWorkspace ? live.workspaceId : null);
  }

  /** Fail a goal that can make no more progress; tell the Lead when all work is done. */
  private async settleIfStuck(goal: Goal): Promise<void> {
    if (goal.status !== "executing") return;
    // A run that is still finishing may yet retry its task.
    const retrying = [...this.retries.keys()].some((key) => key.startsWith(`${goal.id}:`));
    const finishing = this.liveRunsFor(goal.id) > 0 || retrying;
    const active = goal.tasks.some((t) => t.status === "running");
    if (finishing || active || this.launchable(goal).length > 0) return;
    // A rework that failed for good leaves its change unfixable; waiting would hang the goal.
    const deadRework = goal.tasks.find((t) => t.rework && t.status === "failed");
    if (deadRework) {
      await this.pipeline.reworkFailed(goal.id, deadRework);
      return;
    }
    // Changes still being reviewed, merged or reworked may unblock more work.
    if (this.pipeline.hasOpenWork(goal)) return;

    if (goal.tasks.every((t) => t.status === "succeeded")) {
      // Completion needs every criterion verified, which only the pipeline can attest.
      this.track(this.pipeline.verifyAndComplete(goal.id));
      return;
    }
    const blocked = blockedTasks(goal.tasks);
    const failed = goal.tasks.filter((t) => t.status === "failed");
    if (failed.length > 0 || blocked.length > 0) {
      const ids = [...failed, ...blocked].map((t) => t.id).join(", ");
      await this.failGoal(goal.id, `No task can make progress. Failed or blocked: ${ids}`);
    }
  }

  /** The goal ended: stop every agent working for it, including one still being set up. */
  private async abortGoalWork(goalId: string): Promise<void> {
    const targets: (LiveRun | LiveLead)[] = [...this.inFlight.values()].filter(
      (r) => r.goalId === goalId,
    );
    const lead = this.leads.get(goalId);
    if (lead) targets.push(lead);
    this.cancelRetries(goalId);
    for (const target of targets) target.canceled = true;
    await Promise.allSettled(
      targets.filter((t) => t.agentId).map((t) => this.agents.cancel(t.agentId as string)),
    );
    // The Lead outlives planning, so stop it by name rather than only by archiving its worktree.
    const leadAgent = this.store.get(goalId)?.leadAgentId;
    if (leadAgent && !targets.some((t) => t.agentId === leadAgent)) {
      await this.agents.cancel(leadAgent).catch(() => undefined);
    }
    // A finished goal's Lead worktree is no longer needed.
    const leadWorkspace = this.store.get(goalId)?.leadWorkspaceId;
    if (leadWorkspace) await this.discard(null, leadWorkspace);
  }

  // ---- reopening ---------------------------------------------------------

  /**
   * True while anything of this goal still runs in this process. The service
   * refuses to reopen a failed goal until its stopping work has settled.
   */
  hasLiveWork(goalId: string): boolean {
    return (
      this.liveRunsFor(goalId) > 0 || this.leads.has(goalId) || this.pipeline.hasLiveWork(goalId)
    );
  }

  /**
   * A failed goal was reopened. Nothing of it runs any more, so pick up its change
   * sets where the failure left them, as after a restart, then schedule.
   */
  private async resumeReopened(goalId: string): Promise<void> {
    try {
      await this.pipeline.recover(goalId);
    } catch (error) {
      if (!this.stopped) await this.failGoal(goalId, `Reopening failed: ${errorMessage(error)}`);
      return;
    }
    await this.pump(goalId);
  }

  // ---- recovery ---------------------------------------------------------

  /** Close out work the previous daemon process left half done, then resume. */
  private async recover(goalId: string): Promise<void> {
    if (!this.store.get(goalId)?.config) return;
    await this.recoverRuns(goalId);
    await this.recoverTasks(goalId);
    await this.pipeline.recover(goalId);
    await this.resume(goalId);
  }

  private async recoverRuns(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    if (!goal) return;
    for (const run of goal.runs.filter((r) => r.status === "running")) {
      const taskDone = goal.tasks.find((t) => t.id === run.taskId)?.status === "succeeded";
      await this.dispatch(goalId, {
        id: `${run.id}:${taskDone ? "finished" : "interrupted"}`,
        goalId,
        type: "run.finished",
        runId: run.id,
        outcome: taskDone ? "succeeded" : "interrupted",
        ...(taskDone ? {} : { error: "Interrupted by daemon restart" }),
      });
      // A rework run works in the change set's own worktree, which must survive.
      const reworks = goal.tasks.find((t) => t.id === run.taskId)?.rework !== undefined;
      if (!taskDone) await this.discard(run.agentId, reworks ? null : run.workspaceId);
    }
  }

  private async recoverTasks(goalId: string): Promise<void> {
    const goal = this.store.get(goalId);
    const maxAttempts = goal?.config?.maxAttempts ?? 1;
    for (const task of goal?.tasks ?? []) {
      // An interrupted run says nothing about the provider, so it is always retried.
      // A task left failed is retried only while failed attempts remain.
      const interrupted = task.status === "running";
      const strandedFailure =
        task.status === "failed" &&
        goal !== undefined &&
        countedFailures(goal, task.id) < maxAttempts;
      if (!interrupted && !strandedFailure) continue;
      await this.dispatch(goalId, {
        id: `${goalId}:${task.id}-a${task.attempts}:recovered-${task.status}`,
        goalId,
        type: "task.retried",
        taskId: task.id,
      });
    }
  }

  private async resume(goalId: string): Promise<void> {
    const current = this.store.get(goalId);
    if (!current?.config) return;
    if (current.status === "planning") {
      // A Lead from before the restart is gone with its turn; do not leave it running.
      if (current.leadAgentId || current.leadWorkspaceId) {
        await this.discard(current.leadAgentId, current.leadWorkspaceId);
      }
      this.track(this.plan(goalId));
    } else if (current.status === "awaiting_plan_approval" && current.config.autoApprovePlan) {
      await this.dispatch(goalId, {
        id: `${goalId}:auto-approve:recovered:${current.lastSeq}`,
        goalId,
        type: "plan.approved",
      });
    } else if (current.status === "executing") {
      this.track(this.pump(goalId));
    }
  }

  // ---- helpers ----------------------------------------------------------

  private async failGoal(goalId: string, reason: string): Promise<void> {
    this.logger.warn({ goalId, reason }, "Goal failed");
    await this.dispatch(goalId, {
      id: `${goalId}:failed:${this.store.get(goalId)?.lastSeq ?? 0}`,
      goalId,
      type: "goal.failed",
      reason,
    });
  }

  /** Tell the chat the goal was started from how it ended, once, as the goal ends. */
  private async notifyOrigin(goal: Goal, outcome: string): Promise<void> {
    if (!goal.config?.originAgentId) return;
    // A reopened goal ends again, and that ending is a new notice.
    const key = goal.reopens ? `goal-ended-r${goal.reopens}` : "goal-ended";
    await this.deliver(goal.id, {
      id: `${goal.id}:notification:origin:${key}`,
      target: "origin",
      key,
      text: buildLeadNotification(goal, outcome),
    });
  }

  /** Tell the Lead the goal completed. */
  private async notifyLeadFinal(goal: Goal, text: string): Promise<void> {
    if (!goal.config?.notifyLead || !goal.leadAgentId) return;
    await this.deliver(goal.id, {
      id: `${goal.id}:notification:lead:goal-completed`,
      target: "lead",
      key: "goal-completed",
      text: buildLeadNotification(goal, text),
    });
  }

  /** Tell the Lead once per key, however many times the situation is observed. */
  private async notifyLeadOnce(goal: Goal, key: string, reason: string): Promise<void> {
    if (!goal.config?.notifyLead || !goal.leadAgentId) return;
    const latest = this.store.get(goal.id) ?? goal;
    await this.deliver(goal.id, {
      // The id lead.notified used, so a notice an older daemon already sent is not sent again.
      id: `${goal.id}:notified:${key}`,
      target: "lead",
      key,
      text: buildLeadNotification(latest, reason),
    });
  }

  // ---- notifications ----------------------------------------------------

  /**
   * Record a notification as due, then send it. The text is stored with it, so a
   * retry, even after a restart, sends exactly what was first composed.
   */
  private async deliver(
    goalId: string,
    input: { id: string; target: NotificationTarget; key: string; text: string },
  ): Promise<void> {
    if (this.stopped) return;
    const outcome = await this.dispatchOutcome(goalId, {
      id: input.id,
      goalId,
      type: "notification.queued",
      target: input.target,
      key: input.key,
      text: input.text,
    });
    if (outcome !== "new") return;
    // Sending runs on its own, so a slow agent layer never holds up the caller.
    this.track(this.attemptNotification(goalId, input.target, input.key));
  }

  /** Send every notification still pending, at once. A delivered one is never sent again. */
  private resumeNotifications(goal: Goal): void {
    for (const notification of goal.notifications ?? []) {
      if (notification.status !== "pending") continue;
      this.track(this.attemptNotification(goal.id, notification.target, notification.key));
    }
  }

  /**
   * One delivery attempt, recorded with its outcome. A failure is retried after a
   * backoff until the attempts run out; waiting holds no run slot and blocks nothing.
   */
  private async attemptNotification(
    goalId: string,
    target: NotificationTarget,
    key: string,
  ): Promise<void> {
    const slot = `${goalId}:${target}:${key}`;
    if (this.stopped || this.delivering.has(slot)) return;
    const goal = this.store.get(goalId);
    const notification = goal?.notifications?.find((n) => n.target === target && n.key === key);
    if (!goal || notification?.status !== "pending") return;
    this.delivering.add(slot);
    try {
      const attempt = notification.attempts + 1;
      const agentId = target === "lead" ? goal.leadAgentId : goal.config?.originAgentId;
      let error: string | null = null;
      try {
        if (!agentId) throw new Error(`The goal has no ${target} agent to notify`);
        await this.agents.notify(agentId, notification.text);
      } catch (cause) {
        error = errorMessage(cause);
      }
      // A stopped Manager records nothing; the next start sends it again.
      if (this.stopped) return;
      await this.dispatch(goalId, {
        id: `${goalId}:notification:${target}:${key}:attempt-${attempt}`,
        goalId,
        type: "notification.attempted",
        target,
        key,
        attempt,
        outcome: error === null ? "delivered" : "failed",
        ...(error === null ? {} : { error }),
      });
      if (error === null) return;
      this.logger.warn({ goalId, target, key, attempt, error }, "Notification not delivered");
      if (attempt >= MAX_NOTIFICATION_ATTEMPTS) return;
      const delay = NOTIFICATION_BACKOFF_MS[attempt - 1] ?? 0;
      const cancel = this.clock.setTimeout(() => {
        this.notificationRetries.delete(slot);
        if (!this.stopped) this.track(this.attemptNotification(goalId, target, key));
      }, delay);
      this.notificationRetries.set(slot, cancel);
    } finally {
      this.delivering.delete(slot);
    }
  }
}

function describeDeadline(goal: Goal): string {
  const { goalTimeoutMs } = resolveLimits(goal.config);
  const byTimeout = Date.parse(goal.createdAt) + goalTimeoutMs;
  return goalDeadlineMs(goal) < byTimeout
    ? `Deadline ${goal.config?.limits?.deadlineAt} reached`
    : `Time limit of ${Math.round(goalTimeoutMs / 60_000)} minutes reached`;
}

/** Work builds on what is integrated so far, or else on the commit the goal started from. */
function baseRefFor(goal: Goal): { baseRef: string } | Record<string, never> {
  const ref = goal.integration?.headCommit ?? goal.config?.baseCommit;
  return ref ? { baseRef: ref } : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describeFailure(result: TurnResult): string {
  switch (result.outcome) {
    case "failed":
      return result.error;
    case "canceled":
      return "Agent run was canceled";
    case "needs_permission":
      return "Agent is waiting for a permission approval; unattended runs cannot continue";
    case "completed":
      return "";
  }
}
