import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Goal, GoalEvent } from "@getpaseo/protocol/goal/types";
import { useFetchQuery } from "@/data/query";
import { isGoalTerminal } from "@/goals/goal-derivation";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";

// Goals have no push events yet, so the screen polls while it is mounted.
const GOALS_POLL_MS = 5_000;

export const goalsQueryBaseKey = ["goals"] as const;

export function goalsHostQueryKey(serverId: string) {
  return [...goalsQueryBaseKey, serverId] as const;
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
}): GoalQueryResult<Goal[]> {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const shouldFetch = input.enabled && client !== null && isConnected;

  const query = useFetchQuery<Goal[]>({
    queryKey: useMemo(() => [...goalsHostQueryKey(input.serverId), "list"], [input.serverId]),
    queryFn: async () => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const payload = await client.goalList();
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.goals;
    },
    enabled: shouldFetch,
    dataShape: "list",
    staleTimeMs: GOALS_POLL_MS,
    refetchInterval: shouldFetch ? GOALS_POLL_MS : false,
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

  const query = useFetchQuery<GoalDetail>({
    queryKey: useMemo(
      () => [...goalsHostQueryKey(input.serverId), "detail", input.goalId],
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
    staleTimeMs: GOALS_POLL_MS,
    refetchInterval: (activeQuery) => {
      const goal = activeQuery.state.data?.goal;
      const settled = goal ? isGoalTerminal(goal.status) : false;
      return shouldFetch && !settled ? GOALS_POLL_MS : false;
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
