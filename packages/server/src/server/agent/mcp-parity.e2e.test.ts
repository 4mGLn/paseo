import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { experimental_createMCPClient } from "ai";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

import { AGENT_WAIT_TIMEOUT_MS } from "./mcp-shared.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { AgentClient, AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { parseAgentMessage } from "./agent-messages/index.js";

interface StructuredContent {
  [key: string]: unknown;
}

interface McpToolResult {
  structuredContent?: StructuredContent;
  content?: Array<{ structuredContent?: StructuredContent } | StructuredContent>;
  isError?: boolean;
}

interface McpClient {
  callTool: (input: { name: string; args?: StructuredContent }) => Promise<McpToolResult>;
  close: () => Promise<void>;
}

function str(val: unknown): string {
  return z.string().parse(val);
}

function recordArr(val: unknown): StructuredContent[] {
  return z.array(z.record(z.string(), z.unknown())).parse(val);
}

function expectAgentFeatureValue(snapshot: StructuredContent, featureId: string, value: unknown) {
  expect(recordArr(snapshot.features)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: featureId,
        value,
      }),
    ]),
  );
}

function strArrOptional(val: unknown): string[] | undefined {
  return z.array(z.string()).optional().parse(val);
}

function formatHostForHttpUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function buildExpectedAgentMcpUrl(params: { host: string; port: number; agentId: string }): string {
  const baseUrl = new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(params.host)}:${params.port}`,
  );
  baseUrl.searchParams.set("callerAgentId", params.agentId);
  return baseUrl.toString();
}

function getStructuredContent(result: McpToolResult): StructuredContent | null {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const content = result.content?.[0];
  if (content && typeof content === "object" && "structuredContent" in content) {
    if (content.structuredContent) {
      return content.structuredContent;
    }
  }
  if (content && typeof content === "object") {
    return content;
  }
  return null;
}

async function createMcpClient(url: string): Promise<McpClient> {
  const transport = new StreamableHTTPClientTransport(new URL(url));
  const rawClient = await experimental_createMCPClient({ transport });
  const boundCallTool: McpClient["callTool"] = Reflect.get(rawClient, "callTool").bind(rawClient);
  return { callTool: boundCallTool, close: () => rawClient.close() };
}

async function callToolStructured(
  client: McpClient,
  name: string,
  args?: StructuredContent,
): Promise<StructuredContent> {
  const result = await client.callTool({ name, args: args ?? {} });
  const payload = getStructuredContent(result);
  if (!payload) {
    throw new Error(`${name} returned no structured payload`);
  }
  return payload;
}

async function expectToolError(
  client: McpClient,
  name: string,
  args: StructuredContent,
  pattern: RegExp,
): Promise<void> {
  const result = await client.callTool({ name, args });
  expect(result.isError).toBe(true);
  const contentItem = result.content?.[0];
  const contentText: string | undefined =
    contentItem != null && typeof contentItem === "object"
      ? Reflect.get(contentItem, "text")
      : undefined;
  expect(contentText ?? "").toMatch(pattern);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(options: {
  timeoutMs: number;
  intervalMs?: number;
  check: () => Promise<T | null> | T | null;
  label: string;
}): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < options.timeoutMs) {
    const result = await options.check();
    if (result !== null) {
      return result;
    }
    await sleep(options.intervalMs ?? 50);
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for ${options.label}`);
}

let tempRoot: string;
let daemonHandle: TestPaseoDaemon;
let topLevelClient: McpClient;
let agentScopedClient: McpClient;
let parentAgentId: string;
let parentAgentCwd: string;
let worktreeRepoCwd: string;
let launchConfigsByProvider: Record<AgentProvider, AgentSessionConfig[]>;

const seededAgentProfile = {
  id: "ui-profile",
  name: "UI work",
  provider: "claude",
  model: "claude-test-model",
  modeId: "bypassPermissions",
  notes: "Use for UI work: components, layout, design tokens. Not for backend.",
};

function createRecordingAgentClients(): Record<AgentProvider, AgentClient> {
  const baseClients = createTestAgentClients({
    beforeSetFeature: async (featureId) => {
      if (featureId !== "test_feature") throw new Error(`Unsupported feature: ${featureId}`);
    },
  });
  launchConfigsByProvider = {};
  const wrappedClients: Record<AgentProvider, AgentClient> = {};

  for (const [provider, client] of Object.entries(baseClients)) {
    const launchConfigs: AgentSessionConfig[] = [];
    launchConfigsByProvider[provider] = launchConfigs;
    const wrappedClient: AgentClient = {
      provider: client.provider,
      capabilities: client.capabilities,
      createSession: async (config, launchContext, options) => {
        launchConfigs.push(config);
        return await client.createSession(config, launchContext, options);
      },
      resumeSession: async (handle, overrides, launchContext) =>
        await client.resumeSession(handle, overrides, launchContext),
      fetchCatalog: async (options) => await client.fetchCatalog(options),
      isAvailable: async () => await client.isAvailable(),
    };
    if (client.resolveCreateConfig) {
      wrappedClient.resolveCreateConfig = (input) => client.resolveCreateConfig!(input);
    }
    if (client.isCreateConfigUnattended) {
      wrappedClient.isCreateConfigUnattended = (input) => client.isCreateConfigUnattended!(input);
    }
    if (client.listCommands) {
      wrappedClient.listCommands = async (config) => await client.listCommands!(config);
    }
    if (client.listFeatures) {
      wrappedClient.listFeatures = async (config) => await client.listFeatures!(config);
    }
    if (client.listImportableSessions) {
      wrappedClient.listImportableSessions = async (options) =>
        await client.listImportableSessions!(options);
    }
    if (client.importSession) {
      wrappedClient.importSession = async (input, context) =>
        await client.importSession!(input, context);
    }
    wrappedClients[provider] = wrappedClient;
  }

  return wrappedClients;
}

async function makeCwd(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tempRoot, `${prefix}-`));
}

async function createTopLevelAgent(args?: Partial<StructuredContent>): Promise<string> {
  const cwd = typeof args?.cwd === "string" ? args.cwd : await makeCwd("agent-cwd");
  const { cwd: _cwd, ...rest } = args ?? {};
  const payload = await callToolStructured(topLevelClient, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: cwd } },
    title: "Parity agent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
    ...rest,
  });
  return str(payload.agentId);
}

async function createChildAgent(args?: Partial<StructuredContent>): Promise<string> {
  const payload = await callToolStructured(agentScopedClient, "create_agent", {
    relationship: { kind: "subagent" },
    workspace: { kind: "current" },
    title: "Parity child",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    notifyOnFinish: false,
    ...args,
  });
  return str(payload.agentId);
}

