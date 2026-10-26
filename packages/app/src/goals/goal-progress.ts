import type { AgentRun, ChangeSetStatus, Goal, Task } from "@getpaseo/protocol/goal/types";
import { DAEMON_GOAL_SETTINGS } from "./goal-settings";

type ProgressGoal = Pick<
  Goal,
  | "status"
  | "tasks"
  | "runs"
  | "changeSets"
  | "criteria"
  | "createdAt"
  | "updatedAt"
  | "config"
  | "pausedAt"
  | "usage"
>;

const ENDED: ReadonlySet<Goal["status"]> = new Set(["completed", "failed", "cancelled"]);

// How much of the bar each stage is worth. Tasks dominate; planning and verification bracket them.
const PLAN_WEIGHT = 0.05;
const TASKS_WEIGHT = 0.85;
const VERIFY_WEIGHT = 0.1;
// An implement task is half done when its run succeeds, then reviewed, then merged.
const IMPLEMENT_RUN_SHARE = 0.5;
const IMPLEMENT_REVIEW_SHARE = 0.25;

const REVIEWED: ReadonlySet<ChangeSetStatus> = new Set(["approved", "integrating", "integrated"]);

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** How far one task has come, 0 to 1, counting review and merge for implement tasks. */
export function taskCompletion(goal: Pick<Goal, "changeSets">, task: Task): number {
  if (task.status !== "succeeded") {
    return 0;
  }
  if (task.kind !== "implement" || task.rework) {
    return 1;
  }
  const changeSets = goal.changeSets.filter(
    (changeSet) => changeSet.taskId === task.id && changeSet.status !== "superseded",
  );
  // Succeeded without a change set: either nothing changed, or capture has not run yet.
  if (changeSets.length === 0) {
    return task.captured ? 1 : IMPLEMENT_RUN_SHARE;
  }
  if (changeSets.every((changeSet) => changeSet.status === "integrated")) {
    return 1;
  }
  if (changeSets.every((changeSet) => REVIEWED.has(changeSet.status))) {
    return IMPLEMENT_RUN_SHARE + IMPLEMENT_REVIEW_SHARE;
  }
  return IMPLEMENT_RUN_SHARE;
}

/** Overall progress, 0 to 100, weighted over planning, tasks with their review and merge, and verification. */
export function goalPercent(goal: ProgressGoal): number {
  if (goal.status === "completed") {
    return 100;
  }
  const planned = goal.tasks.length > 0 && goal.status !== "awaiting_plan_approval";
  const planDone = planned && goal.status !== "planning" ? PLAN_WEIGHT : 0;
  const counted = goal.tasks.filter((task) => task.status !== "cancelled");
  const taskShare =
    counted.length === 0
      ? 0
      : counted.reduce((sum, task) => sum + taskCompletion(goal, task), 0) / counted.length;
  const verified = goal.criteria.filter((criterion) => criterion.verifiedAt !== null).length;
  const verifyShare = goal.criteria.length === 0 ? 0 : verified / goal.criteria.length;
  const raw = planDone + taskShare * TASKS_WEIGHT + verifyShare * VERIFY_WEIGHT;
  // Only completion reaches 100.
  return Math.min(99, Math.floor(raw * 100));
}

export interface GoalTaskCounts {
  done: number;
  running: number;
  remaining: number;
  failed: number;
  total: number;
}

export function countGoalTasks(goal: Pick<Goal, "tasks">): GoalTaskCounts {
  const counts: GoalTaskCounts = { done: 0, running: 0, remaining: 0, failed: 0, total: 0 };
  for (const task of goal.tasks) {
    if (task.status === "cancelled") {
      continue;
    }
    counts.total += 1;
    if (task.status === "succeeded") counts.done += 1;
    else if (task.status === "running") counts.running += 1;
    else if (task.status === "failed") counts.failed += 1;
    else counts.remaining += 1;
  }
  return counts;
}

/** Time since the goal was created; frozen at its last update once it has ended. Never negative. */
export function goalElapsedMs(goal: ProgressGoal, now: number): number {
  const start = parseTime(goal.createdAt);
  if (start === null) {
    return 0;
  }
  const end = ENDED.has(goal.status) ? (parseTime(goal.updatedAt) ?? now) : now;
  return Math.max(0, end - start);
}

function runsOf(goal: Pick<Goal, "runs">, taskId: string): AgentRun[] {
  return goal.runs.filter((run) => run.taskId === taskId);
}

