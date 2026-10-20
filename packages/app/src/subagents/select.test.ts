import { managedAgentFields } from "@/subagents/test-fixtures";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSubagentsForParentSelector,
  selectProviderSubagentsForParent,
  selectSubagentsForParent,
} from "./select";
import { membershipFixture, relationshipFixture } from "./test-fixtures";
import { useProviderSubagentStore } from "./provider-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { ManagedSubagents } from "./managed";

const SERVER_ID = "server-1";
const AGENT_TIMESTAMP = new Date("2026-03-08T10:00:00.000Z");
const EMPTY_PENDING_ARCHIVE_IDS = new Set<string>();

it("observes authoritative qualified membership with colliding IDs and retains it through authority withdrawal", async () => {
  const harnessModule = new URL(
    "../../../server/src/server/test-utils/paseo-daemon.ts",
    import.meta.url,
  ).pathname;
  const { createTestPaseoDaemon } = await import(harnessModule);
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const a = await createTestPaseoDaemon();
  const b = await createTestPaseoDaemon();
  const origin = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  const direct = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await Promise.all([origin.connect(), direct.connect()]);
  const paseo = createPaseoApi(origin);
  const destination = createPaseoApi(direct);
  const changed = new Set<() => void>();
  let available = true;
  const originRuntime = paseo.hosts.runtime();
  const model = new ManagedSubagents({
    getClient: (serverId) => (available && serverId === a.daemon.getServerId() ? origin : null),
    getSnapshot: () => ({ connectionStatus: available ? "online" : "offline" }),
    withAgent: async (address, operation) => operation(await originRuntime.agent(address)),
    subscribe: (_serverId, listener) => {
      changed.add(listener);
      return () => {
        changed.delete(listener);
      };
    },
  });
  try {
    const registration = await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await expect.poll(async () => (await paseo.hosts.list()).hosts[0]?.status).toBe("online");
    const parent = await paseo.agents.create({
      cwd: a.staticDir,
      config: { provider: "codex/test" },
    });
    const workspace = await destination.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const collision = crypto.randomUUID();
    const local = await parent.subagents.create({
      agentId: collision,
      config: { provider: "codex/test" },
      idempotencyKey: "local",
    });
    const routed = await parent.subagents.create({
      agentId: collision,
      serverId: b.daemon.getServerId(),
      workspaceId: workspace.id,
      config: { provider: "codex/test" },
      idempotencyKey: "routed",
    });
    const directory = model.directory(parent.address);
    const stopView = directory.subscribe(() => {});
    await expect.poll(() => directory.getSnapshot().status).toBe("current");
    expect(directory.getSnapshot().rows.map((row) => row.child)).toEqual(
      expect.arrayContaining([local.address, routed.address]),
    );
    expect(directory.getSnapshot().rows).toHaveLength(2);
    stopView();
    await parent.subagents.create({
      config: { provider: "codex/test" },
      idempotencyKey: "without-view",
    });
    await expect.poll(() => directory.getSnapshot().rows.length).toBe(3);
    available = false;
    for (const listener of changed) listener();
    expect(directory.getSnapshot()).toMatchObject({ status: "unavailable" });
    expect(directory.getSnapshot().rows).toHaveLength(3);
    expect(directory.getSnapshot().rows.every((row) => row.freshness === "unavailable")).toBe(true);
    expect(direct.getConnectionState().status).toBe("connected");
    await parent.subagents.create({
      config: { provider: "codex/test" },
      idempotencyKey: "while-withdrawn",
    });
    expect(directory.getSnapshot().rows).toHaveLength(3);
    available = true;
    for (const listener of changed) listener();
    await expect.poll(() => directory.getSnapshot().rows.length).toBe(4);
    expect(directory.getSnapshot().status).toBe("current");
    // A managed action resolves its complete address through the parent capability.
    await directory.archive(local.address);
    await expect.poll(async () => (await local.refresh())?.agent.archivedAt).not.toBeNull();
    expect((await routed.refresh())?.agent.archivedAt).toBeNull();
    await paseo.hosts.update(registration.registrationId, { enabled: false });
    await expect(directory.archive(routed.address)).rejects.toBeDefined();
    // The separately connected B remains usable but must never satisfy the A-owned action.
    expect((await destination.agents.ref(collision).refresh())?.agent.archivedAt).toBeNull();
    expect(directory.getSnapshot().archiving.size).toBe(0);
    await model.releaseServer(parent.serverId);
    const released = directory.getSnapshot();
    await parent.subagents.create({
      config: { provider: "codex/test" },
      idempotencyKey: "after-release",
    });
    expect(directory.getSnapshot()).toBe(released);
  } finally {
    await model.releaseServer(a.daemon.getServerId());
    await Promise.allSettled([originRuntime.dispose(), paseo.dispose(), destination.dispose()]);
    await Promise.allSettled([origin.close(), direct.close()]);
    await Promise.allSettled([a.close(), b.close()]);
  }
});

