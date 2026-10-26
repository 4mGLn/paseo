import { z } from "zod";
import { AgentProviderSchema } from "../provider-manifest.js";
import {
  GOAL_BRANCH_PREFIX_MAX_LENGTH,
  GOAL_BRANCH_PREFIX_PATTERN,
  GOAL_CONFIG_BOUNDS as B,
  type GoalNumberBound,
} from "./config-bounds.js";

function boundedInt(bound: GoalNumberBound) {
  return z.number().int().min(bound.min).max(bound.max);
}

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
  // Failed runs before the last retry a person asked for. They no longer count
  // against maxAttempts. Absent when the task was never retried by hand.
  forgivenFailures: z.number().int().nonnegative().optional(),
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
  maxParallel: boundedInt(B.maxParallel),
  maxAttempts: boundedInt(B.maxAttempts),
  autoApprovePlan: z.boolean(),
  // Send the Lead a message when a task fails for good or all tasks finish.
  notifyLead: z.boolean(),
  // Provider for the independent reviewer, and for the verifier unless verifyProvider is set.
  // Defaults to the Lead's.
  reviewProvider: AgentProviderSchema.optional(),
  // Provider for the criteria verifier. Defaults to reviewProvider, then the Lead's.
  verifyProvider: AgentProviderSchema.optional(),
  // Shell command run in the integration worktree after each merge. A non-zero exit rejects the merge.
  testCommand: z.string().trim().min(1).optional(),
  // Hold every reviewed change set until a person approves it.
  requireHumanApproval: z.boolean().optional(),
  // Review, conflict and test-failure rework rounds allowed per change.
  maxReworkRounds: boundedInt(B.maxReworkRounds).optional(),
  // The integration branch is `<branchPrefix>/<goalId>`. Defaults to DEFAULT_GOAL_BRANCH_PREFIX.
  branchPrefix: z
    .string()
    .trim()
    .min(1)
    .max(GOAL_BRANCH_PREFIX_MAX_LENGTH)
    .regex(GOAL_BRANCH_PREFIX_PATTERN)
    .optional(),
  limits: z
    .object({
      // Tasks in a plan.
      maxTasks: boundedInt(B.limits.maxTasks).optional(),
      // Agent runs over the goal's lifetime, retries and rework included.
      maxRuns: boundedInt(B.limits.maxRuns).optional(),
      // Wall-clock time for any one agent turn.
      runTimeoutMinutes: boundedInt(B.limits.runTimeoutMinutes).optional(),
      // Wall-clock time from creation until the goal must be finished.
      goalTimeoutMinutes: boundedInt(B.limits.goalTimeoutMinutes).optional(),
      // Pause before a failed task is retried, multiplied by the attempt number.
      retryBackoffSeconds: boundedInt(B.limits.retryBackoffSeconds).optional(),
      // Input plus output tokens the providers report over the goal's life.
      maxTotalTokens: boundedInt(B.limits.maxTotalTokens).optional(),
      // US dollars the providers report over the goal's life.
      maxCostUsd: z.number().min(B.limits.maxCostUsd.min).max(B.limits.maxCostUsd.max).optional(),
      // ISO 8601 time the goal must be finished by, in addition to goalTimeoutMinutes.
      deadlineAt: z.string().trim().min(1).optional(),
    })
    .optional(),
  // What to do when an unattended agent asks for a permission: fail the run, or leave
  // the request pending in Paseo for a person to answer (bounded by the run timeout).
  onPermissionRequest: z.enum(["fail", "wait"]).optional(),
  // The chat the goal was started from. Its outcome is posted back there when the goal ends.
  originAgentId: z.string().trim().min(1).optional(),
  // Providers the goal may use; a plan naming any other is sent back to the Lead.
  allowedProviders: z.array(AgentProviderSchema.trim().min(1)).min(1).optional(),
});
export type GoalConfig = z.infer<typeof GoalConfigSchema>;

export const RunStatusSchema = z.enum(["running", "succeeded", "failed", "interrupted"]);

