import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  GOAL_LIST_FILTERS,
  buildGoalListSections,
  countGoalsByFilter,
  goalAttention,
  type GoalListFilter,
} from "@/goals/goal-attention";
import { goalBadge } from "@/goals/goal-labels";
import { countGoalTasks, goalPercent } from "@/goals/goal-progress";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { GoalBar } from "./goal-bar";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function GoalListFilters({
  goals,
  filter,
  onChange,
}: {
  goals: readonly Goal[];
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
}: {
  goals: readonly Goal[];
  filter: GoalListFilter;
  onSelect: (goalId: string) => void;
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
        />
      ) : null}
      {sections.others.length > 0 ? (
        <GoalRowsSection
          title={showHeadings ? t("goals.sections.others") : null}
          goals={sections.others}
          onSelect={onSelect}
        />
      ) : null}
    </View>
  );
}

function GoalRowsSection({
  title,
  goals,
  onSelect,
}: {
  title: string | null;
  goals: readonly Goal[];
  onSelect: (goalId: string) => void;
}): ReactElement {
  const card = (
    <SettingsCard>
      {goals.map((goal) => (
        <GoalRow key={goal.id} goal={goal} onSelect={onSelect} />
      ))}
    </SettingsCard>
  );
  if (!title) {
    return <View style={settingsStyles.section}>{card}</View>;
  }
  return <SettingsSection title={title}>{card}</SettingsSection>;
}

function GoalRow({
  goal,
  onSelect,
}: {
  goal: Goal;
  onSelect: (goalId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const counts = countGoalTasks(goal);
  const percent = goalPercent(goal);
  const attention = goalAttention(goal);
  const badge = goalBadge(t, goal);
  const updated = useCompactTimeAgo(useMemo(() => new Date(goal.updatedAt), [goal.updatedAt]));
  const handlePress = useCallback(() => onSelect(goal.id), [goal.id, onSelect]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  const tasksLabel =
    counts.total === 0
      ? t("goals.row.noPlan")
      : t("goals.row.tasks", { done: counts.done, total: counts.total });
  const meta = [tasksLabel, t("goals.row.updated", { time: updated })].join(" · ");
  const showBar = goal.config !== null && counts.total > 0;

  return (
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
        {attention ? (
          <Text
            style={attention === "failed" ? styles.attentionDanger : styles.attentionWarning}
            numberOfLines={1}
          >
            {t(`goals.attention.${attention}`)}
          </Text>
        ) : null}
        <Text style={settingsStyles.rowHint} numberOfLines={1}>
          {meta}
        </Text>
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
  bar: {
    marginTop: theme.spacing[2],
    maxWidth: 240,
  },
}));
