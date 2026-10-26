import { GOAL_CONFIG_BOUNDS } from "@getpaseo/protocol/goal/config-bounds";
import type { Goal, GoalConfig } from "@getpaseo/protocol/goal/types";

export interface ResolvedLimits {
  maxTasks: number;
  maxRuns: number;
  runTimeoutMs: number;
  goalTimeoutMs: number;
  retryBackoffMs: number;
  /** Null when no budget is set. */
  maxTotalTokens: number | null;
  maxCostUsd: number | null;
}

const MINUTE = 60_000;
const BOUNDS = GOAL_CONFIG_BOUNDS.limits;

export const DEFAULT_LIMITS: ResolvedLimits = {
  maxTasks: BOUNDS.maxTasks.default,
  maxRuns: BOUNDS.maxRuns.default,
  runTimeoutMs: BOUNDS.runTimeoutMinutes.default * MINUTE,
  goalTimeoutMs: BOUNDS.goalTimeoutMinutes.default * MINUTE,
  retryBackoffMs: BOUNDS.retryBackoffSeconds.default * 1000,
  maxTotalTokens: BOUNDS.maxTotalTokens.default,
  maxCostUsd: BOUNDS.maxCostUsd.default,
};

/** The limits in force for a goal: its own settings over the defaults. */
export function resolveLimits(config: GoalConfig | null | undefined): ResolvedLimits {
  const limits = config?.limits;
  return {
    maxTasks: limits?.maxTasks ?? DEFAULT_LIMITS.maxTasks,
    maxRuns: limits?.maxRuns ?? DEFAULT_LIMITS.maxRuns,
    runTimeoutMs:
      limits?.runTimeoutMinutes === undefined
        ? DEFAULT_LIMITS.runTimeoutMs
        : limits.runTimeoutMinutes * MINUTE,
    goalTimeoutMs:
      limits?.goalTimeoutMinutes === undefined
        ? DEFAULT_LIMITS.goalTimeoutMs
        : limits.goalTimeoutMinutes * MINUTE,
    retryBackoffMs:
      limits?.retryBackoffSeconds === undefined
        ? DEFAULT_LIMITS.retryBackoffMs
        : limits.retryBackoffSeconds * 1000,
    maxTotalTokens: limits?.maxTotalTokens ?? DEFAULT_LIMITS.maxTotalTokens,
    maxCostUsd: limits?.maxCostUsd ?? DEFAULT_LIMITS.maxCostUsd,
  };
}

/**
 * When the goal must be finished, in epoch milliseconds: its time limit from
 * creation, or the absolute deadline if that comes first.
 */
export function goalDeadlineMs(goal: Pick<Goal, "createdAt" | "config">): number {
  const byTimeout = Date.parse(goal.createdAt) + resolveLimits(goal.config).goalTimeoutMs;
  const deadlineAt = goal.config?.limits?.deadlineAt;
  const absolute = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  return Number.isNaN(absolute) ? byTimeout : Math.min(byTimeout, absolute);
}

/** The budget the goal has used up, as a reason to stop it, or null while within budget. */
export function budgetExceeded(goal: Pick<Goal, "usage" | "config">): string | null {
  const { maxTotalTokens, maxCostUsd } = resolveLimits(goal.config);
  const usage = goal.usage;
  if (!usage) return null;
  if (maxTotalTokens !== null && usage.totalTokens >= maxTotalTokens) {
    return `Token budget of ${maxTotalTokens} reached (${usage.totalTokens} reported)`;
  }
  if (maxCostUsd !== null && usage.costUsd >= maxCostUsd) {
    return `Cost budget of $${maxCostUsd} reached ($${usage.costUsd.toFixed(2)} reported)`;
  }
  return null;
}

/** Time source the Manager schedules against; tests supply their own. */
export interface Clock {
  now(): number;
  /** Run `fn` after `ms`. Returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(fn, ms) {
    const timer = setTimeout(fn, ms);
    // Waiting on a limit must not keep the daemon alive.
    timer.unref();
    return () => clearTimeout(timer);
  },
};
