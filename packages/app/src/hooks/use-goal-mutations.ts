import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { GoalCreateInput } from "@/goals/goal-form-model";
import { goalsHostQueryKey } from "@/hooks/use-goals";
import { useSessionStore } from "@/stores/session-store";

export interface UseGoalMutationsResult {
  createGoal: (input: GoalCreateInput) => Promise<void>;
  approvePlan: (goalId: string) => Promise<void>;
  cancelGoal: (goalId: string) => Promise<void>;
  isCreating: boolean;
  isApproving: boolean;
  isCancelling: boolean;
}

function requireClient(serverId: string, unavailableMessage: string): DaemonClient {
  const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
  if (!client) {
    throw new Error(unavailableMessage);
  }
  return client;
}

function throwPayloadError(payload: { error: string | null }): void {
  if (payload.error) {
    throw new Error(payload.error);
  }
}

export function useGoalMutations({ serverId }: { serverId: string }): UseGoalMutationsResult {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const unavailableMessage = t("common.errors.daemonClientUnavailable");

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: goalsHostQueryKey(serverId) });
  }, [queryClient, serverId]);

  const createMutation = useMutation({
    mutationFn: async (input: GoalCreateInput): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalCreate(input));
    },
    onSettled: invalidate,
  });

  const approveMutation = useMutation({
    mutationFn: async (goalId: string): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalApprovePlan({ goalId }));
    },
    onSettled: invalidate,
  });

  const cancelMutation = useMutation({
    mutationFn: async (goalId: string): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalCancel({ goalId }));
    },
    onSettled: invalidate,
  });

  // mutateAsync is referentially stable across renders.
  return {
    createGoal: createMutation.mutateAsync,
    approvePlan: approveMutation.mutateAsync,
    cancelGoal: cancelMutation.mutateAsync,
    isCreating: createMutation.isPending,
    isApproving: approveMutation.isPending,
    isCancelling: cancelMutation.isPending,
  };
}
