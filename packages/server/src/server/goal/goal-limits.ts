import type { GoalConfig } from "@getpaseo/protocol/goal/types";

export interface ResolvedLimits {
  maxTasks: number;
  maxRuns: number;
  runTimeoutMs: number;
  goalTimeoutMs: number;
  retryBackoffMs: number;
}

const MINUTE = 60_000;

export const DEFAULT_LIMITS: ResolvedLimits = {
  maxTasks: 25,
  maxRuns: 60,
  runTimeoutMs: 60 * MINUTE,
  goalTimeoutMs: 24 * 60 * MINUTE,
  retryBackoffMs: 5_000,
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
  };
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
