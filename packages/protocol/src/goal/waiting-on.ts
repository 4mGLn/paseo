import type { Goal, Task } from "./types.js";

export type GoalWaitingOnKind =
  | "paused"
  | "planning"
  | "plan_approval"
  | "change_set_approval"
  | "running"
  | "review"
  | "merge"
  | "retry"
  | "verification"
  | "manual";

export interface GoalWaitingOn {
  kind: GoalWaitingOnKind;
  /** A short phrase for display, such as "plan approval" or "running task t1 (Add tests)". */
  label: string;
}

/**
 * What a live goal is waiting on, derived from its state alone so every client
 * describes it the same way. Null for an ended goal.
 */
export function describeGoalWaitingOn(goal: Goal): GoalWaitingOn | null {
  if (goal.status === "completed" || goal.status === "failed" || goal.status === "cancelled") {
    return null;
  }
  if (goal.pausedAt) return { kind: "paused", label: "resume (paused)" };
  if (goal.status === "planning") {
    return goal.config
      ? { kind: "planning", label: "the Lead's plan" }
      : { kind: "manual", label: "a plan to be proposed" };
  }
  if (goal.status === "awaiting_plan_approval") {
    return { kind: "plan_approval", label: "plan approval" };
  }
  if (!goal.config) return { kind: "manual", label: "task updates recorded by hand" };

  const held = goal.changeSets.filter((c) => c.status === "awaiting_human");
  if (held.length > 0) {
    return { kind: "change_set_approval", label: `change set approval: ${ids(held)}` };
  }
  const running = goal.tasks.filter((t) => t.status === "running");
  if (running.length > 0) {
    return {
      kind: "running",
      label: `running ${plural(running.length, "task")} ${tasks(running)}`,
    };
  }
  const reviewing = goal.changeSets.filter(
    (c) => c.status === "captured" || c.status === "in_review",
  );
  if (reviewing.length > 0) return { kind: "review", label: `review of ${ids(reviewing)}` };
  const merging = goal.changeSets.filter(
    (c) => c.status === "approved" || c.status === "integrating",
  );
  if (merging.length > 0) return { kind: "merge", label: `merge of ${ids(merging)}` };
  const failed = goal.tasks.filter((t) => t.status === "failed");
  if (failed.length > 0) return { kind: "retry", label: `retry of ${tasks(failed)}` };
  if (goal.tasks.length > 0 && goal.tasks.every((t) => t.status === "succeeded")) {
    return { kind: "verification", label: "verification of the acceptance criteria" };
  }
  const pending = goal.tasks.filter((t) => t.status === "pending");
  return { kind: "running", label: `starting ${plural(pending.length, "task")} ${tasks(pending)}` };
}

function ids(items: { id: string }[]): string {
  return items.map((i) => i.id).join(", ");
}

function tasks(items: Task[]): string {
  return items.map((t) => `${t.id} (${t.title})`).join(", ");
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}
