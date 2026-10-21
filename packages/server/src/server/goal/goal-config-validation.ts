import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import type { GitPort } from "./git-ops.js";

/** Returns the config to store: the one given, with the base commit filled in. */
export type GoalConfigValidator = (config: GoalConfig) => Promise<GoalConfig>;

export interface ConfigValidationDeps {
  git: Pick<GitPort, "head">;
  /** Provider ids the daemon has registered. */
  knownProviders: () => string[];
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
    ] as const;
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
