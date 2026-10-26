import { randomUUID } from "node:crypto";
import type {
  Goal,
  GoalConfig,
  GoalEvent,
  GoalEventInput,
  TaskSpec,
} from "@getpaseo/protocol/goal/types";
import type { GoalEventLog } from "./event-log.js";
import type { GoalConfigValidator } from "./goal-config-validation.js";
import type { GoalStore } from "./goal-store.js";

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
}

/** What the service asks of the Manager before reopening a failed goal. */
export interface GoalActivityProbe {
  hasLiveWork(goalId: string): boolean;
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
  ) {}

  /** The Manager is built after the service; it reports whether a goal still has work stopping. */
  attachActivityProbe(probe: GoalActivityProbe): void {
    this.activity = probe;
  }

  async start(): Promise<void> {
    await this.store.recover();
  }

  list(): Goal[] {
    return this.store.list();
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
    const config = input.config
      ? ((await this.validateConfig?.(input.config)) ?? input.config)
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
    });
    return goal;
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
   * and then every failed and cancelled task is retried whichever one is named.
   */
  async retry(goalId: string, taskId: string | undefined, eventId?: string): Promise<Goal> {
    if (await this.alreadyApplied(goalId, "goal.retried", taskId ?? "", eventId)) {
      return this.requireGoal(goalId);
    }
    const goal = this.requireManaged(goalId, "retry");
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
