import type { ChangeSetStatus, Goal, GoalEvent } from "@getpaseo/protocol/goal/types";

export type GoalFeedTone = "default" | "success" | "warning" | "error";

/** One line of the activity feed. `key` names a sentence under `goals.events`. */
export interface GoalFeedEntry {
  id: string;
  key: string;
  tone: GoalFeedTone;
  /** What the sentence is about: task titles, a reason, a provider. Several when collapsed. */
  subjects: string[];
  detail: string | null;
  count: number;
  /** The newest event folded into this line. */
  at: string;
  events: GoalEvent[];
}

type FeedGoal = Pick<Goal, "tasks" | "runs" | "changeSets" | "criteria">;

interface Described {
  key: string;
  tone: GoalFeedTone;
  subject: string | null;
  detail?: string | null;
}

const CHANGE_SET_KEYS: Partial<Record<ChangeSetStatus, Described["key"]>> = {
  in_review: "changeSetInReview",
  awaiting_human: "changeSetAwaitingYou",
  approved: "changeSetApproved",
  integrated: "changeSetIntegrated",
  changes_requested: "changeSetChangesRequested",
  conflicted: "changeSetConflicted",
  test_failed: "changeSetTestFailed",
  rejected: "changeSetRejected",
};

const CHANGE_SET_TONES: Partial<Record<ChangeSetStatus, GoalFeedTone>> = {
  awaiting_human: "warning",
  approved: "success",
  integrated: "success",
  changes_requested: "warning",
  conflicted: "warning",
  test_failed: "error",
  rejected: "error",
};

function taskTitle(goal: FeedGoal, taskId: string): string {
  return goal.tasks.find((task) => task.id === taskId)?.title ?? taskId;
}

function runTaskTitle(goal: FeedGoal, runId: string): string {
  const run = goal.runs.find((candidate) => candidate.id === runId);
  return run ? taskTitle(goal, run.taskId) : runId;
}

function changeSetTitle(goal: FeedGoal, changeSetId: string): string {
  const changeSet = goal.changeSets.find((candidate) => candidate.id === changeSetId);
  return changeSet ? taskTitle(goal, changeSet.taskId) : changeSetId;
}

/**
 * The sentence for one event, or null for bookkeeping nobody needs to read: attachments,
 * delivered notifications, usage records, and steps another event already tells.
 */
export function describeGoalEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "goal.created":
      return { key: "goalCreated", tone: "default", subject: null };
    case "lead.attached":
      return { key: "leadStarted", tone: "default", subject: null };
    case "plan.proposed":
      return { key: "planProposed", tone: "default", subject: String(event.tasks.length) };
    case "plan.approved":
      return { key: "planApproved", tone: "success", subject: null };
    case "plan.rejected":
      return { key: "planRejected", tone: "warning", subject: null, detail: event.reason || null };
    case "run.started":
      return {
        key: "taskStarted",
        tone: "default",
        subject: taskTitle(goal, event.taskId),
        detail: event.provider,
      };
    case "run.finished":
      if (event.outcome === "interrupted") {
        return { key: "runInterrupted", tone: "warning", subject: runTaskTitle(goal, event.runId) };
      }
      return null;
    case "task.succeeded":
      return { key: "taskSucceeded", tone: "success", subject: taskTitle(goal, event.taskId) };
    case "task.failed":
      return {
        key: "taskFailed",
        tone: "error",
        subject: taskTitle(goal, event.taskId),
        detail: event.error,
      };
    case "task.retried":
      return { key: "taskRetried", tone: "default", subject: taskTitle(goal, event.taskId) };
    case "task.cancelled":
      return { key: "taskCancelled", tone: "default", subject: taskTitle(goal, event.taskId) };
    case "task.added":
      return {
        key: `reworkAdded_${event.rework.reason}`,
        tone: "warning",
        subject: changeSetTitle(goal, event.rework.changeSetId),
      };
    default:
      return describeOutcomeEvent(event, goal);
  }
}

/** The second half of `describeGoalEvent`: review, merge, verification and the goal's end. */
function describeOutcomeEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "criterion.verified": {
      const criterion = goal.criteria.find((candidate) => candidate.id === event.criterionId);
      return {
        key: "criterionVerified",
        tone: "success",
        subject: criterion?.text ?? event.criterionId,
      };
    }
    case "integration.prepared":
      return { key: "integrationPrepared", tone: "default", subject: event.branch };
    case "changeset.captured":
      return {
        key: "changeSetCaptured",
        tone: "default",
        subject: taskTitle(goal, event.taskId),
      };
    case "capture.skipped":
      return { key: "captureSkipped", tone: "default", subject: taskTitle(goal, event.taskId) };
    case "changeset.transitioned": {
      const key = CHANGE_SET_KEYS[event.to];
      if (!key) {
        return null;
      }
      return {
        key,
        tone: CHANGE_SET_TONES[event.to] ?? "default",
        subject: changeSetTitle(goal, event.changeSetId),
        detail: event.findings ?? event.error ?? event.testSummary ?? null,
      };
    }
    case "notification.attempted":
      if (event.outcome === "failed") {
        return {
          key: `notifyFailed_${event.target}`,
          tone: "warning",
          subject: null,
          detail: event.error ?? null,
        };
      }
      return null;
    default:
      return describeGoalEndEvent(event, goal);
  }
}

/** How the goal itself moved: ended, paused, resumed or retried. */
function describeGoalEndEvent(event: GoalEvent, goal: FeedGoal): Described | null {
  switch (event.type) {
    case "goal.completed":
      return { key: "goalCompleted", tone: "success", subject: null };
    case "goal.failed":
      return { key: "goalFailed", tone: "error", subject: null, detail: event.reason };
    case "goal.cancelled":
      return { key: "goalCancelled", tone: "default", subject: null };
    case "goal.paused":
      return { key: "goalPaused", tone: "default", subject: null };
    case "goal.resumed":
      return { key: "goalResumed", tone: "default", subject: null };
    case "goal.retried":
      return {
        key: "goalRetried",
        tone: "default",
        subject: event.taskIds.map((taskId) => taskTitle(goal, taskId)).join(", "),
      };
    default:
      return null;
  }
}

/**
 * The goal's history as sentences, newest first. Consecutive events that say the same thing
 * (several tasks starting, the same task retried) fold into one line.
 */
export function buildGoalEventFeed(events: readonly GoalEvent[], goal: FeedGoal): GoalFeedEntry[] {
  const entries: GoalFeedEntry[] = [];
  for (const event of events) {
    const described = describeGoalEvent(event, goal);
    if (!described) {
      continue;
    }
    const last = entries[entries.length - 1];
    const detail = described.detail ?? null;
    if (last && last.key === described.key && last.detail === detail) {
      if (described.subject && !last.subjects.includes(described.subject)) {
        last.subjects.push(described.subject);
      }
      last.count += 1;
      last.at = event.at;
      last.events.push(event);
      continue;
    }
    entries.push({
      id: event.id,
      key: described.key,
      tone: described.tone,
      subjects: described.subject ? [described.subject] : [],
      detail,
      count: 1,
      at: event.at,
      events: [event],
    });
  }
  return entries.toReversed();
}
