import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import {
  countGoalsBlockedOnUser,
  findNewGoalAttention,
  snapshotGoalAttention,
  type GoalAttentionSnapshot,
} from "@/goals/goal-attention";
import { GOALS_BACKGROUND_POLL_MS, useGoalList } from "@/hooks/use-goals";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import { useGoalAttentionStore } from "@/stores/goal-attention-store";

const TOAST_DURATION_MS = 5_000;

/**
 * Polls every host that runs goals, counts the goals blocked on you for the sidebar badge, and
 * shows a toast when one starts waiting. Goals have no push events, so this is the only signal.
 */
export function GoalAttentionWatcher() {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supportsGoals = useHostFeatureMap(serverIds, "goals");
  return (
    <>
      {serverIds
        .filter((serverId) => supportsGoals.get(serverId))
        .map((serverId) => (
          <HostGoalAttentionWatcher key={serverId} serverId={serverId} />
        ))}
    </>
  );
}

function HostGoalAttentionWatcher({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { loadState } = useGoalList({
    serverId,
    enabled: true,
    pollMs: GOALS_BACKGROUND_POLL_MS,
  });
  const goals = loadState.status === "loaded" ? loadState.data : null;
  // The previous poll, compared with the next; not rendered.
  const previousRef = useRef<GoalAttentionSnapshot | null>(null);

  useEffect(() => {
    if (!goals) {
      return;
    }
    useGoalAttentionStore.getState().setBlocked(serverId, countGoalsBlockedOnUser(goals));
    const transitions = findNewGoalAttention(previousRef.current, goals);
    previousRef.current = snapshotGoalAttention(goals);
    const [first] = transitions;
    if (!first) {
      return;
    }
    const message =
      transitions.length === 1
        ? t(`goals.toasts.${first.kind}`, { title: first.goal.title })
        : t("goals.toasts.several", { n: transitions.length });
    toast.show(message, {
      variant: first.kind === "failed" ? "error" : "info",
      durationMs: TOAST_DURATION_MS,
      testID: "goal-attention-toast",
    });
  }, [goals, serverId, t, toast]);

  useEffect(() => {
    return () => {
      useGoalAttentionStore.getState().clear(serverId);
    };
  }, [serverId]);

  return null;
}
