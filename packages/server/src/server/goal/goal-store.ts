import type { Goal, GoalEvent, GoalEventInput } from "@getpaseo/protocol/goal/types";
import type { GoalEventLog } from "./event-log.js";
import { applyGoalEvent, replayGoal } from "./goal-reducer.js";

export type GoalStoreListener = (goal: Goal, event: GoalEvent) => void;

export interface DispatchResult {
  goal: Goal;
  /** True when the event id was already applied; state is unchanged. */
  duplicate: boolean;
}

/**
 * Goal state is a projection of the event log. dispatch() validates the event
 * against current state before it is written, so the log never holds an event
 * the reducer would reject on replay.
 */
export class GoalStore {
  private readonly goals = new Map<string, Goal>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly listeners = new Set<GoalStoreListener>();
  /** Goals whose log could not be replayed at the last recover(). */
  readonly unreadable = new Map<string, Error>();

  constructor(private readonly log: GoalEventLog) {}

  /** Called after an event is durably appended and applied. Not called for duplicates. */
  subscribe(listener: GoalStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Rebuild every goal from its log. Call once at daemon start. */
  async recover(): Promise<void> {
    this.goals.clear();
    this.unreadable.clear();
    for (const goalId of await this.log.listGoalIds()) {
      try {
        const goal = replayGoal(await this.log.read(goalId));
        if (goal) {
          this.goals.set(goalId, goal);
        }
      } catch (error) {
        // One bad log must not keep the daemon from starting. The goal stays
        // unavailable and its file is left untouched for inspection.
        this.unreadable.set(goalId, error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  get(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  list(): Goal[] {
    return [...this.goals.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  dispatch(goalId: string, input: GoalEventInput): Promise<DispatchResult> {
    const previous = this.queues.get(goalId) ?? Promise.resolve();
    const run = previous.then(
      () => this.dispatchNow(goalId, input),
      () => this.dispatchNow(goalId, input),
    );
    this.queues.set(
      goalId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async dispatchNow(goalId: string, input: GoalEventInput): Promise<DispatchResult> {
    const current = this.goals.get(goalId) ?? null;
    if (await this.log.hasEvent(goalId, input.id)) {
      return { goal: this.requireGoal(goalId), duplicate: true };
    }

    // Validate against a provisional event before touching disk. The log
    // assigns the real seq and timestamp, which the reducer only checks for
    // contiguity, so a provisional seq of lastSeq + 1 is equivalent.
    applyGoalEvent(current, {
      ...input,
      goalId,
      seq: (current?.lastSeq ?? 0) + 1,
      at: new Date().toISOString(),
    });

    const { event, duplicate } = await this.log.append(goalId, input);
    if (duplicate) {
      return { goal: this.requireGoal(goalId), duplicate: true };
    }
    const next = applyGoalEvent(current, event);
    this.goals.set(goalId, next);
    for (const listener of this.listeners) {
      try {
        listener(next, event);
      } catch {
        // A faulty observer must not fail a committed event.
      }
    }
    return { goal: next, duplicate: false };
  }

  private requireGoal(goalId: string): Goal {
    const goal = this.goals.get(goalId);
    if (!goal) {
      throw new Error(`Goal ${goalId} not found`);
    }
    return goal;
  }
}
