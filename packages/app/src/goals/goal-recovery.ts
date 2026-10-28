import { goalActiveMs } from "@getpaseo/protocol/goal/active-time";
import {
  diagnoseGoalFailure,
  type BlockingLimit,
  type GoalDiagnosis,
  type GoalFailureKind,
  type PersonNeeded,
  type TaskFailureCause,
} from "@getpaseo/protocol/goal/diagnosis";
import { MAX_GUIDANCE_CHARS, RECOVERY_DECISION_MS } from "@getpaseo/protocol/goal/interventions";
import {
  GOAL_TIME_LIMIT_PASSED,
  type Goal,
  type GoalEvent,
  type GoalTimeMode,
  type Guidance,
  type GuidanceChanges,
  type Recovery,
} from "@getpaseo/protocol/goal/types";
import { toErrorMessage } from "@/utils/error-messages";
import { retryNeedsTimeMode } from "./goal-progress";

/** The daemon counts at most this many recoveries per goal (docs/goals.md "Recover a failed goal"). */
export const MAX_RECOVERIES = 3;

const LIVE_RECOVERY_STATUSES: ReadonlySet<string> = new Set([
  "deciding",
  "decided",
  "awaiting_approval",
]);

/**
 * The recovery of a failed goal that has not ended: the Lead is deciding, its decision is being
 * applied, or a plan change waits for your approval. Null otherwise.
 */
export function liveRecovery(goal: Pick<Goal, "status" | "recovery">): Recovery | null {
  const recovery = goal.recovery;
  if (goal.status !== "failed" || !recovery || !LIVE_RECOVERY_STATUSES.has(recovery.status)) {
    return null;
  }
  return recovery;
}

/**
 * The recovery whose end is the goal's current failure: it ended without reopening the goal, and
 * the goal failed when it ended. The host never clears `recovery`, so after a retry or an applied
 * recovery the goal can fail again with an older recovery still recorded; that one explains
 * nothing about the new failure. The reducer reads the same match (`resolvedAt === failedAt`).
 */
export function endedRecovery(
  goal: Pick<Goal, "status" | "recovery" | "failedAt">,
): Recovery | null {
  const recovery = goal.recovery;
  if (
    goal.status !== "failed" ||
    recovery?.status !== "ended" ||
    recovery.outcome === "applied" ||
    !recovery.resolvedAt ||
    recovery.resolvedAt !== goal.failedAt
  ) {
    return null;
  }
  return recovery;
}

/**
 * The host refused a retry or a recovery without a time mode because the goal's time limit has
 * passed, or would pass while the Lead decides. Both refusals carry `GOAL_TIME_LIMIT_PASSED`.
 */
export function isTimeLimitRefusal(error: unknown): boolean {
  return toErrorMessage(error).includes(GOAL_TIME_LIMIT_PASSED);
}

/**
 * The diagnosis the detail shows for a failed goal. A recovery that already chose a time mode
 * settles a passed time limit, so its mode is read as the person's choice.
 */
export function goalDiagnosisView(
  goal: Goal,
  events: readonly GoalEvent[],
  now: number,
): DiagnosisView {
  const timeMode = liveRecovery(goal)?.timeMode;
  return diagnosisView(
    diagnoseGoalFailure(goal, {
      now,
      activeMs: goalActiveMs(events, now),
      ...(timeMode ? { timeMode } : {}),
    }),
    goal,
  );
}

/**
 * A recovery must choose a time mode when the time limit passes before it could apply: the host
 * refuses one whose limit passes while the Lead decides (`RECOVERY_DECISION_MS`).
 */
export function recoverNeedsTimeMode(
  goal: Parameters<typeof retryNeedsTimeMode>[0],
  now: number,
): boolean {
  return retryNeedsTimeMode(goal, now + RECOVERY_DECISION_MS);
}

/**
 * The limits a recovery cannot fix by itself, as they will stand when the Lead has decided. The
 * time limit is left out: the sheet's time choice restarts it.
 */
