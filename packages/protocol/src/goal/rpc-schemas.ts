import { z } from "zod";
import { GoalConfigSchema, GoalEventSchema, GoalSchema, TaskSpecSchema } from "./types.js";

// Mutating requests accept an optional eventId. A retry with the same eventId is
// a no-op, so a client can safely resend after a dropped connection.
const eventId = z.string().trim().min(1).optional();

export const GoalCreateRequestSchema = z.object({
  type: z.literal("goal.create.request"),
  requestId: z.string(),
  // Client-chosen so a retried create returns the same goal.
  goalId: z.string().trim().min(1).optional(),
  title: z.string().trim().min(1),
  objective: z.string(),
  criteria: z.array(z.string().trim().min(1)),
  // Omit for a manual goal that the Manager does not plan or run.
  config: GoalConfigSchema.optional(),
});

export const GoalListRequestSchema = z.object({
  type: z.literal("goal.list.request"),
  requestId: z.string(),
});

export const GoalInspectRequestSchema = z.object({
  type: z.literal("goal.inspect.request"),
  requestId: z.string(),
  goalId: z.string(),
});

export const GoalProposePlanRequestSchema = z.object({
  type: z.literal("goal.propose_plan.request"),
  requestId: z.string(),
  goalId: z.string(),
  tasks: z.array(TaskSpecSchema),
  eventId,
});

export const GoalApprovePlanRequestSchema = z.object({
  type: z.literal("goal.approve_plan.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

export const GoalCancelRequestSchema = z.object({
  type: z.literal("goal.cancel.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

export const GoalApproveChangeSetRequestSchema = z.object({
  type: z.literal("goal.approve_changeset.request"),
  requestId: z.string(),
  goalId: z.string(),
  changeSetId: z.string(),
  eventId,
});

export const GoalRequestChangesRequestSchema = z.object({
  type: z.literal("goal.request_changes.request"),
  requestId: z.string(),
  goalId: z.string(),
  changeSetId: z.string(),
  findings: z.string().trim().min(1),
  eventId,
});

// Goal controls, gated on server_info.features.goalControls.

export const GoalRejectPlanRequestSchema = z.object({
  type: z.literal("goal.reject_plan.request"),
  requestId: z.string(),
  goalId: z.string(),
  // What the Lead should change. Sent to a fresh Lead with the rejected plan.
  feedback: z.string().optional(),
  eventId,
});

export const GoalRetryRequestSchema = z.object({
  type: z.literal("goal.retry.request"),
  requestId: z.string(),
  goalId: z.string(),
  // Omit to retry every failed or cancelled task. A failed goal always retries all of them.
  taskId: z.string().trim().min(1).optional(),
  eventId,
});

export const GoalPauseRequestSchema = z.object({
  type: z.literal("goal.pause.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

export const GoalResumeRequestSchema = z.object({
  type: z.literal("goal.resume.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

const GoalMutationPayloadSchema = z.object({
  requestId: z.string(),
  goal: GoalSchema.nullable(),
  error: z.string().nullable(),
});

export const GoalCreateResponseSchema = z.object({
  type: z.literal("goal.create.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalListResponseSchema = z.object({
  type: z.literal("goal.list.response"),
  payload: z.object({
    requestId: z.string(),
    goals: z.array(GoalSchema),
    error: z.string().nullable(),
  }),
});

export const GoalInspectResponseSchema = z.object({
  type: z.literal("goal.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    goal: GoalSchema.nullable(),
    events: z.array(GoalEventSchema),
    error: z.string().nullable(),
  }),
});

export const GoalProposePlanResponseSchema = z.object({
  type: z.literal("goal.propose_plan.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalApprovePlanResponseSchema = z.object({
  type: z.literal("goal.approve_plan.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalCancelResponseSchema = z.object({
  type: z.literal("goal.cancel.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalApproveChangeSetResponseSchema = z.object({
  type: z.literal("goal.approve_changeset.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalRequestChangesResponseSchema = z.object({
  type: z.literal("goal.request_changes.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalRejectPlanResponseSchema = z.object({
  type: z.literal("goal.reject_plan.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalRetryResponseSchema = z.object({
  type: z.literal("goal.retry.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalPauseResponseSchema = z.object({
  type: z.literal("goal.pause.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalResumeResponseSchema = z.object({
  type: z.literal("goal.resume.response"),
  payload: GoalMutationPayloadSchema,
});
