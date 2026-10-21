import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";

export const GoalStatusSchema = z.enum([
  "planning",
  "awaiting_plan_approval",
  "executing",
  "completed",
  "failed",
  "cancelled",
]);
export type GoalStatus = z.infer<typeof GoalStatusSchema>;

export const TaskStatusSchema = z.enum(["pending", "running", "succeeded", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskKindSchema = z.enum(["implement", "review", "read"]);
export type TaskKind = z.infer<typeof TaskKindSchema>;

const IdSchema = z.string().trim().min(1);

export const TaskSpecSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1),
  description: z.string(),
  kind: TaskKindSchema,
  dependsOn: z.array(IdSchema),
  provider: AgentProviderSchema.trim().min(1).optional(),
});
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

export const ReworkReasonSchema = z.enum(["review", "conflict", "tests"]);
export type ReworkReason = z.infer<typeof ReworkReasonSchema>;

export const ReworkSchema = z.object({
  changeSetId: IdSchema,
  reason: ReworkReasonSchema,
  round: z.number().int().positive(),
});
export type Rework = z.infer<typeof ReworkSchema>;

export const TaskSchema = TaskSpecSchema.extend({
  status: TaskStatusSchema,
  attempts: z.number().int().nonnegative(),
  error: z.string().nullable(),
  // The agent's final report for the last successful attempt.
  summary: z.string().nullable(),
  // Set on tasks the Manager added to fix a change set; they continue in its worktree.
  rework: ReworkSchema.optional(),
  // For an implement task: its work has been captured as a change set, or recorded as empty.
  captured: z.boolean().optional(),
});
export type Task = z.infer<typeof TaskSchema>;

export const GoalConfigSchema = z.object({
  // Repository the Lead plans against and implementation worktrees branch from.
  cwd: z.string().trim().min(1),
  // The commit checked out in `cwd` when the goal was created. Every worktree starts from
  // it, so the goal builds on the branch you were on, not on the repository's default.
  baseCommit: z.string().trim().min(1).optional(),
  leadProvider: AgentProviderSchema,
  // Used for tasks that do not name a provider.
  defaultProvider: AgentProviderSchema,
  maxParallel: z.number().int().min(1).max(8),
  maxAttempts: z.number().int().min(1).max(5),
  autoApprovePlan: z.boolean(),
  // Send the Lead a message when a task fails for good or all tasks finish.
  notifyLead: z.boolean(),
  // Provider for the independent reviewer and the criteria verifier. Defaults to the Lead's.
  reviewProvider: AgentProviderSchema.optional(),
  // Shell command run in the integration worktree after each merge. A non-zero exit rejects the merge.
  testCommand: z.string().trim().min(1).optional(),
  // Hold every reviewed change set until a person approves it.
  requireHumanApproval: z.boolean().optional(),
  // Review, conflict and test-failure rework rounds allowed per change.
  maxReworkRounds: z.number().int().min(0).max(5).optional(),
  limits: z
    .object({
      // Tasks in a plan.
      maxTasks: z.number().int().min(1).max(100).optional(),
      // Agent runs over the goal's lifetime, retries and rework included.
      maxRuns: z.number().int().min(1).max(500).optional(),
      // Wall-clock time for any one agent turn.
      runTimeoutMinutes: z.number().int().min(1).max(1440).optional(),
      // Wall-clock time from creation until the goal must be finished.
      goalTimeoutMinutes: z.number().int().min(1).max(10080).optional(),
      // Pause before a failed task is retried, multiplied by the attempt number.
      retryBackoffSeconds: z.number().int().min(0).max(3600).optional(),
    })
    .optional(),
  // What to do when an unattended agent asks for a permission: fail the run, or leave
  // the request pending in Paseo for a person to answer (bounded by the run timeout).
  onPermissionRequest: z.enum(["fail", "wait"]).optional(),
  // Providers the goal may use; a plan naming any other is sent back to the Lead.
  allowedProviders: z.array(AgentProviderSchema.trim().min(1)).min(1).optional(),
});
export type GoalConfig = z.infer<typeof GoalConfigSchema>;

export const RunStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