export function recoverBlockingLimits(
  goal: Goal,
  events: readonly GoalEvent[],
  now: number,
): BlockingLimit[] {
  const at = now + RECOVERY_DECISION_MS;
  return diagnoseGoalFailure(goal, {
    now: at,
    activeMs: goalActiveMs(events, at),
  }).blockingLimits.filter((limit) => limit.limit !== "goalTimeoutMinutes");
}

export interface GoalRecoveryControls {
  /** Start a recovery: a failed managed goal, not archived, with a plan and none live. */
  canRecover: boolean;
  /** Stop the live recovery; not while its decision is being applied. */
  canCancel: boolean;
  /** Approve or reject the Lead's plan change. */
  canDecide: boolean;
}

/**
 * What the recovery offers, from the goal and `goalRecovery`. A goal with a change set rejected
 * by review cannot be recovered in place, and one that used its recoveries cannot start another.
 */
export function goalRecoveryControls(goal: Goal, hostHasRecovery: boolean): GoalRecoveryControls {
  const live = liveRecovery(goal);
  if (!hostHasRecovery || !goal.config) {
    return { canRecover: false, canCancel: false, canDecide: false };
  }
  const rejectedByReview = goal.changeSets.some(
    (changeSet) =>
      changeSet.status === "rejected" && changeSet.rejectionReason !== "integration_failed",
  );
  return {
    canRecover:
      goal.status === "failed" &&
      !goal.archivedAt &&
      !live &&
      goal.tasks.length > 0 &&
      !rejectedByReview &&
      (goal.recoveries ?? 0) < MAX_RECOVERIES,
    canCancel: live !== null && live.status !== "decided",
    canDecide: live?.status === "awaiting_approval",
  };
}

/** One finding of the diagnosis; the card words it from its kind. */
export interface DiagnosisFindingView {
  kind: GoalFailureKind;
  personNeeded: PersonNeeded;
}

export interface DiagnosisTaskView {
  taskId: string;
  title: string;
  cause: TaskFailureCause;
  failedRuns: number;
  interruptedRuns: number;
  /** Titles of the tasks that wait on this one. */
  blocks: string[];
  lastError: string | null;
}

export interface DiagnosisView {
  kind: GoalFailureKind;
  /** Whether you must act: yes when any finding says so, depends when any might. */
  personNeeded: PersonNeeded;
  findings: DiagnosisFindingView[];
  tasks: DiagnosisTaskView[];
  limits: BlockingLimit[];
  runs: { used: number; max: number };
  merged: number;
  recoverable: boolean;
}

function overallPersonNeeded(findings: readonly DiagnosisFindingView[]): PersonNeeded {
  if (findings.some((finding) => finding.personNeeded === "yes")) return "yes";
  if (findings.length === 0 || findings.some((finding) => finding.personNeeded === "depends")) {
    return "depends";
  }
  return "no";
}

/** The diagnosis as the card shows it: tasks named by title, one verdict on whether you must act. */
export function diagnosisView(diagnosis: GoalDiagnosis, goal: Pick<Goal, "tasks">): DiagnosisView {
  const titleOf = (taskId: string) =>
    goal.tasks.find((task) => task.id === taskId)?.title ?? taskId;
  const findings = diagnosis.findings.map(({ kind, personNeeded }) => ({ kind, personNeeded }));
  return {
    kind: diagnosis.kind,
    personNeeded: overallPersonNeeded(findings),
    findings,
    tasks: diagnosis.tasks.map((task) => ({
      taskId: task.taskId,
      title: titleOf(task.taskId),
      cause: task.cause,
      failedRuns: task.failedRuns,
      interruptedRuns: task.interruptedRuns,
      blocks: task.blockedDependents.map(titleOf),
      lastError: task.lastError,
    })),
    limits: diagnosis.blockingLimits,
    runs: diagnosis.runs,
    merged: diagnosis.merged.length,
    recoverable: diagnosis.recoverable,
  };
}

/** What the Recover sheet holds while you fill it. */
export interface RecoverDraft {
  /** Your instruction for the whole goal. */
  goalText: string;
  /** Your instruction per failed or cancelled task, by task id. */
  taskTexts: Readonly<Record<string, string>>;
  timeMode: GoalTimeMode | null;
}

