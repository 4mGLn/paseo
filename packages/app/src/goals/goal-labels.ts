import type { TFunction } from "i18next";
import type { Goal, GoalStatus } from "@getpaseo/protocol/goal/types";
import type { StatusBadgeVariant } from "@/components/ui/status-badge";
import { formatDuration } from "@/utils/time";
import { goalAttention } from "./goal-attention";
import { GOAL_STATUS_BADGE } from "./goal-derivation";
import type { BudgetStatus, GoalEstimate } from "./goal-progress";
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
