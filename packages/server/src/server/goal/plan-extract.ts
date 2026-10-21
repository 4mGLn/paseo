import { TaskSpecSchema, type TaskSpec } from "@getpaseo/protocol/goal/types";
import { z } from "zod";
import { TaskGraphError, validateTaskGraph } from "./task-graph.js";

export class PlanParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanParseError";
  }
}

const PlanSchema = z.object({ tasks: z.array(TaskSpecSchema).min(1) });

const FENCE = /```(?:json)?\s*([\s\S]*?)```/g;

/**
 * Reads the Lead's plan out of its final message: the last fenced JSON block,
 * either `{"tasks": [...]}` or a bare task array. The result is validated as a
 * task graph, so nothing unchecked reaches the log.
 */
export function extractPlan(
  text: string,
  knownProviders?: readonly string[],
  maxTasks?: number,
): TaskSpec[] {
  const blocks = [...text.matchAll(FENCE)].map((match) => match[1] ?? "");
  const candidate = blocks.at(-1);
  if (candidate === undefined) {
    throw new PlanParseError("No fenced ```json block found in the message.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new PlanParseError(
      `The JSON block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const result = PlanSchema.safeParse(Array.isArray(parsed) ? { tasks: parsed } : parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new PlanParseError(
      `The plan does not match the schema at ${issue?.path.join(".") || "root"}: ${issue?.message}`,
    );
  }

  try {
    validateTaskGraph(result.data.tasks);
  } catch (error) {
    if (error instanceof TaskGraphError) {
      throw new PlanParseError(error.message);
    }
    throw error;
  }
  if (maxTasks !== undefined && result.data.tasks.length > maxTasks) {
    throw new PlanParseError(
      `The plan has ${result.data.tasks.length} tasks but at most ${maxTasks} are allowed. Combine related work into fewer tasks.`,
    );
  }
  if (knownProviders) {
    for (const task of result.data.tasks) {
      const provider = task.provider?.split("/")[0];
      if (provider && !knownProviders.includes(provider)) {
        throw new PlanParseError(
          `Task ${task.id} names unknown provider "${provider}". Use one of: ${knownProviders.join(", ")}, or omit provider.`,
        );
      }
    }
  }
  return result.data.tasks;
}
