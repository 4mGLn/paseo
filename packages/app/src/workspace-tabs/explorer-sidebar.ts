import { useMemo } from "react";
import { selectIsCompactFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import {
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
  defaultWorkspaceLayoutStore,
  useWorkspaceLayoutStoreApi,
  type WorkspaceLayoutStoreApi,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

export type ExplorerSidebarView = "changes" | "files" | "pr";
export type ExplorerSidebarPresentation = "overlay" | "dock";

const VIEW_TARGETS: Record<ExplorerSidebarView, WorkspaceTabTarget> = {
  changes: { kind: "changes_tree" },
  files: { kind: "files" },
  pr: { kind: "pull_request" },
};

export interface ExplorerSidebarQuery {
  isCompact: boolean;
  workspaceKey: string | null;
}

export function resolveExplorerSidebarPresentation(
  input: Pick<ExplorerSidebarQuery, "isCompact">,
): ExplorerSidebarPresentation {
  if (input.isCompact) {
    return "overlay";
  }
  return "dock";
}

export function createExplorerSidebarActions(layout: WorkspaceLayoutStoreApi) {
  /** Reveals the Explorer sidebar and selects one of its navigation trees. */
  function openExplorerSidebarView(
    input: ExplorerSidebarQuery & { view: ExplorerSidebarView },
  ): void {
    if (!input.workspaceKey) return;
    const store = layout.getState();
    const paneId = showExplorerSidebar(input);
    store.openTab({
      workspaceKey: input.workspaceKey,
      target: VIEW_TARGETS[input.view],
      intent: "reveal",
      placement: paneId ? { mode: "pane", paneId } : undefined,
    });
  }

  function showExplorerSidebar(input: ExplorerSidebarQuery): string | null {
    if (input.isCompact) {
      usePanelStore.getState().showMobileFileExplorer();
    }
    if (input.workspaceKey) {
      const store = layout.getState();
      return input.isCompact
        ? store.ensureExplorerSidebar(input.workspaceKey)
        : store.showExplorerSidebar(input.workspaceKey);
    }
    return null;
  }

  function hideExplorerSidebar(input: ExplorerSidebarQuery): void {
    if (input.isCompact) {
      usePanelStore.getState().showMobileAgent();
      return;
    }
    if (input.workspaceKey) {
      layout.getState().hideExplorerSidebar(input.workspaceKey);
    }
  }

  function toggleExplorerSidebar(input: ExplorerSidebarQuery): void {
    if (input.isCompact) {
      if (isExplorerSidebarOpen(input)) hideExplorerSidebar(input);
      else showExplorerSidebar(input);
      return;
    }
    if (!input.workspaceKey) return;
    if (isExplorerSidebarOpen(input)) {
      hideExplorerSidebar(input);
    } else {
      showExplorerSidebar(input);
    }
  }

  function isExplorerSidebarOpen(input: ExplorerSidebarQuery): boolean {
    if (input.isCompact) {
      return selectIsCompactFileExplorerOpen(usePanelStore.getState());
    }
    return Boolean(
      input.workspaceKey && selectIsExplorerSidebarVisible(layout.getState(), input.workspaceKey),
    );
  }

  return {
    openExplorerSidebarView,
    showExplorerSidebar,
    hideExplorerSidebar,
    toggleExplorerSidebar,
    isExplorerSidebarOpen,
  };
}
export function useExplorerSidebarActions() {
  const layout = useWorkspaceLayoutStoreApi();
  return useMemo(() => createExplorerSidebarActions(layout), [layout]);
}
// COMPAT(unboundExplorerNavigation): added in v0.12, remove after 2027-04-20.
export const {
  openExplorerSidebarView,
  showExplorerSidebar,
  hideExplorerSidebar,
  toggleExplorerSidebar,
  isExplorerSidebarOpen,
} = createExplorerSidebarActions(defaultWorkspaceLayoutStore);
export function useIsExplorerSidebarOpen(input: ExplorerSidebarQuery): boolean {
  const compactOpen = usePanelStore(selectIsCompactFileExplorerOpen);
  const paneOpen = useWorkspaceLayoutStore((state) =>
    input.workspaceKey ? selectIsExplorerSidebarVisible(state, input.workspaceKey) : false,
  );
  return input.isCompact ? compactOpen : paneOpen;
}
