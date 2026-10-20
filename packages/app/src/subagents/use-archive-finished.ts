import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useHostRuntimeStore } from "@/runtime/host-runtime";
import {
  createArchiveFinishedSubagents,
  type ArchiveFinishedOutcome,
  type ArchiveFinishedState,
  type ArchiveFinishedSubagents,
} from "./archive-finished";
import { useProviderSubagentStoreApi } from "./provider-store";
import type { SubagentRow } from "./select";

export type { ArchiveFinishedStatus } from "./archive-finished";

export interface UseArchiveFinishedSubagentsInput {
  serverId: string;
  parentAgentId: string;
  rows: readonly SubagentRow[];
}

export interface ArchiveFinishedSubagentsCapability extends ArchiveFinishedState {
  archiveFinished: () => Promise<ArchiveFinishedOutcome>;
}

export function useArchiveFinishedSubagents({
  serverId,
  parentAgentId,
  rows,
}: UseArchiveFinishedSubagentsInput): ArchiveFinishedSubagentsCapability {
  const runtime = useHostRuntimeStore();
  const providerStore = useProviderSubagentStoreApi();
  const directory = runtime.subagents.directory({ serverId, agentId: parentAgentId });
  const archiveFinished = useMemo<ArchiveFinishedSubagents>(
    () =>
      createArchiveFinishedSubagents([], {
        parent: { serverId, agentId: parentAgentId },
        getManagedSubagent: (address) => {
          const row = directory
            .getSnapshot()
            .rows.find(
              (candidate) =>
                candidate.child.serverId === address.serverId &&
                candidate.child.agentId === address.agentId,
            );
          return row && row.phase === "attached"
            ? {
                address: row.child,
                parent: row.parent,
                status: row.snapshot?.status ?? null,
                freshness: row.freshness,
                phase: row.phase,
                archivedAt: row.snapshot?.archivedAt ? new Date(row.snapshot.archivedAt) : null,
              }
            : undefined;
        },
        archiveManagedSubagent: directory.archive,
        dismissProviderSubagents: (ids) => {
          providerStore.getState().hideFromTrack(serverId, parentAgentId, ids);
        },
      }),
    [directory, parentAgentId, providerStore, serverId],
  );
  const state = useSyncExternalStore(
    archiveFinished.subscribe,
    archiveFinished.getState,
    archiveFinished.getState,
  );

  useEffect(() => {
    archiveFinished.setRows(rows);
  }, [archiveFinished, rows]);

  return { ...state, archiveFinished: archiveFinished.archiveFinished };
}