/** From the first run's start to the last run's end, or to now while it runs. Null before any run. */
export function taskDurationMs(goal: Pick<Goal, "runs">, task: Task, now: number): number | null {
  const runs = runsOf(goal, task.id);
  const starts = runs.map((run) => parseTime(run.startedAt)).filter((t): t is number => t !== null);
  if (starts.length === 0) {
    return null;
  }
  const start = Math.min(...starts);
  const isOpen = task.status === "running" || runs.some((run) => run.status === "running");
  const ends = runs.map((run) => parseTime(run.endedAt)).filter((t): t is number => t !== null);
  const end = isOpen || ends.length === 0 ? now : Math.max(...ends);
  return Math.max(0, end - start);
}

/** Fewer finished tasks than this and any estimate would be a guess. */
export const MIN_SAMPLES_FOR_ESTIMATE = 2;
// The Manager runs at most this many workers across the daemon (docs/goals.md "Concurrency").
const DAEMON_WORKER_LIMIT = 4;

export type GoalEstimate =
  | { kind: "none" }
  | { kind: "paused" }
  | { kind: "estimating"; samples: number }
  | { kind: "range"; lowMs: number; highMs: number };

/**
 * Time left, as a range from the fastest and slowest finished tasks spread over the goal's
 * parallelism. Review, merge and verification are not sampled, so the range is a floor.
 */