async function archiveAgentIfPresent(agentId: string | null | undefined): Promise<void> {
  if (!agentId) {
    return;
  }
  try {
    await topLevelClient.callTool({ name: "archive_agent", args: { agentId } });
  } catch {
    // ignore cleanup errors
  }
}

async function deleteScheduleIfPresent(id: string | null | undefined): Promise<void> {
  if (!id) {
    return;
  }
  try {
    await topLevelClient.callTool({ name: "delete_schedule", args: { id } });
  } catch {
    // ignore cleanup errors
  }
}

async function killTerminalIfPresent(terminalId: string | null | undefined): Promise<void> {
  if (!terminalId) {
    return;
  }
  try {
    await agentScopedClient.callTool({ name: "kill_terminal", args: { terminalId } });
  } catch {
    // ignore cleanup errors
  }
}

beforeAll(async () => {
  tempRoot = await mkdtemp(path.join(os.tmpdir(), "mcp-parity-e2e-"));
  parentAgentCwd = await makeCwd("parent-agent-cwd");
  worktreeRepoCwd = await makeCwd("worktree-repo");

  daemonHandle = await createTestPaseoDaemon({
    agentClients: createRecordingAgentClients(),
    agentProfiles: [seededAgentProfile],
  });
  topLevelClient = await createMcpClient(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`);

  const parentPayload = await callToolStructured(topLevelClient, "create_agent", {
    relationship: { kind: "detached" },
    workspace: { kind: "create", source: { kind: "directory", path: parentAgentCwd } },
    title: "MCP parity parent",
    provider: "claude/claude-test-model",
    initialPrompt: "say done and stop",
    settings: { modeId: "bypassPermissions" },
  });
  parentAgentId = str(parentPayload.agentId);

  agentScopedClient = await createMcpClient(
    `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${parentAgentId}`,
  );

  execSync("git init -b main", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git config user.email 'test@example.com'", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git config user.name 'Test User'", { cwd: worktreeRepoCwd, stdio: "pipe" });
  await writeFile(path.join(worktreeRepoCwd, "README.md"), "# repo\n", "utf8");
  execSync("git add README.md", { cwd: worktreeRepoCwd, stdio: "pipe" });
  execSync("git -c commit.gpgsign=false commit -m 'init'", {
    cwd: worktreeRepoCwd,
    stdio: "pipe",
  });
}, 30_000);

afterAll(async () => {
  await archiveAgentIfPresent(parentAgentId);
  await agentScopedClient?.close();
  await topLevelClient?.close();
  await daemonHandle?.close();
  await rm(tempRoot, { recursive: true, force: true });
});

test("agent MCP delegates to self and selected host and receives qualified run completion", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const parentPrompts: string[] = [];
  const a = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn(prompt, config) {
        if (config.title === "Fleet MCP parent" && typeof prompt === "string")
          parentPrompts.push(prompt);
      },
    }),
  });
  const b = await createTestPaseoDaemon();
  const client = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  const api = createPaseoApi(client);
  let scoped: McpClient | undefined;
  try {
    const parent = await api.agents.create({
      cwd: a.staticDir,
      config: { provider: "claude/claude-test-model" },
      title: "Fleet MCP parent",
    });
    const registration = await api.hosts.add({
      connection: `127.0.0.1:${b.port}`,
      label: "Worker B",
    });
    await expect
      .poll(
        async () =>
          (await api.hosts.list()).hosts.find(
            (host) => host.registrationId === registration.registrationId,
          )?.status,
      )
      .toBe("online");
    scoped = await createMcpClient(
      buildExpectedAgentMcpUrl({ host: "127.0.0.1", port: a.port, agentId: parent.id }),
    );
    const hosts = await callToolStructured(scoped, "list_hosts");
    expect(hosts).toMatchObject({
      self: { serverId: a.daemon.getServerId() },
      hosts: expect.arrayContaining([
        expect.objectContaining({ serverId: b.daemon.getServerId() }),
      ]),
    });
    const serverId = b.daemon.getServerId();
    const workspace = await callToolStructured(scoped, "create_workspace", {
      serverId,
      isolation: "local",
      path: b.staticDir,
    });
    expect(await callToolStructured(scoped, "list_workspaces", { serverId })).toMatchObject({
      serverId,
      workspaces: expect.arrayContaining([
        expect.objectContaining({ workspaceId: workspace.workspaceId }),
      ]),
    });
    const children: StructuredContent[] = [];
    for (const destination of [
      { serverId: a.daemon.getServerId() },
      { serverId, workspaceId: workspace.workspaceId },
    ]) {
      const child = await callToolStructured(scoped, "create_agent", {
        ...destination,
        title: "Fleet MCP child",
        provider: "claude/claude-test-model",
        initialPrompt: "Finish delegated fleet work",
      });
      expect(child).toMatchObject({
        serverId: destination.serverId,
        submissionId: expect.any(String),
      });
      children.push(child);
      expect(
        await callToolStructured(scoped, "get_agent_status", {
          serverId: destination.serverId,
          agentId: child.agentId,
        }),
      ).toMatchObject({ serverId: destination.serverId });
      expect(
        await callToolStructured(scoped, "get_agent_activity", {
          serverId: destination.serverId,
          agentId: child.agentId,
        }),
      ).toMatchObject({ serverId: destination.serverId, content: expect.any(String) });
      expect(
        await callToolStructured(scoped, "list_agents", { serverId: destination.serverId }),
      ).toMatchObject({
        serverId: destination.serverId,
        agents: expect.arrayContaining([expect.objectContaining({ id: child.agentId })]),
      });
    }
    expect((await parent.subagents.list()).rows.map((row) => row.child)).toEqual(
      expect.arrayContaining(
        children.map((child) => ({ serverId: child.serverId, agentId: child.agentId })),
      ),
    );
    await expect.poll(() => parentPrompts.length).toBe(2);
    for (const child of children) {
      const notification = parentPrompts
        .map((text) => parseAgentMessage(text))
        .find((message) => message?.source?.serverId === child.serverId);
      expect(notification?.source).toMatchObject({
        kind: "agent-notification",
        serverId: child.serverId,
        agentId: child.agentId,
        event: "finished",
      });
      expect(notification?.text).toContain(str(child.submissionId));
      expect(notification?.text).toContain("checkpoint");
    }
  } finally {
    await scoped?.close();
    await api.dispose();
    await client.close();
    await a.close();
    await b.close();
  }
});

test("fleet MCP rejects missing destination placement and disabled or offline hosts without local effects", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const b = await createTestPaseoDaemon();
  const sourceClient = createHostClient(`127.0.0.1:${daemonHandle.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  const targetClient = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await Promise.all([sourceClient.connect(), targetClient.connect()]);
  const source = createPaseoApi(sourceClient);
  const target = createPaseoApi(targetClient);
  try {
    const registration = await source.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await expect
      .poll(
        async () =>
          (await source.hosts.list()).hosts.find(
            (host) => host.registrationId === registration.registrationId,
          )?.status,
      )
      .toBe("online");
    const serverId = b.daemon.getServerId();
    const workspace = await callToolStructured(agentScopedClient, "create_workspace", {
      serverId,
      isolation: "local",
      path: b.staticDir,
    });
    const input = {
      serverId,
      workspaceId: workspace.workspaceId,
      title: "Must not fall back",
      provider: "claude/claude-test-model",
      initialPrompt: "Never execute rejected work",
    };
    const counts = async () => [
      (await source.agents.list()).entries.length,
      (await target.agents.list()).entries.length,
    ];
    const before = await counts();
    const noWorkspace = await agentScopedClient.callTool({
      name: "create_agent",
      args: { ...input, workspaceId: undefined },
    });
    expect(noWorkspace).toMatchObject({
      isError: true,
      structuredContent: { serverId, code: "workspace_required" },
    });
    await expectToolError(
      agentScopedClient,
      "create_agent",
      { ...input, provider: undefined },
      /provider/,
    );
    expect(await counts()).toEqual(before);
    const unparented = await callToolStructured(topLevelClient, "create_agent", {
      ...input,
      title: "Top level fleet root",
    });
    const snapshot = (await target.agents.ref(str(unparented.agentId)).refresh())?.agent;
    expect(snapshot?.parent ?? null).toBeNull();
    expect(snapshot?.managedRelationship).toBeNull();
    await source.hosts.update(registration.registrationId, { enabled: false });
    expect(await agentScopedClient.callTool({ name: "create_agent", args: input })).toMatchObject({
      isError: true,
      structuredContent: { serverId, code: "host_disabled" },
    });
    expect(await counts()).toEqual([before[0], before[1]! + 1]);
    await source.hosts.update(registration.registrationId, { enabled: true });
    await expect
      .poll(
        async () =>
          (await source.hosts.list()).hosts.find(
            (host) => host.registrationId === registration.registrationId,
          )?.status,
      )
      .toBe("online");
    await b.close();
    await expect
      .poll(
        async () =>
          (await source.hosts.list()).hosts.find(
            (host) => host.registrationId === registration.registrationId,
          )?.status,
      )
      .not.toBe("online");
    expect(await agentScopedClient.callTool({ name: "create_agent", args: input })).toMatchObject({
      isError: true,
      structuredContent: { serverId },
    });
    expect((await source.agents.list()).entries.length).toBe(before[0]);
  } finally {
    await source.dispose();
    await target.dispose();
    await sourceClient.close();
    await targetClient.close();
    await b.close();
  }
});

test("agent MCP tool policy rejects fleet creation before effects", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const a = await createTestPaseoDaemon({
    providerOverrides: {
      codex: { paseoTools: { disabledTools: ["create_agent", "create_workspace"] } },
    },
  });
  const b = await createTestPaseoDaemon();
  const client = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  const source = createPaseoApi(client);
  let restricted: McpClient | undefined;
  try {
    const parent = await source.agents.create({
      cwd: a.staticDir,
      title: "Restricted caller",
      config: { provider: "codex/gpt-5.4" },
    });
    await source.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await expect.poll(async () => (await source.hosts.list()).hosts[0]?.status).toBe("online");
    restricted = await createMcpClient(
      buildExpectedAgentMcpUrl({ host: "127.0.0.1", port: a.port, agentId: parent.id }),
    );
    await expectToolError(
      restricted,
      "create_workspace",
      { serverId: b.daemon.getServerId(), isolation: "local", path: b.staticDir },
      /not found|unknown/i,
    );
    await expectToolError(
      restricted,
      "create_agent",
      {
        serverId: b.daemon.getServerId(),
        workspaceId: "not-authority",
        title: "Denied child",
        provider: "claude/claude-test-model",
        initialPrompt: "Must not execute",
      },
      /not found|unknown/i,
    );
    // The voice caller context is an injected public tool-host seam; the
    // actual MCP server and target daemon remain ordinary real dependencies.
    const { createAgentMcpServer } = await import("./mcp-server.js");
    const { ProviderSnapshotManager } = await import("./provider-snapshot-manager.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { default: pino } = await import("pino");
    const logger = pino({ level: "silent" });
    const runtime = source.hosts.runtime();
    const server = await createAgentMcpServer({
      agentManager: a.daemon.agentManager,
      agentStorage: a.daemon.agentStorage,
      providerSnapshotManager: new ProviderSnapshotManager({
        logger,
        extraClients: createTestAgentClients(),
      }),
      callerAgentId: parent.id,
      resolveCallerContext: () => ({ lockedCwd: a.staticDir, allowCustomCwd: false }),
      hostRuntime: async () => runtime,
      logger,
    });
    const locked = new Client({ name: "locked-workspace-caller", version: "1.0.0" });
    const [callerTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), locked.connect(callerTransport)]);
      expect(
        await locked.callTool({
          name: "create_agent",
          arguments: {
            serverId: b.daemon.getServerId(),
            workspaceId: "must-not-resolve",
            title: "Denied placement",
            provider: "claude/claude-test-model",
            initialPrompt: "Must not execute",
          },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { serverId: b.daemon.getServerId(), code: "access_denied" },
      });
      expect(
        await locked.callTool({
          name: "create_workspace",
          arguments: { serverId: b.daemon.getServerId(), isolation: "local", path: b.staticDir },
        }),
      ).toMatchObject({
        isError: true,
        structuredContent: { serverId: b.daemon.getServerId(), code: "access_denied" },
      });
    } finally {
      await locked.close();
      await server.close();
      await runtime.dispose();
    }
    expect((await parent.subagents.list()).rows).toEqual([]);
    expect(await b.daemon.agentStorage.list()).toEqual([]);
  } finally {
    await restricted?.close();
    await source.dispose();
    await client.close();
    await a.close();
    await b.close();
  }
});

