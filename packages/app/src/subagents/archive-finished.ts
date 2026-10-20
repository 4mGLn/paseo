import type { Agent } from "@/stores/session-store";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { SubagentRelationship } from "@getpaseo/protocol/messages";
import type { SubagentRow } from "./select";

export type ArchiveFinishedStatus =
  | { kind: "idle" }
  | { kind: "archiving"; completedCount: number; totalCount: number }
  | { kind: "failed"; failedCount: number; totalCount: number };

export interface ArchiveFinishedState {
  eligibleCount: number;
  status: ArchiveFinishedStatus;
}

export interface ArchiveFinishedOutcome {
  archivedPaseoAgents: AgentAddress[];
  dismissedProviderIds: string[];
  skippedPaseoAgents: AgentAddress[];
  failures: Array<{ address: AgentAddress; error: unknown }>;
}

export interface ManagedSubagentSnapshot {
  address: AgentAddress;
  parent: AgentAddress;
  status: Agent["status"] | null;
  freshness: SubagentRelationship["freshness"];
  phase: SubagentRelationship["phase"];
  archivedAt: Agent["archivedAt"];
}

export interface ArchiveFinishedSubagentsDeps {
  parent: AgentAddress;
  getManagedSubagent: (address: AgentAddress) => ManagedSubagentSnapshot | undefined;
  archiveManagedSubagent: (address: AgentAddress) => Promise<void>;
  dismissProviderSubagents: (ids: string[]) => void;
}

export interface ArchiveFinishedSubagents {
  getState(): ArchiveFinishedState;
  setRows(rows: readonly SubagentRow[]): void;
  subscribe(listener: () => void): () => void;
  archiveFinished(): Promise<ArchiveFinishedOutcome>;
}

export function isFinishedSubagent(row: SubagentRow): boolean {
  if (row.kind === "paseo")
    return (
      row.freshness === "current" &&
      row.phase === "attached" &&
      (row.status === "idle" || row.status === "error")
    );
  return row.status === "completed" || row.status === "failed" || row.status === "canceled";
}

function canArchiveManagedSubagent(
  agent: ManagedSubagentSnapshot | undefined,
  parent: AgentAddress,
): boolean {
  return Boolean(
    agent &&
    agent.freshness === "current" &&
    agent.phase === "attached" &&
    !agent.archivedAt &&
    agent.parent.serverId === parent.serverId &&
    agent.parent.agentId === parent.agentId &&
    (agent.status === "idle" || agent.status === "error"),
  );
}

function eligibleSignature(rows: readonly SubagentRow[]): string {
  return identitySignature(rowIdentities(rows));
}

function managedRowIdentity(address: AgentAddress): string {
  return JSON.stringify(["paseo", address.serverId, address.agentId]);
}

function rowIdentity(row: SubagentRow): string {
  return row.kind === "paseo" ? managedRowIdentity(row.address) : `provider:${row.id}`;
}

function rowIdentities(rows: readonly SubagentRow[]): Set<string> {
  return new Set(rows.map(rowIdentity));
}

function identitySignature(ids: ReadonlySet<string>): string {
  return [...ids].sort().join("\0");
}

function emptyOutcome(): ArchiveFinishedOutcome {
  return {
    archivedPaseoAgents: [],
    dismissedProviderIds: [],
    skippedPaseoAgents: [],
    failures: [],
  };
}

export function createArchiveFinishedSubagents(
  initialRows: readonly SubagentRow[],
  deps: ArchiveFinishedSubagentsDeps,
): ArchiveFinishedSubagents {
  let eligibleRows = initialRows.filter(isFinishedSubagent);
  let signature = eligibleSignature(eligibleRows);
  let failedSignature: string | null = null;
  let state: ArchiveFinishedState = {
    eligibleCount: eligibleRows.length,
    status: { kind: "idle" },
  };
  const listeners = new Set<() => void>();

  const publish = () => {
    for (const listener of listeners) listener();
  };
  const setState = (next: ArchiveFinishedState) => {
    state = next;
    publish();
  };

  const setRows = (rows: readonly SubagentRow[]) => {
    const nextEligibleRows = rows.filter(isFinishedSubagent);
    const nextSignature = eligibleSignature(nextEligibleRows);
    const eligibilityChanged = signature !== nextSignature;
    eligibleRows = nextEligibleRows;
    signature = nextSignature;

    if (state.status.kind === "failed" && failedSignature !== signature) {
      failedSignature = null;
      setState({ eligibleCount: eligibleRows.length, status: { kind: "idle" } });
      return;
    }
    if (state.eligibleCount !== eligibleRows.length || eligibilityChanged) {
      setState({ ...state, eligibleCount: eligibleRows.length });
    }
  };

  const archiveFinished = () => {
    if (state.status.kind === "archiving" || eligibleRows.length === 0) {
      return Promise.resolve(emptyOutcome());
    }

    const snapshot = eligibleRows;
    const totalCount = snapshot.length;
    setState({
      eligibleCount: eligibleRows.length,
      status: { kind: "archiving", completedCount: 0, totalCount },
    });
    return runArchiveFinished(snapshot, deps, (completedCount) => {
      setState({
        eligibleCount: eligibleRows.length,
        status: { kind: "archiving", completedCount, totalCount },
      });
    }).then(({ outcome, retryableFailureIds }) => {
      failedSignature =
        retryableFailureIds.size > 0 ? identitySignature(retryableFailureIds) : null;
      setState({
        eligibleCount: eligibleRows.length,
        status:
          retryableFailureIds.size > 0
            ? {
                kind: "failed",
                failedCount: retryableFailureIds.size,
                totalCount: retryableFailureIds.size,
              }
            : { kind: "idle" },
      });
      return outcome;
    });
  };

  return {
    getState: () => state,
    setRows,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    archiveFinished,
  };
}

async function runArchiveFinished(
  rows: readonly SubagentRow[],
  deps: ArchiveFinishedSubagentsDeps,
  reportProgress: (completedCount: number) => void,
): Promise<{ outcome: ArchiveFinishedOutcome; retryableFailureIds: Set<string> }> {
  const providerIds = rows.filter((row) => row.kind === "provider").map((row) => row.id);
  const paseoAddresses = rows.filter((row) => row.kind === "paseo").map((row) => row.address);
  let completedCount = 0;
  const outcome = emptyOutcome();
  const retryableFailureIds = new Set<string>();

  if (providerIds.length > 0) {
    deps.dismissProviderSubagents(providerIds);
    outcome.dismissedProviderIds.push(...providerIds);
    completedCount += providerIds.length;
    reportProgress(completedCount);
  }

  for (const address of paseoAddresses) {
    if (canArchiveManagedSubagent(deps.getManagedSubagent(address), deps.parent)) {
      try {
        await deps.archiveManagedSubagent(address);
        outcome.archivedPaseoAgents.push(address);
      } catch (error) {
        outcome.failures.push({ address, error });
        if (canArchiveManagedSubagent(deps.getManagedSubagent(address), deps.parent)) {
          retryableFailureIds.add(managedRowIdentity(address));
        }
      }
    } else {
      outcome.skippedPaseoAgents.push(address);
    }
    completedCount += 1;
    reportProgress(completedCount);
  }

  return { outcome, retryableFailureIds };
}
