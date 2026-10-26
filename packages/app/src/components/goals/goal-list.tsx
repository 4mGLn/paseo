import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronRight,
  Flag,
  Folder,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Goal, GoalSummary } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import {
  GOAL_LIST_FILTERS,
  buildGoalListSections,
  canAcknowledgeGoal,
  countGoalsByFilter,
  goalAttention,
  isBlockedOnUser,
  type GoalListFilter,
} from "@/goals/goal-attention";
import { goalBadge, priorityBadgeLabel, rowUsageLabel } from "@/goals/goal-labels";
import {
  GOAL_PRIORITIES,
  GOAL_PRIORITY_FILTER_ALL,
  GOAL_SORTS,
  goalPriority,
  isGoalArchived,
  type GoalPriorityFilter,
  type GoalSort,
} from "@/goals/goal-management";
import { goalListProgress, goalPercent } from "@/goals/goal-progress";
import {
  GOAL_PROJECT_FILTER_ALL,
  describeGoalProject,
  type GoalProjectFilterOption,
  type GoalProjectOption,
} from "@/goals/goal-projects";
import { goalWaitingOnText } from "@/goals/goal-waiting-on";
import { useCompactTimeAgo } from "@/hooks/use-time-ago";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { GoalActionsMenu } from "./goal-actions-menu";
import { GoalBar } from "./goal-bar";

const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFolder = withUnistyles(Folder);
const ThemedFlag = withUnistyles(Flag);
const ThemedArrowUpDown = withUnistyles(ArrowUpDown);
const ThemedArrowUp = withUnistyles(ArrowUp);
const ThemedArrowDown = withUnistyles(ArrowDown);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const folderIcon = <ThemedFolder size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const flagIcon = <ThemedFlag size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const sortIcon = <ThemedArrowUpDown size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const highPriorityIcon = <ThemedArrowUp size={12} uniProps={mutedColorMapping} />;
const lowPriorityIcon = <ThemedArrowDown size={12} uniProps={mutedColorMapping} />;

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

