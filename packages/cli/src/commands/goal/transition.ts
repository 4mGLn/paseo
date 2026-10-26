import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { TaskSpecSchema } from "@getpaseo/protocol/goal/types";
import { z } from "zod";
import type { SingleResult } from "../../output/index.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export interface GoalPlanOptions extends GoalCommandOptions {
  file?: string;
}

export async function runPlanCommand(
  id: string,
  options: GoalPlanOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (!options.file) {
      throw new Error("--file is required");
    }
    const tasks = z.array(TaskSpecSchema).parse(JSON.parse(await readFile(options.file, "utf8")));
    const payload = await client.goalProposePlan({ goalId: id, tasks });
    return toResult(payload);
  } catch (error) {
    throw toGoalCommandError("GOAL_PLAN_FAILED", "propose plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runApproveCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalApprovePlan({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_APPROVE_FAILED", "approve plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runApproveChangeSetCommand(
  id: string,
  changeSetId: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalApproveChangeSet({ goalId: id, changeSetId }));
  } catch (error) {
    throw toGoalCommandError("GOAL_APPROVE_CHANGESET_FAILED", "approve change set", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRequestChangesOptions extends GoalCommandOptions {
  message?: string;
}

export async function runRequestChangesCommand(
  id: string,
  changeSetId: string,
  options: GoalRequestChangesOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    if (!options.message) {
      throw new Error("--message is required");
    }
    return toResult(
      await client.goalRequestChanges({ goalId: id, changeSetId, findings: options.message }),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_REQUEST_CHANGES_FAILED", "request changes", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runCancelCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalCancel({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_CANCEL_FAILED", "cancel goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRejectPlanOptions extends GoalCommandOptions {
  message?: string;
}

export async function runRejectPlanCommand(
  id: string,
  options: GoalRejectPlanOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(
      await client.goalRejectPlan({
        goalId: id,
        ...(options.message ? { feedback: options.message } : {}),
      }),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_REJECT_PLAN_FAILED", "reject plan", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export interface GoalRetryOptions extends GoalCommandOptions {
  task?: string;
}

export async function runRetryCommand(
  id: string,
  options: GoalRetryOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(
      await client.goalRetry({ goalId: id, ...(options.task ? { taskId: options.task } : {}) }),
    );
  } catch (error) {
    throw toGoalCommandError("GOAL_RETRY_FAILED", "retry goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runPauseCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalPause({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_PAUSE_FAILED", "pause goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

export async function runResumeCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<SingleResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    return toResult(await client.goalResume({ goalId: id }));
  } catch (error) {
    throw toGoalCommandError("GOAL_RESUME_FAILED", "resume goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}

function toResult(payload: { goal: Parameters<typeof toGoalRow>[0] | null; error: string | null }) {
  if (payload.error || !payload.goal) {
    throw new Error(payload.error ?? "Daemon returned no goal");
  }
  return { type: "single" as const, data: toGoalRow(payload.goal), schema: goalSchema };
}
