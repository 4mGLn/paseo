import { useHostRuntimeStore, type HostRuntimeStore } from "@/runtime/host-runtime";
import { useCallback, useMemo } from "react";
import { useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useSessionStoreApi, type SessionStoreApi } from "@/stores/session-store";
import { agentHistoryQueryKey, allAgentHistoryQueryRootKey } from "./agent-history-query-key";

export const ARCHIVE_AGENT_PENDING_QUERY_KEY = ["archive-agent-pending"] as const;
const EMPTY_PENDING_ARCHIVE_AGENT_IDS = new Set<string>();

export interface ArchiveAgentInput {
  serverId: string;
  agentId: string;
}

export type ArchiveAgentPendingState = Record<string, true>;

interface SetAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
  isArchiving: boolean;
}

interface IsAgentArchivingInput extends ArchiveAgentInput {
  queryClient: QueryClient;
}

export interface AgentsListQueryData {
  entries?: Array<{ agent?: { id?: string | null } | null } | null>;
}

export interface AgentHistoryQueryAgent {
  id?: string | null;
  serverId?: string | null;
  archivedAt?: Date | null;
}

export interface AgentHistoryQueryPage {
  agents?: AgentHistoryQueryAgent[];
}

export interface AgentHistoryQueryData {
  pages?: AgentHistoryQueryPage[];
}

export function toArchiveKey(input: ArchiveAgentInput): string {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) {
    return "";
  }
  return `${serverId}:${agentId}`;
}

export function readPendingState(queryClient: QueryClient): ArchiveAgentPendingState {
  return queryClient.getQueryData<ArchiveAgentPendingState>(ARCHIVE_AGENT_PENDING_QUERY_KEY) ?? {};
}

export function selectPendingArchiveAgentIds(
  pendingState: ArchiveAgentPendingState,
  serverId: string,
): ReadonlySet<string> {
  const normalizedServerId = serverId.trim();
  if (!normalizedServerId) {
    return EMPTY_PENDING_ARCHIVE_AGENT_IDS;
  }

  const prefix = `${normalizedServerId}:`;
  let agentIds: string[] | null = null;
  for (const key of Object.keys(pendingState)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const agentId = key.slice(prefix.length);
    if (!agentId) {
      continue;
    }
    agentIds ??= [];
    agentIds.push(agentId);
  }

  if (!agentIds || agentIds.length === 0) {
    return EMPTY_PENDING_ARCHIVE_AGENT_IDS;
  }
  return new Set(agentIds);
}

export function setAgentArchiving(input: SetAgentArchivingInput): void {
  const key = toArchiveKey(input);
  if (!key) {
    return;
  }

  input.queryClient.setQueryData<ArchiveAgentPendingState>(
    ARCHIVE_AGENT_PENDING_QUERY_KEY,
    (current) => {
      const state = current ?? {};
      if (input.isArchiving) {
        if (state[key]) {
          return state;
        }
        return { ...state, [key]: true };
      }

      if (!state[key]) {
        return state;
      }

      const next = { ...state };
      delete next[key];
      return next;
    },
  );
}

export function isAgentArchiving(input: IsAgentArchivingInput): boolean {
  const key = toArchiveKey(input);
  if (!key) {
    return false;
  }
  return readPendingState(input.queryClient)[key] ?? false;
}

export function removeAgentFromListPayload<T extends AgentsListQueryData | undefined>(
  payload: T,
  agentId: string,
): T {
  if (!payload || !Array.isArray(payload.entries) || !agentId) {
    return payload;
  }
  const filtered = payload.entries.filter((entry) => entry?.agent?.id !== agentId);
  if (filtered.length === payload.entries.length) {
    return payload;
  }
  return {
    ...payload,
    entries: filtered,
  } as T;
}

export function removeAgentFromCachedLists(
  queryClient: QueryClient,
  input: ArchiveAgentInput,
): void {
  const agentId = input.agentId.trim();
  if (!agentId) {
    return;
  }

  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["sidebarAgentsList", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
  queryClient.setQueryData<AgentsListQueryData | undefined>(
    ["allAgents", input.serverId],
    (current) => removeAgentFromListPayload(current, agentId),
  );
}

export function markAgentArchivedInHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: ArchiveAgentInput & { archivedAt: string },
): T {
  if (!payload || !Array.isArray(payload.pages) || !input.agentId) {
    return payload;
  }

  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return payload;
  }

  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }

    let pageChanged = false;
    const agents = page.agents.map((agent) => {
      if (
        agent.id !== input.agentId ||
        (agent.serverId != null && agent.serverId !== input.serverId)
      ) {
        return agent;
      }
      pageChanged = true;
      changed = true;
      return {
        ...agent,
        archivedAt,
      };
    });

    return pageChanged ? { ...page, agents } : page;
  });

  return changed ? ({ ...payload, pages } as T) : payload;
}