const AGENT_DEFAULTS: Agent = {
  serverId: SERVER_ID,
  id: "agent",
  provider: "codex",
  status: "idle",
  turn: { phase: "idle", cancellationRequestId: null },
  createdAt: AGENT_TIMESTAMP,
  updatedAt: AGENT_TIMESTAMP,
  lastUserMessageAt: null,
  lastActivityAt: AGENT_TIMESTAMP,
  capabilities: {
    supportsStreaming: true,
    supportsSessionPersistence: true,
    supportsDynamicModes: true,
    supportsMcpServers: true,
    supportsReasoningStream: true,
    supportsToolInvocations: true,
  },
  currentModeId: null,
  availableModes: [],
  pendingPermissions: [],
  persistence: null,
  runtimeInfo: undefined,
  lastUsage: undefined,
  lastError: null,
  title: "Agent",
  cwd: "/tmp/project",
  model: null,
  features: undefined,
  thinkingOptionId: undefined,
  requiresAttention: false,
  attentionReason: null,
  attentionTimestamp: null,
  archivedAt: null,
  parent: null,
  managedRelationship: null,
  labels: {},
  projectPlacement: null,
};

function makeAgent(input: Partial<Agent> & Pick<Agent, "id">): Agent {
  return { ...AGENT_DEFAULTS, ...input };
}

function setAgents(agents: Agent[]): void {
  useSessionStore.getState().initializeSession(SERVER_ID, null as unknown as DaemonClient);
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((agent) => [agent.id, agent])));
}

afterEach(() => {
  useSessionStore.getState().clearSession(SERVER_ID);
  useProviderSubagentStore.setState({
    descriptors: new Map(),
    timelines: new Map(),
    hiddenFromTrack: new Set(),
  });
});

describe("selectSubagentsForParent", () => {
  it("hides cached provider children when the host does not support them", () => {
    useProviderSubagentStore.getState().applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: "provider-child",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Provider child",
        description: null,
        subtitle: "Codex worker · 4.2k tokens",
        status: "completed",
        createdAt: "2026-03-08T10:01:00.000Z",
        updatedAt: "2026-03-08T10:02:00.000Z",
        toolCallId: "call-1",
      },
    });
    const params = { serverId: SERVER_ID, parentAgentId: "parent-a" };

    expect(
      selectProviderSubagentsForParent(useProviderSubagentStore.getState(), params, false),
    ).toEqual([]);
    expect(
      selectProviderSubagentsForParent(useProviderSubagentStore.getState(), params, true).map(
        (row) => row.id,
      ),
    ).toEqual(["provider-child"]);
    expect(
      selectProviderSubagentsForParent(useProviderSubagentStore.getState(), params, true)[0]
        ?.subtitle,
    ).toBe("Codex worker · 4.2k tokens");
  });

  it("hides locally dismissed provider children while retaining their descriptor", () => {
    const store = useProviderSubagentStore.getState();
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        id: "provider-child",
        parentAgentId: "parent-a",
        provider: "codex",
        title: "Provider child",
        description: null,
        status: "completed",
        createdAt: "2026-03-08T10:01:00.000Z",
        updatedAt: "2026-03-08T10:02:00.000Z",
        toolCallId: "call-1",
      },
    });
    store.hideFromTrack(SERVER_ID, "parent-a", ["provider-child"]);

    expect(
      selectProviderSubagentsForParent(
        useProviderSubagentStore.getState(),
        { serverId: SERVER_ID, parentAgentId: "parent-a" },
        true,
      ),
    ).toEqual([]);
    expect(useProviderSubagentStore.getState().descriptors.size).toBe(1);
  });

  it("places nested provider children only beneath their direct provider parent", () => {
    const store = useProviderSubagentStore.getState();
    const base = {
      parentAgentId: "parent-a",
      provider: "claude" as const,
      title: "general-purpose",
      subtitle: null,
      status: "running" as const,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
      toolCallId: null,
    };
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: { ...base, id: "direct", description: "Direct", parentSubagentId: null },
    });
    store.applyUpdate(SERVER_ID, {
      kind: "upsert",
      subagent: {
        ...base,
        id: "nested",
        description: "Nested",
        parentSubagentId: "direct",
      },
    });

    expect(
      selectProviderSubagentsForParent(
        useProviderSubagentStore.getState(),
        { serverId: SERVER_ID, parentAgentId: "parent-a" },
        true,
        true,
      ).map((row) => row.id),
    ).toEqual(["direct"]);
    expect(
      selectProviderSubagentsForParent(
        useProviderSubagentStore.getState(),
        {
          serverId: SERVER_ID,
          parentAgentId: "parent-a",
          providerParentSubagentId: "direct",
        },
        true,
        true,
      ).map((row) => row.id),
    ).toEqual(["nested"]);
  });
});

