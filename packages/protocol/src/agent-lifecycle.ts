import type { WorkspaceAddress } from "./addresses.js";
export const AGENT_LIFECYCLE_STATUSES = [
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
] as const;

export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

/** Archiving a parent preserves children in another workspace or an open tab. */
export function shouldDetachFromArchivedParent(input: {
  parentWorkspace: WorkspaceAddress | undefined;
  childWorkspace: WorkspaceAddress | undefined;
  hasOpenTab: boolean;
}): boolean {
  const { parentWorkspace, childWorkspace } = input;
  const differentWorkspace =
    parentWorkspace !== undefined &&
    childWorkspace !== undefined &&
    (parentWorkspace.serverId !== childWorkspace.serverId ||
      parentWorkspace.workspaceId !== childWorkspace.workspaceId);
  return differentWorkspace || input.hasOpenTab;
}
