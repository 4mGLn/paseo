import type { TFunction } from "i18next";
import type { GoalRetainedResource } from "@getpaseo/protocol/goal/rpc-schemas";
import type { Goal, GoalPriority, GoalStatus } from "@getpaseo/protocol/goal/types";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";
import { formatDuration } from "@/utils/time";
import { goalAttention } from "./goal-attention";
import { GOAL_STATUS_BADGE } from "./goal-derivation";
import {
  formatCompactCount,
  formatUsd,
  goalUsageStatus,
  type BudgetStatus,
  type GoalEstimate,
} from "./goal-progress";
import type { DurationParts, GoalSettingsSummaryPart } from "./goal-settings";

export function durationLabel(t: TFunction, parts: DurationParts): string {
  return t(`goals.duration.${parts.unit}`, { n: parts.n });
}

export function settingsSummaryText(
  t: TFunction,
  parts: readonly GoalSettingsSummaryPart[],
): string {
  const clauses = parts.map((part) => {
    switch (part.key) {
      case "parallel":
        return t("goals.form.summary.parallel", { n: part.n });
      case "runLimit":
      case "deadline":
        return t(`goals.form.summary.${part.key}`, { duration: durationLabel(t, part.duration) });
      case "thinking":
        // Mid-sentence, so the level reads as a word rather than a label.
        return t("goals.form.summary.thinking", {
          level: part.label.toLocaleLowerCase(),
          role: t(`goals.form.thinkingRoles.${part.role}`),
        });
      default:
        return t(`goals.form.summary.${part.key}`);
    }
  });
  const sentence = clauses.join(t("goals.form.listSeparator"));
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

export interface GoalBadge {
  label: string;
  variant: StatusBadgeVariant;
}

/** The status pill for a goal: what it waits on when it waits on you, else its status. */
export function goalBadge(t: TFunction, goal: Pick<Goal, "status" | "changeSets">): GoalBadge {
  if (goalAttention(goal) === "change_review") {
    return { label: t("goals.changeSetStatus.awaiting_human"), variant: "warning" };
  }
  const status: GoalStatus = goal.status;
  return { label: t(`goals.status.${status}`), variant: GOAL_STATUS_BADGE[status] };
}

export function estimateLabel(t: TFunction, estimate: GoalEstimate): string | null {
  switch (estimate.kind) {
    case "none":
      return null;
    case "paused":
      return t("goals.progress.paused");
    case "estimating":
      return t("goals.progress.estimating");
    case "range":
      if (estimate.lowMs === estimate.highMs) {
        return formatDuration(estimate.highMs);
      }
      return t("goals.progress.estimateRange", {
        low: formatDuration(estimate.lowMs),
        high: formatDuration(estimate.highMs),
      });
  }
}

export function budgetLabel(
  t: TFunction,
  status: BudgetStatus,
  format: (value: number) => string,
): string {
  switch (status.kind) {
    case "not_reported":
      return t("goals.progress.notReported");
    case "unlimited":
      return t("goals.progress.usedNoLimit", { used: format(status.used) });
    case "limited":
      return t("goals.progress.usedOf", { used: format(status.used), limit: format(status.limit) });
  }
}

/** A budget in a list row: the amount, against its cap when one is set. */
function compactBudgetLabel(
  t: TFunction,
  status: BudgetStatus,
  format: (value: number) => string,
): string {
  switch (status.kind) {
    case "not_reported":
      return t("goals.row.notReported");
    case "unlimited":
      return format(status.used);
    case "limited":
      return t("goals.progress.usedOf", { used: format(status.used), limit: format(status.limit) });
  }
}

/** Tokens and cost for a managed goal's list row; null for a manual goal, which runs nothing. */
export function rowUsageLabel(t: TFunction, goal: Pick<Goal, "usage" | "config">): string | null {
  if (!goal.config) {
    return null;
  }
  const usage = goalUsageStatus(goal);
  if (usage.tokens.kind === "not_reported" && usage.cost.kind === "not_reported") {
    return t("goals.row.usageNotReported");
  }
  const tokens = compactBudgetLabel(t, usage.tokens, formatCompactCount);
  // Most providers report tokens without cost; a bare $0.00 would read as free.
  const noCost = usage.cost.kind === "unlimited" && usage.cost.used === 0;
  if (noCost) {
    return t("goals.row.tokensOnly", { tokens });
  }
  return t("goals.row.usage", { tokens, cost: compactBudgetLabel(t, usage.cost, formatUsd) });
}

const MAX_RETAINED_LINES = 4;

/** What delete kept, one line per branch or worktree and at most a few, for the toast. */
export function retainedSummary(t: TFunction, retained: readonly GoalRetainedResource[]): string {
  const lines = retained.slice(0, MAX_RETAINED_LINES).map((resource) =>
    t(resource.kind === "branch" ? "goals.actions.keptBranch" : "goals.actions.keptWorktree", {
      name: resource.name,
      reason: resource.reason,
    }),
  );
  if (retained.length > MAX_RETAINED_LINES) {
    lines.push(t("goals.actions.keptMore", { n: retained.length - MAX_RETAINED_LINES }));
  }
  return [t("goals.actions.deletedKept"), ...lines].join("\n");
}

/** The row's priority mark; none for normal, which is every goal's default. */
export function priorityBadgeLabel(t: TFunction, priority: GoalPriority): string | null {
  return priority === "normal" ? null : t(`goals.priority.badge.${priority}`);
}
