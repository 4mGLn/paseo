import { useCallback, useMemo, useState, type ReactElement } from "react";
import { ScrollView, Text, View } from "react-native";
import { useIsFocused } from "expo-router/react-navigation";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { GoalDetail } from "@/components/goals/goal-detail";
import { GoalEmptyState } from "@/components/goals/goal-empty-state";
import { GoalFormSheet } from "@/components/goals/goal-form-sheet";
import { GoalList, GoalListFilters } from "@/components/goals/goal-list";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import type { GoalListFilter } from "@/goals/goal-attention";
import type { GoalFormPrefill } from "@/goals/goal-form-model";
import { buildTemplatePrefill, type GoalTemplate } from "@/goals/goal-templates";
import { useGoalList } from "@/hooks/use-goals";
import { useHostFeatureAvailabilityMap } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspaceFields } from "@/stores/session-store-hooks";
import { resolveGoalsScreenBodyState } from "./goals-screen-state";

const EMPTY_GOALS: Goal[] = [];

interface GoalsScreenProps {
  /** Opens on this host and goal, such as one just started from a chat. */
  initialServerId?: string;
  initialGoalId?: string;
}

export function GoalsScreen(props: GoalsScreenProps): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.container} />;
  }

  return <GoalsScreenContent {...props} />;
}

function GoalsScreenContent({ initialServerId, initialGoalId }: GoalsScreenProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const goalsSupport = useHostFeatureAvailabilityMap(serverIds, "goals");
  const [pickedServerId, setPickedServerId] = useState<string | null>(initialServerId ?? null);
  const [selectedGoalId, setSelectedGoalId] = useState<string | null>(initialGoalId ?? null);
  // Each open gets its own key, so the form mounts fresh with the prefill it was opened with.
  const [form, setForm] = useState<{ key: number; prefill: GoalFormPrefill | undefined } | null>(
    null,
  );
  const [filter, setFilter] = useState<GoalListFilter>("all");

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
  const formPrefill = useLastWorkspacePrefill(serverId);
  const openForm = useCallback(
    () => setForm({ key: Date.now(), prefill: formPrefill }),
    [formPrefill],
  );
  const openTemplate = useCallback(
    (template: GoalTemplate) =>
      setForm({
        key: Date.now(),
        prefill: buildTemplatePrefill(
          template,
          {
            objective: t(`goals.templates.${template.id}.objective`),
            criteria: t(`goals.templates.${template.id}.criteria`),
          },
          formPrefill ?? {},
        ),
      }),
    [formPrefill, t],
  );
  const closeForm = useCallback(() => setForm(null), []);
  const closeDetail = useCallback(() => setSelectedGoalId(null), []);
  const selectCreatedGoal = useCallback((goal: Goal) => setSelectedGoalId(goal.id), []);

  // The detail stays reachable only while the host can still serve goals.
  const detailGoalId = canCreate ? selectedGoalId : null;
  let body: ReactElement;
  if (detailGoalId) {
    body = <GoalDetail serverId={serverId} goalId={detailGoalId} onBack={closeDetail} />;
  } else if (bodyState.kind === "content") {
    body = (
      <>
        <View style={styles.filters}>
          <GoalListFilters goals={goals} filter={filter} onChange={setFilter} />
        </View>
        <GoalList goals={goals} filter={filter} onSelect={setSelectedGoalId} />
      </>
    );
  } else if (bodyState.kind === "empty") {
    body = <GoalEmptyState onCreate={openForm} onTemplate={openTemplate} />;
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
      {form ? (
        <GoalFormSheet
          key={form.key}
          serverId={serverId}
          prefill={form.prefill}
          onClose={closeForm}
          onCreated={selectCreatedGoal}
        />
      ) : null}
    </View>
  );
}

/** The working directory starts from the last workspace you were in on this host. */
function useLastWorkspacePrefill(serverId: string): GoalFormPrefill | undefined {
  const lastWorkspace = useLastWorkspaceSelection();
  const lastWorkspaceDirectory = useWorkspaceFields(
    lastWorkspace?.serverId === serverId ? serverId : null,
    lastWorkspace?.workspaceId ?? null,
    (workspace) => workspace.workspaceDirectory,
  );
  return useMemo(
    () => (lastWorkspaceDirectory ? { cwd: lastWorkspaceDirectory } : undefined),
    [lastWorkspaceDirectory],
  );
}

function GoalsMessage({
  kind,
  onRetry,
}: {
  kind: "no-host" | "update-host" | "load-error";
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const messages = {
    "no-host": t("goals.noHost"),
    "update-host": t("goals.updateHost"),
    "load-error": t("goals.loadFailed"),
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
  filters: {
    alignItems: "flex-start",
    marginBottom: theme.spacing[4],
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
  // Static color holder read by the spinner; keeps the muted token without useUnistyles.
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
