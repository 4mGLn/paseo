import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import type { GitPort } from "./git-ops.js";

/** Returns the config to store: the one given, with the base commit filled in. */
export type GoalConfigValidator = (config: GoalConfig) => Promise<GoalConfig>;

export interface ConfigValidationDeps {
  git: Pick<GitPort, "head">;
  /** Provider ids the daemon has registered. */
  knownProviders: () => string[];
  /** Current time in epoch milliseconds; tests supply their own. */
  now?: () => number;
}

const baseProvider = (provider: string): string => provider.split("/")[0] ?? provider;

/**
 * Catches a bad goal configuration when the goal is created, rather than minutes
 * later when an agent first fails to start.
 */
export function createGoalConfigValidator(deps: ConfigValidationDeps): GoalConfigValidator {
  return async (config) => {
    const used = [
      ["leadProvider", config.leadProvider],
      ["defaultProvider", config.defaultProvider],
      ...(config.reviewProvider ? [["reviewProvider", config.reviewProvider]] : []),
      ...(config.verifyProvider ? [["verifyProvider", config.verifyProvider]] : []),
    ] as const;
    const deadlineAt = config.limits?.deadlineAt;
    if (deadlineAt !== undefined) {
      const at = Date.parse(deadlineAt);
      if (Number.isNaN(at)) throw new Error(`limits.deadlineAt "${deadlineAt}" is not a date`);
      if (at <= (deps.now ?? Date.now)()) {
        throw new Error(`limits.deadlineAt "${deadlineAt}" is in the past`);
      }
    }
    const known = deps.knownProviders();
    for (const [field, provider] of used) {
      if (!known.includes(baseProvider(provider))) {
        throw new Error(
          `${field} "${provider}" is not a registered provider. Available: ${known.join(", ") || "(none)"}`,
        );
      }
      if (config.allowedProviders && !config.allowedProviders.includes(baseProvider(provider))) {
        throw new Error(`${field} "${provider}" is not in allowedProviders`);
      }
    }
    let head: string;
    try {
      head = await deps.git.head(config.cwd);
    } catch {
      throw new Error(`cwd "${config.cwd}" is not a git repository`);
    }
    return { ...config, baseCommit: config.baseCommit ?? head };
  };
}
