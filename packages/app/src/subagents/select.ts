import { useEffect, useMemo, useSyncExternalStore } from "react";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  refreshProviderSubagents,
  useProviderSubagentStore,
  useProviderSubagentStoreApi,
} from "./provider-store";
import { useHostRuntimeStore, type HostAuthorityReference } from "@/runtime/host-runtime";
import type { AgentAddress, WorkspaceAddress } from "@getpaseo/protocol/addresses";
import type { ManagedSubagentState } from "./managed";
import type { SubagentRelationship } from "@getpaseo/protocol/messages";
import { normalizeAgentSnapshot } from "@/utils/agent-snapshots";
import {
  buildAgentFactsLine,
  agentFactsSnapshot,
  type AgentFactsSnapshot,
} from "@/panels/agent-facts-line";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";

export interface PaseoSubagentRow {
  kind: "paseo";
  address: AgentAddress;
  authority: HostAuthorityReference;
  relationshipId: string;
  workspace: WorkspaceAddress | null;
  freshness: SubagentRelationship["freshness"];
  phase: SubagentRelationship["phase"];
  error: SubagentRelationship["error"];
  provider: Agent["provider"];
  title: Agent["title"];
  /** Managed agents have a real title, so the union's task line is always absent for them. */
  description: null;
  subtitle: string | null;
  facts: AgentFactsSnapshot | null;
  status: Agent["status"] | null;
  turn: Agent["turn"] | null;
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"] | null;
}

export interface ProviderSubagentRow {
  kind: "provider";
  id: string;
  parentAgentId: string;
  provider: ProviderSubagentDescriptorPayload["provider"];
  // `title` is the subagent type ("Explore", "general-purpose") and repeats across a fan-out;
  // `description` is the task it was given. Both are carried so presentation can choose which
  // one names the row — collapsing them here is what makes every row read alike.
  title: string | null;
  description: string | null;
  /** Compact provider-owned context. The app displays it without interpreting its contents. */
  subtitle: string | null;
  status: ProviderSubagentDescriptorPayload["status"];
  requiresAttention: boolean;
  createdAt: Date;
}

export type SubagentRow = PaseoSubagentRow | ProviderSubagentRow;

type ProviderSubagentStoreSnapshot = ReturnType<typeof useProviderSubagentStore.getState>;

interface SelectSubagentsParams {
  serverId: string;
  parentAgentId: string;
  /** Select children of this provider subagent instead of children of the managed agent. */
  providerParentSubagentId?: string;
}

const EMPTY_PROVIDER_SUBAGENT_ROWS: ProviderSubagentRow[] = [];

export function subagentRowIdentity(row: SubagentRow): string {
  return row.kind === "paseo"
    ? JSON.stringify(["paseo", row.address.serverId, row.address.agentId])
    : JSON.stringify(["provider", row.parentAgentId, row.id]);
}

export function selectSubagentsForParent(
  state: ManagedSubagentState,
  authority: HostAuthorityReference,
  pendingArchiveKeys: ReadonlySet<string>,
): PaseoSubagentRow[] {
  const rows: PaseoSubagentRow[] = [];
  for (const relationship of state.rows) {
    if (["detached", "archived", "forgotten", "canceled"].includes(relationship.phase)) continue;
    const address = relationship.child;
    if (pendingArchiveKeys.has(JSON.stringify([address.serverId, address.agentId]))) continue;
    const snapshot = relationship.snapshot
      ? normalizeAgentSnapshot(relationship.snapshot, address.serverId)
      : null;
    rows.push({
      kind: "paseo",
      address,
      authority: { originServerId: authority.originServerId, serverId: address.serverId },
      relationshipId: relationship.id,
      workspace: relationship.workspace ?? null,
      phase: relationship.phase,
      freshness: relationship.freshness,
      error: relationship.error,
      provider: snapshot?.provider ?? "",
      title: snapshot?.title ?? null,
      description: null,
      subtitle: snapshot
        ? buildAgentFactsLine({ ...agentFactsSnapshot(snapshot), models: null })
        : null,
      facts: snapshot ? agentFactsSnapshot(snapshot) : null,
      status: snapshot?.status ?? null,
      turn: snapshot?.turn ?? null,
      requiresAttention: snapshot?.requiresAttention ?? false,
      createdAt: snapshot?.createdAt ?? null,
    });
  }
  rows.sort(compareSubagentRows);
  return rows;
}