test("MCP-created managed child belongs to the parent ledger and archives with its parent", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const client = createHostClient(`127.0.0.1:${daemonHandle.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  const api = createPaseoApi(client);
  const archived: string[] = [];
  const releaseArchived = daemonHandle.daemon.agentManager.onAgentArchived((id) => {
    archived.push(id);
  });
  let scoped: McpClient | undefined;
  try {
    const parentId = await createTopLevelAgent({ title: "Ledger MCP parent" });
    scoped = await createMcpClient(
      buildExpectedAgentMcpUrl({ host: "127.0.0.1", port: daemonHandle.port, agentId: parentId }),
    );
    const child = await callToolStructured(scoped, "create_agent", {
      title: "Ledger MCP child",
      provider: "claude/claude-test-model",
      initialPrompt: "Finish the delegated task",
      notifyOnFinish: false,
    });
    const childId = str(child.agentId);
    expect((await api.agents.ref(parentId).subagents.list()).rows).toEqual([
      expect.objectContaining({
        child: { serverId: daemonHandle.daemon.getServerId(), agentId: childId },
      }),
    ]);
    const childStates: string[] = [];
    const releaseStates = daemonHandle.daemon.agentManager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === childId)
          childStates.push(event.agent.lifecycle);
      },
      { agentId: childId, replayState: false },
    );
    try {
      await callToolStructured(topLevelClient, "archive_agent", { agentId: parentId });
      await expect
        .poll(async () => (await api.agents.ref(childId).refresh())?.agent.archivedAt)
        .toBeTruthy();
      expect(archived.filter((id) => id === parentId || id === childId).sort()).toEqual(
        [parentId, childId].sort(),
      );
      expect(childStates).toContain("closed");
      expect(daemonHandle.daemon.agentManager.getAgent(childId)).toBeNull();
    } finally {
      releaseStates();
    }
  } finally {
    releaseArchived();
    await scoped?.close();
    await api.dispose();
    await client.close();
  }
});

describe("Suite A: Core Fixes", () => {
  test.each([
    ["Stop", "cancelAgent"],
    ["Reload", "refreshAgent"],
  ] as const)(
    "%s tells the parent that a watched child was canceled",
    async (_action, method) => {
      let releaseChild!: () => void;
      let childReachedGate!: () => void;
      const heldTurn = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      const childAtGate = new Promise<void>((resolve) => {
        childReachedGate = resolve;
      });
      const parentPrompts: string[] = [];
      const daemon = await createTestPaseoDaemon({
        agentClients: createTestAgentClients({
          onStartTurn(prompt, config) {
            if (config.title === "Watching parent" && typeof prompt === "string")
              parentPrompts.push(prompt);
          },
          async beforeTurnComplete(prompt) {
            if (
              typeof prompt === "string" &&
              parseAgentMessage(prompt).text === "Hold this child turn"
            ) {
              childReachedGate();
              await heldTurn;
            }
          },
        }),
      });
      const client = new DaemonClient({
        url: `ws://127.0.0.1:${daemon.port}/ws`,
        appVersion: "0.11.2",
      });
      let mcp: McpClient | undefined;
      let unsubscribe: (() => void) | undefined;
      try {
        await client.connect();
        await client.fetchAgents({ subscribe: {} });
        const parent = await client.createAgent({
          provider: "claude",
          cwd: daemon.paseoHome,
          title: "Watching parent",
          modeId: "bypassPermissions",
        });
        mcp = await createMcpClient(
          buildExpectedAgentMcpUrl({ host: "127.0.0.1", port: daemon.port, agentId: parent.id }),
        );
        const created = await callToolStructured(mcp, "create_agent", {
          relationship: { kind: "subagent" },
          workspace: { kind: "current" },
          title: "Watched child",
          provider: "codex/gpt-5.4",
          initialPrompt: "Hold this child turn",
          notifyOnFinish: true,
          settings: { modeId: "full-access" },
        });
        const childId = str(created.agentId);
        await childAtGate;
        expect(daemon.daemon.agentManager.getAgent(childId)?.lifecycle).toBe("running");
        const terminalEvents: string[] = [];
        unsubscribe = daemon.daemon.agentManager.subscribe(
          (event) => {
            if (
              event.type === "agent_stream" &&
              event.agentId === childId &&
              (event.event.type === "turn_completed" || event.event.type === "turn_canceled")
            )
              terminalEvents.push(event.event.type);
          },
          { agentId: childId, replayState: false },
        );

        await client[method](childId);
        await waitFor({
          timeoutMs: 10000,
          label: "parent cancellation notification",
          check: () => (parentPrompts.length === 1 ? true : null),
        });
        const notification = parseAgentMessage(parentPrompts[0]);
        expect(terminalEvents).toEqual(["turn_canceled"]);
        expect(notification.source).toEqual({
          kind: "agent-notification",
          serverId: client.getLastServerInfoMessage()!.serverId,
          agentId: childId,
          title: "Watched child",
          event: "errored",
        });
        expect(notification.text).toContain(`Agent ${childId} (Watched child) was canceled.`);
        expect(notification.text).not.toContain("finished.");
        await waitFor({
          timeoutMs: 10000,
          label: "parent notification turn drained",
          check: () =>
            daemon.daemon.agentManager.getAgent(parent.id)?.lifecycle === "idle" ? true : null,
        });
        expect(parentPrompts).toHaveLength(1);
      } finally {
        releaseChild();
        unsubscribe?.();
        await mcp?.close();
        await client.close();
        await daemon.close();
      }
    },
    30000,
  );

  test.each([
    { outcome: "finished", prompt: "say done and stop", status: "idle" },
    { outcome: "errored", prompt: "Emit a turn failure", status: "error" },
  ])(
    "a watched child still reports $outcome after send_agent_prompt",
    async ({ outcome, prompt, status }) => {
      const childId = await createChildAgent({
        title: "Follow-up child",
        settings: { modeId: "bypassPermissions" },
      });
      try {
        await waitFor({
          timeoutMs: 10000,
          label: "initial child turn completed",
          check: () =>
            daemonHandle.daemon.agentManager.getAgent(childId)?.lifecycle === "idle" ? true : null,
        });
        await callToolStructured(agentScopedClient, "send_agent_prompt", {
          agentId: childId,
          prompt,
          notifyOnFinish: true,
        });
        const notifications = await waitFor({
          timeoutMs: 10000,
          label: `${outcome} notification`,
          check: () => {
            const items = daemonHandle.daemon.agentManager
              .getTimeline(parentAgentId)
              .filter(
                (item) => item.type === "tool_call" && item.agentMessage?.sender.id === childId,
              );
            return items.length > 0 ? items : null;
          },
        });
        expect(notifications).toEqual([
          expect.objectContaining({
            type: "tool_call",
            agentMessage: {
              event: outcome,
              sender: { id: childId, title: "Follow-up child" },
              text: expect.stringContaining(`(Follow-up child) ${outcome}.`),
            },
          }),
        ]);
        expect(daemonHandle.daemon.agentManager.getAgent(childId)?.lifecycle).toBe(status);
      } finally {
        await archiveAgentIfPresent(childId);
      }
    },
    30000,
  );

  test("AGENT_WAIT_TIMEOUT_MS is 30000", () => {
    expect(AGENT_WAIT_TIMEOUT_MS).toBe(30_000);
  });

  test("create_agent with callerAgentId sets the parent agent label", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent();
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels).toMatchObject({
        [PARENT_AGENT_ID_LABEL]: parentAgentId,
      });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent with detached relationship omits the parent agent label", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent({ relationship: { kind: "detached" } });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels?.[PARENT_AGENT_ID_LABEL]).toBeUndefined();
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("agentManager.createAgent injects paseo MCP using the daemon listen target", async () => {
    let agentId: string | null = null;
    try {
      const listenTarget = daemonHandle.daemon.getListenTarget();
      expect(listenTarget?.type).toBe("tcp");
      const cwd = await makeCwd("manager-direct-agent-cwd");

      const snapshot = await daemonHandle.daemon.agentManager.createAgent(
        {
          provider: "claude",
          cwd,
          title: "Manager direct parity agent",
          modeId: "bypassPermissions",
        },
        undefined,
        { workspaceId: undefined },
      );
      agentId = snapshot.id;

      const expectedUrl = buildExpectedAgentMcpUrl({
        host: listenTarget!.host,
        port: listenTarget!.port,
        agentId,
      });

      const launchConfig = launchConfigsByProvider.claude
        ?.toReversed()
        .find((config) => config.cwd === cwd);
      expect(launchConfig?.mcpServers).toMatchObject({
        paseo: {
          type: "http",
          url: expectedUrl,
        },
      });
      expect(snapshot.config.mcpServers?.paseo).toBeUndefined();

      const liveAgent = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(liveAgent?.config.mcpServers?.paseo).toBeUndefined();
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent accepts provider/model syntax", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ provider: "claude/claude-test-model" });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.config.model).toBe("claude-test-model");
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("create_agent accepts provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ settings: { features: { test_feature: true } } });
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("agent-scoped create_agent accepts provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createChildAgent({
        provider: "claude/claude-test-model",
        settings: { features: { test_feature: true } },
      });
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("update_agent updates provider features over MCP", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ settings: { features: { test_feature: false } } });
      const updated = await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        settings: { features: { test_feature: true } },
      });
      expect(updated.success).toBe(true);
      const internalSnapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(internalSnapshot?.config.featureValues).toEqual({ test_feature: true });

      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      const snapshot = z.record(z.string(), z.unknown()).parse(status.snapshot);
      expectAgentFeatureValue(snapshot, "test_feature", true);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("MCP settings failure preserves metadata and no-op update preserves the full snapshot", async () => {
    const agentId = await createTopLevelAgent();
    try {
      await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        name: "Configured metadata",
        labels: { role: "worker" },
        settings: {
          modeId: "default",
          model: "claude-test-model",
          features: { test_feature: true },
        },
      });
      const before = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      expect(before.snapshot).toMatchObject({
        id: agentId,
        title: "Configured metadata",
        model: "claude-test-model",
        currentModeId: "default",
        labels: { role: "worker" },
        capabilities: expect.any(Object),
        availableModes: expect.any(Array),
        pendingPermissions: [],
        runtimeInfo: expect.any(Object),
        persistence: expect.any(Object),
      });
      expectAgentFeatureValue(
        z.record(z.string(), z.unknown()).parse(before.snapshot),
        "test_feature",
        true,
      );
      expect(await callToolStructured(topLevelClient, "update_agent", { agentId })).toMatchObject({
        success: true,
      });
      expect(
        (await callToolStructured(topLevelClient, "get_agent_status", { agentId })).snapshot,
      ).toEqual(before.snapshot);
      await expectToolError(
        topLevelClient,
        "update_agent",
        {
          agentId,
          name: "Must not persist",
          labels: { role: "changed" },
          settings: { features: { unsupported_feature: true } },
        },
        /feature/i,
      );
      expect(
        (await callToolStructured(topLevelClient, "get_agent_status", { agentId })).snapshot,
      ).toEqual(before.snapshot);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("MCP reads archived history and hides internal stored agents", async () => {
    const agentId = await createTopLevelAgent();
    await callToolStructured(topLevelClient, "archive_agent", { agentId });
    expect(await callToolStructured(topLevelClient, "get_agent_status", { agentId })).toMatchObject(
      {
        status: "closed",
        snapshot: { id: agentId, archivedAt: expect.any(String) },
      },
    );
    const now = new Date().toISOString();
    const internalId = crypto.randomUUID();
    await daemonHandle.daemon.agentStorage.upsert({
      id: internalId,
      internal: true,
      provider: "claude",
      cwd: parentAgentCwd,
      createdAt: now,
      updatedAt: now,
      labels: {},
      lastStatus: "closed",
      title: "Internal history",
    });
    await expectToolError(
      topLevelClient,
      "get_agent_status",
      { agentId: internalId },
      /not found/i,
    );
  });

  test("inspect_provider returns draft provider features over MCP", async () => {
    const payload = await callToolStructured(topLevelClient, "inspect_provider", {
      provider: "claude",
      cwd: parentAgentCwd,
      settings: {
        model: "claude-test-model",
        features: { test_feature: true },
      },
    });

    expect(payload.provider).toBe("claude");
    expect(payload.selectedModel).toBe("claude-test-model");
    expect(recordArr(payload.features)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "toggle",
          id: "test_feature",
          value: true,
        }),
      ]),
    );
  });

  test("create_agent accepts labels param", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent({ labels: { team: "infra" } });
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(snapshot?.labels).toMatchObject({ team: "infra" });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("archive_agent archives an agent", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent();
      const archivedAgentId = agentId;
      await callToolStructured(topLevelClient, "archive_agent", { agentId });
      agentId = null;

      const agents = daemonHandle.daemon.agentManager.listAgents();
      expect(agents.some((agent) => agent.id === archivedAgentId)).toBe(false);
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });

  test("update_agent updates name and labels", async () => {
    let agentId: string | null = null;
    try {
      agentId = await createTopLevelAgent();
      await callToolStructured(topLevelClient, "update_agent", {
        agentId,
        name: "Renamed parity agent",
        labels: { team: "infra", surface: "mcp" },
      });

      const stored = await daemonHandle.daemon.agentStorage.get(agentId);
      const snapshot = daemonHandle.daemon.agentManager.getAgent(agentId);
      expect(stored?.title).toBe("Renamed parity agent");
      expect(snapshot?.labels).toMatchObject({
        team: "infra",
        surface: "mcp",
      });
    } finally {
      await archiveAgentIfPresent(agentId);
    }
  });
});

