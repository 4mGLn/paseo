import { useCallback } from "react";
import { useToast } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useHostRuntimeStore } from "@/runtime/host-runtime";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { PaseoSubagentRow } from "./select";
import { confirmDialog } from "@/utils/confirm-dialog";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { requestDetachSubagent, type ResolveDetachSubagentDialogInput } from "./detach-subagent";

export { resolveDetachSubagentDialog, requestDetachSubagent } from "./detach-subagent";
export type {
  DetachSubagentDeps,
  RequestDetachSubagentInput,
  ResolveDetachSubagentDialogInput,
} from "./detach-subagent";

export interface UseDetachSubagentInput {
  parent: AgentAddress;
}

export function useDetachSubagent(input: UseDetachSubagentInput): (row: PaseoSubagentRow) => void {
  const runtime = useHostRuntimeStore();
  const directory = runtime.subagents.directory(input.parent);
  const toast = useToast();

  return useCallback(
    (row: PaseoSubagentRow) => {
      void requestDetachSubagent(
        { child: row.address },
        {
          getSubagent: (child): ResolveDetachSubagentDialogInput | undefined =>
            directory
              .getSnapshot()
              .rows.find(
                (current) =>
                  current.child.serverId === child.serverId &&
                  current.child.agentId === child.agentId,
              )?.snapshot,
          confirm: confirmDialog,
          detachAgent: directory.detach,
          reportPending: () => toast.show(i18n.t("agentList.badges.pending", { count: 1 })),
          openDetachedAgent: ({ serverId: targetServerId, agentId }) => {
            navigateToAgent({ serverId: targetServerId, agentId, authority: row.authority });
          },
          reportError: (error) => {
            toast.error(toErrorMessage(error));
          },
        },
      );
    },
    [directory, toast],
  );
}
