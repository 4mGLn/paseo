import { randomUUID } from "node:crypto";
import type {
  GoalListArchivedFilter,
  GoalRetainedResource,
} from "@getpaseo/protocol/goal/rpc-schemas";
import { DEFAULT_GOAL_PERMISSION_POLICY } from "@getpaseo/protocol/goal/config-bounds";
import {
  GoalConfigSchema,
  type Goal,
  type GoalConfig,
  type GoalConfigChanges,
  type GoalEvent,
  type GoalEventInput,
  type GoalPriority,
  type GoalStatus,
  type TaskSpec,
} from "@getpaseo/protocol/goal/types";
import type { GoalEventLog } from "./event-log.js";
import type { GoalConfigUpdateValidator, GoalConfigValidator } from "./goal-config-validation.js";
import { goalPriority, sortGoalsByPriority } from "./goal-priority.js";
import { isTerminalGoalStatus } from "./goal-reducer.js";
import type { GoalRemovedListener, GoalStore, GoalStoreListener } from "./goal-store.js";

/** Client ids are namespaced so they cannot collide with the Manager's own event ids. */
function clientEventId(type: string, target: string, eventId: string): string {
  return `client:${type}:${target}:${eventId}`;
}

export class GoalNotFoundError extends Error {
  constructor(public readonly goalId: string) {
    super(`Goal ${goalId} not found`);
    this.name = "GoalNotFoundError";
  }
}

export interface CreateGoalInput {
  goalId?: string;
  title: string;
  objective: string;
  criteria: string[];
  config?: GoalConfig | null;
  priority?: GoalPriority;
}

/** What the service asks of the Manager before reopening or deleting a goal. */
export interface GoalActivityProbe {
  hasLiveWork(goalId: string): boolean;
  /** Remove what a deleted goal created; returns what was left in place. Never throws. */
  releaseResources?(goal: Goal): Promise<GoalRetainedResource[]>;
}

/** goal.list filters. Every one is optional; they combine with AND. */
export interface GoalListFilter {
  query?: string;
  status?: readonly GoalStatus[];
  priority?: readonly GoalPriority[];
  cwd?: string;
  /** Absent hides archived goals. */
  archived?: GoalListArchivedFilter;
}

export interface GoalDeletion {
  goalId: string;
  /** False when there was no such goal, for example on a repeated delete. */
  deleted: boolean;
  retained: GoalRetainedResource[];
}

/** Every filter in `filter` holds for the goal. */
export function matchesGoalFilter(goal: Goal, filter: GoalListFilter): boolean {
  const archived = filter.archived ?? "exclude";
  if (archived === "exclude" && goal.archivedAt) return false;
  if (archived === "only" && !goal.archivedAt) return false;
  if (filter.status && !filter.status.includes(goal.status)) return false;
  if (filter.priority && !filter.priority.includes(goalPriority(goal))) return false;
  if (filter.cwd !== undefined && goal.config?.cwd !== filter.cwd) return false;
  const query = filter.query?.trim().toLowerCase();
  if (query) {
    const haystack = [goal.title, goal.objective, goal.id];
    if (!haystack.some((text) => text.toLowerCase().includes(query))) return false;
  }
  return true;
}

export interface GoalInspection {
  goal: Goal;
  events: GoalEvent[];
}

/**
 * The Manager's command surface. It turns requests into events and never
 * decides anything itself; legality lives in the reducer.
 */
export class GoalService {
  private activity: GoalActivityProbe | null = null;

  constructor(
    private readonly store: GoalStore,
    private readonly log: GoalEventLog,
    private readonly validateConfig?: GoalConfigValidator,
    private readonly validateConfigUpdate?: GoalConfigUpdateValidator,
  ) {}

  /** The Manager is built after the service; it reports whether a goal still has work stopping. */
  attachActivityProbe(probe: GoalActivityProbe): void {
    this.activity = probe;
  }

  async start(): Promise<void> {
    await this.store.recover();
  }

  /** Matching goals, higher priority first, then oldest first. Archived ones are hidden by default. */
  list(filter: GoalListFilter = {}): Goal[] {
    return sortGoalsByPriority(this.store.list().filter((goal) => matchesGoalFilter(goal, filter)));
  }

  /** Called after each event is recorded; returns the unsubscribe. */
  subscribe(listener: GoalStoreListener): () => void {
    return this.store.subscribe(listener);
  }