describe("Suite B: Terminal Tools", () => {
  test("create_terminal and list_terminals", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity terminal",
      });
      terminalId = str(created.id);

      const listed = await callToolStructured(agentScopedClient, "list_terminals");
      const terminals = recordArr(listed.terminals);
      expect(terminals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: terminalId,
            name: "Parity terminal",
            cwd: parentAgentCwd,
          }),
        ]),
      );
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("send_terminal_keys and capture_terminal", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity capture terminal",
      });
      terminalId = str(created.id);

      await callToolStructured(agentScopedClient, "send_terminal_keys", {
        terminalId,
        keys: "echo hello\r",
        literal: true,
      });
      await sleep(500);

      const captured = await waitFor({
        timeoutMs: 10_000,
        intervalMs: 100,
        label: "terminal output to contain hello",
        check: async () => {
          const payload = await callToolStructured(agentScopedClient, "capture_terminal", {
            terminalId,
            scrollback: true,
          });
          const lines = strArrOptional(payload.lines) ?? [];
          return lines.some((line) => line.includes("hello")) ? payload : null;
        },
      });

      expect(captured.lines).toEqual(expect.arrayContaining([expect.stringContaining("hello")]));
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("kill_terminal removes terminal", async () => {
    let terminalId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_terminal", {
        name: "Parity kill terminal",
      });
      terminalId = str(created.id);

      await callToolStructured(agentScopedClient, "kill_terminal", { terminalId });
      terminalId = null;

      const listed = await waitFor({
        timeoutMs: 5_000,
        intervalMs: 100,
        label: "terminal removal",
        check: async () => {
          const payload = await callToolStructured(agentScopedClient, "list_terminals");
          const terminals = recordArr(payload.terminals);
          return terminals.some((terminal) => terminal.id === created.id) ? null : payload;
        },
      });
      const terminals = recordArr(listed.terminals);
      expect(terminals.some((terminal) => terminal.id === created.id)).toBe(false);
    } finally {
      await killTerminalIfPresent(terminalId);
    }
  });

  test("kill_terminal with invalid id throws", async () => {
    await expectToolError(
      agentScopedClient,
      "kill_terminal",
      { terminalId: "missing-terminal-id" },
      /not found/i,
    );
  });
});

