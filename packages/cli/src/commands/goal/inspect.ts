import type { Command } from "commander";
import { goalRoleThinking } from "@getpaseo/protocol/goal/thinking";
import type { Goal, Task } from "@getpaseo/protocol/goal/types";
import type { ListResult, OutputSchema } from "../../output/index.js";
import { formatDuration, formatUsage, taskTimes, taskUsage } from "./progress.js";
import { connectGoalClient, toGoalCommandError, type GoalCommandOptions } from "./shared.js";

interface GoalTaskRow {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  rework: string;
  dependsOn: string;
  provider: string;
  thinking: string;
  elapsed: string;
  usage: string;
  title: string;
}

const taskSchema: OutputSchema<GoalTaskRow> = {
  idField: "id",
  columns: [
    { header: "TASK", field: "id", width: 16 },
    { header: "KIND", field: "kind", width: 10 },
    { header: "STATUS", field: "status", width: 11 },
    { header: "TRIES", field: "attempts", width: 6 },
    { header: "REWORK", field: "rework", width: 7 },
    { header: "DEPENDS ON", field: "dependsOn", width: 16 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "THINKING", field: "thinking", width: 9 },
    { header: "ELAPSED", field: "elapsed", width: 9 },
    { header: "USAGE", field: "usage", width: 30 },
    { header: "TITLE", field: "title", width: 36 },
  ],
};

/** What the task's last run started with, else what the goal asks for, else "-". */
function taskThinking(goal: Goal, task: Task): string {
  const run = goal.runs.findLast((r) => r.taskId === task.id);
  return (
    run?.thinking ??
    (goal.config ? goalRoleThinking(goal.config, "worker", task) : undefined) ??
    "-"
  );
}

export async function runInspectCommand(
  id: string,
  options: GoalCommandOptions,
  _command: Command,
): Promise<ListResult<GoalTaskRow>> {
  const client = await connectGoalClient(options.daemonTarget);
  try {
    const payload = await client.goalInspect(id);
    if (payload.error || !payload.goal) {
      throw new Error(payload.error ?? `Goal not found: ${id}`);
    }
    const goal = payload.goal;
    const now = Date.now();
    return {
      type: "list",
      data: goal.tasks.map((task) => {
        const { startedAt, endedAt } = taskTimes(goal, task);
        return {
          id: task.id,
          kind: task.kind,
          status: task.status,
          attempts: task.attempts,
          rework: task.rework ? `${task.rework.reason} #${task.rework.round}` : "-",
          dependsOn: task.dependsOn.join(",") || "-",
          provider: task.provider ?? "-",
          thinking: taskThinking(goal, task),
          elapsed: startedAt
            ? formatDuration((endedAt ? Date.parse(endedAt) : now) - Date.parse(startedAt))
            : "-",
          usage: formatUsage(taskUsage(goal, task)),
          title: task.title,
        };
      }),
      schema: {
        ...taskSchema,
        // JSON output carries the full goal and its event history.
        serialize: () => ({ goal, events: payload.events }),
      },
    };
  } catch (error) {
    throw toGoalCommandError("GOAL_INSPECT_FAILED", "inspect goal", error);
  } finally {
    await client.close().catch(() => {});
  }
}
