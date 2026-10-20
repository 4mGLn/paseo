import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { pickAttentionAgent } from "@/utils/agent-attention";
import {
  buildHostWorkspaceOpenRoute,
  buildHostWorkspaceRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
  withHostRouteAuthority,
} from "@/utils/host-routes";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { prepareWorkspaceTab, type PrepareWorkspaceTabDeps } from "@/utils/prepare-workspace-tab";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";

export interface RouteSelectionInput {
  pathname: string;
  params: {
    serverId?: string | string[];
    workspaceId?: string | string[];
    origin?: string | string[];
  };
}

export interface NavigateToWorkspaceInput {
  serverId: string;
  workspaceId: string;
  target?: WorkspaceTabTarget;
  pin?: boolean;
  placement?: WorkspaceTabPlacement;
  authority?: { originServerId: string };
}

export interface NavigateToWorkspaceDeps extends PrepareWorkspaceTabDeps {
  getSessionWorkspaces: (serverId: string) => Map<string, WorkspaceDescriptor> | null | undefined;
  getSessionAgents: (serverId: string) => Iterable<Agent>;
  isWorkspaceLayoutHydrated: () => boolean;
  rememberLastWorkspace: (selection: ActiveWorkspaceSelection) => void;
  navigateToRoute: (route: string) => void;
}

export interface NavigateToLastWorkspaceDeps extends NavigateToWorkspaceDeps {
  getLastWorkspaceSelection: () => ActiveWorkspaceSelection | null;
}

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function parseWorkspaceSelectionFromRouteParams(params: {
  serverId?: string | string[];
  workspaceId?: string | string[];
  origin?: string | string[];
}): ActiveWorkspaceSelection | null {
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
  if (!serverId || !workspaceId) {
    return null;
  }
  const originServerId = getParamValue(params.origin);
  return { serverId, workspaceId, ...(originServerId ? { authority: { originServerId } } : {}) };
}

export function parseActiveWorkspaceSelection(
  input: RouteSelectionInput,
): ActiveWorkspaceSelection | null {
  const routeSelection = parseHostWorkspaceRouteFromPathname(input.pathname);
  if (routeSelection) {
    const originServerId = getParamValue(input.params.origin);
    return routeSelection.authority || !originServerId
      ? routeSelection
      : { ...routeSelection, authority: { originServerId } };
  }

  if (input.pathname !== "/" && input.pathname !== "") {
    return null;
  }

  return parseWorkspaceSelectionFromRouteParams(input.params);
}

export function navigateToWorkspace(
  input: NavigateToWorkspaceInput,
  deps: NavigateToWorkspaceDeps,
): string {
  // COMPAT(unboundWorkspaceNavigation): added in v0.12, remove after 2027-04-20.
  // Bound routes prepare their intent only after reacquiring the selected authority.
  const workspaces = input.authority ? null : deps.getSessionWorkspaces(input.serverId);
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: input.workspaceId,
  });
  const shouldDeferAgentOpen = Boolean(
    input.target?.kind === "agent" &&
    (input.authority || !resolvedWorkspaceId || !deps.isWorkspaceLayoutHydrated()),
  );
  if (input.target) {
    if (!shouldDeferAgentOpen) {
      prepareWorkspaceTab({ ...input, target: input.target }, deps);
    }
  } else {
    const workspaceAgents = resolvedWorkspaceId
      ? Array.from(deps.getSessionAgents(input.serverId)).filter(
          (agent) => normalizeWorkspaceOpaqueId(agent.workspaceId) === resolvedWorkspaceId,
        )
      : [];
    const attentionAgentId = pickAttentionAgent(workspaceAgents);
    if (attentionAgentId && resolvedWorkspaceId) {
      deps.openTab({
        workspaceKey: `${input.serverId}:${resolvedWorkspaceId}`,
        target: { kind: "agent", agentId: attentionAgentId },
        intent: "reveal",
      });
    }
  }

  const baseRoute =
    input.target?.kind === "agent" && shouldDeferAgentOpen
      ? buildHostWorkspaceOpenRoute(
          input.serverId,
          input.workspaceId,
          `agent:${input.target.agentId}`,
        )
      : buildHostWorkspaceRoute(input.serverId, input.workspaceId);
  const route = input.authority ? withHostRouteAuthority(baseRoute, input.authority) : baseRoute;
  deps.rememberLastWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    ...(input.authority ? { authority: input.authority } : {}),
  });
  deps.navigateToRoute(route);
  return route;
}

export function navigateToLastWorkspace(deps: NavigateToLastWorkspaceDeps): boolean {
  const selection = deps.getLastWorkspaceSelection();
  if (!selection) {
    return false;
  }
  navigateToWorkspace(selection, deps);
  return true;
}