describe("Suite C: Schedule Tools", () => {
  test("create_schedule and list_schedules", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity schedule list",
        provider: "claude",
      });
      scheduleId = str(created.id);

      const listed = await callToolStructured(topLevelClient, "list_schedules");
      const schedules = recordArr(listed.schedules);
      expect(schedules).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: scheduleId,
            name: "Parity schedule list",
          }),
        ]),
      );
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_schedule accepts provider/model syntax", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity provider schedule",
        provider: "codex/gpt-5.4",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "new-agent",
        config: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("inspect_schedule returns details", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity inspect schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      const inspected = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(inspected).toMatchObject({
        id: scheduleId,
        name: "Parity inspect schedule",
        prompt: "say hello",
        status: "active",
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("pause and resume schedule", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity pause schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      await callToolStructured(topLevelClient, "pause_schedule", { id: scheduleId });
      const paused = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(paused.status).toBe("paused");

      await callToolStructured(topLevelClient, "resume_schedule", { id: scheduleId });
      const resumed = await callToolStructured(topLevelClient, "inspect_schedule", {
        id: scheduleId,
      });
      expect(resumed.status).toBe("active");
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("delete_schedule removes schedule", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(topLevelClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity delete schedule",
        provider: "claude",
      });
      scheduleId = str(created.id);

      await callToolStructured(topLevelClient, "delete_schedule", { id: scheduleId });
      scheduleId = null;

      const listed = await callToolStructured(topLevelClient, "list_schedules");
      const schedules = recordArr(listed.schedules);
      expect(schedules.some((schedule) => schedule.id === created.id)).toBe(false);
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_heartbeat targets the scoped agent", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_heartbeat", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        name: "Parity heartbeat",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "agent",
        agentId: parentAgentId,
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_schedule on agent MCP accepts provider/model override for new-agent", async () => {
    let scheduleId: string | null = null;
    try {
      const created = await callToolStructured(agentScopedClient, "create_schedule", {
        prompt: "say hello",
        cron: "*/5 * * * *",
        provider: "codex/gpt-5.4",
      });
      scheduleId = str(created.id);
      expect(created.target).toMatchObject({
        type: "new-agent",
        config: {
          provider: "codex",
          model: "gpt-5.4",
        },
      });
    } finally {
      await deleteScheduleIfPresent(scheduleId);
    }
  });

  test("create_heartbeat without callerAgentId throws", async () => {
    await expectToolError(
      topLevelClient,
      "create_heartbeat",
      {
        prompt: "say hello",
        cron: "*/5 * * * *",
      },
      /requires an agent-scoped session/i,
    );
  });
});

