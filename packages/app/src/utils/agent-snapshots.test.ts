import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { normalizeAgentSnapshot, projectAgentSnapshot } from "./agent-snapshots";

function createSnapshot(
  input: Partial<Omit<AgentSnapshotPayload, "labels">> & {
    labels?: Record<string, unknown>;
  } = {},
): AgentSnapshotPayload {
  return {
    id: input.id ?? "agent-1",
    parent: input.parent,
    managedRelationship: input.managedRelationship,
    provider: input.provider ?? "codex",
    cwd: input.cwd ?? "/repo",
    model: input.model ?? null,
    createdAt: input.createdAt ?? "2026-04-20T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-04-20T00:01:00.000Z",
    lastUserMessageAt: input.lastUserMessageAt ?? null,
    status: input.status ?? "idle",
    activeTurn: input.activeTurn,
    capabilities: input.capabilities ?? {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: input.currentModeId ?? null,
    availableModes: input.availableModes ?? [],
    pendingPermissions: input.pendingPermissions ?? [],
    persistence: input.persistence ?? null,
    title: input.title ?? null,
    labels: (input.labels ?? {}) as AgentSnapshotPayload["labels"],
  };
}

describe("normalizeAgentSnapshot", () => {
  it("round-trips identified active turns through the canonical snapshot boundary", () => {
    const snapshot = createSnapshot({
      status: "running",
      activeTurn: { turnId: "turn-1", startedAt: "2026-07-31T12:00:00.000Z" },
    });

    expect(projectAgentSnapshot(normalizeAgentSnapshot(snapshot, "server-1"))).toMatchObject({
      status: "running",
      activeTurn: snapshot.activeTurn,
    });
  });

  it("normalizes identified and legacy active turns at the snapshot boundary", () => {
    const startedAt = "2026-07-31T12:00:00.000Z";
    expect(
      normalizeAgentSnapshot(
        createSnapshot({
          status: "running",
          activeTurn: { turnId: "turn-1", startedAt },
        }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: "turn-1",
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });

    expect(
      normalizeAgentSnapshot(
        createSnapshot({ status: "running", lastUserMessageAt: startedAt }),
        "server-1",
      ).turn,
    ).toEqual({
      phase: "open",
      turnId: null,
      startedAt: new Date(startedAt),
      cancellationRequestId: null,
    });
  });

  it("normalizes legacy parent identity from the parent label while preserving labels", () => {
    const labels = {
      [PARENT_AGENT_ID_LABEL]: "parent-1",
      "custom.label": "still-here",
    };

    const agent = normalizeAgentSnapshot(createSnapshot({ labels }), "server-1", { features: {} });

    expect(agent.parent).toEqual({ serverId: "server-1", agentId: "parent-1" });
    expect(agent.labels).toEqual(labels);
  });

  it("trims whitespace around the parent label", () => {
    const agent = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "  parent-1 \n" } }),
      "server-1",
      { features: {} },
    );

    expect(agent.parent).toEqual({ serverId: "server-1", agentId: "parent-1" });
  });

  it("maps missing, empty, and non-string parent labels to null", () => {
    const missing = normalizeAgentSnapshot(createSnapshot(), "server-1", { features: {} });
    const empty = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: "   " } }),
      "server-1",
      { features: {} },
    );
    const nonString = normalizeAgentSnapshot(
      createSnapshot({ labels: { [PARENT_AGENT_ID_LABEL]: 42 } }),
      "server-1",
      { features: {} },
    );

    expect(missing.parent).toBeNull();
    expect(empty.parent).toBeNull();
    expect(nonString.parent).toBeNull();
  });
});

it("capable snapshots never acquire membership from a parent pointer or injected label", () => {
  for (const parent of [
    { serverId: "server-1", agentId: "parent" },
    { serverId: "other", agentId: "parent" },
  ]) {
    const normalized = normalizeAgentSnapshot(
      createSnapshot({ parent, labels: { [PARENT_AGENT_ID_LABEL]: "parent" } }),
      "server-1",
      { features: { fleetSubagents: true } },
    );
    expect(normalized.parent).toEqual(parent);
    expect(normalized.managedRelationship).toBeNull();
    expect(projectAgentSnapshot(normalized)).toMatchObject({ parent, managedRelationship: null });
  }
});
it("round trips owner membership and explicit clearing without consulting labels", () => {
  const managedRelationship = {
    id: "relationship",
    parent: { serverId: "A", agentId: "parent" },
    parentWorkspace: { serverId: "A", workspaceId: "same-workspace" },
  };
  const input = createSnapshot({ parent: managedRelationship.parent, managedRelationship });
  expect(projectAgentSnapshot(normalizeAgentSnapshot(input, "A"))).toMatchObject({
    managedRelationship,
  });
  expect(
    projectAgentSnapshot(normalizeAgentSnapshot({ ...input, managedRelationship: null }, "A")),
  ).toMatchObject({ managedRelationship: null });
});
