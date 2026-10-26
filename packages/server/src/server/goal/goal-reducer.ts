import type {
  AgentRun,
  ChangeSet,
  ChangeSetStatus,
  Goal,
  GoalEvent,
  GoalStatus,
  Notification,
  Task,
  TaskSpec,
  TurnUsage,
  UsageTotals,
} from "@getpaseo/protocol/goal/types";
import { budgetExceeded, goalDeadlineMs, resolveLimits } from "./goal-limits.js";
import { readyTasks, validateTaskGraph } from "./task-graph.js";

export class GoalTransitionError extends Error {
  constructor(
    public readonly eventType: GoalEvent["type"],
    message: string,
  ) {
    super(`${eventType}: ${message}`);
    this.name = "GoalTransitionError";
  }
}

const TERMINAL_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

/** Delivery attempts per notification, the first included. */
export const MAX_NOTIFICATION_ATTEMPTS = 5;

/**
 * Wait before the next delivery attempt, indexed by attempts made so far minus one.
 * One wait sits between each pair of attempts, so it is one shorter than the cap.
 */
export const NOTIFICATION_BACKOFF_MS = [5_000, 30_000, 120_000, 300_000];

/** Times a person may send a goal's plan back to the Lead. */
export const MAX_PLAN_REJECTIONS = 5;

export function isTerminalGoalStatus(status: GoalStatus): boolean {
  return TERMINAL_GOAL_STATUSES.has(status);
}

/** Runs of a task that failed since a person last retried it; these count against maxAttempts. */
export function countedFailures(goal: Goal, taskId: string): number {
  const failed = goal.runs.filter((r) => r.taskId === taskId && r.status === "failed").length;
  const forgiven = goal.tasks.find((t) => t.id === taskId)?.forgivenFailures ?? 0;
  return failed - forgiven;
}

function toSpec(task: Task): TaskSpec {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    kind: task.kind,
    dependsOn: task.dependsOn,
    ...(task.provider ? { provider: task.provider } : {}),
  };
}

/**
 * Pure, deterministic fold of one event into goal state. Throws
 * GoalTransitionError when the event is not legal in the current state, so an
 * illegal event never reaches the log.
 */
export function applyGoalEvent(goal: Goal | null, event: GoalEvent): Goal {
  if (event.type === "goal.created") {
    if (goal) {
      throw new GoalTransitionError(event.type, "goal already exists");
    }
    if (event.seq !== 1) {
      throw new GoalTransitionError(event.type, `expected seq 1, got ${event.seq}`);
    }
    return {
      id: event.goalId,
      title: event.title,
      objective: event.objective,
      status: "planning",
      config: event.config ?? null,
      leadAgentId: null,
      leadWorkspaceId: null,
      runs: [],
      changeSets: [],
      integration: null,
      criteria: event.criteria.map((c) => ({
        id: c.id,
        text: c.text,
        verifiedAt: null,
        evidence: null,
      })),
      tasks: [],
      notifications: [],
      lastSeq: event.seq,
      failureReason: null,
      createdAt: event.at,
      updatedAt: event.at,
    };
  }

  if (!goal) {
    throw new GoalTransitionError(event.type, "goal does not exist");
  }
  if (event.seq !== goal.lastSeq + 1) {
    throw new GoalTransitionError(event.type, `expected seq ${goal.lastSeq + 1}, got ${event.seq}`);
  }
  if (event.type === "goal.acknowledged") {
    return { ...acknowledge(goal, event), lastSeq: event.seq, updatedAt: event.at };
  }
  // A goal's outcome is sent as it ends, so its notifications outlive it, and a
  // failed goal can be reopened by a retry. Nothing else reaches an ended goal
  // except an acknowledgement, handled above.
  const reopening = event.type === "goal.retried" && goal.status === "failed";
  if (isTerminalGoalStatus(goal.status) && !event.type.startsWith("notification.") && !reopening) {
    throw new GoalTransitionError(event.type, `goal is ${goal.status}`);
  }

  const next = withVerificationTimes(applyToLiveGoal(goal, event), event);
  return { ...next, lastSeq: event.seq, updatedAt: event.at };
}