export function markAgentArchivedInHistoryCache(
  queryClient: QueryClient,
  input: ArchiveAgentInput & { archivedAt: string },
): void {
  queryClient.setQueryData<AgentHistoryQueryData | undefined>(
    agentHistoryQueryKey(input.serverId),
    (current) => markAgentArchivedInHistoryPayload(current, input),
  );
  queryClient.setQueriesData<AgentHistoryQueryData | undefined>(
    { queryKey: allAgentHistoryQueryRootKey() },
    (current) => markAgentArchivedInHistoryPayload(current, input),
  );
}

export function clearArchiveAgentPending(input: IsAgentArchivingInput): void {
  setAgentArchiving({
    ...input,
    isArchiving: false,
  });
}

export interface ArchivedAgentCloseResult {
  agentId: string;
  archivedAt: string;
}

interface ArchivedAgentListCacheSnapshot {
  sidebarAgentsList: AgentsListQueryData | undefined;
  allAgents: AgentsListQueryData | undefined;
  agentHistory: AgentHistoryQueryData | undefined;
  allAgentHistory: Array<[QueryKey, AgentHistoryQueryData | undefined]>;
}

interface ArchiveAgentMutationContext {
  agent: ReturnType<typeof getStoredAgentSnapshot>;
  lists: ArchivedAgentListCacheSnapshot;
}

function getStoredAgentSnapshot(store: SessionStoreApi, input: ArchiveAgentInput) {
  return store.getState().sessions[input.serverId]?.agents.get(input.agentId);
}

function restoreAgentSnapshot(
  runtime: HostRuntimeStore,
  input: ArchiveAgentInput & { agent: ReturnType<typeof getStoredAgentSnapshot> },
): void {
  runtime.restoreAgentSnapshot(input.serverId, input.agentId, input.agent);
}

function getArchivedAgentListCacheSnapshot(
  queryClient: QueryClient,
  serverId: string,
): ArchivedAgentListCacheSnapshot {
  return {
    sidebarAgentsList: queryClient.getQueryData<AgentsListQueryData | undefined>([
      "sidebarAgentsList",
      serverId,
    ]),
    allAgents: queryClient.getQueryData<AgentsListQueryData | undefined>(["allAgents", serverId]),
    agentHistory: queryClient.getQueryData<AgentHistoryQueryData | undefined>(
      agentHistoryQueryKey(serverId),
    ),
    allAgentHistory: queryClient.getQueriesData<AgentHistoryQueryData | undefined>({
      queryKey: allAgentHistoryQueryRootKey(),
    }),
  };
}

function restoreCachedQuerySnapshot(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  snapshot: unknown,
): void {
  if (snapshot === undefined) {
    queryClient.removeQueries({ queryKey, exact: true });
    return;
  }
  queryClient.setQueryData(queryKey, snapshot);
}

function restoreArchivedAgentListCacheSnapshot(
  queryClient: QueryClient,
  serverId: string,
  snapshot: ArchivedAgentListCacheSnapshot,
): void {
  restoreCachedQuerySnapshot(
    queryClient,
    ["sidebarAgentsList", serverId],
    snapshot.sidebarAgentsList,
  );
  restoreCachedQuerySnapshot(queryClient, ["allAgents", serverId], snapshot.allAgents);
  restoreCachedQuerySnapshot(queryClient, agentHistoryQueryKey(serverId), snapshot.agentHistory);
  for (const [queryKey, querySnapshot] of snapshot.allAgentHistory) {
    restoreCachedQuerySnapshot(queryClient, queryKey, querySnapshot);
  }
}

function markAgentArchivedInStore(
  runtime: HostRuntimeStore,
  input: ArchiveAgentInput & { archivedAt: string },
): void {
  const archivedAt = new Date(input.archivedAt);
  if (Number.isNaN(archivedAt.getTime())) {
    return;
  }

  runtime.archiveAgentSnapshot(input.serverId, input.agentId, archivedAt.toISOString());
}

interface ApplyArchivedAgentCloseResultsInput {
  runtime: HostRuntimeStore;
  queryClient: QueryClient;
  serverId: string;
  results: ArchivedAgentCloseResult[];
  invalidateQueries?: boolean;
}

