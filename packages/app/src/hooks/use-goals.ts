import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Goal, GoalEvent, GoalSummary } from "@getpaseo/protocol/goal/types";
import { useFetchQuery } from "@/data/query";
import { isGoalTerminal } from "@/goals/goal-derivation";
import { mergePolledGoals } from "@/goals/goal-updates";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useGoalPushLive } from "@/stores/goal-attention-store";

// Without `goal.update` pushes the screen polls while it is mounted.
const GOALS_POLL_MS = 5_000;
/** How often the app-wide watcher polls for goals that need you, without pushes. */
export const GOALS_BACKGROUND_POLL_MS = 15_000;
/** With pushes live, polling only repairs a push missed across a reconnect. */
export const GOALS_PUSH_FALLBACK_POLL_MS = 60_000;

export const goalsQueryBaseKey = ["goals"] as const;

export function goalsHostQueryKey(serverId: string) {
  return [...goalsQueryBaseKey, serverId] as const;
}

export function goalListQueryKey(serverId: string) {
  return [...goalsHostQueryKey(serverId), "list"] as const;
}

export function goalDetailQueryKey(serverId: string, goalId: string) {
  return [...goalsHostQueryKey(serverId), "detail", goalId] as const;
}

export type GoalLoadState<T> =
  | { status: "connecting" }
  | { status: "loading" }
  | { status: "loaded"; data: T };

export interface GoalQueryResult<T> {
  loadState: GoalLoadState<T>;
  isError: boolean;
  refetch: () => void;
}

export interface GoalDetail {
  goal: Goal | null;
  events: GoalEvent[];
}

function toLoadState<T>(input: { isConnected: boolean; data: T | undefined }): GoalLoadState<T> {
  if (input.data !== undefined) {
    return { status: "loaded", data: input.data };
  }
  return input.isConnected ? { status: "loading" } : { status: "connecting" };
}

export function useGoalList(input: {
  serverId: string;
  enabled: boolean;
  /** Defaults to the Goals screen's interval. Ignored while pushes are live. */
  pollMs?: number;
}): GoalQueryResult<GoalSummary[]> {
  const isPushLive = useGoalPushLive(input.serverId);
  const pollMs = isPushLive ? GOALS_PUSH_FALLBACK_POLL_MS : (input.pollMs ?? GOALS_POLL_MS);
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const shouldFetch = input.enabled && client !== null && isConnected;
  const queryKey = useMemo(() => goalListQueryKey(input.serverId), [input.serverId]);

  const query = useFetchQuery<GoalSummary[]>({
    queryKey,
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.goalList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return mergePolledGoals(queryClient.getQueryData<GoalSummary[]>(queryKey), payload.goals);
    },
    enabled: shouldFetch,
    dataShape: "list",
    staleTimeMs: pollMs,
    refetchInterval: shouldFetch ? pollMs : false,
  });

  return {
    loadState: toLoadState({ isConnected, data: query.data }),
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}

export function useGoalDetail(input: {
  serverId: string;
  goalId: string;
}): GoalQueryResult<GoalDetail> {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const shouldFetch = client !== null && isConnected;
  // Each push for this goal refetches the detail, so polling only backs it up.
  const pollMs = useGoalPushLive(input.serverId) ? GOALS_PUSH_FALLBACK_POLL_MS : GOALS_POLL_MS;

  const query = useFetchQuery<GoalDetail>({
    queryKey: useMemo(
      () => goalDetailQueryKey(input.serverId, input.goalId),
      [input.serverId, input.goalId],
    ),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.goalInspect(input.goalId);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { goal: payload.goal, events: payload.events };
    },
    enabled: shouldFetch,
    dataShape: "value",
    staleTimeMs: pollMs,
    refetchInterval: (activeQuery) => {
      const goal = activeQuery.state.data?.goal;
      const settled = goal ? isGoalTerminal(goal.status) : false;
      return shouldFetch && !settled ? pollMs : false;
    },
  });

  return {
    loadState: toLoadState({ isConnected, data: query.data }),
    isError: query.isError,
    refetch: () => {
      void query.refetch();
    },
  };
}
