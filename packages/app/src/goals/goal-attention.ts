import type { Goal, GoalStatus } from "@getpaseo/protocol/goal/types";

/** Why a goal is waiting on you. A plan or a change to approve blocks it; a failure only reports. */
export type GoalAttentionKind = "plan_review" | "change_review" | "failed";

export type GoalListFilter = "needs_you" | "running" | "done" | "all";

export const GOAL_LIST_FILTERS: readonly GoalListFilter[] = ["needs_you", "running", "done", "all"];

type AttentionInput = Pick<Goal, "status" | "changeSets" | "acknowledgedAt" | "archivedAt">;

const DONE_STATUSES: ReadonlySet<GoalStatus> = new Set(["completed", "failed", "cancelled"]);

function awaitingChangeSetIds(goal: AttentionInput): string[] {
  return goal.changeSets
    .filter((changeSet) => changeSet.status === "awaiting_human")
    .map((changeSet) => changeSet.id);
}

export function goalAttention(goal: AttentionInput): GoalAttentionKind | null {
  // Archiving puts an ended goal away; it stops asking like a dismissed one.
  if (goal.archivedAt) {
    return null;
  }
  if (goal.status === "awaiting_plan_approval") {
    return "plan_review";
  }
  // A dismissed failure stops asking; a retry that reopens the goal clears the mark.
  if (goal.status === "failed") {
    return goal.acknowledgedAt ? null : "failed";
  }
  if (goal.status === "executing" && awaitingChangeSetIds(goal).length > 0) {
    return "change_review";
  }
  return null;
}

/** An ended goal that has not been dismissed yet; the daemon refuses to acknowledge a live one. */
export function canAcknowledgeGoal(goal: Pick<Goal, "status" | "acknowledgedAt">): boolean {
  return DONE_STATUSES.has(goal.status) && !goal.acknowledgedAt;
}

/** Plans and changes held for your approval. Failures are listed, but do not count here. */
export function isBlockedOnUser(kind: GoalAttentionKind | null): boolean {
  return kind === "plan_review" || kind === "change_review";
}

export function countGoalsBlockedOnUser(goals: readonly AttentionInput[]): number {
  return goals.filter((goal) => isBlockedOnUser(goalAttention(goal))).length;
}

export function matchesGoalListFilter(goal: AttentionInput, filter: GoalListFilter): boolean {
  switch (filter) {
    case "needs_you":
      return goalAttention(goal) !== null;
    case "running":
      return !DONE_STATUSES.has(goal.status);
    case "done":
      return DONE_STATUSES.has(goal.status);
    case "all":
      return true;
  }
}

export function countGoalsByFilter(
  goals: readonly AttentionInput[],
): Record<GoalListFilter, number> {
  const counts: Record<GoalListFilter, number> = { needs_you: 0, running: 0, done: 0, all: 0 };
  for (const goal of goals) {
    for (const filter of GOAL_LIST_FILTERS) {
      if (matchesGoalListFilter(goal, filter)) {
        counts[filter] += 1;
      }
    }
  }
  return counts;
}

export interface GoalListSections<T> {
  /** Goals waiting on you. */
  attention: T[];
  others: T[];
  /** Archived goals, present only when the list shows them. */
  archived: T[];
}

const byRecentUpdate = (a: Pick<Goal, "updatedAt">, b: Pick<Goal, "updatedAt">) =>
  Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

/**
 * The goals the filter keeps, split into the ones waiting on you, the rest, and the archived
 * ones, each in `compare` order (newest activity first by default).
 */
export function buildGoalListSections<T extends AttentionInput & Pick<Goal, "updatedAt">>(
  goals: readonly T[],
  filter: GoalListFilter,
  compare: (a: T, b: T) => number = byRecentUpdate,
): GoalListSections<T> {
  const sorted = goals.filter((goal) => matchesGoalListFilter(goal, filter)).sort(compare);
  const live = sorted.filter((goal) => !goal.archivedAt);
  return {
    attention: live.filter((goal) => goalAttention(goal) !== null),
    others: live.filter((goal) => goalAttention(goal) === null),
    archived: sorted.filter((goal) => Boolean(goal.archivedAt)),
  };
}

interface GoalAttentionMark {
  kind: GoalAttentionKind | null;
  changeSetIds: readonly string[];
}

/** What each goal was waiting on at one poll, compared with the next by `findNewGoalAttention`. */
export type GoalAttentionSnapshot = ReadonlyMap<string, GoalAttentionMark>;

export function snapshotGoalAttention(
  goals: readonly (AttentionInput & Pick<Goal, "id">)[],
): GoalAttentionSnapshot {
  return new Map(
    goals.map((goal) => [
      goal.id,
      { kind: goalAttention(goal), changeSetIds: awaitingChangeSetIds(goal) },
    ]),
  );
}

export interface GoalAttentionTransition<T> {
  goal: T;
  kind: GoalAttentionKind;
}

/**
 * Goals that started waiting on you since the previous poll: a new state, or another change set
 * held for approval. Without a previous poll nothing is new, so opening the app is quiet.
 */
export function findNewGoalAttention<T extends AttentionInput & Pick<Goal, "id">>(
  previous: GoalAttentionSnapshot | null,
  goals: readonly T[],
): GoalAttentionTransition<T>[] {
  if (!previous) {
    return [];
  }
  const transitions: GoalAttentionTransition<T>[] = [];
  for (const goal of goals) {
    const kind = goalAttention(goal);
    if (!kind) {
      continue;
    }
    const before = previous.get(goal.id);
    const isNewKind = before?.kind !== kind;
    const hasNewChangeSet =
      kind === "change_review" &&
      awaitingChangeSetIds(goal).some((id) => !before?.changeSetIds.includes(id));
    if (isNewKind || hasNewChangeSet) {
      transitions.push({ goal, kind });
    }
  }
  return transitions;
}
