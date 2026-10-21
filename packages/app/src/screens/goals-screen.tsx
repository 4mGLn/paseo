import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import { ChevronRight, Plus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { GoalDetail } from "@/components/goals/goal-detail";
import { GoalFormSheet } from "@/components/goals/goal-form-sheet";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { SettingsCard } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { GOAL_STATUS_BADGE, summarizeGoalProgress } from "@/goals/goal-derivation";
import { useGoalList } from "@/hooks/use-goals";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { resolveGoalsScreenBodyState } from "./goals-screen-state";

const ThemedChevronRight = withUnistyles(ChevronRight);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const EMPTY_GOALS: Goal[] = [];

export function GoalsScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <GoalsScreenContent />;
}

function GoalsScreenContent(): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const goalsSupport = useHostFeatureAvailabilityMap(serverIds, "goals");
  const [pickedServerId, setPickedServerId] = useState<string | null>(null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);

  // A picked host that was removed falls back to the first host that supports goals.
  const pickedHostExists = hosts.some((host) => host.serverId === pickedServerId);
  const defaultServerId =
    serverIds.find((serverId) => goalsSupport.get(serverId) === true) ?? serverIds[0] ?? "";
  const serverId = pickedHostExists && pickedServerId ? pickedServerId : defaultServerId;
  const supportsGoals = goalsSupport.get(serverId) ?? null;

  const { loadState, isError, refetch } = useGoalList({
    serverId,
    enabled: supportsGoals === true,
  });
  const bodyState = resolveGoalsScreenBodyState({
    hasHost: serverId !== "",
    supportsGoals,
    loadState,
    isError,
  });
  const goals = loadState.status === "loaded" ? loadState.data : EMPTY_GOALS;
  const canCreate = bodyState.kind === "empty" || bodyState.kind === "content";

  const selectHost = useCallback((nextServerId: string) => {
    setPickedServerId(nextServerId);
    setSelectedGoalId(null);
  }, []);
  const openForm = useCallback(() => setIsFormOpen(true), []);
  const closeForm = useCallback(() => setIsFormOpen(false), []);
  const closeDetail = useCallback(() => setSelectedGoalId(null), []);

  // The detail stays reachable only while the host can still serve goals.
  const detailGoalId = canCreate ? selectedGoalId : null;
  let body: ReactElement;
  if (detailGoalId) {
    body = <GoalDetail serverId={serverId} goalId={detailGoalId} onBack={closeDetail} />;
  } else if (bodyState.kind === "content") {
    body = <GoalList goals={goals} onSelect={setSelectedGoalId} />;
  } else if (bodyState.kind === "loading") {
    body = <LoadingSpinner size="large" color={styles.spinner.color} />;
  } else {
    body = <GoalsMessage kind={bodyState.kind} onRetry={refetch} />;
  }

  return (
    <View style={styles.container}>
      <MenuHeader title={t("goals.title")} />
      <View style={styles.toolbar}>
        <View style={styles.toolbarStart}>
          {hosts.length > 1 ? (
            <HostFilter
              hosts={hosts}
              selectedHost={serverId}
              onSelectHost={selectHost}
              includeAllHost={false}
              triggerTestID="goals-host-filter-trigger"
            />
          ) : null}
        </View>
        {canCreate ? (
          <Button variant="outline" size="sm" leftIcon={Plus} onPress={openForm} testID="goals-new">
            {t("goals.newGoal")}
          </Button>
        ) : null}
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        testID="goals-list"
      >
        <View style={styles.column}>{body}</View>
      </ScrollView>
      {isFormOpen ? <GoalFormSheet serverId={serverId} onClose={closeForm} /> : null}
    </View>
  );
}

function GoalsMessage({
  kind,
  onRetry,
}: {
  kind: "no-host" | "update-host" | "load-error" | "empty";
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const messages = {
    "no-host": t("goals.noHost"),
    "update-host": t("goals.updateHost"),
    "load-error": t("goals.loadFailed"),
    empty: t("goals.empty"),
  };
  return (
    <View style={styles.centered} testID={`goals-${kind}`}>
      <Text style={styles.message}>{messages[kind]}</Text>
      {kind === "load-error" ? (
        <Button variant="ghost" onPress={onRetry} testID="goals-retry">
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </View>
  );
}

function GoalList({
  goals,
  onSelect,
}: {
  goals: Goal[];
  onSelect: (goalId: string) => void;
}): ReactElement {
  const sorted = useMemo(
    () => [...goals].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [goals],
  );
  return (
    <SettingsCard testID="goals-table">
      {sorted.map((goal) => (
        <GoalRow key={goal.id} goal={goal} onSelect={onSelect} />
      ))}
    </SettingsCard>
  );
}

function GoalRow({
  goal,
  onSelect,
}: {
  goal: Goal;
  onSelect: (goalId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const progress = summarizeGoalProgress(goal);
  const handlePress = useCallback(() => onSelect(goal.id), [goal.id, onSelect]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      settingsStyles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

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
        <Text style={settingsStyles.rowHint}>{t("goals.progress", { ...progress })}</Text>
      </View>
      <View style={styles.rowTrailing}>
        <StatusBadge
          label={t(`goals.status.${goal.status}`)}
          variant={GOAL_STATUS_BADGE[goal.status]}
        />
        <ThemedChevronRight size={ICON_SIZE.sm} uniProps={mutedColorMapping} />
      </View>
    </PressHighlight>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  toolbarStart: {
    flexDirection: "row",
    alignItems: "center",
    flexShrink: 1,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  column: {
    width: "100%",
    maxWidth: 720,
    alignSelf: "center",
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[4],
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
  // Static color holder read by the spinner; keeps the muted token without useUnistyles.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
