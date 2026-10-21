import path from "node:path";
import type { Command } from "commander";
import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import type { SingleResult } from "../../output/index.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export interface GoalCreateOptions extends GoalCommandOptions {
  objective?: string;
  criterion?: string[];
  cwd?: string;
  lead?: string;
  provider?: string;
  maxParallel?: string;
  maxAttempts?: string;
  autoApprove?: boolean;
  notifyLead?: boolean;
  reviewProvider?: string;
  testCommand?: string;
  requireApproval?: boolean;
  maxRework?: string;
  maxTasks?: string;
  maxRuns?: string;
  runTimeout?: string;
  goalTimeout?: string;
  retryBackoff?: string;
  onPermission?: "fail" | "wait";
  allowProvider?: string[];
}

function intOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}

function buildLimits(options: GoalCreateOptions): GoalConfig["limits"] {
  const limits = {
    maxTasks: intOption(options.maxTasks, "--max-tasks"),
    maxRuns: intOption(options.maxRuns, "--max-runs"),
    runTimeoutMinutes: intOption(options.runTimeout, "--run-timeout"),
    goalTimeoutMinutes: intOption(options.goalTimeout, "--goal-timeout"),
    retryBackoffSeconds: intOption(options.retryBackoff, "--retry-backoff"),
  };
  const set = Object.fromEntries(Object.entries(limits).filter(([, v]) => v !== undefined));
  return Object.keys(set).length > 0 ? set : undefined;
}

// A goal runs under the Manager only when --cwd is given; without it the goal is
// manual and only records plans and state.
function buildConfig(options: GoalCreateOptions): GoalConfig | undefined {
  if (!options.cwd) return undefined;
  if (!options.lead || !options.provider) {
    throw new Error("--lead and --provider are required with --cwd");
  }
  return {
    cwd: path.resolve(options.cwd),
    leadProvider: options.lead,
    defaultProvider: options.provider,
    maxParallel: Number.parseInt(options.maxParallel ?? "2", 10),
    maxAttempts: Number.parseInt(options.maxAttempts ?? "2", 10),
    autoApprovePlan: options.autoApprove === true,
    notifyLead: options.notifyLead !== false,
    ...(options.reviewProvider ? { reviewProvider: options.reviewProvider } : {}),
    ...(options.testCommand ? { testCommand: options.testCommand } : {}),
    ...(options.requireApproval ? { requireHumanApproval: true } : {}),
    ...(options.maxRework ? { maxReworkRounds: Number.parseInt(options.maxRework, 10) } : {}),
    ...(buildLimits(options) ? { limits: buildLimits(options) } : {}),
    ...(options.onPermission ? { onPermissionRequest: options.onPermission } : {}),
    ...(options.allowProvider?.length ? { allowedProviders: options.allowProvider } : {}),
  };
}

export async function runCreateCommand(
  title: string,
  options: GoalCreateOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const config = buildConfig(options);
    const payload = await client.goalCreate({
      title,
      objective: options.objective ?? "",
      criteria: options.criterion ?? [],
      ...(config ? { config } : {}),
    });
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? "Daemon returned no goal");
    }
    return { type: "single", data: toGoalRow(payload.goal), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_CREATE_FAILED", "create goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}
