import { buildHostAgentDetailRoute, withHostRouteAuthority } from "@/utils/host-routes";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  pin?: boolean;
  authority?: { originServerId: string };
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: {
    serverId: string;
    agentId: string;
    authority?: { originServerId: string };
  }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const agentWorkspaceId =
    input.workspaceId ??
    deps.readAgentNavTarget({
      serverId: input.serverId,
      agentId: input.agentId,
      ...(input.authority ? { authority: input.authority } : {}),
    }).agentWorkspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId) {
    const base = buildHostAgentDetailRoute(input.serverId, input.agentId);
    const route = input.authority ? withHostRouteAuthority(base, input.authority) : base;
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    pin: input.pin,
    ...(input.authority ? { authority: input.authority } : {}),
  });
}
