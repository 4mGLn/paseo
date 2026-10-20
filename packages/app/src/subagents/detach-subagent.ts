import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { Agent } from "@/stores/session-store";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

export interface ResolveDetachSubagentDialogInput {
  title: Agent["title"] | null | undefined;
}

function resolveSubagentLabel(title: Agent["title"] | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function resolveDetachSubagentDialog(
  input: ResolveDetachSubagentDialogInput,
): ConfirmDialogInput {
  const subagentLabel = resolveSubagentLabel(input.title) ?? "This subagent";

  return {
    title: "Detach subagent?",
    message: `${subagentLabel} will leave this track and continue as a standalone agent.`,
    confirmLabel: "Detach",
    cancelLabel: "Cancel",
    destructive: false,
  };
}

export interface DetachSubagentDeps {
  getSubagent: (child: AgentAddress) => ResolveDetachSubagentDialogInput | undefined;
  confirm: (input: ConfirmDialogInput) => Promise<boolean>;
  detachAgent: (input: AgentAddress) => Promise<{ phase: string }>;
  reportPending: () => void;
  openDetachedAgent: (input: AgentAddress) => void;
  reportError: (error: unknown) => void;
}

export interface RequestDetachSubagentInput {
  child: AgentAddress;
}

export async function requestDetachSubagent(
  input: RequestDetachSubagentInput,
  deps: DetachSubagentDeps,
): Promise<void> {
  const subagent = deps.getSubagent(input.child);
  const confirmed = await deps.confirm(
    resolveDetachSubagentDialog({
      title: subagent?.title,
    }),
  );
  if (!confirmed) {
    return;
  }
  try {
    const result = await deps.detachAgent(input.child);
    if (result.phase === "detached") deps.openDetachedAgent(input.child);
    else deps.reportPending();
  } catch (error) {
    deps.reportError(error);
  }
}