// What a provider reported for one agent turn. Any field may be missing: providers
// report different subsets, and some report nothing.
export const TurnUsageSchema = z.object({
  inputTokens: z.number().nonnegative().optional(),
  cachedInputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
export type TurnUsage = z.infer<typeof TurnUsageSchema>;

// Usage summed over turns. `reportedTurns` of `totalTurns` agent turns came with usage;
// the totals cover only those.
export const UsageTotalsSchema = z.object({
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  // inputTokens + outputTokens; what limits.maxTotalTokens is checked against.
  totalTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
  reportedTurns: z.number().int().nonnegative(),
  totalTurns: z.number().int().nonnegative(),
});
export type UsageTotals = z.infer<typeof UsageTotalsSchema>;

export const UsageRoleSchema = z.enum(["lead", "worker", "reviewer", "verifier"]);
export type UsageRole = z.infer<typeof UsageRoleSchema>;
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
  // Usage of this run's turns. Absent until a turn of the run is recorded.
  usage: UsageTotalsSchema.optional(),
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
  // Stage times, set by the reducer from changeset.transitioned events. Absent until the
  // stage is reached, and from daemons that predate them.
  // Entered in_review.
  reviewStartedAt: z.string().optional(),
  // Left in_review with a verdict: approved, held for a person, changes requested or rejected.
  reviewedAt: z.string().optional(),
  // First entered integrating.
  mergeStartedAt: z.string().optional(),
  // Reached integrated.
  mergedAt: z.string().optional(),
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

export const NotificationTargetSchema = z.enum(["lead", "origin"]);
export type NotificationTarget = z.infer<typeof NotificationTargetSchema>;

export const NotificationStatusSchema = z.enum(["pending", "delivered", "failed"]);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// A message the Manager sends an agent: the Lead, or the chat the goal was started from.
// `delivered` means the agent layer accepted the prompt, not that anyone read it.
export const NotificationSchema = z.object({
  // Unique per target within a goal.
  key: z.string().min(1),
  target: NotificationTargetSchema,
  // The exact text sent on every attempt.
  text: z.string(),
  status: NotificationStatusSchema,
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  updatedAt: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

// A plan a person sent back to the Lead, and why.
export const PlanRejectionSchema = z.object({
  reason: z.string(),
  tasks: z.array(TaskSpecSchema),
  at: z.string(),
});
export type PlanRejection = z.infer<typeof PlanRejectionSchema>;

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
  // Absent from daemons that predate recorded notifications.
  notifications: z.array(NotificationSchema).optional(),
  // When the goal was paused; null or absent while it runs. A paused goal starts no worker runs.
  pausedAt: z.string().nullable().optional(),
  // Plans sent back to the Lead, oldest first. Absent from daemons without goal controls.
  planRejections: z.array(PlanRejectionSchema).optional(),
  // Times a failed goal was reopened by a retry.
  reopens: z.number().int().nonnegative().optional(),
  // Usage of every agent turn: Lead, workers, reviewers, verifier. Absent until the
  // first turn is recorded, and from daemons that predate usage tracking.
  usage: UsageTotalsSchema.optional(),
  // When every task succeeded and every change set settled, so verification could start.
  // Absent until then, and from daemons that predate stage times.
  verifyStartedAt: z.string().optional(),
  // When the last acceptance criterion was verified.
  verifiedAt: z.string().optional(),
  // When a person dismissed an ended goal. Null again after a retry reopens it. It changes
  // nothing else. Absent from daemons without goal.acknowledge.
  acknowledgedAt: z.string().nullable().optional(),
  // Sequence number of the last event folded into this state.
  lastSeq: z.number().int().nonnegative(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Goal = z.infer<typeof GoalSchema>;

// Task counts for a list row; see summarizeGoalProgress in ./progress.ts.
export const GoalProgressSummarySchema = z.object({
  tasksTotal: z.number().int().nonnegative(),
  tasksDone: z.number().int().nonnegative(),
  tasksFailed: z.number().int().nonnegative(),
  tasksRunning: z.number().int().nonnegative(),
});
export type GoalProgressSummary = z.infer<typeof GoalProgressSummarySchema>;

// A goal as goal.list and goal.update carry it: the full goal plus derived counts.
// `progress` is absent from daemons that predate it; derive it from `tasks` then.
export const GoalSummarySchema = GoalSchema.extend({
  progress: GoalProgressSummarySchema.optional(),
});
export type GoalSummary = z.infer<typeof GoalSummarySchema>;

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
  // Written before notifications were recorded: the Lead was told something, outcome unknown.
  // Current daemons write notification.queued instead, under the same event id.
  z.object({ ...eventEnvelope, type: z.literal("lead.notified"), key: z.string().min(1) }),
  // A notification is due. Accepted after the goal has ended, so its outcome can be sent.
  z.object({
    ...eventEnvelope,
    type: z.literal("notification.queued"),
    key: z.string().min(1),
    target: NotificationTargetSchema,
    text: z.string(),
  }),
  // One delivery attempt and how it ended.
  z.object({
    ...eventEnvelope,
    type: z.literal("notification.attempted"),
    key: z.string().min(1),
    target: NotificationTargetSchema,
    attempt: z.number().int().min(1),
    outcome: z.enum(["delivered", "failed"]),
    error: z.string().optional(),
  }),
  z.object({
    ...eventEnvelope,
    type: z.literal("plan.proposed"),
    tasks: z.array(TaskSpecSchema),
  }),
  z.object({ ...eventEnvelope, type: z.literal("plan.approved") }),
  // `reason` is the person's feedback for the Lead; it may be empty.
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
  // One agent turn ended. `usage` is what the provider reported, absent when it reported
  // nothing. `runId` is set for a worker run's turn.
  z.object({
    ...eventEnvelope,
    type: z.literal("usage.recorded"),
    role: UsageRoleSchema,
    agentId: z.string().min(1),
    runId: IdSchema.optional(),
    usage: TurnUsageSchema.optional(),
  }),
  // A person stops new worker runs from starting, then lets them start again.
  z.object({ ...eventEnvelope, type: z.literal("goal.paused") }),
  z.object({ ...eventEnvelope, type: z.literal("goal.resumed") }),
  // A person retries failed or cancelled tasks. `reopen` is set when the goal had
  // failed and goes back to executing; it then covers every failed and cancelled task.
  z.object({
    ...eventEnvelope,
    type: z.literal("goal.retried"),
    taskIds: z.array(IdSchema).min(1),
    reopen: z.boolean(),
  }),
  // A person dismissed an ended goal. Accepted only after the goal has ended.
  z.object({ ...eventEnvelope, type: z.literal("goal.acknowledged") }),
]);
export type GoalEvent = z.infer<typeof GoalEventSchema>;
export type GoalEventType = GoalEvent["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller supplies; the log fills in `seq` and `at`. */
export type GoalEventInput = DistributiveOmit<GoalEvent, "seq" | "at">;
