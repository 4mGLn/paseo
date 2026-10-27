import type { Goal } from "@getpaseo/protocol/goal/types";
import { describeGoalWaitingOn, type GoalWaitingOnKind } from "@getpaseo/protocol/goal/waiting-on";

/** Where a goal stands, in the words the detail screen explains it with. */
export type GoalPhase =
  | "manual"
  | "planning"
  | "plan_review"
  | "paused"
  | "working"
  | "change_review"
  | "reviewing"
  | "integrating"
  | "verifying"
  | "completed"
  | "failed"
  | "cancelled";

export type GoalStepId = "planning" | "plan_review" | "working" | "review" | "integrating" | "done";

export const GOAL_STEP_IDS: readonly GoalStepId[] = [
  "planning",
  "plan_review",
  "working",
  "review",
  "integrating",
  "done",
];

export type GoalStepState = "done" | "current" | "upcoming" | "stopped";

export interface GoalStep {
  id: GoalStepId;
  state: GoalStepState;
}

const PHASE_OF_WAITING: Record<GoalWaitingOnKind, GoalPhase> = {
  paused: "paused",
  planning: "planning",
  plan_approval: "plan_review",
  change_set_approval: "change_review",
  running: "working",
  review: "reviewing",
  merge: "integrating",
  retry: "working",
  verification: "verifying",
  manual: "manual",
};

/** Where the work of a goal stands, from the protocol's shared reading of its state. */
function workPhase(goal: Goal): GoalPhase {
  // Ended goals are read as if still running, to find the step they stopped at.
  const waiting = describeGoalWaitingOn({ ...goal, status: "executing", pausedAt: null });
  return waiting ? PHASE_OF_WAITING[waiting.kind] : "verifying";
}

export function goalPhase(goal: Goal): GoalPhase {
  switch (goal.status) {
    case "completed":
    case "failed":
    case "cancelled":
      return goal.status;
    case "planning":
      return goal.config ? "planning" : "manual";
    case "awaiting_plan_approval":
      return "plan_review";
    case "executing":
      if (!goal.config) {
        return "manual";
      }
      return goal.pausedAt ? "paused" : workPhase(goal);
  }
}

const STEP_OF_PHASE: Record<GoalPhase, number> = {
  manual: 0,
  planning: 0,
  plan_review: 1,
  paused: 2,
  working: 2,
  change_review: 3,
  reviewing: 3,
  integrating: 4,
  verifying: 4,
  completed: 5,
  failed: 0,
  cancelled: 0,
};

/** The step an ended goal stopped at, read from how far its work got. */
function stoppedStep(goal: Goal): number {
  if (goal.tasks.length === 0) {
    return STEP_OF_PHASE.planning;
  }
  if (goal.runs.length === 0) {
    return STEP_OF_PHASE.plan_review;
  }
  return STEP_OF_PHASE[workPhase(goal)];
}

/** The six-step stepper, or null for a manual goal, which has no pipeline to show. */
export function goalSteps(goal: Goal): GoalStep[] | null {
  if (!goal.config) {
    return null;
  }
  if (goal.status === "completed") {
    return GOAL_STEP_IDS.map((id) => ({ id, state: "done" }));
  }
  const isEnded = goal.status === "failed" || goal.status === "cancelled";
  const reached = isEnded ? stoppedStep(goal) : STEP_OF_PHASE[goalPhase(goal)];
  return GOAL_STEP_IDS.map((id, index) => {
    if (index < reached) {
      return { id, state: "done" };
    }
    if (index === reached) {
      return { id, state: isEnded ? "stopped" : "current" };
    }
    return { id, state: "upcoming" };
  });
}

export type GoalGuidanceTone = "default" | "info" | "success" | "warning" | "error";

const TONE_OF_PHASE: Record<GoalPhase, GoalGuidanceTone> = {
  manual: "default",
  planning: "info",
  plan_review: "warning",
  paused: "default",
  working: "info",
  change_review: "warning",
  reviewing: "info",
  integrating: "info",
  verifying: "info",
  completed: "success",
  failed: "error",
  cancelled: "default",
};

export interface GoalGuidance {
  phase: GoalPhase;
  tone: GoalGuidanceTone;
  /** Interpolation values for the phase's sentence. */
  params: { running: number; total: number; held: number; branch: string };
}

/** What is happening and what, if anything, you need to do. */
export function goalGuidance(goal: Goal): GoalGuidance {
  const phase = goalPhase(goal);
  return {
    phase,
    tone: TONE_OF_PHASE[phase],
    params: {
      running: goal.tasks.filter((task) => task.status === "running").length,
      total: goal.tasks.length,
      held: goal.changeSets.filter((changeSet) => changeSet.status === "awaiting_human").length,
      branch: goal.integration?.branch ?? `paseo-goal/${goal.id}`,
    },
  };
}

/**
 * The goal failed because an agent asked for a permission. The daemon names the turn outcome
 * `needs_permission` in the reason when the Lead stops on it ("Lead agent did not finish
 * planning (needs_permission).", goal-manager.ts); that identifier is the stable part of the text.
 */
export function goalFailedOnPermission(goal: Pick<Goal, "status" | "failureReason">): boolean {
  return goal.status === "failed" && (goal.failureReason ?? "").includes("needs_permission");
}

/** The daemon refuses more plan rejections than this (docs/goals.md "Control a running goal"). */
export const MAX_PLAN_REJECTIONS = 5;

export interface GoalControls {
  canRejectPlan: boolean;
  canPause: boolean;
  canResume: boolean;
  /** Retry every failed task, reopening the failed goal. */
  canRetry: boolean;
  /** The retry reopens a goal that failed while planning: a fresh Lead plans again. */
  canRetryPlanning: boolean;
  /** Retry one failed or cancelled task of a live goal. */
  canRetryTasks: boolean;
}

const NO_CONTROLS: GoalControls = {
  canRejectPlan: false,
  canPause: false,
  canResume: false,
  canRetry: false,
  canRetryPlanning: false,
  canRetryTasks: false,
};

/**
 * Which controls to offer: only on hosts with goal controls, only for managed goals, and only in
 * the states the daemon accepts them in. A goal that failed while planning has no tasks; only a
 * host with `goalConfigEdit` reopens it, an older one refuses the retry.
 */
export function goalControlsAvailable(
  goal: Goal,
  hostHasControls: boolean,
  host: { configEdit?: boolean } = {},
): GoalControls {
  if (!hostHasControls || !goal.config) {
    return NO_CONTROLS;
  }
  const isLive =
    goal.status !== "completed" && goal.status !== "failed" && goal.status !== "cancelled";
  const rejections = goal.planRejections?.length ?? 0;
  const hasRejectedChange = goal.changeSets.some((changeSet) => changeSet.status === "rejected");
  // The daemon reopens an archived failed goal only after it is unarchived.
  const retryable = goal.status === "failed" && !hasRejectedChange && !goal.archivedAt;
  const failedPlanning = goal.tasks.length === 0;
  return {
    canRejectPlan: goal.status === "awaiting_plan_approval" && rejections < MAX_PLAN_REJECTIONS,
    canPause: isLive && !goal.pausedAt,
    canResume: isLive && Boolean(goal.pausedAt),
    canRetry: retryable && (!failedPlanning || host.configEdit === true),
    canRetryPlanning: retryable && failedPlanning && host.configEdit === true,
    canRetryTasks: goal.status === "executing",
  };
}
