import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import type { GoalFormPrefill } from "./goal-form-model";
import type { GoalSettings } from "./goal-settings";

/** What the form remembers from your last managed goal on a host. */
export interface GoalFormMemory {
  cwd: string;
  leadProvider: string;
  defaultProvider: string;
  reviewProvider: string | null;
  testCommand: string | null;
  allowedProviders: string[];
  settings: GoalSettings;
}

export function goalFormMemoryFromConfig(
  config: GoalConfig,
  settings: GoalSettings,
): GoalFormMemory {
  return {
    cwd: config.cwd,
    leadProvider: config.leadProvider,
    defaultProvider: config.defaultProvider,
    reviewProvider: config.reviewProvider ?? null,
    testCommand: config.testCommand ?? null,
    allowedProviders: config.allowedProviders ?? [],
    settings,
  };
}

/**
 * Seeds a new goal from your last one. The directory you are working in wins over the
 * remembered one, and the test command comes along only for the same directory, since it
 * belongs to that project.
 */
export function prefillFromGoalFormMemory(
  memory: GoalFormMemory | null,
  context: { cwd?: string },
): GoalFormPrefill {
  if (!memory) {
    return context.cwd ? { managed: true, cwd: context.cwd } : { managed: true };
  }
  const cwd = context.cwd ?? memory.cwd;
  return {
    managed: true,
    cwd,
    leadProvider: memory.leadProvider,
    defaultProvider: memory.defaultProvider,
    ...(memory.reviewProvider ? { reviewProvider: memory.reviewProvider } : {}),
    ...(memory.testCommand && cwd === memory.cwd ? { testCommand: memory.testCommand } : {}),
    ...(memory.allowedProviders.length > 0 ? { allowedProviders: memory.allowedProviders } : {}),
  };
}
