import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { resolveCreateAgentIntent } from "./intent.js";

describe("resolveCreateAgentIntent", () => {
  it("resolves placement without manufacturing relationship membership", async () => {
    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: "workspace-isolated",
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      labels: { purpose: "review" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/isolated" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-isolated",
      cwd: "/isolated",
      labels: {
        purpose: "review",
      },
    });
  });

  it("defaults an agent caller to its workspace without creating one", async () => {
    let createCount = 0;
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => {
        createCount += 1;
        return { workspaceId: "workspace-created", cwd: "/created" };
      },
    });

    expect(intent.workspaceId).toBe("workspace-parent");
    expect(intent.cwd).toBe("/parent");
    expect(createCount).toBe(0);
  });

  it("creates a workspace for a human caller with no workspace context", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: null,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-created",
      cwd: "/created",
      labels: {},
    });
  });

  it("keeps legacy detached creation independent", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      labels: { [PARENT_AGENT_ID_LABEL]: "spoofed-parent" },
      legacyDetached: true,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-parent",
      cwd: "/parent",
      labels: {},
    });
  });
});
