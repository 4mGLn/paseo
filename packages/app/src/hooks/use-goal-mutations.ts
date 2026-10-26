import { useCallback } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Goal } from "@getpaseo/protocol/goal/types";
import type { GoalCreateInput } from "@/goals/goal-form-model";
import { goalsHostQueryKey } from "@/hooks/use-goals";
import { useSessionStore } from "@/stores/session-store";

export interface UseGoalMutationsResult {
  /** Resolves with the created goal. */
  createGoal: (input: GoalCreateInput) => Promise<Goal | null>;
  approvePlan: (goalId: string) => Promise<void>;
  cancelGoal: (goalId: string) => Promise<void>;
  approveChangeSet: (input: ChangeSetTarget) => Promise<void>;
  requestChanges: (input: ChangeSetTarget & { findings: string }) => Promise<void>;
  isCreating: boolean;
  isApproving: boolean;
  isCancelling: boolean;
  /** The change set an approve or request-changes call is in flight for. */
  pendingChangeSetId: string | null;
  rejectPlan: (input: { goalId: string; feedback?: string }) => Promise<void>;
  /** Without a task, retries every failed task, reopening a failed goal. */
  retry: (input: { goalId: string; taskId?: string }) => Promise<void>;
  pause: (goalId: string) => Promise<void>;
  resume: (goalId: string) => Promise<void>;
  isRejecting: boolean;
  isPausing: boolean;
  /** The task a retry is in flight for; "" for a whole-goal retry. */
  pendingRetryTaskId: string | null;
}

export interface ChangeSetTarget {
  goalId: string;
  changeSetId: string;
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
    mutationFn: async (input: GoalCreateInput): Promise<Goal | null> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = await client.goalCreate(input);
      throwPayloadError(payload);
      return payload.goal;
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

  const approveChangeSetMutation = useMutation({
    mutationFn: async (input: ChangeSetTarget): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalApproveChangeSet(input));
    },
    onSettled: invalidate,
  });

  const requestChangesMutation = useMutation({
    mutationFn: async (input: ChangeSetTarget & { findings: string }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRequestChanges(input));
    },
    onSettled: invalidate,
  });

  const rejectPlanMutation = useMutation({
    mutationFn: async (input: { goalId: string; feedback?: string }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRejectPlan(input));
    },
    onSettled: invalidate,
  });

  const retryMutation = useMutation({
    mutationFn: async (input: { goalId: string; taskId?: string }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      throwPayloadError(await client.goalRetry(input));
    },
    onSettled: invalidate,
  });

  const pauseMutation = useMutation({
    mutationFn: async (input: { goalId: string; paused: boolean }): Promise<void> => {
      const client = requireClient(serverId, unavailableMessage);
      const payload = input.paused
        ? await client.goalPause({ goalId: input.goalId })
        : await client.goalResume({ goalId: input.goalId });
      throwPayloadError(payload);
    },
    onSettled: invalidate,
  });
  const pauseAsync = pauseMutation.mutateAsync;
  const pause = useCallback((goalId: string) => pauseAsync({ goalId, paused: true }), [pauseAsync]);
  const resume = useCallback(
    (goalId: string) => pauseAsync({ goalId, paused: false }),
    [pauseAsync],
  );

  let pendingChangeSetId: string | null = null;
  if (approveChangeSetMutation.isPending) {
    pendingChangeSetId = approveChangeSetMutation.variables?.changeSetId ?? null;
  } else if (requestChangesMutation.isPending) {
    pendingChangeSetId = requestChangesMutation.variables?.changeSetId ?? null;
  }

  // mutateAsync is referentially stable across renders.
  return {
    createGoal: createMutation.mutateAsync,
    approvePlan: approveMutation.mutateAsync,
    cancelGoal: cancelMutation.mutateAsync,
    approveChangeSet: approveChangeSetMutation.mutateAsync,
    requestChanges: requestChangesMutation.mutateAsync,
    pendingChangeSetId,
    rejectPlan: rejectPlanMutation.mutateAsync,
    retry: retryMutation.mutateAsync,
    pause,
    resume,
    isRejecting: rejectPlanMutation.isPending,
    isPausing: pauseMutation.isPending,
    pendingRetryTaskId: retryMutation.isPending ? (retryMutation.variables?.taskId ?? "") : null,
    isCreating: createMutation.isPending,
    isApproving: approveMutation.isPending,
    isCancelling: cancelMutation.isPending,
  };
}
