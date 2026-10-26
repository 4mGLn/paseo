import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Goal, GoalSummary } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  GOAL_LIST_FILTERS,
  buildGoalListSections,
  canAcknowledgeGoal,
  countGoalsByFilter,
  goalAttention,
  isBlockedOnUser,
  type GoalListFilter,
} from "@/goals/goal-attention";
import { goalBadge, rowUsageLabel } from "@/goals/goal-labels";
import { goalListProgress, goalPercent } from "@/goals/goal-progress";
import { goalWaitingOnText } from "@/goals/goal-waiting-on";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { GoalBar } from "./goal-bar";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Dismiss for list rows: offered only on hosts with `goalAcknowledge`. */
export interface GoalListDismiss {
  onDismiss: (goalId: string) => void;
  /** The goal a dismiss is in flight for. */
  pendingGoalId: string | null;
}

export function GoalListFilters({
  goals,
  filter,
  onChange,
}: {
  goals: readonly GoalSummary[];
  filter: GoalListFilter;
  onChange: (filter: GoalListFilter) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "sm" : "xs";
  const counts = useMemo(() => countGoalsByFilter(goals), [goals]);
  const options = useMemo<SegmentedControlOption<GoalListFilter>[]>(
    () =>
      GOAL_LIST_FILTERS.map((value) => {
        const label = t(`goals.filters.${value}`);
        const showCount = value === "needs_you" && counts.needs_you > 0;
        return {
          value,
          label: showCount ? t("goals.filterWithCount", { label, n: counts.needs_you }) : label,
          testID: `goals-filter-${value}`,
        };
      }),
    [counts.needs_you, t],
  );
  return (
    <SegmentedControl
      options={options}
      value={filter}
      onValueChange={onChange}
      size={size}
      testID="goals-filter"
    />
  );
}

export function GoalList({
  goals,
  filter,
  onSelect,
  dismiss,
}: {
  goals: readonly GoalSummary[];
  filter: GoalListFilter;
  onSelect: (goalId: string) => void;
  dismiss: GoalListDismiss | null;
}): ReactElement {
  const { t } = useTranslation();
  const sections = useMemo(() => buildGoalListSections(goals, filter), [filter, goals]);

  if (sections.attention.length === 0 && sections.others.length === 0) {
    return (
      <View style={styles.centered} testID="goals-filter-empty">
        <Text style={styles.message}>{t(`goals.filterEmpty.${filter}`)}</Text>
      </View>
    );
  }

  // Under "Needs you" every goal is in one group, so a heading would only repeat the filter.
  const showHeadings = filter !== "needs_you" && sections.attention.length > 0;
  return (
    <View testID="goals-table">
      {sections.attention.length > 0 ? (
        <GoalRowsSection
          title={showHeadings ? t("goals.sections.attention") : null}
          goals={sections.attention}
          onSelect={onSelect}
          dismiss={dismiss}
        />
      ) : null}
      {sections.others.length > 0 ? (
        <GoalRowsSection
          title={showHeadings ? t("goals.sections.others") : null}
          goals={sections.others}
          onSelect={onSelect}
          dismiss={dismiss}
        />
      ) : null}
    </View>
  );
}

function GoalRowsSection({
  title,
  goals,
  onSelect,
  dismiss,
}: {
  title: string | null;
  goals: readonly GoalSummary[];
  onSelect: (goalId: string) => void;
  dismiss: GoalListDismiss | null;
}): ReactElement {
  const card = (
    <SettingsCard>
      {goals.map((goal) => (
        <GoalRow key={goal.id} goal={goal} onSelect={onSelect} dismiss={dismiss} />
      ))}
    </SettingsCard>
  );
  if (!title) {
    return <View style={settingsStyles.section}>{card}</View>;
  }
  return <SettingsSection title={title}>{card}</SettingsSection>;
}

/** The reason line: a failure, or what a live goal waits on, warning-colored when it waits on you. */
function GoalRowReason({ goal }: { goal: Goal }): ReactElement | null {
  const { t } = useTranslation();
  const attention = goalAttention(goal);
  if (attention === "failed") {
    return (
      <Text style={styles.attentionDanger} numberOfLines={1}>
        {t("goals.attention.failed")}
      </Text>
    );
  }
  const waiting = goalWaitingOnText(t, goal);
  if (!waiting) {
    return null;
  }
  return (
    <Text
      style={isBlockedOnUser(attention) ? styles.attentionWarning : styles.reasonMuted}
      numberOfLines={1}
    >
      {waiting}
    </Text>
  );
}

function GoalRow({
  goal,
  onSelect,
  dismiss,
}: {
  goal: GoalSummary;
  onSelect: (goalId: string) => void;
  dismiss: GoalListDismiss | null;
}): ReactElement {
  const { t } = useTranslation();
  const progress = goalListProgress(goal);
  const percent = goalPercent(goal);
  const badge = goalBadge(t, goal);
  const usage = rowUsageLabel(t, goal);
  const updated = useCompactTimeAgo(useMemo(() => new Date(goal.updatedAt), [goal.updatedAt]));
  const handlePress = useCallback(() => onSelect(goal.id), [goal.id, onSelect]);
  const onDismiss = dismiss?.onDismiss;
  const handleDismiss = useCallback(() => onDismiss?.(goal.id), [goal.id, onDismiss]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  const tasksLabel =
    progress.tasksTotal === 0
      ? t("goals.row.noPlan")
      : t("goals.row.tasks", { done: progress.tasksDone, total: progress.tasksTotal });
  const meta = [tasksLabel, t("goals.row.updated", { time: updated })];
  if (goal.acknowledgedAt) {
    meta.push(t("goals.row.dismissed"));
  }
  const showBar = goal.config !== null && progress.tasksTotal > 0;
  // Only a failure asks for attention among ended goals, so only it carries Dismiss in the list.
  const showDismiss = dismiss !== null && goal.status === "failed" && canAcknowledgeGoal(goal);

  // Dismiss sits under the pressable row, not inside it: a button inside a button is invalid on web.
  return (
    <View>
      <PressHighlight
        style={rowStyle}
        onPress={handlePress}
        accessibilityRole="button"
        testID={`goal-row-${goal.id}`}
      >
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {goal.title}
          </Text>
          <GoalRowReason goal={goal} />
          <Text style={settingsStyles.rowHint} numberOfLines={1}>
            {meta.join(" · ")}
          </Text>
          {usage ? (
            <Text
              style={settingsStyles.rowHint}
              numberOfLines={1}
              testID={`goal-row-usage-${goal.id}`}
            >
              {usage}
            </Text>
          ) : null}
          {showBar ? (
            <View style={styles.bar}>
              <GoalBar fraction={percent / 100} tone={percent === 100 ? "success" : "neutral"} />
            </View>
          ) : null}
        </View>
        <View style={styles.rowTrailing}>
          <StatusBadge label={badge.label} variant={badge.variant} />
          <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
        </View>
      </PressHighlight>
      {showDismiss ? (
        <View style={styles.rowActions}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleDismiss}
            loading={dismiss.pendingGoalId === goal.id}
            testID={`goal-row-dismiss-${goal.id}`}
          >
            {t("goals.detail.dismiss")}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    paddingVertical: theme.spacing[6],
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  rowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowActions: {
    flexDirection: "row",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  attentionWarning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  attentionDanger: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  reasonMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  bar: {
    marginTop: theme.spacing[2],
    maxWidth: 240,
  },
}));