export function createSubagentsForParentSelector(
  authority: HostAuthorityReference,
  pendingArchiveKeys: ReadonlySet<string>,
): (state: ManagedSubagentState) => PaseoSubagentRow[] {
  let previous: ManagedSubagentState | null = null;
  let previousRows: PaseoSubagentRow[] = [];
  return (state) => {
    if (previous === state) return previousRows;
    const rows = selectSubagentsForParent(state, authority, pendingArchiveKeys);
    previous = state;
    if (!equal(previousRows, rows)) previousRows = rows;
    return previousRows;
  };
}

function compareSubagentRows(left: SubagentRow, right: SubagentRow): number {
  return (
    (left.createdAt?.getTime() ?? 0) - (right.createdAt?.getTime() ?? 0) ||
    subagentRowIdentity(left).localeCompare(subagentRowIdentity(right))
  );
}

export function selectProviderSubagentsForParent(
  state: ProviderSubagentStoreSnapshot,
  params: SelectSubagentsParams,
  supported: boolean,
  nestingSupported = false,
): ProviderSubagentRow[] {
  if (!supported) return EMPTY_PROVIDER_SUBAGENT_ROWS;
  if (params.providerParentSubagentId && !nestingSupported) return EMPTY_PROVIDER_SUBAGENT_ROWS;
  const rows: ProviderSubagentRow[] = [];
  const prefix = `${params.serverId}\0${params.parentAgentId}\0`;
  for (const [key, subagent] of state.descriptors) {
    if (!key.startsWith(prefix) || state.hiddenFromTrack.has(key)) continue;
    if (
      nestingSupported &&
      (subagent.parentSubagentId ?? null) !== (params.providerParentSubagentId ?? null)
    ) {
      continue;
    }
    rows.push({
      kind: "provider",
      id: subagent.id,
      parentAgentId: subagent.parentAgentId,
      provider: subagent.provider,
      title: subagent.title,
      description: subagent.description,
      subtitle: subagent.subtitle ?? null,
      status: subagent.status,
      requiresAttention: subagent.status === "failed",
      createdAt: new Date(subagent.createdAt),
    });
  }
  rows.sort(compareSubagentRows);
  return rows;
}

export function useSubagentsForParent(params: SelectSubagentsParams): SubagentRow[] {
  const { serverId, parentAgentId } = params;
  const providerStore = useProviderSubagentStoreApi();
  const runtime = useHostRuntimeStore();
  const directory = runtime.subagents.directory({ serverId, agentId: parentAgentId });
  const membership = useSyncExternalStore(
    directory.subscribe,
    directory.getSnapshot,
    directory.getSnapshot,
  );
  const paseoRows = useMemo(
    () =>
      selectSubagentsForParent(membership, runtime.authorityFor(serverId), membership.archiving),
    [membership, runtime, serverId],
  );
  const supported = useSessionStore(
    (state) => state.sessions[params.serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) =>
      state.sessions[params.serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const providerRows = useStoreWithEqualityFn(
    providerStore,
    (state) => selectProviderSubagentsForParent(state, params, supported, nestingSupported),
    equal,
  );
  const client = useSessionStore((state) => state.sessions[params.serverId]?.client ?? null);

  useEffect(() => {
    if (!client || !supported) return;
    void refreshProviderSubagents(
      client,
      params.serverId,
      params.parentAgentId,
      providerStore,
    ).catch(() => undefined);
  }, [client, params.parentAgentId, params.serverId, providerStore, supported]);

  return useMemo(() => {
    if (params.providerParentSubagentId) return providerRows;
    if (providerRows.length === 0) return paseoRows;
    const rows = [...paseoRows, ...providerRows];
    rows.sort(compareSubagentRows);
    return rows;
  }, [params.providerParentSubagentId, paseoRows, providerRows]);
}