/** Narrows the list to one project; the caller shows it only when goals span more than one. */
export function GoalProjectFilter({
  options,
  value,
  onChange,
}: {
  options: readonly GoalProjectFilterOption[];
  value: string;
  onChange: (key: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "sm" : "xs";
  const allLabel = t("goals.projectFilter.all");
  const selected = options.find((option) => option.key === value);
  const label = selected?.name ?? allLabel;
  const selectAll = useCallback(() => onChange(GOAL_PROJECT_FILTER_ALL), [onChange]);
  return (
    <DropdownMenu>
      <DropdownTrigger
        size={size}
        leading={folderIcon}
        accessibilityRole="button"
        accessibilityLabel={t("goals.projectFilter.label", { project: label })}
        testID="goals-project-filter-trigger"
      >
        {label}
      </DropdownTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        minWidth={240}
        maxWidth={360}
        testID="goals-project-filter-menu"
      >
        <DropdownMenuItem
          selected={!selected}
          onSelect={selectAll}
          testID="goals-project-filter-all"
        >
          {allLabel}
        </DropdownMenuItem>
        {options.map((option) => (
          <GoalProjectFilterItem
            key={option.key}
            option={option}
            selected={option.key === selected?.key}
            onChange={onChange}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GoalProjectFilterItem({
  option,
  selected,
  onChange,
}: {
  option: GoalProjectFilterOption;
  selected: boolean;
  onChange: (key: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onChange(option.key), [onChange, option.key]);
  return (
    <DropdownMenuItem
      selected={selected}
      description={option.path ?? undefined}
      onSelect={handleSelect}
      testID={`goals-project-filter-option-${option.key}`}
    >
      {t("goals.projectFilter.option", { project: option.name, n: option.count })}
    </DropdownMenuItem>
  );
}

/** Narrows the list to one priority; a goal without one counts as normal. */
export function GoalPriorityFilterMenu({
  value,
  onChange,
}: {
  value: GoalPriorityFilter;
  onChange: (value: GoalPriorityFilter) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "sm" : "xs";
  const label =
    value === GOAL_PRIORITY_FILTER_ALL
      ? t("goals.priorityFilter.all")
      : t("goals.priorityFilter.label", { priority: t(`goals.priority.levels.${value}`) });
  const choices: GoalPriorityFilter[] = [GOAL_PRIORITY_FILTER_ALL, ...GOAL_PRIORITIES];
  return (
    <DropdownMenu>
      <DropdownTrigger
        size={size}
        leading={flagIcon}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="goals-priority-filter-trigger"
      >
        {label}
      </DropdownTrigger>
      <DropdownMenuContent
        side="bottom"
        align="start"
        minWidth={200}
        testID="goals-priority-filter-menu"
      >
        {choices.map((choice) => (
          <ChoiceItem
            key={choice}
            value={choice}
            label={
              choice === GOAL_PRIORITY_FILTER_ALL
                ? t("goals.priorityFilter.all")
                : t(`goals.priority.levels.${choice}`)
            }
            selected={choice === value}
            onChange={onChange}
            testID={`goals-priority-filter-${choice}`}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The order inside each group; remembered on this device. */
export function GoalSortMenu({
  value,
  onChange,
}: {
  value: GoalSort;
  onChange: (value: GoalSort) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "sm" : "xs";
  const label = t("goals.sort.label", { sort: t(`goals.sort.${value}`) });
  return (
    <DropdownMenu>
      <DropdownTrigger
        size={size}
        leading={sortIcon}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="goals-sort-trigger"
      >
        {label}
      </DropdownTrigger>
      <DropdownMenuContent side="bottom" align="start" minWidth={200} testID="goals-sort-menu">
        {GOAL_SORTS.map((sort) => (
          <ChoiceItem
            key={sort}
            value={sort}
            label={t(`goals.sort.${sort}`)}
            selected={sort === value}
            onChange={onChange}
            testID={`goals-sort-${sort}`}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChoiceItem<T extends string>({
  value,
  label,
  selected,
  onChange,
  testID,
}: {
  value: T;
  label: string;
  selected: boolean;
  onChange: (value: T) => void;
  testID: string;
}): ReactElement {
  const handleSelect = useCallback(() => onChange(value), [onChange, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={handleSelect} testID={testID}>
      {label}
    </DropdownMenuItem>
  );
}

/** Shows archived goals in their own group; offered only on hosts with `goalManagement`. */
export function GoalArchivedToggle({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (value: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "sm" : "xs";
  const handlePress = useCallback(() => onChange(!value), [onChange, value]);
  const accessibilityState = useMemo(() => ({ selected: value }), [value]);
  return (
    <Button
      variant={value ? "secondary" : "outline"}
      size={size}
      leftIcon={value ? Check : undefined}
      onPress={handlePress}
      accessibilityState={accessibilityState}
      testID="goals-show-archived"
    >
      {t("goals.archived.show")}
    </Button>
  );
}

export function GoalList({
  serverId,
  goals,
  projects,
  filter,
  compare,
  onSelect,
  dismiss,
  onClearFilters,
}: {
  serverId: string;
  goals: readonly GoalSummary[];
  /** The host's projects, for naming each goal's directory. */
  projects: readonly GoalProjectOption[];
  filter: GoalListFilter;
  compare: (a: GoalSummary, b: GoalSummary) => number;
  onSelect: (goalId: string) => void;
  dismiss: GoalListDismiss | null;
  /** Set while a search, priority or project narrows the list; offered when nothing matches. */
  onClearFilters: (() => void) | null;
}): ReactElement {
  const { t } = useTranslation();
  const sections = useMemo(
    () => buildGoalListSections(goals, filter, compare),
    [compare, filter, goals],
  );

  if (
    sections.attention.length === 0 &&
    sections.others.length === 0 &&
    sections.archived.length === 0
  ) {
    if (onClearFilters) {
      return (
        <View style={styles.centered} testID="goals-no-match">
          <Text style={styles.message}>{t("goals.noMatch")}</Text>
          <Button variant="ghost" onPress={onClearFilters} testID="goals-clear-filters">
            {t("goals.clearFilters")}
          </Button>
        </View>
      );
    }
    return (
      <View style={styles.centered} testID="goals-filter-empty">
        <Text style={styles.message}>{t(`goals.filterEmpty.${filter}`)}</Text>
      </View>
    );
  }

  // Under "Needs you" every goal is in one group, so a heading would only repeat the filter.
  const showHeadings =
    (filter !== "needs_you" && sections.attention.length > 0) || sections.archived.length > 0;
  const rows = { serverId, projects, onSelect, dismiss };
  return (
    <View testID="goals-table">
      {sections.attention.length > 0 ? (
        <GoalRowsSection
          title={showHeadings ? t("goals.sections.attention") : null}
          goals={sections.attention}
          {...rows}
        />
      ) : null}
      {sections.others.length > 0 ? (
        <GoalRowsSection
          title={showHeadings ? t("goals.sections.others") : null}
          goals={sections.others}
          {...rows}
        />
      ) : null}
      {sections.archived.length > 0 ? (
        <GoalRowsSection title={t("goals.archived.section")} goals={sections.archived} {...rows} />
      ) : null}
    </View>
  );
}

function GoalRowsSection({
  title,
  goals,
  serverId,
  projects,
  onSelect,
  dismiss,
}: {
  title: string | null;
  goals: readonly GoalSummary[];
  serverId: string;
  projects: readonly GoalProjectOption[];
  onSelect: (goalId: string) => void;
  dismiss: GoalListDismiss | null;
}): ReactElement {
  const card = (
    <SettingsCard>
      {goals.map((goal) => (
        <GoalRow
          key={goal.id}
          serverId={serverId}
          goal={goal}
          projects={projects}
          onSelect={onSelect}
          dismiss={dismiss}
        />
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

/** The project a goal runs on, with its directory as the secondary part. */
export function GoalProjectLine({
  projects,
  cwd,
  testID,
}: {
  projects: readonly GoalProjectOption[];
  cwd: string | null | undefined;
  testID?: string;
}): ReactElement | null {
  const label = useMemo(() => describeGoalProject(projects, cwd), [cwd, projects]);
  if (!label) {
    return null;
  }
  return (
    <Text
      style={settingsStyles.rowHint}
      numberOfLines={1}
      ellipsizeMode="middle"
      testID={testID}
      accessibilityLabel={`${label.name}, ${label.path}`}
    >
      <Text style={styles.projectName}>{label.name}</Text>
      {label.path !== label.name ? `  ${label.path}` : null}
    </Text>
  );
}

/** High or low priority, beside the title; normal goals carry no mark. */
export function GoalPriorityBadge({ goal }: { goal: Goal }): ReactElement | null {
  const { t } = useTranslation();
  const priority = goalPriority(goal);
  const label = priorityBadgeLabel(t, priority);
  if (!label) {
    return null;
  }
  return (
    <StatusBadge
      size="xs"
      label={label}
      leading={priority === "high" ? highPriorityIcon : lowPriorityIcon}
    />
  );
}

function GoalRow({
  serverId,
  goal,
  projects,
  onSelect,
  dismiss,
}: {
  serverId: string;
  goal: GoalSummary;
  projects: readonly GoalProjectOption[];
  onSelect: (goalId: string) => void;
  dismiss: GoalListDismiss | null;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  // Hover reveals the kebab on web; touch layouts always show it (docs/hover.md).
  const kebab = useOpenKebabMenuVisibility(isHovered || isNative || isCompact);
  const archived = isGoalArchived(goal);
  const badge = goalBadge(t, goal);
  const handlePress = useCallback(() => onSelect(goal.id), [goal.id, onSelect]);
  const onDismiss = dismiss?.onDismiss;
  const handleDismiss = useCallback(() => onDismiss?.(goal.id), [goal.id, onDismiss]);
  // The row's fill follows the outer hover target, so pointing at the kebab keeps it.
  const rowStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      settingsStyles.row,
      isHovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [isHovered],
  );
  // Only a failure asks for attention among ended goals, so only it carries Dismiss in the list.
  const showDismiss =
    dismiss !== null && goal.status === "failed" && canAcknowledgeGoal(goal) && !archived;

  // Dismiss sits under the pressable row, not inside it: a button inside a button is invalid on web.
  return (
    <View
      style={styles.rowHoverTarget}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        style={rowStyle}
        onPress={handlePress}
        accessibilityRole="button"
        testID={`goal-row-${goal.id}`}
      >
        <GoalRowContent goal={goal} projects={projects} archived={archived} />
        <View style={styles.rowTrailing}>
          {archived ? <StatusBadge label={t("goals.archived.badge")} /> : null}
          <StatusBadge label={badge.label} variant={archived ? "muted" : badge.variant} />
          <View
            style={[styles.kebabSlot, !kebab.showKebab && styles.kebabHidden]}
            pointerEvents={kebab.showKebab ? "auto" : "none"}
          >
            <GoalActionsMenu
              serverId={serverId}
              goal={goal}
              open={kebab.menuProps.open}
              onOpenChange={kebab.menuProps.onOpenChange}
              testID={`goal-row-menu-${goal.id}`}
            />
          </View>
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

/** The row's text: title and priority, project, what it waits on, counts, usage and progress. */
function GoalRowContent({
  goal,
  projects,
  archived,
}: {
  goal: GoalSummary;
  projects: readonly GoalProjectOption[];
  archived: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const progress = goalListProgress(goal);
  const percent = goalPercent(goal);
  const usage = rowUsageLabel(t, goal);
  const updated = useCompactTimeAgo(useMemo(() => new Date(goal.updatedAt), [goal.updatedAt]));
  const tasksLabel =
    progress.tasksTotal === 0
      ? t("goals.row.noPlan")
      : t("goals.row.tasks", { done: progress.tasksDone, total: progress.tasksTotal });
  const meta = [tasksLabel, t("goals.row.updated", { time: updated })];
  if (goal.acknowledgedAt) {
    meta.push(t("goals.row.dismissed"));
  }
  const showBar = goal.config !== null && progress.tasksTotal > 0 && !archived;
  return (
    <View style={settingsStyles.rowContent}>
      <View style={styles.titleLine}>
        <Text
          style={[settingsStyles.rowTitle, styles.rowTitle, archived && styles.archivedTitle]}
          numberOfLines={1}
        >
          {goal.title}
        </Text>
        <GoalPriorityBadge goal={goal} />
      </View>
      <GoalProjectLine
        projects={projects}
        cwd={goal.config?.cwd}
        testID={`goal-row-project-${goal.id}`}
      />
      {archived ? null : <GoalRowReason goal={goal} />}
      <Text style={settingsStyles.rowHint} numberOfLines={1}>
        {meta.join(" · ")}
      </Text>
      {usage ? (
        <Text style={settingsStyles.rowHint} numberOfLines={1} testID={`goal-row-usage-${goal.id}`}>
          {usage}
        </Text>
      ) : null}
      {showBar ? (
        <View style={styles.bar}>
          <GoalBar fraction={percent / 100} tone={percent === 100 ? "success" : "neutral"} />
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
  projectName: {
    color: theme.colors.foreground,
  },
  rowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  // Only the hover target: layout lives on the row inside it (docs/hover.md).
  rowHoverTarget: {
    position: "relative",
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  rowTitle: {
    flexShrink: 1,
  },
  archivedTitle: {
    color: theme.colors.foregroundMuted,
  },
  // A fixed slot, so revealing the kebab never moves the badge or the chevron.
  kebabSlot: {
    width: 18,
    alignItems: "center",
  },
  kebabHidden: {
    opacity: 0,
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
