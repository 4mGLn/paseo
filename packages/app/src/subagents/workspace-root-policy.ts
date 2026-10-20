import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

type WorkspaceAgent = Pick<Agent, "serverId" | "workspaceId" | "managedRelationship">;

export function isWorkspaceRootAgent(
  agent: WorkspaceAgent,
  parentAgent?: Pick<Agent, "id" | "serverId" | "workspaceId">,
): boolean {
  const membership = agent.managedRelationship;
  if (!membership) return true;
  const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
  const parentWorkspace =
    membership.parentWorkspace ??
    (parentAgent?.serverId === membership.parent.serverId &&
    parentAgent.id === membership.parent.agentId &&
    parentAgent.workspaceId
      ? { serverId: parentAgent.serverId, workspaceId: parentAgent.workspaceId }
      : null);
  return Boolean(
    workspaceId &&
    parentWorkspace &&
    (agent.serverId !== parentWorkspace.serverId || workspaceId !== parentWorkspace.workspaceId),
  );
}