  /** Called once per deleted goal with its last state; returns the unsubscribe. */
  subscribeRemoved(listener: GoalRemovedListener): () => void {
    return this.store.subscribeRemoved(listener);
  }

  async inspect(goalId: string): Promise<GoalInspection> {
    const goal = this.requireGoal(goalId);
    return { goal, events: await this.log.read(goalId) };
  }

  async create(input: CreateGoalInput): Promise<Goal> {
    // Completion rests on verified criteria; without any, there would be nothing to verify.
    if (input.config && input.criteria.length === 0) {
      throw new Error("A managed goal needs at least one acceptance criterion");
    }
    const validated = input.config
      ? ((await this.validateConfig?.(input.config)) ?? input.config)
      : null;
    // The default is recorded, so a later change of default leaves this goal as it was.
    const config = validated
      ? {
          ...validated,
          onPermissionRequest: validated.onPermissionRequest ?? DEFAULT_GOAL_PERMISSION_POLICY,
        }
      : null;
    const goalId = input.goalId ?? randomUUID();
    const { goal } = await this.store.dispatch(goalId, {
      // Derived from the goal id so a retried create is a duplicate, not a second goal.
      id: `${goalId}:created`,
      goalId,
      type: "goal.created",
      title: input.title,
      objective: input.objective,
      criteria: input.criteria.map((text, index) => ({ id: `c${index + 1}`, text })),
      ...(config ? { config } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
    });
    return goal;
  }

  /** Allowed in any state. The same title again returns the goal unchanged. */
  async rename(goalId: string, title: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.renamed", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const trimmed = title.trim();
    if (!trimmed) throw new Error("A goal title cannot be empty");
    const goal = this.requireGoal(goalId);
    if (goal.title === trimmed) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.renamed", title: trimmed });
  }

  /**
   * Change a managed goal's settings, in any state but archived. The changes are merged
   * into the current config and checked as on create. A live goal picks them up at its
   * next turn or run. The same settings again return the goal unchanged.
   */
  async updateConfig(goalId: string, changes: GoalConfigChanges, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.config_updated", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireManaged(goalId, "change");
    if (goal.archivedAt) {
      throw new Error(`Goal ${goalId} is archived; unarchive it before changing its settings`);
    }
    const previous = goal.config as GoalConfig;
    const parsed = GoalConfigSchema.safeParse(mergeConfigChanges(previous, changes));
    if (!parsed.success) {
      throw new Error(`Invalid goal settings: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }
    const next = parsed.data;
    if (stableJson(next) === stableJson(previous)) return goal;
    await this.validateConfigUpdate?.(next, previous);
    return this.dispatch(goalId, eventId, { type: "goal.config_updated", config: next });
  }

  /** Allowed in any state. The current priority again returns the goal unchanged. */
  async setPriority(goalId: string, priority: GoalPriority, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.priority_set", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireGoal(goalId);
    if (goalPriority(goal) === priority) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.priority_set", priority });
  }

  /** Only an ended goal can be archived. Archiving twice returns the goal unchanged. */
  async archive(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.archived", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireEnded(goalId, "archived");
    if (goal.archivedAt) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.archived" });
  }

  /** Unarchiving a goal that is not archived returns it unchanged. */
  async unarchive(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.unarchived", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireGoal(goalId);
    if (!goal.archivedAt) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.unarchived" });
  }

  /**
   * Delete an ended goal for good. Its log is tombstoned first, in one atomic rename,
   * so a crash leaves the goal either whole or marked deleted; the worktrees it created
   * are removed next, and the tombstone last. A restart finishes a deletion that a crash
   * interrupted. Deleting a goal that does not exist succeeds with `deleted: false`.
   */
  async delete(goalId: string): Promise<GoalDeletion> {
    if (this.store.get(goalId)) this.requireEnded(goalId, "deleted");
    const removed = await this.store.remove(goalId, (goal) => {
      if (!isTerminalGoalStatus(goal.status)) {
        throw new Error(`Goal ${goalId} is ${goal.status}; stop it before it can be deleted`);
      }
      if (this.activity?.hasLiveWork(goalId)) {
        throw new Error("The goal's agents are still stopping; delete again in a moment");
      }
    });
    if (!removed) return { goalId, deleted: false, retained: [] };
    const retained = (await this.activity?.releaseResources?.(removed)) ?? [];
    await this.store.removeTombstone(goalId);
    return { goalId, deleted: true, retained };
  }

  async proposePlan(goalId: string, tasks: TaskSpec[], eventId?: string): Promise<Goal> {
    // A managed goal's plan comes from its Lead, which is checked against the goal's
    // providers and limits; a hand-written plan would skip those checks.
    if (this.requireGoal(goalId).config) {
      throw new Error("This goal's plan comes from its Lead and cannot be proposed by hand");
    }
    return this.dispatch(goalId, eventId, { type: "plan.proposed", tasks });
  }

  approvePlan(goalId: string, eventId?: string): Promise<Goal> {
    return this.dispatch(goalId, eventId, { type: "plan.approved" });
  }

  /** A person releases a reviewed change set that is held for human approval. */
  async approveChangeSet(goalId: string, changeSetId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "changeset.transitioned", changeSetId, eventId)) {
      return this.requireGoal(goalId);
    }
    const changeSet = this.requireGoal(goalId).changeSets.find((c) => c.id === changeSetId);
    if (!changeSet) {
      throw new Error(`Change set ${changeSetId} not found in goal ${goalId}`);
    }
    if (changeSet.status !== "awaiting_human") {
      throw new Error(
        `Change set ${changeSetId} is ${changeSet.status}; only a reviewed change set held for approval can be approved`,
      );
    }
    return this.dispatch(goalId, eventId, {
      type: "changeset.transitioned",
      changeSetId,
      to: "approved",
    });
  }

  /** A person sends a change set held for approval back to its author. */
  async requestChanges(
    goalId: string,
    changeSetId: string,
    findings: string,
    eventId?: string,
  ): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "changeset.transitioned", changeSetId, eventId)) {
      return this.requireGoal(goalId);
    }
    const changeSet = this.requireGoal(goalId).changeSets.find((c) => c.id === changeSetId);
    if (!changeSet) {
      throw new Error(`Change set ${changeSetId} not found in goal ${goalId}`);
    }
    if (changeSet.status !== "awaiting_human") {
      throw new Error(
        `Change set ${changeSetId} is ${changeSet.status}; changes can only be requested while it is held for approval`,
      );
    }
    return this.dispatch(goalId, eventId, {
      type: "changeset.transitioned",
      changeSetId,
      to: "changes_requested",
      findings: `- ${findings}`,
    });
  }

  cancel(goalId: string, eventId?: string): Promise<Goal> {
    return this.dispatch(goalId, eventId, { type: "goal.cancelled" });
  }

  /** A person sends the proposed plan back; the Lead plans again with the feedback. */
  rejectPlan(goalId: string, feedback: string | undefined, eventId?: string): Promise<Goal> {
    return this.dispatch(goalId, eventId, {
      type: "plan.rejected",
      reason: feedback?.trim() ?? "",
    });
  }

  /** Stop new worker runs from starting. Runs already going finish normally. */
  async pause(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.paused", "", eventId)) {
      return this.requireGoal(goalId);
    }
    this.requireManaged(goalId, "pause");
    return this.dispatch(goalId, eventId, { type: "goal.paused" });
  }

  async resume(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.resumed", "", eventId)) {
      return this.requireGoal(goalId);
    }
    this.requireManaged(goalId, "resume");
    return this.dispatch(goalId, eventId, { type: "goal.resumed" });
  }

  /**
   * Retry one failed or cancelled task, or all of them. A failed goal is reopened,
   * and then every failed and cancelled task is retried whichever one is named. A goal
   * that failed while planning has no tasks; it is reopened and a fresh Lead plans.
   */
  async retry(goalId: string, taskId: string | undefined, eventId?: string): Promise<Goal> {
    if (
      (await this.alreadyApplied(goalId, "goal.retried", taskId ?? "", eventId)) ||
      (await this.alreadyApplied(goalId, "goal.reopened", "", eventId))
    ) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireManaged(goalId, "retry");
    if (goal.status === "failed" && goal.tasks.length === 0) {
      if (taskId) throw new Error(`Task ${taskId} not found in goal ${goalId}`);
      if (this.activity?.hasLiveWork(goalId)) {
        throw new Error("The goal's agents are still stopping; retry again in a moment");
      }
      return this.dispatch(goalId, eventId, { type: "goal.reopened" });
    }
    const retryable = goal.tasks
      .filter((t) => t.status === "failed" || t.status === "cancelled")
      .map((t) => t.id);
    const reopen = goal.status === "failed";
    if (taskId && !retryable.includes(taskId)) {
      const task = goal.tasks.find((t) => t.id === taskId);
      throw new Error(
        task
          ? `Task ${taskId} is ${task.status}; only a failed or cancelled task can be retried`
          : `Task ${taskId} not found in goal ${goalId}`,
      );
    }
    if (retryable.length === 0) {
      throw new Error(`Goal ${goalId} has no failed or cancelled task to retry`);
    }
    if (reopen && this.activity?.hasLiveWork(goalId)) {
      throw new Error("The goal's agents are still stopping; retry again in a moment");
    }
    return this.dispatch(goalId, eventId, {
      type: "goal.retried",
      taskIds: reopen || !taskId ? retryable : [taskId],
      reopen,
      target: taskId ?? "",
    });
  }

  /**
   * A person dismisses an ended goal, so it stops asking for attention. It changes
   * nothing else: a failed goal can still be retried, and a reopened goal that ends
   * again needs a new acknowledgement. Acknowledging twice returns the goal unchanged.
   */
  async acknowledge(goalId: string, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.acknowledged", "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireGoal(goalId);
    if (goal.status !== "completed" && goal.status !== "failed" && goal.status !== "cancelled") {
      throw new Error(`Goal ${goalId} is ${goal.status}; only an ended goal can be acknowledged`);
    }
    if (goal.acknowledgedAt) return goal;
    return this.dispatch(goalId, eventId, { type: "goal.acknowledged" });
  }

  private async dispatch(
    goalId: string,
    eventId: string | undefined,
    body: Record<string, unknown> & { type: GoalEventInput["type"] },
  ): Promise<Goal> {
    this.requireGoal(goalId);
    // `target` scopes the client id to what the request acts on; it is not part of the event.
    const { target, ...fields } = body;
    const scope = String(target ?? body.changeSetId ?? "");
    const { goal } = await this.store.dispatch(goalId, {
      // Client ids are namespaced so they cannot collide with the Manager's own.
      id: eventId ? clientEventId(body.type, scope, eventId) : randomUUID(),
      goalId,
      ...fields,
    } as GoalEventInput);
    return goal;
  }

  /**
   * A resend with the same eventId must return the result of the first request, even
   * though the state that request changed no longer passes the usual checks.
   */
  private async alreadyApplied(
    goalId: string,
    type: string,
    changeSetId: string,
    eventId: string | undefined,
  ): Promise<boolean> {
    if (!eventId) return false;
    this.requireGoal(goalId);
    return this.log.hasEvent(goalId, clientEventId(type, changeSetId, eventId));
  }

  /** A live goal must be stopped (goal.cancel) before it is archived or deleted. */
  private requireEnded(goalId: string, action: string): Goal {
    const goal = this.requireGoal(goalId);
    if (!isTerminalGoalStatus(goal.status)) {
      throw new Error(`Goal ${goalId} is ${goal.status}; stop it before it can be ${action}`);
    }
    return goal;
  }

  /** A manual goal runs nothing, so it has nothing to pause, resume or retry. */
  private requireManaged(goalId: string, action: string): Goal {
    const goal = this.requireGoal(goalId);
    if (!goal.config) {
      throw new Error(`Goal ${goalId} is manual and runs nothing; there is nothing to ${action}`);
    }
    return goal;
  }

  private requireGoal(goalId: string): Goal {
    const goal = this.store.get(goalId);
    if (!goal) {
      throw new GoalNotFoundError(goalId);
    }
    return goal;
  }
}

/** The config with `changes` applied: absent keeps a setting, null clears an optional one. */
export function mergeConfigChanges(config: GoalConfig, changes: GoalConfigChanges): GoalConfig {
  const { limits: limitChanges, ...topLevel } = changes;
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(topLevel)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (limitChanges) {
    const limits: Record<string, unknown> = { ...config.limits };
    for (const [key, value] of Object.entries(limitChanges)) {
      if (value === undefined) continue;
      if (value === null) delete limits[key];
      else limits[key] = value;
    }
    if (Object.keys(limits).length > 0) next.limits = limits;
    else delete next.limits;
  }
  return next as GoalConfig;
}

/** JSON with object keys sorted, so two configs compare by content alone. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}
