import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { GoalSummary } from "@getpaseo/protocol/goal/types";
import { applyGoalUpdate } from "@/goals/goal-updates";
import { goalDetailQueryKey, goalListQueryKey } from "@/hooks/use-goals";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useGoalAttentionStore } from "@/stores/goal-attention-store";

/**
 * Applies `goal.update` pushes from one host to the cached goal list and refetches an open
 * detail, so the badge and toasts react at once. Polling stays on at a slower rate while the
 * subscription is live, since a push missed across a reconnect is not replayed.
 */
export function useGoalUpdates(serverId: string): void {
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const supported = useHostFeature(serverId, "goalUpdates");

  useEffect(() => {
    if (!client || !isConnected || !supported) {
      return;
    }
    const store = useGoalAttentionStore.getState();
    const listKey = goalListQueryKey(serverId);
    let observation: ReturnType<typeof client.observeGoalUpdates>;
    try {
      observation = client.observeGoalUpdates();
    } catch (error) {
      // The client checks the same flag; polling covers the host until it reports it.
      console.warn("[Goals] Goal updates unavailable", error);
      return;
    }
    observation.subscribe({
      // Sent on subscribe and again after every reconnect: catch up on what was missed.
      snapshot: () => {
        store.setPushLive(serverId, true);
        void queryClient.invalidateQueries({ queryKey: listKey });
      },
      update: (message) => {
        if (message.type !== "goal.update") {
          return;
        }
        const goal: GoalSummary = message.payload.goal;
        // Before the first list arrives there is nothing to compare with; let the fetch fill it.
        if (queryClient.getQueryData<GoalSummary[]>(listKey) === undefined) {
          void queryClient.invalidateQueries({ queryKey: listKey });
        } else {
          queryClient.setQueryData<GoalSummary[]>(listKey, (current) =>
            current ? applyGoalUpdate(current, goal) : current,
          );
        }
        void queryClient.invalidateQueries({ queryKey: goalDetailQueryKey(serverId, goal.id) });
      },
      error: () => {
        store.setPushLive(serverId, false);
      },
    });
    return () => {
      store.setPushLive(serverId, false);
      void observation
        .release()
        .catch((error) => console.warn("[Goals] Failed to release goal updates", error));
    };
  }, [client, isConnected, queryClient, serverId, supported]);
}