export function estimateRemaining(goal: ProgressGoal, now: number): GoalEstimate {
  if (ENDED.has(goal.status) || !goal.config || goal.tasks.length === 0) {
    return { kind: "none" };
  }
  if (goal.pausedAt) {
    return { kind: "paused" };
  }
  const samples = goal.tasks
    .filter((task) => task.status === "succeeded")
    .map((task) => taskDurationMs(goal, task, now))
    .filter((ms): ms is number => ms !== null && ms > 0);
  if (samples.length < MIN_SAMPLES_FOR_ESTIMATE) {
    return { kind: "estimating", samples: samples.length };
  }
  const fastest = Math.min(...samples);
  const slowest = Math.max(...samples);
  const open = goal.tasks.filter(
    (task) => task.status === "pending" || task.status === "running" || task.status === "failed",
  );
  if (open.length === 0) {
    return { kind: "range", lowMs: 0, highMs: 0 };
  }
  const parallel = Math.max(1, Math.min(goal.config.maxParallel, DAEMON_WORKER_LIMIT, open.length));
  let lowWork = 0;
  let highWork = 0;
  for (const task of open) {
    const spent = task.status === "running" ? (taskDurationMs(goal, task, now) ?? 0) : 0;
    lowWork += Math.max(0, fastest - spent);
    highWork += Math.max(0, slowest - spent);
  }
  return {
    kind: "range",
    lowMs: roundEstimate(lowWork / parallel, "down"),
    highMs: roundEstimate(highWork / parallel, "up"),
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Whole minutes under an hour, five-minute steps above: an estimate shows no more than it knows. */
function roundEstimate(ms: number, direction: "down" | "up"): number {
  const unit = ms < HOUR_MS ? MINUTE_MS : 5 * MINUTE_MS;
  const round = direction === "down" ? Math.floor : Math.ceil;
  return round(ms / unit) * unit;
}

/** 950 → "950", 12_300 → "12.3k", 4_500_000 → "4.5M". */
export function formatCompactCount(value: number): string {
  const abs = Math.abs(value);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      const digits = Math.abs(scaled) >= 100 ? 0 : 1;
      return `${Number(scaled.toFixed(digits))}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** US dollars, cents under a hundred. */
export function formatUsd(value: number): string {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

export type GoalDeadline =
  | { kind: "none" }
  | { kind: "running"; remainingMs: number; totalMs: number; usedFraction: number }
  | { kind: "overdue"; overdueMs: number };

/** Time left before the goal timeout fails the goal. */
export function goalDeadline(goal: ProgressGoal, now: number): GoalDeadline {
  const start = parseTime(goal.createdAt);
  if (ENDED.has(goal.status) || !goal.config || start === null) {
    return { kind: "none" };
  }
  const minutes = goal.config.limits?.goalTimeoutMinutes ?? DAEMON_GOAL_SETTINGS.goalTimeoutMinutes;
  const timeoutEnd = start + minutes * 60_000;
  // The earlier of the timeout and an explicit deadline wins.
  const explicitEnd = parseTime(goal.config.limits?.deadlineAt);
  const end = explicitEnd === null ? timeoutEnd : Math.min(timeoutEnd, explicitEnd);
  const totalMs = Math.max(1, end - start);
  const elapsed = Math.max(0, now - start);
  const remainingMs = end - Math.max(now, start);
  if (remainingMs < 0) {
    return { kind: "overdue", overdueMs: -remainingMs };
  }
  return { kind: "running", remainingMs, totalMs, usedFraction: elapsed / totalMs };
}

export type BudgetStatus =
  | { kind: "not_reported" }
  | { kind: "unlimited"; used: number }
  | { kind: "limited"; used: number; limit: number; fraction: number; isOver: boolean };

/** Usage against a limit. `null` usage means nobody reported it, which is not zero. */
export function budgetStatus(used: number | null, limit: number | null): BudgetStatus {
  if (used === null || !Number.isFinite(used)) {
    return { kind: "not_reported" };
  }
  const safeUsed = Math.max(0, used);
  if (limit === null || limit <= 0) {
    return { kind: "unlimited", used: safeUsed };
  }
  return {
    kind: "limited",
    used: safeUsed,
    limit,
    fraction: Math.min(1, safeUsed / limit),
    isOver: safeUsed >= limit,
  };
}

/** Usage per hour of elapsed time, or null when there is nothing to divide. */
export function burnRatePerHour(used: number | null, elapsedMs: number): number | null {
  if (used === null || elapsedMs <= 0) {
    return null;
  }
  return (Math.max(0, used) / elapsedMs) * 3_600_000;
}

export interface TaskTimelineBar {
  taskId: string;
  /** Where the task's first run started, 0 to 1 across the goal's span. */
  offset: number;
  /** How much of the span it ran, 0 to 1; zero before it starts. */
  width: number;
  durationMs: number | null;
  attempts: number;
  reworkRound: number | null;
}

/**
 * One bar per task over the goal's life, for a small Gantt-like view. Times before the goal's
 * creation (clock skew between hosts) are clamped to its start.
 */
export function buildTaskTimeline(goal: ProgressGoal, now: number): TaskTimelineBar[] {
  const goalStart = parseTime(goal.createdAt) ?? now;
  const span = Math.max(1, goalElapsedMs(goal, now));
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return goal.tasks.map((task) => {
    const starts = runsOf(goal, task.id)
      .map((run) => parseTime(run.startedAt))
      .filter((t): t is number => t !== null);
    const durationMs = taskDurationMs(goal, task, now);
    const offset = starts.length === 0 ? 0 : clamp((Math.min(...starts) - goalStart) / span);
    const width = durationMs === null ? 0 : Math.min(1 - offset, clamp(durationMs / span));
    return {
      taskId: task.id,
      offset,
      width,
      durationMs,
      attempts: task.attempts,
      reworkRound: task.rework?.round ?? null,
    };
  });
}

export interface GoalUsageStatus {
  tokens: BudgetStatus;
  cost: BudgetStatus;
  /** Agent turns that came with usage, out of all turns. Totals cover only the reported ones. */
  reportedTurns: number;
  totalTurns: number;
}

/** Tokens and cost so far against the goal's caps. Unreported usage is not counted as zero. */
export function goalUsageStatus(goal: Pick<Goal, "usage" | "config">): GoalUsageStatus {
  const usage = goal.usage;
  const reported = usage !== undefined && usage.reportedTurns > 0;
  const limits = goal.config?.limits;
  return {
    tokens: budgetStatus(reported ? usage.totalTokens : null, limits?.maxTotalTokens ?? null),
    cost: budgetStatus(reported ? usage.costUsd : null, limits?.maxCostUsd ?? null),
    reportedTurns: usage?.reportedTurns ?? 0,
    totalTurns: usage?.totalTurns ?? 0,
  };
}

/** Tokens a task's runs reported, or null when none did. */
export function taskTokens(goal: Pick<Goal, "runs">, taskId: string): number | null {
  const reported = runsOf(goal, taskId).filter(
    (run) => run.usage !== undefined && run.usage.reportedTurns > 0,
  );
  if (reported.length === 0) {
    return null;
  }
  return reported.reduce((sum, run) => sum + (run.usage?.totalTokens ?? 0), 0);
}