describe("Suite D: Provider Tools", () => {
  test("list_providers returns providers", async () => {
    const payload = await callToolStructured(topLevelClient, "list_providers");
    const providers = recordArr(payload.providers);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0]).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
        modes: expect.any(Array),
      }),
    );
  });

  test("list_models returns models for provider", async () => {
    const payload = await callToolStructured(topLevelClient, "list_models", {
      provider: "claude",
    });
    expect(payload.provider).toBe("claude");
    expect(Array.isArray(payload.models)).toBe(true);
  });

  test("list_profiles returns configured agent profiles, including notes", async () => {
    const payload = await callToolStructured(topLevelClient, "list_profiles");
    const profiles = recordArr(payload.profiles);
    expect(profiles).toEqual([seededAgentProfile]);
  });
});

describe("Suite E: Workspace Tools", () => {
  test("background worktree creation, discovery and archive use ordinary workspace ownership", async () => {
    const created = await callToolStructured(topLevelClient, "create_workspace", {
      isolation: "worktree",
      path: worktreeRepoCwd,
      baseBranch: "main",
      branchName: `parity-background-${Date.now()}`,
      background: true,
    });
    const workspaceId = str(created.workspaceId);
    try {
      expect(created.background).toBe(true);
      const ordinary = await callToolStructured(topLevelClient, "list_workspaces", {});
      expect(
        recordArr(ordinary.workspaces).map((workspace) => workspace.workspaceId),
      ).not.toContain(workspaceId);
      const inclusive = await callToolStructured(topLevelClient, "list_workspaces", {
        includeBackground: true,
      });
      expect(recordArr(inclusive.workspaces)).toContainEqual(
        expect.objectContaining({ workspaceId, background: true }),
      );
      const child = await callToolStructured(topLevelClient, "create_agent", {
        workspaceId,
        title: "Background worker",
        provider: "claude/claude-test-model",
        initialPrompt: "Say done.",
      });
      const agentId = str(child.agentId);
      const workerClient = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${agentId}`,
      );
      let terminalId: string;
      try {
        const terminal = await callToolStructured(workerClient, "create_terminal", {
          name: "Background terminal",
        });
        terminalId = str(terminal.id);
        expect(terminal.cwd).toBe(created.cwd);
      } finally {
        await workerClient.close();
      }
      const status = await callToolStructured(topLevelClient, "get_agent_status", { agentId });
      expect((status.snapshot as StructuredContent).workspaceId).toBe(workspaceId);
      const archived = await callToolStructured(topLevelClient, "archive_workspace", {
        workspaceId,
      });
      expect(archived.archivedAgentIds).toContain(agentId);
      const terminals = await callToolStructured(topLevelClient, "list_terminals", { all: true });
      expect(recordArr(terminals.terminals).map((terminal) => terminal.id)).not.toContain(
        terminalId,
      );
      const remaining = await callToolStructured(topLevelClient, "list_workspaces", {
        includeBackground: true,
      });
      expect(
        recordArr(remaining.workspaces).map((workspace) => workspace.workspaceId),
      ).not.toContain(workspaceId);
    } finally {
      await topLevelClient
        .callTool({ name: "archive_workspace", args: { workspaceId } })
        .catch(() => undefined);
    }
  });

  test("agent-scoped workspace creation inherits visibility and permits an explicit false override", async () => {
    const parentWorkspace = await callToolStructured(topLevelClient, "create_workspace", {
      isolation: "local",
      path: worktreeRepoCwd,
      background: true,
    });
    const parentWorkspaceId = str(parentWorkspace.workspaceId);
    let scoped: McpClient | null = null;
    const ownedWorkspaces: string[] = [parentWorkspaceId];
    try {
      const parent = await callToolStructured(topLevelClient, "create_agent", {
        workspaceId: parentWorkspaceId,
        title: "Background parent",
        provider: "claude/claude-test-model",
        initialPrompt: "Say done.",
      });
      scoped = await createMcpClient(
        `http://127.0.0.1:${daemonHandle.port}/mcp/agents?callerAgentId=${str(parent.agentId)}`,
      );
      const inherited = await callToolStructured(scoped, "create_workspace", {
        isolation: "local",
      });
      ownedWorkspaces.push(str(inherited.workspaceId));
      expect(inherited.background).toBe(true);
      const visible = await callToolStructured(scoped, "create_workspace", {
        isolation: "local",
        background: false,
      });
      ownedWorkspaces.push(str(visible.workspaceId));
      expect(visible.background).toBe(false);
    } finally {
      await scoped?.close();
      for (const workspaceId of ownedWorkspaces.toReversed())
        await topLevelClient
          .callTool({ name: "archive_workspace", args: { workspaceId } })
          .catch(() => undefined);
    }
  });
});