const fixtureParent = { serverId: SERVER_ID, agentId: "parent" };
const authority = { originServerId: SERVER_ID, serverId: SERVER_ID };
function membership(agents: Agent[]) {
  return membershipFixture(
    fixtureParent,
    agents.map((agent) => relationshipFixture(fixtureParent, agent)),
  );
}

describe("authoritative managed row projection", () => {
  it("projects only supplied membership, independently of labels, siblings and grandchildren", () => {
    setAgents([
      makeAgent({
        id: "unrelated",
        ...managedAgentFields({ serverId: SERVER_ID, agentId: "parent" }),
      }),
      makeAgent({
        id: "grandchild",
        ...managedAgentFields({ serverId: SERVER_ID, agentId: "child" }),
      }),
    ]);
    const state = membership([
      makeAgent({
        id: "child",
        ...managedAgentFields({ serverId: SERVER_ID, agentId: "untrusted-other-fixtureParent" }),
      }),
    ]);
    const rows = selectSubagentsForParent(state, authority, EMPTY_PENDING_ARCHIVE_IDS);
    expect(rows.map((row) => row.address)).toEqual([{ serverId: SERVER_ID, agentId: "child" }]);
    expect(selectSubagentsForParent(membership([]), authority, EMPTY_PENDING_ARCHIVE_IDS)).toEqual(
      [],
    );
  });

  it("removes confirmed terminal membership but retains creating and pending rows", () => {
    const phases = [
      "attached",
      "creating",
      "detach_pending",
      "lifecycle_pending",
      "detached",
      "archived",
      "forgotten",
      "canceled",
    ] as const;
    const state = membershipFixture(
      fixtureParent,
      phases.map((phase) =>
        relationshipFixture(fixtureParent, makeAgent({ id: phase }), { phase }),
      ),
    );
    expect(
      selectSubagentsForParent(state, authority, EMPTY_PENDING_ARCHIVE_IDS).map((row) => row.phase),
    ).toEqual(["attached", "creating", "detach_pending", "lifecycle_pending"]);
  });

  it("sorts by creation time and preserves ordinary presentation fields without exposing raw agent data", () => {
    const earlier = makeAgent({
      id: "first",
      title: "Review child",
      provider: "claude",
      status: "running",
      requiresAttention: true,
      createdAt: new Date("2026-03-08T09:00:00Z"),
    });
    const rows = selectSubagentsForParent(
      membership([makeAgent({ id: "second" }), earlier]),
      authority,
      EMPTY_PENDING_ARCHIVE_IDS,
    );
    expect(rows.map((row) => row.address.agentId)).toEqual(["first", "second"]);
    expect(rows[0]).toMatchObject({
      title: "Review child",
      provider: "claude",
      status: "running",
      requiresAttention: true,
      createdAt: earlier.createdAt,
      authority,
    });
    expect(rows[0]).not.toHaveProperty("onOpen");
    expect(rows[0]).not.toHaveProperty("cwd");
    expect(rows[0]).not.toHaveProperty("model");
  });

  it("keeps colliding IDs distinct and hides only the qualified pending archive", () => {
    const rows = selectSubagentsForParent(
      membership([makeAgent({ id: "same" }), makeAgent({ serverId: "server-2", id: "same" })]),
      authority,
      new Set([JSON.stringify([SERVER_ID, "same"])]),
    );
    expect(rows.map((row) => row.address)).toEqual([{ serverId: "server-2", agentId: "same" }]);
    expect(rows[0]?.authority).toEqual({ originServerId: SERVER_ID, serverId: "server-2" });
  });

  it("retains unavailable membership with its last snapshot and unresolved membership without a fabricated status", () => {
    const state = membershipFixture(fixtureParent, [
      relationshipFixture(fixtureParent, makeAgent({ id: "stale", status: "running" }), {
        freshness: "unavailable",
        error: { code: "host_offline", message: "Host unavailable" },
      }),
      relationshipFixture(fixtureParent, makeAgent({ id: "creating" }), {
        phase: "creating",
        snapshot: undefined,
        freshness: "unavailable",
      }),
    ]);
    const rows = selectSubagentsForParent(state, authority, EMPTY_PENDING_ARCHIVE_IDS);
    expect(rows.find((row) => row.address.agentId === "stale")).toMatchObject({
      status: "running",
      freshness: "unavailable",
      error: { code: "host_offline" },
    });
    expect(rows.find((row) => row.address.agentId === "creating")).toMatchObject({
      status: null,
      turn: null,
      createdAt: null,
      phase: "creating",
    });
  });
});

