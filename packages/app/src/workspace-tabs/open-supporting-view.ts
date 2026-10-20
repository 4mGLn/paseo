import { supportsDesktopPaneSplits } from "@/constants/layout";
import { createWorkspaceTabNavigation } from "./navigation";
import { useMemo } from "react";
import {
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  DEFAULT_PANE_ID,
  findPaneContainingTab,
  resolveExplorerSidebarPaneId,
  defaultWorkspaceLayoutStore,
  useWorkspaceLayoutStoreApi,
  type WorkspaceLayoutStoreApi,
} from "@/stores/workspace-layout-store";
import type { OpenInSidePanePreferences, PullRequestOpenLocation } from "@/hooks/use-settings";
import {
  createExplorerSidebarActions,
  type ExplorerSidebarView,
} from "@/workspace-tabs/explorer-sidebar";
import { createWorkspaceTargetActions } from "@/workspace-tabs/open-beside";

interface WorkspaceViewInput {
  isCompact: boolean;
  workspaceKey: string | null;
  supportsPaneSplits?: boolean;
}

interface OpenWorkspaceChangesInput extends WorkspaceViewInput {
  preferences: OpenInSidePanePreferences;
}

interface OpenWorkspacePullRequestInput extends WorkspaceViewInput {
  destination: PullRequestOpenLocation;
}

export function createSupportingViewActions(layoutStore: WorkspaceLayoutStoreApi) {
  const { revealWorkspaceTab } = createWorkspaceTabNavigation(layoutStore);
  const { openExplorerSidebarView, isExplorerSidebarOpen } =
    createExplorerSidebarActions(layoutStore);
  const { openPreferredWorkspaceTarget, openWorkspaceTargetAtLocation } =
    createWorkspaceTargetActions(layoutStore);
  function supportingViewsBelongInExplorer(input: WorkspaceViewInput): boolean {
    return input.isCompact || !(input.supportsPaneSplits ?? supportsDesktopPaneSplits());
  }

  function openExplorerView(input: WorkspaceViewInput, view: ExplorerSidebarView): void {
    openExplorerSidebarView({ ...input, view });
  }

  /** Opens the workspace Changes view according to the current layout and diff preference. */
  function openWorkspaceChanges(input: OpenWorkspaceChangesInput): string | null {
    if (supportingViewsBelongInExplorer(input)) {
      openExplorerView(input, "changes");
      return null;
    }
    return openPreferredWorkspaceTarget({
      workspaceKey: input.workspaceKey,
      target: { kind: "working_diff" },
      source: "diffs",
      preferences: input.preferences,
    });
  }

  /** Reveals Changes from the composer, then opens its diff on a subsequent desktop action. */
  function openComposerChanges(input: OpenWorkspaceChangesInput): string | null {
    if (supportingViewsBelongInExplorer(input) || isExplorerSidebarOpen(input)) {
      return openWorkspaceChanges(input);
    }
    openExplorerView(input, "changes");
    return null;
  }

  /** Opens the workspace pull request at its semantic destination. */
  function openWorkspacePullRequest(input: OpenWorkspacePullRequestInput): string | null {
    if (!input.workspaceKey) return null;
    let tabId: string | null;
    if (supportingViewsBelongInExplorer(input) || input.destination === "explorer") {
      const store = layoutStore.getState();
      const paneId = store.ensureExplorerSidebar(input.workspaceKey);
      tabId = store.openTab({
        workspaceKey: input.workspaceKey,
        target: { kind: "pull_request" },
        intent: "reveal",
        placement: paneId ? { mode: "prefer", paneId } : undefined,
      });
    } else {
      return openWorkspaceTargetAtLocation({
        workspaceKey: input.workspaceKey,
        target: { kind: "pull_request" },
        location: input.destination,
      });
    }
    revealWorkspaceTab(input.workspaceKey, tabId);
    return tabId;
  }

  /** Adds a detected desktop PR once without revealing or selecting its destination. */
  function autoOpenWorkspacePullRequest(input: {
    workspaceKey: string | null;
    destination: PullRequestOpenLocation;
  }): string | null {
    if (!input.workspaceKey) return null;
    const workspaceKey = input.workspaceKey;
    const store = layoutStore.getState();
    return store.autoOpenPullRequestTab(workspaceKey, () => {
      const layout =
        store.layoutByWorkspace[workspaceKey] ?? createWorkspaceLayoutWithExplorerSidebar();
      // A background open finds an existing PR tab wherever the user left it.
      if (collectAllTabs(layout.root).some((tab) => tab.target.kind === "pull_request")) {
        return {};
      }
      const explorerPaneId = resolveExplorerSidebarPaneId(
        layout,
        store.explorerSidebarPaneIdByWorkspace[workspaceKey],
      );
      let paneId = explorerPaneId;
      if (input.destination === "side") {
        paneId = store.ensureSidePane(workspaceKey, { focus: false });
      } else if (input.destination === "main") {
        const panes = collectAllPanes(layout.root);
        const mainPane =
          panes.find((pane) => pane.id === DEFAULT_PANE_ID) ??
          panes.find((pane) => pane.id !== explorerPaneId && !pane.hidden);
        paneId = mainPane?.id ?? null;
      }
      const changes =
        input.destination === "explorer"
          ? collectAllTabs(layout.root).find(
              (tab) =>
                tab.target.kind === "changes_tree" &&
                findPaneContainingTab(layout.root, tab.tabId)?.id === paneId,
            )
          : undefined;
      return {
        placement: paneId ? { mode: "prefer", paneId } : undefined,
        insertionPosition: changes ? { afterTabId: changes.tabId } : undefined,
      };
    });
  }

  return {
    openWorkspaceChanges,
    openComposerChanges,
    openWorkspacePullRequest,
    autoOpenWorkspacePullRequest,
  };
}
export function useSupportingViewActions() {
  const layout = useWorkspaceLayoutStoreApi();
  return useMemo(() => createSupportingViewActions(layout), [layout]);
}
// COMPAT(unboundSupportingViews): added in v0.12, remove after 2027-04-20.
export const {
  openWorkspaceChanges,
  openComposerChanges,
  openWorkspacePullRequest,
  autoOpenWorkspacePullRequest,
} = createSupportingViewActions(defaultWorkspaceLayoutStore);
