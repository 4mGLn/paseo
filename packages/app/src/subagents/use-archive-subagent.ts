import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { useHostRuntimeStore } from "@/runtime/host-runtime";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { PaseoSubagentRow } from "./select";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { requestArchiveSubagent, type ResolveArchiveSubagentDialogInput } from "./archive-subagent";

export { resolveArchiveSubagentDialog, requestArchiveSubagent } from "./archive-subagent";
export type {
  ArchiveSubagentDeps,
  RequestArchiveSubagentInput,
  ResolveArchiveSubagentDialogInput,
} from "./archive-subagent";

export interface UseArchiveSubagentInput {
  parent: AgentAddress;
}

export function useArchiveSubagent(
  input: UseArchiveSubagentInput,
): (row: PaseoSubagentRow) => void {
  const runtime = useHostRuntimeStore();
  const directory = runtime.subagents.directory(input.parent);
  const toast = useToast();

  return useCallback(
    (row: PaseoSubagentRow) => {
      void requestArchiveSubagent(
        { child: row.address },
        {
          getSubagent: (child): ResolveArchiveSubagentDialogInput | undefined =>
            directory
              .getSnapshot()
              .rows.find(
                (current) =>
                  current.child.serverId === child.serverId &&
                  current.child.agentId === child.agentId,
              )?.snapshot,
          confirm: confirmDialog,
          archiveAgent: directory.archive,
          reportError: (error) => {
            toast.error(toErrorMessage(error));
          },
        },
      );
    },
    [directory, toast],
  );
}