/** A person dismissed an ended goal. Only the mark changes; a failed goal can still be retried. */
function acknowledge(goal: Goal, event: GoalEvent): Goal {
  if (!isTerminalGoalStatus(goal.status)) {
    throw new GoalTransitionError(
      event.type,
      `goal is ${goal.status}; only an ended goal can be acknowledged`,
    );
  }
  if (goal.acknowledgedAt) {
    throw new GoalTransitionError(event.type, "goal is already acknowledged");
  }
  return { ...goal, acknowledgedAt: event.at };
}

/**
 * Verification has no start event: it starts once every task succeeded and every
 * change set settled, and ends with the last criterion verified. Derived from the
 * event times alone, so replay gives the same answer.
 */
function withVerificationTimes(goal: Goal, event: GoalEvent): Goal {
  if (goal.status !== "executing" && goal.status !== "completed") return goal;
  let next = goal;
  if (!next.verifyStartedAt && readyToVerify(next)) {
    next = { ...next, verifyStartedAt: event.at };
  }
  if (
    !next.verifiedAt &&
    event.type === "criterion.verified" &&
    next.criteria.every((c) => c.verifiedAt)
  ) {
    next = { ...next, verifiedAt: event.at };
  }
  return next;
}

function readyToVerify(goal: Goal): boolean {
  return (
    goal.tasks.length > 0 &&
    goal.tasks.every((t) => t.status === "succeeded") &&
    (!goal.config || goal.tasks.every((t) => t.kind !== "implement" || t.captured)) &&
    goal.changeSets.every((c) => c.status === "integrated" || c.status === "superseded")
  );
}

export function replayGoal(events: readonly GoalEvent[]): Goal | null {
  return events.reduce<Goal | null>((goal, event) => applyGoalEvent(goal, event), null);
}

function requireStatus(goal: Goal, event: GoalEvent, ...allowed: GoalStatus[]): void {
  if (!allowed.includes(goal.status)) {
    throw new GoalTransitionError(
      event.type,
      `requires goal status ${allowed.join(" or ")}, goal is ${goal.status}`,
    );
  }
}

function updateTask(
  goal: Goal,
  event: GoalEvent,
  taskId: string,
  from: Task["status"][],
  update: (task: Task) => Task,
): Goal {
  requireStatus(goal, event, "executing");
  const task = goal.tasks.find((t) => t.id === taskId);
  if (!task) {
    throw new GoalTransitionError(event.type, `unknown task ${taskId}`);
  }
  if (!from.includes(task.status)) {
    throw new GoalTransitionError(
      event.type,
      `task ${taskId} is ${task.status}, expected ${from.join(" or ")}`,
    );
  }
  return { ...goal, tasks: goal.tasks.map((t) => (t.id === taskId ? update(t) : t)) };
}

type EventHandler = (goal: Goal, event: GoalEvent) => Goal;

// Events are grouped by the first segment of their type.
const HANDLERS: Record<string, EventHandler> = {
  plan: (goal, event) => applyPlanEvent(goal, event),
  task: (goal, event) => applyTaskEvent(goal, event),
  lead: (goal, event) => applyRunEvent(goal, event),
  run: (goal, event) => applyRunEvent(goal, event),
  criterion: (goal, event) => applyGoalLevelEvent(goal, event),
  goal: (goal, event) => applyGoalLevelEvent(goal, event),
  capture: (goal, event) => applyChangeSetEvent(goal, event),
  changeset: (goal, event) => applyChangeSetEvent(goal, event),
  integration: (goal, event) => applyChangeSetEvent(goal, event),
  notification: (goal, event) => applyNotificationEvent(goal, event),
  usage: (goal, event) => applyUsageEvent(goal, event),
};

function applyToLiveGoal(goal: Goal, event: GoalEvent): Goal {
  const handler = HANDLERS[event.type.split(".")[0] ?? ""];
  if (!handler) {
    throw new GoalTransitionError(event.type, "unknown event group");
  }
  return handler(goal, event);
}

function applyPlanEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "plan.proposed": {
      requireStatus(goal, event, "planning");
      try {
        validateTaskGraph(event.tasks);
      } catch (error) {
        throw new GoalTransitionError(
          event.type,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (event.tasks.length === 0) {
        throw new GoalTransitionError(event.type, "plan has no tasks");
      }
      const { maxTasks } = resolveLimits(goal.config);
      if (event.tasks.length > maxTasks) {
        throw new GoalTransitionError(
          event.type,
          `plan has ${event.tasks.length} tasks; the limit is ${maxTasks}`,
        );
      }
      return {
        ...goal,
        status: "awaiting_plan_approval",
        tasks: event.tasks.map((spec) => ({
          ...spec,
          status: "pending",
          attempts: 0,
          error: null,
          summary: null,
        })),
      };
    }

    case "plan.approved":
      requireStatus(goal, event, "awaiting_plan_approval");
      return { ...goal, status: "executing" };

    case "plan.rejected": {
      requireStatus(goal, event, "awaiting_plan_approval");
      const rejections = goal.planRejections ?? [];
      if (rejections.length >= MAX_PLAN_REJECTIONS) {
        throw new GoalTransitionError(
          event.type,
          `the plan was already rejected ${rejections.length} times; the limit is ${MAX_PLAN_REJECTIONS}`,
        );
      }
      return {
        ...goal,
        status: "planning",
        tasks: [],
        planRejections: [
          ...rejections,
          { reason: event.reason, tasks: goal.tasks.map(toSpec), at: event.at },
        ],
      };
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

function applyTaskEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "task.started":
      requireStatus(goal, event, "executing");
      if (!readyTasks(goal.tasks).some((t) => t.id === event.taskId)) {
        const known = goal.tasks.some((t) => t.id === event.taskId);
        throw new GoalTransitionError(
          event.type,
          known ? `task ${event.taskId} is not ready` : `unknown task ${event.taskId}`,
        );
      }
      return updateTask(goal, event, event.taskId, ["pending"], (t) => ({
        ...t,
        status: "running",
        attempts: t.attempts + 1,
      }));

    case "task.succeeded":
      return updateTask(goal, event, event.taskId, ["running"], (t) => ({
        ...t,
        status: "succeeded",
        error: null,
        summary: event.summary ?? null,
      }));

    case "task.failed":
      return updateTask(goal, event, event.taskId, ["running"], (t) => ({
        ...t,
        status: "failed",
        error: event.error,
      }));

    case "task.retried":
      return updateTask(goal, event, event.taskId, ["running", "failed"], (t) => ({
        ...t,
        status: "pending",
        error: null,
      }));

    case "task.cancelled":
      return updateTask(goal, event, event.taskId, ["pending", "running"], (t) => ({
        ...t,
        status: "cancelled",
      }));

    case "task.added": {
      requireStatus(goal, event, "executing");
      if (goal.tasks.some((t) => t.id === event.task.id)) {
        throw new GoalTransitionError(event.type, `task ${event.task.id} already exists`);
      }
      if (!goal.changeSets.some((c) => c.id === event.rework.changeSetId)) {
        throw new GoalTransitionError(event.type, `unknown change set ${event.rework.changeSetId}`);
      }
      const added: Task = {
        ...event.task,
        status: "pending",
        attempts: 0,
        error: null,
        summary: null,
        rework: event.rework,
      };
      return { ...goal, tasks: [...goal.tasks, added] };
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

function interruptLiveRuns(runs: AgentRun[], at: string): AgentRun[] {
  return runs.map((r) =>
    r.status === "running" ? { ...r, status: "interrupted", endedAt: at } : r,
  );
}

function updateRun(
  goal: Goal,
  event: GoalEvent,
  runId: string,
  update: (run: AgentRun) => AgentRun,
): Goal {
  requireStatus(goal, event, "executing");
  const run = goal.runs.find((r) => r.id === runId);
  if (!run) {
    throw new GoalTransitionError(event.type, `unknown run ${runId}`);
  }
  if (run.status !== "running") {
    throw new GoalTransitionError(event.type, `run ${runId} is ${run.status}`);
  }
  return { ...goal, runs: goal.runs.map((r) => (r.id === runId ? update(r) : r)) };
}

function applyRunEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "lead.attached":
      requireStatus(goal, event, "planning", "awaiting_plan_approval");
      return {
        ...goal,
        leadAgentId: event.agentId,
        leadWorkspaceId: event.workspaceId ?? goal.leadWorkspaceId,
      };

    // Only in logs from before notifications were recorded. Its outcome was never
    // written down, so it creates no entry and is never sent again.
    case "lead.notified":
      requireStatus(goal, event, "executing");
      return goal;

    case "run.started": {
      requireStatus(goal, event, "executing");
      const task = goal.tasks.find((t) => t.id === event.taskId);
      if (!task || task.status !== "running") {
        throw new GoalTransitionError(event.type, `task ${event.taskId} is not running`);
      }
      if (goal.runs.some((r) => r.id === event.runId)) {
        throw new GoalTransitionError(event.type, `run ${event.runId} already exists`);
      }
      if (goal.runs.some((r) => r.taskId === event.taskId && r.status === "running")) {
        throw new GoalTransitionError(event.type, `task ${event.taskId} already has a live run`);
      }
      const run: AgentRun = {
        id: event.runId,
        taskId: event.taskId,
        provider: event.provider,
        agentId: null,
        workspaceId: null,
        cwd: null,
        status: "running",
        startedAt: event.at,
        endedAt: null,
        error: null,
      };
      return { ...goal, runs: [...goal.runs, run] };
    }

    case "run.attached":
      return updateRun(goal, event, event.runId, (r) => ({
        ...r,
        agentId: event.agentId,
        workspaceId: event.workspaceId,
        cwd: event.cwd ?? null,
        ...(event.thinking ? { thinking: event.thinking } : {}),
      }));

    case "run.finished":
      return updateRun(goal, event, event.runId, (r) => ({
        ...r,
        status: event.outcome,
        endedAt: event.at,
        error: event.error ?? null,
      }));

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

// What a change set may move to from each status. `integrating` is reachable
// only from `approved`, and `approved` only from a review verdict or a person,
// so unreviewed work can never be merged.
const CHANGE_SET_TRANSITIONS: Record<ChangeSetStatus, readonly ChangeSetStatus[]> = {
  captured: ["in_review"],
  in_review: ["approved", "awaiting_human", "changes_requested", "rejected"],
  awaiting_human: ["approved", "changes_requested", "rejected"],
  approved: ["integrating"],
  // Back to approved when a restart interrupts a merge, so it can be retried.
  integrating: ["integrated", "conflicted", "test_failed", "approved", "rejected"],
  integrated: [],
  changes_requested: ["superseded", "rejected"],
  conflicted: ["superseded", "rejected"],
  test_failed: ["superseded", "rejected"],
  superseded: [],
  rejected: [],
};

function applyChangeSetEvent(goal: Goal, event: GoalEvent): Goal {
  requireStatus(goal, event, "executing");
  switch (event.type) {
    case "integration.prepared":
      if (goal.integration) {
        throw new GoalTransitionError(event.type, "integration already prepared");
      }
      return {
        ...goal,
        integration: {
          branch: event.branch,
          workspaceId: event.workspaceId,
          cwd: event.cwd,
          baseCommit: event.baseCommit,
          headCommit: event.baseCommit,
        },
      };

    case "changeset.captured": {
      const task = goal.tasks.find((t) => t.id === event.taskId);
      if (!task || task.status !== "succeeded" || task.kind !== "implement") {
        throw new GoalTransitionError(
          event.type,
          `task ${event.taskId} is not a succeeded implement task`,
        );
      }
      if (goal.changeSets.some((c) => c.id === event.changeSetId)) {
        throw new GoalTransitionError(event.type, `change set ${event.changeSetId} exists`);
      }
      const previous = event.supersedes
        ? goal.changeSets.find((c) => c.id === event.supersedes)
        : undefined;
      if (event.supersedes && !previous) {
        throw new GoalTransitionError(event.type, `unknown change set ${event.supersedes}`);
      }
      if (previous && !CHANGE_SET_TRANSITIONS[previous.status].includes("superseded")) {
        throw new GoalTransitionError(
          event.type,
          `change set ${previous.id} is ${previous.status} and cannot be superseded`,
        );
      }
      const captured: ChangeSet = {
        id: event.changeSetId,
        taskId: event.taskId,
        runId: event.runId,
        round: event.round,
        supersedes: event.supersedes,
        workspaceId: event.workspaceId,
        cwd: event.cwd,
        branch: event.branch,
        baseCommit: event.baseCommit,
        headCommit: event.headCommit,
        files: event.files,
        status: "captured",
        findings: null,
        testSummary: null,
        integratedCommit: null,
        error: null,
        createdAt: event.at,
        updatedAt: event.at,
      };
      // The new change set replaces the old one in the same step, so a crash cannot
      // leave both open.
      return {
        ...goal,
        tasks: markCaptured(goal.tasks, event.taskId),
        changeSets: [
          ...goal.changeSets.map((c) =>
            c.id === previous?.id
              ? { ...c, status: "superseded" as const, updatedAt: event.at }
              : c,
          ),
          captured,
        ],
      };
    }

    case "capture.skipped": {
      const task = goal.tasks.find((t) => t.id === event.taskId);
      if (!task || task.status !== "succeeded" || task.kind !== "implement") {
        throw new GoalTransitionError(
          event.type,
          `task ${event.taskId} is not a succeeded implement task`,
        );
      }
      return { ...goal, tasks: markCaptured(goal.tasks, event.taskId) };
    }

    case "changeset.transitioned":
      return transitionChangeSet(goal, event);

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

function markCaptured(tasks: Task[], taskId: string): Task[] {
  return tasks.map((t) => (t.id === taskId ? { ...t, captured: true } : t));
}

function transitionChangeSet(
  goal: Goal,
  event: Extract<GoalEvent, { type: "changeset.transitioned" }>,
): Goal {
  const current = goal.changeSets.find((c) => c.id === event.changeSetId);
  if (!current) {
    throw new GoalTransitionError(event.type, `unknown change set ${event.changeSetId}`);
  }
  if (!CHANGE_SET_TRANSITIONS[current.status].includes(event.to)) {
    throw new GoalTransitionError(
      event.type,
      `change set ${current.id} cannot go from ${current.status} to ${event.to}`,
    );
  }
  if (event.to === "integrated" && !event.integratedCommit) {
    throw new GoalTransitionError(event.type, "integrated requires integratedCommit");
  }
  const next: ChangeSet = {
    ...current,
    ...stageTimes(current, event.to, event.at),
    status: event.to,
    findings: event.findings ?? current.findings,
    testSummary: event.testSummary ?? current.testSummary,
    integratedCommit: event.integratedCommit ?? current.integratedCommit,
    // A change set that ends keeps the reason it needed fixing; live ones start clean.
    error:
      event.error ?? (event.to === "superseded" || event.to === "rejected" ? current.error : null),
    updatedAt: event.at,
  };
  return {
    ...goal,
    changeSets: goal.changeSets.map((c) => (c.id === current.id ? next : c)),
    integration:
      event.to === "integrated" && goal.integration
        ? { ...goal.integration, headCommit: event.integratedCommit as string }
        : goal.integration,
  };
}

/** Times a change set entered and left review and merge; the first entry into merging counts. */
function stageTimes(
  current: ChangeSet,
  to: ChangeSetStatus,
  at: string,
): Partial<Pick<ChangeSet, "reviewStartedAt" | "reviewedAt" | "mergeStartedAt" | "mergedAt">> {
  if (to === "in_review") return { reviewStartedAt: at };
  if (current.status === "in_review") return { reviewedAt: at };
  if (to === "integrating" && !current.mergeStartedAt) return { mergeStartedAt: at };
  if (to === "integrated") return { mergedAt: at };
  return {};
}

const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  reportedTurns: 0,
  totalTurns: 0,
};

function addUsage(totals: UsageTotals | undefined, turn: TurnUsage | undefined): UsageTotals {
  const base = totals ?? EMPTY_USAGE;
  if (!turn) return { ...base, totalTurns: base.totalTurns + 1 };
  const input = turn.inputTokens ?? 0;
  const output = turn.outputTokens ?? 0;
  return {
    inputTokens: base.inputTokens + input,
    cachedInputTokens: base.cachedInputTokens + (turn.cachedInputTokens ?? 0),
    outputTokens: base.outputTokens + output,
    totalTokens: base.totalTokens + input + output,
    costUsd: base.costUsd + (turn.costUsd ?? 0),
    reportedTurns: base.reportedTurns + 1,
    totalTurns: base.totalTurns + 1,
  };
}

/** An agent turn ended; add what its provider reported to the goal and, for a worker, its run. */
function applyUsageEvent(goal: Goal, event: GoalEvent): Goal {
  if (event.type !== "usage.recorded") {
    throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
  if (event.role === "worker" && !event.runId) {
    throw new GoalTransitionError(event.type, "a worker turn names its run");
  }
  if (event.runId && !goal.runs.some((r) => r.id === event.runId)) {
    throw new GoalTransitionError(event.type, `unknown run ${event.runId}`);
  }
  return {
    ...goal,
    usage: addUsage(goal.usage, event.usage),
    runs: event.runId
      ? goal.runs.map((r) =>
          r.id === event.runId ? { ...r, usage: addUsage(r.usage, event.usage) } : r,
        )
      : goal.runs,
  };
}

function applyNotificationEvent(goal: Goal, event: GoalEvent): Goal {
  const notifications = goal.notifications ?? [];
  switch (event.type) {
    case "notification.queued": {
      if (notifications.some((n) => n.target === event.target && n.key === event.key)) {
        throw new GoalTransitionError(
          event.type,
          `notification ${event.target}:${event.key} already queued`,
        );
      }
      const queued: Notification = {
        key: event.key,
        target: event.target,
        text: event.text,
        status: "pending",
        attempts: 0,
        lastError: null,
        updatedAt: event.at,
      };
      return { ...goal, notifications: [...notifications, queued] };
    }

    case "notification.attempted": {
      const current = notifications.find((n) => n.target === event.target && n.key === event.key);
      if (!current) {
        throw new GoalTransitionError(
          event.type,
          `unknown notification ${event.target}:${event.key}`,
        );
      }
      if (current.status !== "pending") {
        throw new GoalTransitionError(
          event.type,
          `notification ${event.target}:${event.key} is ${current.status}`,
        );
      }
      if (event.attempt !== current.attempts + 1 || event.attempt > MAX_NOTIFICATION_ATTEMPTS) {
        throw new GoalTransitionError(
          event.type,
          `expected attempt ${current.attempts + 1} of at most ${MAX_NOTIFICATION_ATTEMPTS}, got ${event.attempt}`,
        );
      }
      const delivered = event.outcome === "delivered";
      // A failure is final only on the last attempt allowed.
      let status: Notification["status"] = "pending";
      if (delivered) status = "delivered";
      else if (event.attempt >= MAX_NOTIFICATION_ATTEMPTS) status = "failed";
      const next: Notification = {
        ...current,
        status,
        attempts: event.attempt,
        lastError: delivered ? current.lastError : (event.error ?? "unknown error"),
        updatedAt: event.at,
      };
      return { ...goal, notifications: notifications.map((n) => (n === current ? next : n)) };
    }

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

function applyGoalLevelEvent(goal: Goal, event: GoalEvent): Goal {
  switch (event.type) {
    case "criterion.verified": {
      requireStatus(goal, event, "executing");
      const criterion = goal.criteria.find((c) => c.id === event.criterionId);
      if (!criterion) {
        throw new GoalTransitionError(event.type, `unknown criterion ${event.criterionId}`);
      }
      if (criterion.verifiedAt) {
        throw new GoalTransitionError(
          event.type,
          `criterion ${event.criterionId} already verified`,
        );
      }
      return {
        ...goal,
        criteria: goal.criteria.map((c) =>
          c.id === event.criterionId
            ? { ...c, verifiedAt: event.at, evidence: event.evidence ?? null }
            : c,
        ),
      };
    }

    case "goal.completed": {
      requireStatus(goal, event, "executing");
      const open = goal.tasks.filter((t) => t.status !== "succeeded");
      if (open.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `tasks not succeeded: ${open.map((t) => t.id).join(", ")}`,
        );
      }
      const unsettled = goal.changeSets.filter(
        (c) => c.status !== "integrated" && c.status !== "superseded",
      );
      if (unsettled.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `change sets not integrated: ${unsettled.map((c) => c.id).join(", ")}`,
        );
      }
      // In a managed goal, an implement task whose work was never captured may have
      // changes nobody reviewed.
      const uncaptured = goal.config
        ? goal.tasks.filter((t) => t.kind === "implement" && !t.captured)
        : [];
      if (uncaptured.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `work not captured for: ${uncaptured.map((t) => t.id).join(", ")}`,
        );
      }
      const unverified = goal.criteria.filter((c) => !c.verifiedAt);
      if (unverified.length > 0) {
        throw new GoalTransitionError(
          event.type,
          `criteria not verified: ${unverified.map((c) => c.id).join(", ")}`,
        );
      }
      return { ...goal, status: "completed" };
    }

    case "goal.failed":
      // Pending tasks never ran and stay pending; anything live is closed out.
      return {
        ...goal,
        status: "failed",
        failureReason: event.reason,
        tasks: goal.tasks.map((t) => (t.status === "running" ? { ...t, status: "cancelled" } : t)),
        runs: interruptLiveRuns(goal.runs, event.at),
      };

    case "goal.cancelled":
      return {
        ...goal,
        status: "cancelled",
        tasks: goal.tasks.map((t) =>
          t.status === "pending" || t.status === "running" ? { ...t, status: "cancelled" } : t,
        ),
        runs: interruptLiveRuns(goal.runs, event.at),
      };

    case "goal.paused":
      if (goal.pausedAt) throw new GoalTransitionError(event.type, "goal is already paused");
      return { ...goal, pausedAt: event.at };

    case "goal.resumed":
      if (!goal.pausedAt) throw new GoalTransitionError(event.type, "goal is not paused");
      return { ...goal, pausedAt: null };

    case "goal.retried":
      return applyRetry(goal, event);

    default:
      throw new GoalTransitionError(event.type, "unexpected event for this handler");
  }
}

/**
 * A person retries failed or cancelled tasks. Their earlier failures stop counting
 * against maxAttempts. A failed goal is reopened only when it can still finish:
 * every failed and cancelled task is retried, no change set was rejected, and the
 * run and time limits leave room.
 */
function applyRetry(goal: Goal, event: Extract<GoalEvent, { type: "goal.retried" }>): Goal {
  if (!goal.config) {
    throw new GoalTransitionError(event.type, "a manual goal runs nothing to retry");
  }
  requireStatus(goal, event, "executing", "failed");
  const reopen = goal.status === "failed";
  if (event.reopen !== reopen) {
    throw new GoalTransitionError(
      event.type,
      reopen ? "the goal failed; a retry must reopen it" : "only a failed goal can be reopened",
    );
  }
  const retryable = new Set(
    goal.tasks.filter((t) => t.status === "failed" || t.status === "cancelled").map((t) => t.id),
  );
  for (const id of event.taskIds) {
    if (!retryable.has(id)) {
      const known = goal.tasks.find((t) => t.id === id);
      throw new GoalTransitionError(
        event.type,
        known
          ? `task ${id} is ${known.status}, expected failed or cancelled`
          : `unknown task ${id}`,
      );
    }
  }
  const { maxRuns } = resolveLimits(goal.config);
  if (goal.runs.length >= maxRuns) {
    throw new GoalTransitionError(event.type, `the run limit of ${maxRuns} is used up`);
  }
  if (Date.parse(event.at) >= goalDeadlineMs(goal)) {
    throw new GoalTransitionError(event.type, "the goal's time limit has passed");
  }
  const overBudget = budgetExceeded(goal);
  if (overBudget) throw new GoalTransitionError(event.type, overBudget);
  if (reopen) {
    const missing = [...retryable].filter((id) => !event.taskIds.includes(id));
    if (missing.length > 0) {
      throw new GoalTransitionError(
        event.type,
        `reopening needs every failed or cancelled task retried; missing ${missing.join(", ")}`,
      );
    }
    const rejected = goal.changeSets.filter((c) => c.status === "rejected");
    if (rejected.length > 0) {
      throw new GoalTransitionError(
        event.type,
        `change set ${rejected.map((c) => c.id).join(", ")} was rejected, so the goal cannot complete`,
      );
    }
  }
  const retried = new Set(event.taskIds);
  const failedRuns = (taskId: string) =>
    goal.runs.filter((r) => r.taskId === taskId && r.status === "failed").length;
  return {
    ...goal,
    status: "executing",
    failureReason: reopen ? null : goal.failureReason,
    ...(reopen ? { reopens: (goal.reopens ?? 0) + 1 } : {}),
    // A reopened goal that ends again needs attention again.
    ...(reopen && goal.acknowledgedAt ? { acknowledgedAt: null } : {}),
    tasks: goal.tasks.map((t) =>
      retried.has(t.id)
        ? { ...t, status: "pending", error: null, forgivenFailures: failedRuns(t.id) }
        : t,
    ),
  };
}