describe("createSubagentsForParentSelector", () => {
  it("retains row identity across 100 unrelated transcript commits without reading the session agent map", () => {
    setAgents([makeAgent({ id: "parent" })]);
    const state = membership([makeAgent({ id: "child" })]);
    const select = createSubagentsForParentSelector(authority, EMPTY_PENDING_ARCHIVE_IDS);
    const before = select(state);
    for (let tick = 0; tick < 100; tick++) {
      useSessionStore.getState().setAgentStreamState(SERVER_ID, "parent", {
        head: [
          {
            kind: "assistant_message",
            id: "message",
            text: `token ${tick}`,
            timestamp: AGENT_TIMESTAMP,
          },
        ],
      });
      expect(select(state)).toBe(before);
    }
    expect(before.map((row) => row.address.agentId)).toEqual(["child"]);
  });
  it("recomputes changed membership and preserves equal projections after a refreshed snapshot", () => {
    const select = createSubagentsForParentSelector(authority, EMPTY_PENDING_ARCHIVE_IDS);
    const state = membership([makeAgent({ id: "first" })]);
    const before = select(state);
    expect(select({ ...state })).toBe(before);
    const after = select(membership([makeAgent({ id: "first" }), makeAgent({ id: "second" })]));
    expect(after).not.toBe(before);
    expect(after.map((row) => row.address.agentId)).toEqual(["first", "second"]);
  });
  it("applies captured qualified archive keys, including hiding the last child", () => {
    const select = createSubagentsForParentSelector(
      authority,
      new Set([JSON.stringify([SERVER_ID, "child"])]),
    );
    expect(select(membership([makeAgent({ id: "child" })]))).toEqual([]);
  });
});

