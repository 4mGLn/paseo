import { z } from "zod";
import {
  GoalConfigSchema,
  GoalEventSchema,
  GoalPrioritySchema,
  GoalSchema,
  GoalStatusSchema,
  GoalSummarySchema,
  TaskSpecSchema,
} from "./types.js";

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
  // Gated on server_info.features.goalManagement; older daemons ignore it. Absent is "normal".
  priority: GoalPrioritySchema.optional(),
});

// Which archived goals goal.list returns. Absent hides them.
export const GoalListArchivedFilterSchema = z.enum(["exclude", "only", "include"]);
export type GoalListArchivedFilter = z.infer<typeof GoalListArchivedFilterSchema>;

// Every filter is optional and gated on server_info.features.goalManagement. A request with
// none of them returns every goal that is not archived. Filters combine with AND; a list
// filter matches any of its values.
export const GoalListRequestSchema = z.object({
  type: z.literal("goal.list.request"),
  requestId: z.string(),
  // Case-insensitive substring of the title, objective or id.
  query: z.string().optional(),
  status: z.array(GoalStatusSchema).optional(),
  // A goal without a priority matches "normal".
  priority: z.array(GoalPrioritySchema).optional(),
  // The goal's repository (config.cwd), compared exactly. Manual goals have none.
  cwd: z.string().optional(),
  archived: GoalListArchivedFilterSchema.optional(),
  // Shorthand for archived: "include". `archived` wins when both are sent.
  includeArchived: z.boolean().optional(),
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

// Gated on server_info.features.goalAcknowledge. Dismisses an ended goal; see the
// goal.acknowledged event.
export const GoalAcknowledgeRequestSchema = z.object({
  type: z.literal("goal.acknowledge.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

// Goal management, gated on server_info.features.goalManagement.

export const GoalRenameRequestSchema = z.object({
  type: z.literal("goal.rename.request"),
  requestId: z.string(),
  goalId: z.string(),
  title: z.string().trim().min(1),
  eventId,
});

export const GoalSetPriorityRequestSchema = z.object({
  type: z.literal("goal.set_priority.request"),
  requestId: z.string(),
  goalId: z.string(),
  priority: GoalPrioritySchema,
  eventId,
});

// Only an ended goal (completed, failed or cancelled) can be archived.
export const GoalArchiveRequestSchema = z.object({
  type: z.literal("goal.archive.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

export const GoalUnarchiveRequestSchema = z.object({
  type: z.literal("goal.unarchive.request"),
  requestId: z.string(),
  goalId: z.string(),
  eventId,
});

// Removes an ended goal for good: its event log and the worktrees it created. Branches are
// kept. Deleting a goal that is already gone succeeds with deleted: false.
export const GoalDeleteRequestSchema = z.object({
  type: z.literal("goal.delete.request"),
  requestId: z.string(),
  goalId: z.string(),
});

// Something the goal created that delete left in place, and why.
export const GoalRetainedResourceSchema = z.object({
  kind: z.enum(["branch", "worktree"]),
  // Branch name, or worktree path.
  name: z.string(),
  reason: z.string(),
});
export type GoalRetainedResource = z.infer<typeof GoalRetainedResourceSchema>;

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
    // Each goal carries `progress` from daemons that compute it.
    goals: z.array(GoalSummarySchema),
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

export const GoalAcknowledgeResponseSchema = z.object({
  type: z.literal("goal.acknowledge.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalRenameResponseSchema = z.object({
  type: z.literal("goal.rename.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalSetPriorityResponseSchema = z.object({
  type: z.literal("goal.set_priority.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalArchiveResponseSchema = z.object({
  type: z.literal("goal.archive.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalUnarchiveResponseSchema = z.object({
  type: z.literal("goal.unarchive.response"),
  payload: GoalMutationPayloadSchema,
});

export const GoalDeleteResponseSchema = z.object({
  type: z.literal("goal.delete.response"),
  payload: z.object({
    requestId: z.string(),
    goalId: z.string(),
    // False when there was no such goal, for example on a repeated delete.
    deleted: z.boolean(),
    retained: z.array(GoalRetainedResourceSchema),
    error: z.string().nullable(),
  }),
});

// Pushed to connections that subscribed to the "goal.update" session event, gated on
// server_info.features.goalUpdates. One per goal change, coalesced per goal, carrying
// the goal as goal.list returns it. Not a reply: there is no requestId.
export const GoalUpdateMessageSchema = z.object({
  type: z.literal("goal.update"),
  payload: z.object({
    // The session.events subscription this push belongs to.
    subscriptionId: z.string().optional(),
    goal: GoalSummarySchema,
    // Set once, when the goal was deleted; `goal` is its last state. Drop it from your list.
    // Absent from daemons without goal management.
    deleted: z.boolean().optional(),
  }),
});