test("MCP qualified control addresses the selected daemon with colliding agent IDs through one SDK workflow", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const b = await createTestPaseoDaemon();
  const sourceClient = createHostClient(`127.0.0.1:${daemonHandle.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  const targetClient = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await Promise.all([sourceClient.connect(), targetClient.connect()]);
  const source = createPaseoApi(sourceClient);
  const target = createPaseoApi(targetClient);
  try {
    const agentId = crypto.randomUUID();
    await source.agents.create({
      agentId,
      cwd: daemonHandle.staticDir,
      title: "Origin identity",
      config: { provider: "claude/claude-test-model" },
    });
    await target.agents.create({
      agentId,
      cwd: b.staticDir,
      title: "Destination identity",
      config: { provider: "claude/claude-test-model" },
    });
    const registration = await source.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await expect.poll(async () => (await source.hosts.list()).hosts[0]?.status).toBe("online");
    const serverId = b.daemon.getServerId();
    const status = await callToolStructured(topLevelClient, "get_agent_status", {
      serverId,
      agentId,
    });
    expect(status).toMatchObject({
      serverId,
      snapshot: { id: agentId, title: "Destination identity" },
    });
    await callToolStructured(topLevelClient, "update_agent", {
      serverId,
      agentId,
      name: "Changed through selected host",
    });
    await callToolStructured(topLevelClient, "set_agent_mode", {
      serverId,
      agentId,
      modeId: "default",
    });
    expect((await target.agents.ref(agentId).refresh())?.agent).toMatchObject({
      title: "Changed through selected host",
      currentModeId: "default",
    });
    expect((await source.agents.ref(agentId).refresh())?.agent.title).toBe("Origin identity");
    expect(
      await callToolStructured(topLevelClient, "cancel_agent", { serverId, agentId }),
    ).toMatchObject({ serverId, success: false });
    expect(
      await callToolStructured(topLevelClient, "kill_agent", { serverId, agentId }),
    ).toMatchObject({ serverId, success: true });
    expect(await target.agents.ref(agentId).refresh()).not.toBeNull();
    expect((await source.agents.ref(agentId).refresh())?.agent.title).toBe("Origin identity");
    expect(await callToolStructured(topLevelClient, "get_agent_status", { agentId })).toMatchObject(
      { serverId: daemonHandle.daemon.getServerId(), snapshot: { title: "Origin identity" } },
    );
    await source.hosts.update(registration.registrationId, { enabled: false });
    const failure = await topLevelClient.callTool({
      name: "get_agent_status",
      args: { serverId, agentId },
    });
    expect(failure.isError).toBe(true);
    expect(getStructuredContent(failure)).toMatchObject({
      serverId,
      code: "host_disabled",
      error: expect.any(String),
    });
  } finally {
    await Promise.allSettled([source.dispose(), target.dispose()]);
    await Promise.allSettled([sourceClient.close(), targetClient.close()]);
    await b.close();
  }
});

test("MCP preserves selected destination and unknown submitted-action outcome at the client response", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let closes = 0;
  const b = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      closeSession: async () => {
        closes++;
        reached();
        await gate;
      },
    }),
  });
  const sourceClient = createHostClient(`127.0.0.1:${daemonHandle.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  const targetClient = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await Promise.all([sourceClient.connect(), targetClient.connect()]);
  const source = createPaseoApi(sourceClient);
  const target = createPaseoApi(targetClient);
  try {
    const agent = await target.agents.create({
      cwd: b.staticDir,
      title: "Uncertain close",
      config: { provider: "codex/test" },
    });
    const registration = await source.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await expect
      .poll(
        async () =>
          (await source.hosts.list()).hosts.find(
            (host) => host.registrationId === registration.registrationId,
          )?.status,
      )
      .toBe("online");
    const closing = topLevelClient.callTool({
      name: "kill_agent",
      args: { serverId: agent.serverId, agentId: agent.id },
    });
    void closing.catch(() => {});
    await ready;
    await source.hosts.update(registration.registrationId, { enabled: false });
    const failure = await closing;
    expect(failure.isError).toBe(true);
    expect(getStructuredContent(failure)).toMatchObject({
      serverId: agent.serverId,
      code: "DAEMON_CONNECTION_LOST",
      outcome: "unknown",
    });
    release();
    await expect.poll(async () => (await agent.refresh())?.agent.status).toBe("closed");
    expect(closes).toBe(1);
  } finally {
    release();
    await Promise.allSettled([source.dispose(), target.dispose()]);
    await Promise.allSettled([sourceClient.close(), targetClient.close()]);
    await b.close();
  }
});

test("MCP provider discovery uses the selected host profiles and models", async () => {
  const { createHostClient } = await import("@getpaseo/client/node");
  const { createPaseoApi } = await import("@getpaseo/client");
  const profile = { ...seededAgentProfile, id: "destination-profile", name: "Destination work" };
  const b = await createTestPaseoDaemon({ agentProfiles: [profile] });
  const client = createHostClient(`127.0.0.1:${daemonHandle.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  const source = createPaseoApi(client);
  try {
    const registration = await source.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await expect
      .poll(
        async () =>
          (await source.hosts.list()).hosts.find(
            (host) => host.registrationId === registration.registrationId,
          )?.status,
      )
      .toBe("online");
    const serverId = b.daemon.getServerId();
    expect(await callToolStructured(topLevelClient, "list_profiles", { serverId })).toMatchObject({
      serverId,
      profiles: [profile],
    });
    expect(await callToolStructured(topLevelClient, "list_providers", { serverId })).toMatchObject({
      serverId,
      providers: expect.arrayContaining([expect.objectContaining({ id: "codex" })]),
    });
    expect(
      await callToolStructured(topLevelClient, "list_models", { serverId, provider: "codex" }),
    ).toMatchObject({ serverId, provider: "codex", models: expect.any(Array) });
    const inspected = await callToolStructured(topLevelClient, "inspect_provider", {
      serverId,
      provider: "codex",
      cwd: b.staticDir,
    });
    expect(inspected.error).toBeUndefined();
    expect(inspected).toMatchObject({
      serverId,
      provider: "codex",
      enabled: true,
      features: expect.any(Array),
    });
  } finally {
    await source.dispose();
    await client.close();
    await b.close();
  }
});

test("real MCP discovery preserves custom catalog modes, disabled-provider isolation, and draft settings", async () => {
  const clients = createTestAgentClients();
  const base = clients.codex!;
  let disabledAvailabilityChecks = 0;
  let disabledCatalogFetches = 0;
  const drafts: AgentSessionConfig[] = [];
  const dynamicModes = [{ id: "dynamic", label: "Dynamic", description: "Runtime mode" }];
  const custom: AgentClient = {
    ...base,
    provider: "zai",
    capabilities: base.capabilities,
    createSession: (...args) => base.createSession(...args),
    resumeSession: (...args) => base.resumeSession(...args),
    isAvailable: async () => true,
    fetchCatalog: async () => ({
      models: [{ provider: "zai", id: "custom-model", label: "Custom model", isDefault: true }],
      modes: dynamicModes,
    }),
    listFeatures: async (config) => {
      drafts.push(config);
      return [
        {
          type: "toggle",
          id: "fast_mode",
          label: "Fast mode",
          value: config.featureValues?.fast_mode === true,
        },
      ];
    },
  };
  const disabled: AgentClient = {
    ...base,
    provider: "codex",
    capabilities: base.capabilities,
    createSession: (...args) => base.createSession(...args),
    resumeSession: (...args) => base.resumeSession(...args),
    isAvailable: async () => {
      disabledAvailabilityChecks++;
      return true;
    },
    fetchCatalog: async (options) => {
      disabledCatalogFetches++;
      return base.fetchCatalog(options);
    },
  };
  const destination = await createTestPaseoDaemon({
    agentClients: { ...clients, codex: disabled, zai: custom },
    providerOverrides: {
      codex: { enabled: false },
      zai: { extends: "codex", label: "ZAI", enabled: true },
    },
    agentProfiles: [],
  });
  const mcp = await createMcpClient(`http://127.0.0.1:${destination.port}/mcp/agents`);
  try {
    const response = await mcp.callTool({ name: "list_providers", args: {} });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const providers = recordArr(getStructuredContent(response)?.providers);
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "zai",
          label: "ZAI",
          enabled: true,
          status: "available",
          modes: dynamicModes,
        }),
        expect.objectContaining({ id: "codex", enabled: false, status: "unavailable", modes: [] }),
      ]),
    );
    const modelText =
      response.content?.map((item) => Reflect.get(item, "text") ?? "").join("\n") ?? "";
    expect(modelText).toContain(`providers_count=${providers.length}`);
    expect(modelText).toContain(
      `providers_ids=${providers.map((provider) => provider.id).join(",")}`,
    );
    expect(modelText).toContain('"providers"');
    expect(await callToolStructured(mcp, "list_profiles")).toMatchObject({ profiles: [] });
    await expectToolError(mcp, "list_models", { provider: "codex" }, /disabled/i);
    await expectToolError(
      mcp,
      "inspect_provider",
      { provider: "codex", cwd: destination.staticDir },
      /disabled/i,
    );
    expect(disabledAvailabilityChecks).toBe(0);
    expect(disabledCatalogFetches).toBe(0);
    const inspected = await callToolStructured(mcp, "inspect_provider", {
      provider: "zai/custom-model",
      cwd: destination.staticDir,
      settings: { modeId: "dynamic", thinkingOptionId: "high", features: { fast_mode: true } },
    });
    expect(inspected).toMatchObject({
      provider: "zai",
      label: "ZAI",
      selectedModel: "custom-model",
      modes: dynamicModes,
      features: [{ type: "toggle", id: "fast_mode", label: "Fast mode", value: true }],
    });
    expect(drafts).toContainEqual(
      expect.objectContaining({
        provider: "zai",
        cwd: destination.staticDir,
        model: "custom-model",
        modeId: "dynamic",
        thinkingOptionId: "high",
        featureValues: { fast_mode: true },
      }),
    );
  } finally {
    await mcp.close();
    await destination.close();
  }
});

test("real MCP without configured profiles returns an empty list", async () => {
  const destination = await createTestPaseoDaemon();
  const mcp = await createMcpClient(`http://127.0.0.1:${destination.port}/mcp/agents`);
  try {
    expect(await callToolStructured(mcp, "list_profiles")).toMatchObject({ profiles: [] });
  } finally {
    await mcp.close();
    await destination.close();
  }
});