export interface RecoverRules {
  /** The time limit passes before a recovery could apply, so a time mode is required. */
  needsTimeMode: boolean;
  /** Time mode remaining leaves no running time. */
  noneLeft: boolean;
  /** The guidance the goal has now; an emptied field clears its entry. */
  current: Guidance | undefined;
}

export type RecoverRequest =
  | { ok: true; input: { timeMode?: GoalTimeMode; guidance?: GuidanceChanges } }
  | { ok: false; error: "timeModeRequired" | "noneLeft" }
  /** The fields whose text is longer than the host accepts: the goal's and these tasks'. */
  | { ok: false; error: "tooLong"; goal: boolean; tasks: string[] };

const isTooLong = (text: string) => text.trim().length > MAX_GUIDANCE_CHARS;

/** A text change against the current entry: the new text, null to clear it, undefined for none. */
function textChange(text: string, current: string | undefined): string | null | undefined {
  const trimmed = text.trim();
  if (trimmed === (current ?? "")) return undefined;
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The `goal.recovery.start` input for a draft, or why it cannot be sent. Only changed texts are
 * sent; a field you emptied clears what the goal had.
 */
export function buildRecoverRequest(draft: RecoverDraft, rules: RecoverRules): RecoverRequest {
  if (rules.needsTimeMode && !draft.timeMode) {
    return { ok: false, error: "timeModeRequired" };
  }
  if (draft.timeMode === "remaining" && rules.noneLeft) {
    return { ok: false, error: "noneLeft" };
  }
  const longTasks = Object.entries(draft.taskTexts)
    .filter(([, text]) => isTooLong(text))
    .map(([taskId]) => taskId);
  if (isTooLong(draft.goalText) || longTasks.length > 0) {
    return { ok: false, error: "tooLong", goal: isTooLong(draft.goalText), tasks: longTasks };
  }
  const guidance: GuidanceChanges = {};
  const goalChange = textChange(draft.goalText, rules.current?.goal);
  if (goalChange !== undefined) {
    guidance.goal = goalChange;
  }
  const tasks: Record<string, string | null> = {};
  for (const [taskId, text] of Object.entries(draft.taskTexts)) {
    const change = textChange(text, rules.current?.tasks?.[taskId]);
    if (change !== undefined) {
      tasks[taskId] = change;
    }
  }
  if (Object.keys(tasks).length > 0) {
    guidance.tasks = tasks;
  }
  const hasGuidance = guidance.goal !== undefined || guidance.tasks !== undefined;
  return {
    ok: true,
    input: {
      ...(draft.timeMode ? { timeMode: draft.timeMode } : {}),
      ...(hasGuidance ? { guidance } : {}),
    },
  };
}

/** Your instruction and the Lead's advice for one task's workers. */
export interface TaskGuidance {
  person: string | null;
  /** `person` was cut short by a list payload; goal.inspect has it in full. */
  personCut: boolean;
  lead: string | null;
}

/** Length of a person's text in list payloads (`SLIM_GUIDANCE_CHARS` on the host). */
const SLIM_GUIDANCE_CHARS = 500;

/**
 * Whether this text of the goal's guidance was cut short. The payload marks the whole guidance
 * (`truncated`), not which text, so a text counts as cut only when it also has the cut's length
 * and its ellipsis. goal.inspect never cuts, so a detail never shows the mark.
 */
export function guidanceTextCut(goal: Pick<Goal, "guidance">, text: string): boolean {
  return (
    goal.guidance?.truncated === true && text.length >= SLIM_GUIDANCE_CHARS && text.endsWith("…")
  );
}

/** The guidance a task's workers get, or null when there is none. */
export function taskGuidance(goal: Pick<Goal, "guidance">, taskId: string): TaskGuidance | null {
  const person = goal.guidance?.tasks?.[taskId] ?? null;
  const lead = goal.guidance?.lead?.tasks[taskId] ?? null;
  if (!person && !lead) {
    return null;
  }
  return { person, personCut: person ? guidanceTextCut(goal, person) : false, lead };
}
