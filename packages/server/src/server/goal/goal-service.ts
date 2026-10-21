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

export interface GoalInspection {
  goal: Goal;
  events: GoalEvent[];
}

/**
 * The Manager's command surface. It turns requests into events and never
 * decides anything itself; legality lives in the reducer.
 */
export class GoalService {
  constructor(
    private readonly store: GoalStore,
    private readonly log: GoalEventLog,
    private readonly validateConfig?: GoalConfigValidator,
  ) {}

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

  private async dispatch(
    goalId: string,
    eventId: string | undefined,
    body: Record<string, unknown> & { type: GoalEventInput["type"] },
  ): Promise<Goal> {
    this.requireGoal(goalId);
    const { goal } = await this.store.dispatch(goalId, {
      // Client ids are namespaced so they cannot collide with the Manager's own.
      id: eventId
        ? clientEventId(body.type, String(body.changeSetId ?? ""), eventId)
        : randomUUID(),
      goalId,
      ...body,
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

  private requireGoal(goalId: string): Goal {
    const goal = this.store.get(goalId);
    if (!goal) {
      throw new GoalNotFoundError(goalId);
    }
    return goal;
  }
}