export function applyArchivedAgentCloseResults(input: ApplyArchivedAgentCloseResultsInput): void {
  if (input.results.length === 0) {
    return;
  }

  for (const result of input.results) {
    markAgentArchivedInStore(input.runtime, {
      serverId: input.serverId,
      agentId: result.agentId,
      archivedAt: result.archivedAt,
    });
    removeAgentFromCachedLists(input.queryClient, {
      serverId: input.serverId,
      agentId: result.agentId,
    });
    markAgentArchivedInHistoryCache(input.queryClient, {
      serverId: input.serverId,
      agentId: result.agentId,
      archivedAt: result.archivedAt,
    });
  }

  if (input.invalidateQueries ?? true) {
    void input.queryClient.invalidateQueries({
      queryKey: ["sidebarAgentsList", input.serverId],
    });
    void input.queryClient.invalidateQueries({
      queryKey: ["allAgents", input.serverId],
    });
    void input.queryClient.invalidateQueries({
      queryKey: agentHistoryQueryKey(input.serverId),
    });
    void input.queryClient.invalidateQueries({
      queryKey: allAgentHistoryQueryRootKey(),
    });
  }
}

function useArchiveAgentPendingQuery() {
  return useQuery({
    queryKey: ARCHIVE_AGENT_PENDING_QUERY_KEY,
    queryFn: async (): Promise<ArchiveAgentPendingState> => ({}),
    initialData: {} as ArchiveAgentPendingState,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

export function usePendingArchiveAgentIds(serverId: string): ReadonlySet<string> {
  const pendingQuery = useArchiveAgentPendingQuery();
  return useMemo(
    () => selectPendingArchiveAgentIds(pendingQuery.data ?? {}, serverId),
    [pendingQuery.data, serverId],
  );
}

/** The action owns optimistic state and rollback within its captured authority. */
export function createAgentArchiveAction({
  runtime,
  sessionStore,
  queryClient,
  unavailableMessage,
}: {
  runtime: HostRuntimeStore;
  sessionStore: SessionStoreApi;
  queryClient: QueryClient;
  unavailableMessage: string;
}): (input: ArchiveAgentInput) => Promise<void> {
  return async (input) => {
    const context: ArchiveAgentMutationContext = {
      agent: getStoredAgentSnapshot(sessionStore, input),
      lists: getArchivedAgentListCacheSnapshot(queryClient, input.serverId),
    };
    applyArchivedAgentCloseResults({
      runtime,
      queryClient,
      serverId: input.serverId,
      results: [{ agentId: input.agentId, archivedAt: new Date().toISOString() }],
      invalidateQueries: false,
    });
    setAgentArchiving({ ...input, queryClient, isArchiving: true });
    try {
      const client = runtime.getClient(input.serverId);
      if (!client) throw new Error(unavailableMessage);
      const result = await client.archiveAgent(input.agentId);
      markAgentArchivedInStore(runtime, { ...input, archivedAt: result.archivedAt });
    } catch (error) {
      restoreAgentSnapshot(runtime, { ...input, agent: context.agent });
      restoreArchivedAgentListCacheSnapshot(queryClient, input.serverId, context.lists);
      throw error;
    } finally {
      clearArchiveAgentPending({ ...input, queryClient });
      for (const queryKey of [
        ["sidebarAgentsList", input.serverId],
        ["allAgents", input.serverId],
        agentHistoryQueryKey(input.serverId),
        allAgentHistoryQueryRootKey(),
      ])
        void queryClient.invalidateQueries({ queryKey });
    }
  };
}

export function useArchiveAgent() {
  const queryClient = useQueryClient();
  const runtime = useHostRuntimeStore();
  const sessionStore = useSessionStoreApi();
  const { t } = useTranslation();
  const pendingQuery = useArchiveAgentPendingQuery();
  const unavailableMessage = t("common.errors.daemonClientUnavailable");
  const archiveAgent = useMemo(
    () =>
      createAgentArchiveAction({
        runtime,
        sessionStore,
        queryClient,
        unavailableMessage,
      }),
    [runtime, sessionStore, queryClient, unavailableMessage],
  );

  const isArchivingAgent = useCallback(
    (input: ArchiveAgentInput): boolean => {
      const key = toArchiveKey(input);
      if (!key) {
        return false;
      }
      return (pendingQuery.data ?? {})[key] ?? false;
    },
    [pendingQuery.data],
  );

  return {
    archiveAgent,
    isArchivingAgent,
  };
}
