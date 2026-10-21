import type { Goal } from "@getpaseo/protocol/goal/types";
import type { CommandError, CommandOptions, OutputSchema } from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { DaemonTarget } from "../../utils/daemon-target.js";

type GoalDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

export interface GoalCommandOptions extends CommandOptions {
  host?: string;
}

export async function connectGoalClient(target: DaemonTarget): Promise<GoalDaemonClient> {
  const resolvedHost = getDaemonHost({ target });
  try {
    return await connectToDaemon({ target });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${resolvedHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export function toGoalCommandError(code: string, action: string, error: unknown): CommandError {
  if (error && typeof error === "object" && "code" in error) {
    return error as CommandError;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code, message: `Failed to ${action}: ${message}` };
}

export interface GoalRow {
  id: string;
  title: string;
  status: string;
  tasks: string;
  criteria: string;
  updatedAt: string;
}

export function toGoalRow(goal: Goal): GoalRow {
  const done = goal.tasks.filter((t) => t.status === "succeeded").length;
  const verified = goal.criteria.filter((c) => c.verifiedAt).length;
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    tasks: `${done}/${goal.tasks.length}`,
    criteria: `${verified}/${goal.criteria.length}`,
    updatedAt: goal.updatedAt,
  };
}

export const goalSchema: OutputSchema<GoalRow> = {
  idField: "id",
  columns: [
    { header: "ID", field: "id", width: 38 },
    { header: "TITLE", field: "title", width: 28 },
    { header: "STATUS", field: "status", width: 24 },
    { header: "TASKS", field: "tasks", width: 8 },
    { header: "CRITERIA", field: "criteria", width: 9 },
    { header: "UPDATED", field: "updatedAt", width: 24 },
  ],
};