// One execution attempt of a task by one agent. Tracked apart from the task so
// retries and interrupted attempts stay in the history.
export const AgentRunSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  provider: AgentProviderSchema,
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  // Working directory of the run, so its work can be captured after a restart.
  cwd: z.string().nullable().optional(),
  status: RunStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: IdSchema,
  text: z.string().trim().min(1),
  verifiedAt: z.string().nullable(),
  // What the verifier observed.
  evidence: z.string().nullable(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const ChangeSetStatusSchema = z.enum([
  "captured",
  "in_review",
  "awaiting_human",
  "approved",
  "integrating",
  "integrated",
  "changes_requested",
  "conflicted",
  "test_failed",
  "superseded",
  "rejected",
]);
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;

export const ChangedFileSchema = z.object({ path: z.string(), status: z.string() });
export type ChangedFile = z.infer<typeof ChangedFileSchema>;

// The work of one successful implement run, pinned to explicit commits.
export const ChangeSetSchema = z.object({
  id: IdSchema,
  taskId: IdSchema,
  runId: IdSchema,
  // 0 for the original change, then one more per rework.
  round: z.number().int().nonnegative(),
  supersedes: z.string().nullable(),
  workspaceId: z.string(),
  cwd: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
  headCommit: z.string(),
  files: z.array(ChangedFileSchema),
  status: ChangeSetStatusSchema,
  findings: z.string().nullable(),
  testSummary: z.string().nullable(),
  integratedCommit: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChangeSet = z.infer<typeof ChangeSetSchema>;

// The goal's own branch and worktree, where approved change sets are merged.
export const IntegrationSchema = z.object({
  branch: z.string(),
  workspaceId: z.string(),
  cwd: z.string(),
  baseCommit: z.string(),
  headCommit: z.string(),
});
export type Integration = z.infer<typeof IntegrationSchema>;

export const GoalSchema = z.object({
  id: IdSchema,
  title: z.string().trim().min(1),
  objective: z.string(),
  status: GoalStatusSchema,
  // Null for a manual goal: the Manager does not plan or run anything for it.
  config: GoalConfigSchema.nullable(),
  leadAgentId: z.string().nullable(),
  leadWorkspaceId: z.string().nullable(),
  criteria: z.array(AcceptanceCriterionSchema),
  tasks: z.array(TaskSchema),
  runs: z.array(AgentRunSchema),
  changeSets: z.array(ChangeSetSchema),
  integration: IntegrationSchema.nullable(),
  // Sequence number of the last event folded into this state.
  lastSeq: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

const eventEnvelope = {
  // Unique per event; the log treats a repeated id as a duplicate delivery.
  id: IdSchema,
  goalId: IdSchema,
  // Assigned by the log, strictly increasing per goal starting at 1.
  seq: z.number().int().positive(),
  at: z.string(),
};

export const GoalEventSchema = z.discriminatedUnion("type", [
  z.object({
    ...eventEnvelope,
    type: z.literal("goal.created"),
    title: z.string().trim().min(1),
    objective: z.string(),
    criteria: z.array(z.object({ id: IdSchema, text: z.string().trim().min(1) })),
    config: GoalConfigSchema.nullable().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("lead.attached"),
    agentId: z.string().min(1),
    workspaceId: z.string().min(1).optional(),
  }),
  // Records that the Lead was told something, so a restart does not tell it again.
  z.object({ ...eventEnvelope, type: z.literal("lead.notified"), key: z.string().min(1) }),
  z.object({
    ...eventEnvelope,
    type: z.literal("plan.proposed"),
    tasks: z.array(TaskSpecSchema),
  }),
  z.object({ ...eventEnvelope, type: z.literal("plan.approved") }),
  z.object({ ...eventEnvelope, type: z.literal("plan.rejected"), reason: z.string() }),
  z.object({ ...eventEnvelope, type: z.literal("task.started"), taskId: IdSchema }),
  z.object({
    ...eventEnvelope,
    type: z.literal("task.succeeded"),
    taskId: IdSchema,
    summary: z.string().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.started"),
    runId: IdSchema,
    taskId: IdSchema,
    provider: AgentProviderSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.attached"),
    runId: IdSchema,
    agentId: z.string().min(1),
    workspaceId: z.string().min(1),
    cwd: z.string().min(1).optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("run.finished"),
    runId: IdSchema,
    outcome: z.enum(["succeeded", "failed", "interrupted"]),
    error: z.string().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("task.failed"),
    taskId: IdSchema,
    error: z.string(),
  }),
  // Returns a failed or running task to pending so it can be dispatched again.
  z.object({ ...eventEnvelope, type: z.literal("task.retried"), taskId: IdSchema }),
  z.object({ ...eventEnvelope, type: z.literal("task.cancelled"), taskId: IdSchema }),
  z.object({
    ...eventEnvelope,
    type: z.literal("criterion.verified"),
    criterionId: IdSchema,
    evidence: z.string().optional(),
  }),
  // The Manager adds a rework task to fix a change set.
  z.object({
    ...eventEnvelope,
    type: z.literal("task.added"),
    task: TaskSpecSchema,
    rework: ReworkSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("integration.prepared"),
    branch: z.string(),
    workspaceId: z.string(),
    cwd: z.string(),
    baseCommit: z.string(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("changeset.captured"),
    changeSetId: IdSchema,
    taskId: IdSchema,
    runId: IdSchema,
    round: z.number().int().nonnegative(),
    supersedes: z.string().nullable(),
    workspaceId: z.string(),
    cwd: z.string(),
    branch: z.string(),
    baseCommit: z.string(),
    headCommit: z.string(),
    files: z.array(ChangedFileSchema),
  }),
  // An implement task finished without changing anything, so there is nothing to review.
  z.object({
    ...eventEnvelope,
    type: z.literal("capture.skipped"),
    taskId: IdSchema,
    runId: IdSchema,
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("changeset.transitioned"),
    changeSetId: IdSchema,
    to: ChangeSetStatusSchema,
    findings: z.string().optional(),
    testSummary: z.string().optional(),
    integratedCommit: z.string().optional(),
    error: z.string().optional(),
  }),
  z.object({ ...eventEnvelope, type: z.literal("goal.completed") }),
  z.object({ ...eventEnvelope, type: z.literal("goal.failed"), reason: z.string() }),
  z.object({ ...eventEnvelope, type: z.literal("goal.cancelled") }),
]);
export type GoalEvent = z.infer<typeof GoalEventSchema>;
export type GoalEventType = GoalEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller supplies; the log fills in `seq` and `at`. */
export type GoalEventInput = DistributiveOmit<GoalEvent, "seq" | "at">;
