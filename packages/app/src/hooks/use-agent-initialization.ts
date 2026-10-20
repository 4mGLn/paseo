import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  selectAgentTimelineState,
  useSessionStore,
  useSessionStoreApi,
  type SessionStoreApi,
} from "@/stores/session-store";
import { getInitKey, INIT_TIMEOUT_MS } from "@/utils/agent-initialization";
import { useHostRuntimeStore, type HostRuntimeStore } from "@/runtime/host-runtime";
import { planTimelineResumeFetch, planTimelineTailFetch } from "@/timeline/timeline-sync-plan";
import { i18n } from "@/i18n/i18next";

export type SetAgentInitializing = (agentId: string, initializing: boolean) => void;

export function createHistorySyncTimeoutError(): Error {
  return new Error(`History sync timed out after ${Math.round(INIT_TIMEOUT_MS / 1000)}s`);
}

export function refreshAgentInitializationTimeout(input: {
  key: string;
  store?: SessionStoreApi;
  agentId: string;
  setAgentInitializing: SetAgentInitializing;
}): void {
  const initializations = (input.store ?? useSessionStore).initializations;
  initializations.refreshInitTimeout({
    key: input.key,
    onTimeout: () => {
      input.setAgentInitializing(input.agentId, false);
      initializations.rejectInitDeferred(input.key, createHistorySyncTimeoutError());
    },
  });
}

export interface EnsureAgentIsInitializedInput {
  store?: SessionStoreApi;
  serverId: string;
  agentId: string;
  client: Pick<DaemonClient, "fetchAgentTimeline"> | null;
  runtime: Pick<HostRuntimeStore, "fetchAgentTimeline">;
  setAgentInitializing: SetAgentInitializing;
  hostDisconnectedMessage?: string;
}

export function ensureAgentIsInitialized(input: EnsureAgentIsInitializedInput): Promise<void> {
  const { serverId, agentId, client, setAgentInitializing } = input;
  const store = input.store ?? useSessionStore;
  const initializations = store.initializations;
  const key = getInitKey(serverId, agentId);
  const existing = initializations.getInitDeferred(key);
  if (existing) {
    return existing.promise;
  }

  const timeline = selectAgentTimelineState(store.getState().sessions[serverId], agentId);
  const timelineRequest = planTimelineResumeFetch(
    timeline.status === "synced" ? timeline.range : null,
  );

  const deferred = initializations.createInitDeferred(key, timelineRequest.direction);
  refreshAgentInitializationTimeout({ key, store, agentId, setAgentInitializing });

  setAgentInitializing(agentId, true);

  if (!client) {
    setAgentInitializing(agentId, false);
    initializations.rejectInitDeferred(
      key,
      new Error(input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected")),
    );
    return deferred.promise;
  }

  input.runtime.fetchAgentTimeline(serverId, agentId, timelineRequest).catch((error) => {
    setAgentInitializing(agentId, false);
    initializations.rejectInitDeferred(
      key,
      error instanceof Error ? error : new Error(String(error)),
    );
  });

  return deferred.promise;
}

export interface RefreshAgentInput {
  serverId: string;
  agentId: string;
  client: Pick<DaemonClient, "refreshAgent"> | null;
  runtime: Pick<HostRuntimeStore, "fetchAgentTimeline">;
  setAgentInitializing: SetAgentInitializing;
  hostDisconnectedMessage?: string;
}

export async function refreshAgent(input: RefreshAgentInput): Promise<void> {
  const { serverId, agentId, client, runtime, setAgentInitializing } = input;
  if (!client) {
    throw new Error(input.hostDisconnectedMessage ?? i18n.t("workspace.terminal.hostDisconnected"));
  }
  setAgentInitializing(agentId, true);

  try {
    await client.refreshAgent(agentId);
    await runtime.fetchAgentTimeline(serverId, agentId, planTimelineTailFetch());
  } catch (error) {
    setAgentInitializing(agentId, false);
    throw error;
  }
}

export function createSetAgentInitializing(
  serverId: string,
  setInitializingAgents: ReturnType<typeof useSessionStore.getState>["setInitializingAgents"],
): SetAgentInitializing {
  return (agentId, initializing) => {
    setInitializingAgents(serverId, (prev) => {
      if (prev.get(agentId) === initializing) {
        return prev;
      }
      const next = new Map(prev);
      next.set(agentId, initializing);
      return next;
    });
  };
}

export function useAgentInitialization({
  serverId,
  client,
}: {
  serverId: string;
  client: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const store = useSessionStoreApi();
  const runtime = useHostRuntimeStore();
  const setInitializingAgents = useSessionStore((state) => state.setInitializingAgents);
  const setAgentInitializing = useMemo(
    () => createSetAgentInitializing(serverId, setInitializingAgents),
    [serverId, setInitializingAgents],
  );

  const ensureAgentIsInitializedCallback = useCallback(
    (agentId: string): Promise<void> =>
      ensureAgentIsInitialized({
        store,
        serverId,
        agentId,
        client,
        runtime,
        setAgentInitializing,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [client, runtime, serverId, setAgentInitializing, store, t],
  );

  const refreshAgentCallback = useCallback(
    (agentId: string): Promise<void> =>
      refreshAgent({
        serverId,
        agentId,
        client,
        runtime,
        setAgentInitializing,
        hostDisconnectedMessage: t("workspace.terminal.hostDisconnected"),
      }),
    [client, runtime, serverId, setAgentInitializing, t],
  );

  return {
    ensureAgentIsInitialized: ensureAgentIsInitializedCallback,
    refreshAgent: refreshAgentCallback,
  };
}