it("resolves child actions through the owning app runtime after initial failure and blocks disposed callers", async () => {
  const harnessModule = new URL(
    "../../../server/src/server/test-utils/paseo-daemon.ts",
    import.meta.url,
  ).pathname;
  const { createTestPaseoDaemon } = await import(harnessModule);
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const { acquireHostConnection } = await import("@getpaseo/client/internal/host-connection");
  const { HostRuntimeStore } = await import("@/runtime/host-runtime");
  const { createSessionStore } = await import("@/stores/session-store");
  const { indexedDB, IDBKeyRange } = await import("fake-indexeddb");
  globalThis.indexedDB = indexedDB;
  globalThis.IDBKeyRange = IDBKeyRange;
  const daemons = await Promise.all([
    createTestPaseoDaemon(),
    createTestPaseoDaemon(),
    createTestPaseoDaemon(),
  ]);
  const [a, b, c] = daemons;
  const clients = daemons.map((daemon) =>
    createHostClient(`127.0.0.1:${daemon.port}`, {
      clientId: crypto.randomUUID(),
      reconnect: { enabled: false },
    }),
  );
  await Promise.all(clients.map((client) => client.connect()));
  const [origin, parentApi, destination] = clients.map((client) => createPaseoApi(client));
  const storage = new Map<string, string>();
  let failC = true;
  let acquisitions = 0;
  const registry = new HostRuntimeStore({
    sessionStore: createSessionStore(),
    storage: {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
      removeItem: async (key) => {
        storage.delete(key);
      },
    },
    resolveHostConnection: async (source, serverId, signal) => {
      acquisitions++;
      expect(source).toBe(clients[0]);
      if (serverId === c.daemon.getServerId() && failC)
        throw new Error("Initial C acquisition unavailable");
      return acquireHostConnection(source, serverId, signal);
    },
  });
  const leases: Array<import("@/runtime/host-runtime").OwnedHostAuthorityBinding> = [];
  try {
    const [, cRegistration] = await Promise.all([
      origin!.hosts.add({ connection: `127.0.0.1:${b.port}` }),
      origin!.hosts.add({ connection: `127.0.0.1:${c.port}` }),
      parentApi!.hosts.add({ connection: `127.0.0.1:${c.port}` }),
    ]);
    await expect
      .poll(async () =>
        (await origin!.hosts.list()).hosts.every((host) => host.status === "online"),
      )
      .toBe(true);
    await expect.poll(async () => (await parentApi!.hosts.list()).hosts[0]?.status).toBe("online");
    const parent = await parentApi!.agents.create({
      cwd: b.staticDir,
      config: { provider: "codex/test" },
    });
    const workspace = await destination!.workspaces.create({
      source: { kind: "directory", path: c.staticDir },
    });
    const child = await parent.subagents.create({
      serverId: c.daemon.getServerId(),
      workspaceId: workspace.id,
      config: { provider: "codex/test" },
      idempotencyKey: "bound-parent-child",
    });
    await registry.upsertDirectConnection({
      serverId: a.daemon.getServerId(),
      endpoint: `127.0.0.1:${a.port}`,
      existingClient: clients[0],
    });
    await expect
      .poll(() => registry.getSnapshot(a.daemon.getServerId())?.connectionStatus)
      .toBe("online");
    const retainedC = registry.acquireBinding({
      originServerId: a.daemon.getServerId(),
      serverId: c.daemon.getServerId(),
    });
    leases.push(retainedC);
    await expect(retainedC.binding.ready).rejects.toThrow("Initial C acquisition unavailable");
    failC = false;
    await origin!.hosts.update(cRegistration!.registrationId, {
      metadata: { revision: "recovered" },
    });
    await expect
      .poll(() => retainedC.binding.runtime.getSnapshot(c.daemon.getServerId())?.connectionStatus)
      .toBe("online");
    const boundParent = registry.acquireBinding({
      originServerId: a.daemon.getServerId(),
      serverId: b.daemon.getServerId(),
    });
    leases.push(boundParent);
    await boundParent.binding.ready;
    const directory = boundParent.binding.runtime.subagents.directory(parent.address);
    directory.subscribe(() => {});
    await expect.poll(() => directory.getSnapshot().rows.length).toBe(1);
    await directory.archive(child.address);
    expect((await child.refresh())?.agent.archivedAt).not.toBeNull();
    const captured = boundParent.binding.runtime.withAgent.bind(boundParent.binding.runtime);
    await boundParent.release();
    const beforeDisposedCall = acquisitions;
    await expect(captured(child.address, (agent) => agent.refresh())).rejects.toThrow("disposed");
    expect(acquisitions).toBe(beforeDisposedCall);
    const direct = registry.acquireBinding({
      originServerId: a.daemon.getServerId(),
      serverId: a.daemon.getServerId(),
    });
    leases.push(direct);
    await direct.binding.ready;
    expect(
      await direct.binding.runtime.withAgent(child.address, async (agent) => agent.address),
    ).toEqual(child.address);
  } finally {
    await Promise.allSettled(leases.map((lease) => lease.release()));
    registry.syncHosts([]);
    await Promise.allSettled([origin, parentApi, destination].map((api) => api!.dispose()));
    await Promise.allSettled(clients.map((client) => client.close()));
    await Promise.allSettled(daemons.map((daemon) => daemon.close()));
  }
}, 60000);
