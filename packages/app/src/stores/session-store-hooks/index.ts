import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  composeWorkspaceStructure,
  createWorkspaceStructureProjectsSelector,
  selectHasHydratedWorkspaces,
  selectHydratedWorkspaceServerIds,
  selectWorkspaceDirectoryServerIds,
  selectHasWorkspaces,
  selectProjectOrder,
  selectRecommendedProjectPaths,
  selectWorkspace,
  selectWorkspaceDirectory,
  selectWorkspaceExists,
  selectWorkspaceFields,
  selectWorkspaceKeys,
  selectWorkspaceOrderByScope,
  selectWorkspaceStatusesForBadges,
  workspaceEqualityFns,
  type WorkspaceStructure,
} from "./selectors";
import { useSessionStoreApi, type WorkspaceDescriptor } from "../session-store";
import type { DesktopBadgeWorkspaceStatus } from "@/utils/desktop-badge-state";

// These are the ONLY supported ways to read workspaces from the session store.
// Do not write raw `useSessionStore` selectors that return the workspaces Map, a session object,
// or the sessions dict — it breaks re-render isolation.

export type {
  DesktopBadgeWorkspaceStatus,
  WorkspaceStructure,
  WorkspaceStructureProject,
} from "./selectors";

export function useWorkspace(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceDescriptor | null {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspace(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceFields<T>(
  serverId: string | null,
  workspaceId: string | null,
  project: (w: WorkspaceDescriptor) => T,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspaceFields(state, serverId, workspaceId, project),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceExists(serverId: string | null, workspaceId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspaceExists(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useHasHydratedWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectHasHydratedWorkspaces(state, serverId),
    workspaceEqualityFns.identity,
  );
}

export function useHydratedWorkspaceServerIds(serverIds: string[]): string[] {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectHydratedWorkspaceServerIds(state, serverIds),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceDirectoryServerIds(serverIds: string[]): string[] {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspaceDirectoryServerIds(state, serverIds),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceDirectory(
  serverId: string | null,
  workspaceId: string | null,
): string | null {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspaceDirectory(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceStructure(serverIds: string[]): WorkspaceStructure {
  const selectProjects = useMemo(
    () => createWorkspaceStructureProjectsSelector(serverIds),
    [serverIds],
  );
  const projects = useStoreWithEqualityFn(
    useSessionStoreApi(),
    selectProjects,
    workspaceEqualityFns.deep,
  );
  const projectOrder = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) => selectProjectOrder(state),
    workspaceEqualityFns.deep,
  );
  const workspaceOrderByScope = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) => selectWorkspaceOrderByScope(state),
    workspaceEqualityFns.deep,
  );

  return useMemo(
    () =>
      composeWorkspaceStructure({
        projects,
        projectOrder,
        workspaceOrderByScope,
      }),
    [projectOrder, projects, workspaceOrderByScope],
  );
}

export function useWorkspaceKeys(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspaceKeys(state, serverId),
    workspaceEqualityFns.deep,
  );
}

export function useRecommendedProjectPaths(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectRecommendedProjectPaths(state, serverId),
    workspaceEqualityFns.deep,
  );
}

export function useHasWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectHasWorkspaces(state, serverId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceStatusesForBadges(): DesktopBadgeWorkspaceStatus[] {
  return useStoreWithEqualityFn(
    useSessionStoreApi(),
    (state) => selectWorkspaceStatusesForBadges(state),
    workspaceEqualityFns.deep,
  );
}
