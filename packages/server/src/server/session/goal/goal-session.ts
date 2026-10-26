import type pino from "pino";
import { toGoalSummary } from "@getpaseo/protocol/goal/progress";
import type { Goal } from "@getpaseo/protocol/goal/types";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { GoalService } from "../../goal/goal-service.js";

export interface GoalSessionHost {
  emit(msg: SessionOutboundMessage): void;
  /** Whether the client parses the event types added with goal controls. Assumed when absent. */
  supportsGoalControlEvents?(): boolean;
  /** Whether the client parses goal.acknowledged. Assumed when absent. */
  supportsGoalAcknowledgeEvents?(): boolean;
}

// COMPAT(goalControlEvents): added in v0.13.0, remove after 2027-04-26.
const GOAL_CONTROL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "goal.paused",
  "goal.resumed",
  "goal.retried",
  "usage.recorded",
]);

// COMPAT(goalAcknowledgeEvents): added in v0.13.0, remove after 2027-04-26.
const GOAL_ACKNOWLEDGE_EVENT_TYPES: ReadonlySet<string> = new Set(["goal.acknowledged"]);

export interface GoalSessionOptions {
  host: GoalSessionHost;
  goalService: GoalService;
  logger: pino.Logger;
}

export interface OptionalGoalSessionOptions extends Omit<GoalSessionOptions, "goalService"> {
  goalService: GoalService | undefined;
}

type GoalMutationRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "goal.create.request"
      | "goal.propose_plan.request"
      | "goal.approve_plan.request"
      | "goal.approve_changeset.request"
      | "goal.request_changes.request"
      | "goal.cancel.request"
      | "goal.reject_plan.request"
      | "goal.retry.request"
      | "goal.pause.request"
      | "goal.resume.request"
      | "goal.acknowledge.request";
  }
>;

type GoalMutationResponseType =
  | "goal.create.response"
  | "goal.propose_plan.response"
  | "goal.approve_plan.response"
  | "goal.approve_changeset.response"
  | "goal.request_changes.response"
  | "goal.cancel.response"
  | "goal.reject_plan.response"
  | "goal.retry.response"
  | "goal.pause.response"
  | "goal.resume.response"
  | "goal.acknowledge.response";

export class GoalSession {
  private readonly host: GoalSessionHost;
  private readonly goalService: GoalService;
  private readonly logger: pino.Logger;

  /** Goals are advertised and served only when the daemon was built with a GoalService. */
  static forService(options: OptionalGoalSessionOptions): GoalSession | null {
    const { goalService, ...rest } = options;
    return goalService ? new GoalSession({ ...rest, goalService }) : null;
  }

  constructor(options: GoalSessionOptions) {
    this.host = options.host;
    this.goalService = options.goalService;
    this.logger = options.logger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "goal.create.request":
        return this.mutate(msg, "goal.create.response", () =>
          this.goalService.create({
            goalId: msg.goalId,
            title: msg.title,
            objective: msg.objective,
            criteria: msg.criteria,
            config: msg.config,
          }),
        );
      case "goal.propose_plan.request":
        return this.mutate(msg, "goal.propose_plan.response", () =>
          this.goalService.proposePlan(msg.goalId, msg.tasks, msg.eventId),
        );
      case "goal.approve_plan.request":
        return this.mutate(msg, "goal.approve_plan.response", () =>
          this.goalService.approvePlan(msg.goalId, msg.eventId),
        );
      case "goal.approve_changeset.request":
        return this.mutate(msg, "goal.approve_changeset.response", () =>
          this.goalService.approveChangeSet(msg.goalId, msg.changeSetId, msg.eventId),
        );
      case "goal.request_changes.request":
        return this.mutate(msg, "goal.request_changes.response", () =>
          this.goalService.requestChanges(msg.goalId, msg.changeSetId, msg.findings, msg.eventId),
        );
      case "goal.cancel.request":
        return this.mutate(msg, "goal.cancel.response", () =>
          this.goalService.cancel(msg.goalId, msg.eventId),
        );
      case "goal.reject_plan.request":
        return this.mutate(msg, "goal.reject_plan.response", () =>
          this.goalService.rejectPlan(msg.goalId, msg.feedback, msg.eventId),
        );
      case "goal.retry.request":
        return this.mutate(msg, "goal.retry.response", () =>
          this.goalService.retry(msg.goalId, msg.taskId, msg.eventId),
        );
      case "goal.pause.request":
        return this.mutate(msg, "goal.pause.response", () =>
          this.goalService.pause(msg.goalId, msg.eventId),
        );
      case "goal.resume.request":
        return this.mutate(msg, "goal.resume.response", () =>
          this.goalService.resume(msg.goalId, msg.eventId),
        );
      case "goal.acknowledge.request":
        return this.mutate(msg, "goal.acknowledge.response", () =>
          this.goalService.acknowledge(msg.goalId, msg.eventId),
        );
      case "goal.list.request":
        return this.handleList(msg.requestId);
      case "goal.inspect.request":
        return this.handleInspect(msg.requestId, msg.goalId);
      default:
        return undefined;
    }
  }

  private async mutate(
    request: GoalMutationRequest,
    responseType: GoalMutationResponseType,
    run: () => Promise<Goal>,
  ): Promise<void> {
    try {
      const goal = await run();
      this.host.emit({
        type: responseType,
        payload: { requestId: request.requestId, goal, error: null },
      });
    } catch (error) {
      this.emitError(request.requestId, request.type, error);
    }
  }

  private async handleList(requestId: string): Promise<void> {
    try {
      this.host.emit({
        type: "goal.list.response",
        payload: { requestId, goals: this.goalService.list().map(toGoalSummary), error: null },
      });
    } catch (error) {
      this.emitError(requestId, "goal.list.request", error);
    }
  }

  private async handleInspect(requestId: string, goalId: string): Promise<void> {
    try {
      const { goal, events } = await this.goalService.inspect(goalId);
      // An older client's event union rejects types it does not know.
      const hideControl = this.host.supportsGoalControlEvents?.() === false;
      const hideAcknowledge = this.host.supportsGoalAcknowledgeEvents?.() === false;
      const visible =
        hideControl || hideAcknowledge
          ? events.filter(
              (e) =>
                !(hideControl && GOAL_CONTROL_EVENT_TYPES.has(e.type)) &&
                !(hideAcknowledge && GOAL_ACKNOWLEDGE_EVENT_TYPES.has(e.type)),
            )
          : events;
      this.host.emit({
        type: "goal.inspect.response",
        payload: { requestId, goal, events: visible, error: null },
      });
    } catch (error) {
      this.emitError(requestId, "goal.inspect.request", error);
    }
  }

  private emitError(requestId: string, requestType: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType }, "Goal request failed");
    this.host.emit({
      type: "rpc_error",
      payload: { requestId, requestType, error: message, code: "goal_request_failed" },
    });
  }
}
