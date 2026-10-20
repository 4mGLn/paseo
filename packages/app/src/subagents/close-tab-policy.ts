import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: Pick<Agent, "managedRelationship"> | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.managedRelationship) {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
