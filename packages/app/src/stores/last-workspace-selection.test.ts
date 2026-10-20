import { describe, expect, it } from "vitest";
import {
  createLastWorkspaceSelectionStore,
  type ActiveWorkspaceSelection,
  type LastWorkspaceSelectionStorage,
} from "./last-workspace-selection";

class DelayedWorkspaceSelectionStorage implements LastWorkspaceSelectionStorage {
  private finishRead: (value: string | null) => void = () => {};
  private readonly pendingRead = new Promise<string | null>((resolve) => {
    this.finishRead = resolve;
  });
  private saved: string | null = null;

  read(): Promise<string | null> {
    return this.pendingRead;
  }

  async write(value: string): Promise<void> {
    this.saved = value;
  }

  async clear(): Promise<void> {
    this.saved = null;
  }

  finishHydrationWith(selection: ActiveWorkspaceSelection | null) {
    this.finishRead(selection ? JSON.stringify(selection) : null);
  }

  getSavedSelection(): ActiveWorkspaceSelection | null {
    if (!this.saved) return null;
    const parsed: unknown = JSON.parse(this.saved);
    if (!parsed || typeof parsed !== "object") return null;
    return this.saved ? JSON.parse(this.saved) : null;
  }
}

describe("last workspace selection", () => {
  it("hydrates the saved workspace selection", async () => {
    const storage = new DelayedWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    const hydration = store.hydrate();

    storage.finishHydrationWith({ serverId: "server-saved", workspaceId: "workspace-saved" });
    await hydration;

    expect(store.getSelection()).toEqual({
      serverId: "server-saved",
      workspaceId: "workspace-saved",
    });
    expect(store.isHydrated()).toBe(true);
  });

  it("keeps a newer workspace selection when storage hydration finishes late", async () => {
    const storage = new DelayedWorkspaceSelectionStorage();
    const store = createLastWorkspaceSelectionStore(storage);
    const hydration = store.hydrate();

    store.remember({ serverId: "server-new", workspaceId: "workspace-new" });
    storage.finishHydrationWith({ serverId: "server-old", workspaceId: "workspace-old" });
    await hydration;

    expect(store.getSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
    expect(storage.getSavedSelection()).toEqual({
      serverId: "server-new",
      workspaceId: "workspace-new",
    });
  });
});

it("persists and restores selected origin independently of a destination and distinguishes authority changes", async () => {
  const storage = new DelayedWorkspaceSelectionStorage();
  const store = createLastWorkspaceSelectionStore(storage);
  store.remember({ serverId: "B", workspaceId: "workspace", authority: { originServerId: "B" } });
  store.remember({ serverId: "B", workspaceId: "workspace", authority: { originServerId: "A" } });
  expect(store.getSelection()).toEqual({
    serverId: "B",
    workspaceId: "workspace",
    authority: { originServerId: "A" },
  });
  const restored = createLastWorkspaceSelectionStore(storage);
  const hydration = restored.hydrate();
  storage.finishHydrationWith(storage.getSavedSelection());
  await hydration;
  expect(restored.getSelection()).toEqual(store.getSelection());
});
