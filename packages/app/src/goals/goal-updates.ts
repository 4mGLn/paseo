import type { GoalSummary } from "@getpaseo/protocol/goal/types";

/**
 * The cached list with one pushed goal applied. A push older than the cached copy (a lower
 * `lastSeq`) is dropped, so a late push cannot move a goal backwards.
 */
export function applyGoalUpdate(goals: readonly GoalSummary[], update: GoalSummary): GoalSummary[] {
  const index = goals.findIndex((goal) => goal.id === update.id);
  if (index === -1) {
    return [update, ...goals];
  }
  const current = goals[index];
  if (current && current.lastSeq > update.lastSeq) {
    return goals.slice();
  }
  const next = goals.slice();
  next[index] = update;
  return next;
}

/**
 * A polled list merged with what the cache already holds. A poll that left before a push
 * arrived carries the older state; the newer cached goal wins.
 */
export function mergePolledGoals(
  cached: readonly GoalSummary[] | undefined,
  polled: readonly GoalSummary[],
): GoalSummary[] {
  if (!cached || cached.length === 0) {
    return polled.slice();
  }
  const newer = new Map(cached.map((goal) => [goal.id, goal]));
  return polled.map((goal) => {
    const held = newer.get(goal.id);
    return held && held.lastSeq > goal.lastSeq ? held : goal;
  });
}
