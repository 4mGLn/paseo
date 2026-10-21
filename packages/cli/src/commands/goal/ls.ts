import type { Command } from "commander";
import type { ListResult } from "../../output/index.js";
import {
  connectGoalClient,
  goalSchema,
  toGoalCommandError,
  toGoalRow,
  type GoalCommandOptions,
  type GoalRow,
} from "./shared.js";

export async function runLsCommand(
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<GoalRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalList();
    if (payload.error) {
      throw new Error(payload.error);
    }
    return { type: "list", data: payload.goals.map(toGoalRow), schema: goalSchema };
  } catch (error) {
    throw toGoalCommandError("GOAL_LIST_FAILED", "list goals", error);
  } finally {
    await client.close().catch(() => {});
  }
}
