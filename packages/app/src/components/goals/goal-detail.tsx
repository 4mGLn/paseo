import { useCallback, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { ChevronLeft } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { TFunction } from "i18next";
import type { Goal, GoalEvent, Task } from "@getpaseo/protocol/goal/types";
import { SettingsCard, SettingsSection } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  canApproveGoalPlan,
  GOAL_STATUS_BADGE,
  goalEventSubject,
  isGoalTerminal,
  TASK_STATUS_BADGE,
} from "@/goals/goal-derivation";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { useGoalDetail } from "@/hooks/use-goals";
import { settingsStyles } from "@/styles/settings";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";

export function GoalDetail({
  serverId,
  goalId,
  onBack,
}: {
  serverId: string;
  goalId: string;
  onBack: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { loadState, isError, refetch } = useGoalDetail({ serverId, goalId });

  let body: ReactElement;
  if (loadState.status === "loaded" && loadState.data.goal) {
    body = (
      <GoalDetailContent
        serverId={serverId}
        goal={loadState.data.goal}
        events={loadState.data.events}
      />
    );
  } else if (loadState.status === "loaded") {
    body = <Text style={styles.message}>{t("goals.detail.notFound")}</Text>;
  } else if (isError) {
    body = (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("goals.detail.loadFailed")}</Text>
        <Button variant="ghost" onPress={refetch}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  } else {
    body = <LoadingSpinner size="large" color={styles.spinner.color} />;
  }

  return (
    <View style={styles.container} testID="goal-detail">
      <View style={styles.backRow}>
        <Button variant="ghost" size="sm" leftIcon={ChevronLeft} onPress={onBack}>
          {t("common.actions.back")}
        </Button>
      </View>
      {body}
    </View>
  );
}

function GoalDetailContent({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events: GoalEvent[];
}): ReactElement {
  const { t } = useTranslation();
  const { approvePlan, cancelGoal, isApproving, isCancelling } = useGoalMutations({ serverId });
  const [actionError, setActionError] = useState<string | null>(null);
  const showApprove = canApproveGoalPlan(goal.status);
  const showCancel = !isGoalTerminal(goal.status);

  const handleApprove = useCallback(() => {
    setActionError(null);
    approvePlan(goal.id).catch((error: unknown) => setActionError(toErrorMessage(error)));
  }, [approvePlan, goal.id]);

  const handleCancel = useCallback(() => {
    void confirmDialog({
      title: t("goals.detail.cancelConfirmTitle"),
      message: t("goals.detail.cancelConfirmMessage"),
      confirmLabel: t("goals.detail.cancelGoal"),
      cancelLabel: t("goals.detail.keepGoal"),
      destructive: true,
    }).then((confirmed) => {
      if (!confirmed) {
        return null;
      }
      setActionError(null);
      return cancelGoal(goal.id).catch((error: unknown) => setActionError(toErrorMessage(error)));
    });
  }, [cancelGoal, goal.id, t]);

  return (
    <View>
      <View style={styles.summary}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{goal.title}</Text>
          <StatusBadge
            label={t(`goals.status.${goal.status}`)}
            variant={GOAL_STATUS_BADGE[goal.status]}
          />
        </View>
        {goal.objective ? <Text style={styles.objective}>{goal.objective}</Text> : null}
        {goal.failureReason ? <Text style={styles.error}>{goal.failureReason}</Text> : null}
        {showApprove || showCancel ? (
          <View style={styles.actions}>
            {showApprove ? (
              <Button
                size="sm"
                variant="default"
                onPress={handleApprove}
                loading={isApproving}
                testID="goal-approve-plan"
              >
                {t("goals.detail.approvePlan")}
              </Button>
            ) : null}
            {showCancel ? (
              <Button
                size="sm"
                variant="outline"
                onPress={handleCancel}
                loading={isCancelling}
                testID="goal-cancel"
              >
                {t("goals.detail.cancelGoal")}
              </Button>
            ) : null}
          </View>
        ) : null}
        {actionError ? <Text style={styles.error}>{actionError}</Text> : null}
      </View>

      <SettingsSection title={t("goals.detail.criteria")}>
        <SettingsCard>
          {goal.criteria.length === 0 ? (
            <EmptyRow label={t("goals.detail.noCriteria")} />
          ) : (
            goal.criteria.map((criterion) => (
              <View key={criterion.id} style={settingsStyles.row}>
                <Text style={[settingsStyles.rowTitle, styles.rowText]}>{criterion.text}</Text>
                <StatusBadge
                  label={t(
                    criterion.verifiedAt ? "goals.detail.verified" : "goals.detail.unverified",
                  )}
                  variant={criterion.verifiedAt ? "success" : "muted"}
                />
              </View>
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("goals.detail.tasks")}>
        <SettingsCard>
          {goal.tasks.length === 0 ? (
            <EmptyRow label={t("goals.detail.noTasks")} />
          ) : (
            goal.tasks.map((task) => (
              <View key={task.id} style={settingsStyles.row}>
                <View style={settingsStyles.rowContent}>
                  <Text style={settingsStyles.rowTitle}>{task.title}</Text>
                  <Text style={settingsStyles.rowHint}>{formatTaskMeta(task, t)}</Text>
                  {task.error ? <Text style={settingsStyles.rowError}>{task.error}</Text> : null}
                </View>
                <StatusBadge
                  label={t(`goals.taskStatus.${task.status}`)}
                  variant={TASK_STATUS_BADGE[task.status]}
                />
              </View>
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("goals.detail.history")}>
        <SettingsCard>
          {events.length === 0 ? (
            <EmptyRow label={t("goals.detail.noEvents")} />
          ) : (
            events.map((event) => <GoalEventRow key={event.id} event={event} />)
          )}
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}

function formatTaskMeta(task: Task, t: TFunction): string {
  const base = `${task.id} · ${task.kind}`;
  if (task.dependsOn.length === 0) {
    return base;
  }
  return `${base} · ${t("goals.detail.dependsOn", { ids: task.dependsOn.join(", ") })}`;
}

function GoalEventRow({ event }: { event: GoalEvent }): ReactElement {
  const subject = goalEventSubject(event);
  return (
    <View style={settingsStyles.row}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{event.type}</Text>
        {subject ? <Text style={settingsStyles.rowHint}>{subject}</Text> : null}
      </View>
      <Text style={styles.meta}>{new Date(event.at).toLocaleString()}</Text>
    </View>
  );
}

function EmptyRow({ label }: { label: string }): ReactElement {
  return (
    <View style={settingsStyles.row}>
      <Text style={styles.meta}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[4],
  },
  backRow: {
    flexDirection: "row",
  },
  centered: {
    alignItems: "center",
    gap: theme.spacing[4],
  },
  summary: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[6],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  objective: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  rowText: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  meta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
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
