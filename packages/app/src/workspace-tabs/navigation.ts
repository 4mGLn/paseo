import {
  prepareWorkspaceTab as prepareWorkspaceTabPure,
  type PrepareWorkspaceTabInput,
} from "@/utils/prepare-workspace-tab";
import { useMemo } from "react";
import { useWorkspaceLayoutStoreApi } from "@/stores/workspace-layout-store";
import {
  defaultWorkspaceLayoutStore,
  type WorkspaceLayoutStoreApi,
} from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";

export function createWorkspaceTabNavigation(layout: WorkspaceLayoutStoreApi) {
  /** Reveals the actual destination after placement and deduplication, including existing tabs. */
  function revealWorkspaceTab(workspaceKey: string, tabId: string | null): string | null {
    if (!tabId) return null;
    const store = layout.getState();
    const destination = store.getTabDestination(workspaceKey, tabId);
    // Opening a sheet already reveals it, preserving the surface underneath.
    if (!destination) return null;
    if (destination.kind === "sheet") return tabId;
    store.focusTab(workspaceKey, tabId);
    if (store.layoutMode === "compact") {
      const panels = usePanelStore.getState();
      if (destination.host === "explorer") panels.showMobileFileExplorer();
      else panels.showMobileAgent();
    }
    return tabId;
  }

  return {
    revealWorkspaceTab,
    prepareWorkspaceTab: (input: PrepareWorkspaceTabInput) =>
      prepareWorkspaceTabPure(input, { openTab: (request) => layout.getState().openTab(request) }),
  };
}
// COMPAT(unboundWorkspaceNavigation): added in v0.12, remove after 2027-04-20.
export const { revealWorkspaceTab } = createWorkspaceTabNavigation(defaultWorkspaceLayoutStore);

export function useWorkspaceTabNavigation() {
  const layout = useWorkspaceLayoutStoreApi();
  return useMemo(() => createWorkspaceTabNavigation(layout), [layout]);
}
