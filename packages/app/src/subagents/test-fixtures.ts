import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { SubagentRelationship } from "@getpaseo/protocol/messages";
import type { Agent } from "@/stores/session-store";
import { projectAgentSnapshot } from "@/utils/agent-snapshots";
import type { ManagedSubagentState } from "./managed";

export function relationshipFixture(
  parent: AgentAddress,
  agent: Agent,
  overrides: Partial<SubagentRelationship> = {},
): SubagentRelationship {
  return {
    id: JSON.stringify([parent, agent.serverId, agent.id]),
    parent,
    child: { serverId: agent.serverId, agentId: agent.id },
    ...(agent.workspaceId
      ? { workspace: { serverId: agent.serverId, workspaceId: agent.workspaceId } }
      : {}),
    snapshot: projectAgentSnapshot(agent),
    phase: "attached",
    observedAt: agent.updatedAt.toISOString(),
    freshness: "current",
    error: null,
    ...overrides,
  };
}

export function membershipFixture(
  parent: AgentAddress,
  rows: SubagentRelationship[],
): ManagedSubagentState {
  return { parent, rows, status: "current", error: null, archiving: new Set() };
}

export function managedAgentFields(
  parent: AgentAddress | null,
  parentWorkspace: import("@getpaseo/protocol/addresses").WorkspaceAddress | null = null,
): Pick<Agent, "parent" | "managedRelationship"> {
  return {
    parent,
    managedRelationship: parent ? { id: JSON.stringify(parent), parent, parentWorkspace } : null,
  };
}
