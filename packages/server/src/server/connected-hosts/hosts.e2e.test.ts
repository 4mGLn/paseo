import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
import { afterEach, expect, test } from "vitest";
import { createPaseoApi, HostRuntime } from "@getpaseo/client";
import { createHostClient, createHostChannelTransport } from "@getpaseo/client/node";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import type { HostDirectory } from "@getpaseo/protocol/hosts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function daemon(): Promise<TestPaseoDaemon> {
  const instance = await createTestPaseoDaemon();
  cleanup.push(() => instance.close());
  return instance;
}
async function api(instance: TestPaseoDaemon) {
  const client = createHostClient(`127.0.0.1:${instance.port}`, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  await client.connect();
  expect(client.getLastServerInfoMessage()).toMatchObject({ sourceId: "owner" });
  expect(client.getLastServerInfoMessage()).not.toHaveProperty("principalId");
  const paseo = createPaseoApi(client);
  cleanup.push(async () => {
    await paseo.dispose();
    await client.close();
  });
  return { paseo, client };
}
async function online(paseo: ReturnType<typeof createPaseoApi>): Promise<HostDirectory> {
  let directory!: HostDirectory;
  await expect
    .poll(
      async () => {
        directory = await paseo.hosts.list();
        return directory.hosts[0]?.status;
      },
      { timeout: 15000 },
    )
    .toBe("online");
  return directory;
}

test("SDK saves unreachable hosts, rejects syntax and preserves source identity without exposing secrets", async () => {
  const a = await daemon();
  const { paseo } = await api(a);
  await expect(paseo.hosts.add({ connection: "ssh://-bad" })).rejects.toMatchObject({
    code: "invalid_connection",
  });
  for (const connection of [
    "alice:example-secret@localhost:6767",
    "not-a-scheme://localhost:6767",
    "localhost/path:6767",
  ]) {
    const failure = await paseo.hosts.add({ connection }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "invalid_connection" });
    expect(String(failure)).not.toContain("example-secret");
    expect((await paseo.hosts.list()).hosts).toEqual([]);
  }
  const saved = await paseo.hosts.add({
    connection: "tcp://127.0.0.1:1?password=private-secret",
    label: "Unavailable",
    metadata: { team: "infra" },
    sourceKey: "stable",
  });
  expect(saved).toMatchObject({
    registrationId: expect.stringMatching(/^hst_/),
    serverId: null,
    label: "Unavailable",
    source: { id: "owner", key: "stable" },
    metadata: { team: "infra" },
    enabled: true,
  });
  expect(JSON.stringify(await paseo.hosts.list())).not.toContain("private-secret");
  await paseo.hosts.update(saved.registrationId, { enabled: false });
  expect(
    await paseo.hosts.add({
      connection: "tcp://127.0.0.1:1?password=private-secret",
      label: "Unavailable",
      metadata: { team: "infra" },
      sourceKey: "stable",
    }),
  ).toMatchObject({ registrationId: saved.registrationId, enabled: false, status: "disabled" });
  await expect(
    paseo.hosts.add({ connection: "127.0.0.1:2", sourceKey: "stable" }),
  ).rejects.toMatchObject({ code: "source_conflict" });
  await paseo.hosts.remove(saved.registrationId);
  expect((await paseo.hosts.list()).hosts).toEqual([]);
});

test("ordinary routed APIs isolate scopes and enforce one-hop, disable and origin disposal", async () => {
  const b = await daemon();
  const wire = await hostWire(b);
  const a = await daemon();
  const { paseo } = await api(a);
  const observation = paseo.hosts.observe();
  expect((await observation.ready).hosts).toEqual([]);
  const saved = await paseo.hosts.add({ connection: wire.connection, label: "B" });
  const directory = await online(paseo);
  const serverId = directory.hosts[0]!.serverId!;
  const first = await paseo.hosts.client(serverId);
  const second = await paseo.hosts.client(serverId);
  expect(wire.connections()).toBe(1);
  expect(wire.active()).toBe(1);
  const workspaces = await second.workspaces.list({ subscribe: {} });
  expect(workspaces.entries).toEqual([]);
  await first.dispose();
  expect(wire.active()).toBe(1);
  expect((await second.workspaces.list()).entries).toEqual([]);
  await expect(second.hosts.client(directory.self.serverId)).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  await paseo.hosts.update(saved.registrationId, { enabled: false });
  await expect(paseo.hosts.client(serverId)).rejects.toMatchObject({ code: "host_disabled" });
  await paseo.hosts.update(saved.registrationId, { enabled: true });
  await online(paseo);
  await expect
    .poll(
      async () => {
        try {
          return (await second.workspaces.list()).entries.length;
        } catch {
          return -1;
        }
      },
      { timeout: 20000 },
    )
    .toBe(0);
  expect(wire.connections()).toBe(2);
  expect(wire.active()).toBe(1);
  await second.dispose();
  expect(wire.active()).toBe(1);
  await observation.release();
  await paseo.dispose();
});

test("routed authority is bounded by the caller, with isolated simultaneous sessions", async () => {
  const b = await daemon();
  const a = await daemon();
  const owner = await api(a);
  await owner.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const directory = await online(owner.paseo);
  const serverId = directory.hosts[0]!.serverId!;
  const viewerClient = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: "overlapping",
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  await viewerClient.connect();
  const viewer = createPaseoApi(viewerClient);
  cleanup.push(async () => {
    await viewer.dispose();
    await viewerClient.close();
  });
  const remote = await viewer.hosts.client(serverId);
  expect((await remote.workspaces.list()).entries).toEqual([]);
  await expect(
    remote.workspaces.create({ source: { kind: "directory", path: b.paseoHome } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  await expect(viewer.hosts.add({ connection: "127.0.0.1:1" })).rejects.toMatchObject({
    code: "permission_denied",
  });
  expect((await owner.paseo.hosts.list()).hosts).toHaveLength(1);
  await remote.dispose();
});

test("SDK host clients preserve ordinary permission RPC errors", async () => {
  const b = await daemon();
  const a = await daemon();
  const owner = await api(a);
  await owner.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(owner.paseo)).hosts[0]!.serverId!;
  const clients = [a, b].map((host) =>
    createHostClient(`127.0.0.1:${host.port}`, {
      clientId: crypto.randomUUID(),
      sessionPermissions: ["daemon.read", "workspace.read"],
      reconnect: { enabled: false },
    }),
  );
  for (const client of clients) {
    cleanup.push(() => client.close());
    await client.connect();
  }
  const origin = createPaseoApi(clients[0]!);
  const direct = createPaseoApi(clients[1]!);
  const remote = await origin.hosts.client(serverId);
  cleanup.push(async () => {
    await remote.dispose();
    await direct.dispose();
    await origin.dispose();
  });
  const input = { source: { kind: "directory" as const, path: b.staticDir } };
  const directError = (await direct.workspaces.create(input).catch((error: unknown) => error)) as {
    code: string;
  };
  const remoteError = (await remote.workspaces.create(input).catch((error: unknown) => error)) as {
    code: string;
  };
  expect(directError.code).toBe("access_denied");
  expect(remoteError.code).toBe(directError.code);
});

test("distinct origin sessions cannot collide through a caller-selected route scope, including terminal binary output", async () => {
  const b = await daemon();
  const wire = await hostWire(b);
  const a = await daemon();
  const admin = await api(a);
  await admin.paseo.hosts.add({ connection: wire.connection });
  const serverId = (await online(admin.paseo)).hosts[0]!.serverId!;
  const remote = await admin.paseo.hosts.client(serverId);
  const workspace = await remote.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const one = await workspace.terminals.create({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
    name: "First",
  });
  const two = await workspace.terminals.create({
    command: process.execPath,
    args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
    name: "Second",
  });
  const firstOrigin = await api(a);
  const secondOrigin = await api(a);
  const first = await RoutePeer.open(firstOrigin.client, serverId);
  const second = await RoutePeer.open(secondOrigin.client, serverId);
  await first.subscribeTerminal(one.id);
  await second.subscribeTerminal(two.id);
  expect(wire.connections()).toBe(1);
  first.input("FIRST_ONLY\n");
  second.input("SECOND_ONLY\n");
  await expect.poll(() => first.output()).toContain("FIRST_ONLY");
  await expect.poll(() => second.output()).toContain("SECOND_ONLY");
  expect(first.output()).not.toContain("SECOND_ONLY");
  expect(second.output()).not.toContain("FIRST_ONLY");
  const firstBytes = new Uint8Array([0, 255, 128, 173]);
  const secondBytes = new Uint8Array([173, 128, 255, 0]);
  const paths = await Promise.all([
    first.upload("first.bin", firstBytes),
    second.upload("second.bin", secondBytes),
  ]);
  expect((await readFile(paths[0]!)).equals(firstBytes)).toBe(true);
  expect((await readFile(paths[1]!)).equals(secondBytes)).toBe(true);

  const binary = wire.frames.filter((frame) => frame.binary);
  expect(binary.length).toBeGreaterThan(0);
  expect(binary.every((frame) => decodeHostRouteFrame(frame.bytes) !== null)).toBe(true);
  expect(
    binary.some((frame) => {
      const payload = decodeHostRouteFrame(frame.bytes)!.payload;
      return Buffer.from(payload).equals(
        encodeTerminalStreamFrame({
          opcode: TerminalStreamOpcode.Input,
          slot: 0,
          payload: "FIRST_ONLY\n",
        }),
      );
    }),
  ).toBe(true);
  const json = wire.frames
    .filter((frame) => !frame.binary)
    .map((frame) => JSON.parse(frame.bytes.toString()));
  expect(json.filter((frame) => frame.type === "hello")).toHaveLength(1);
  expect(json.some((frame) => frame.message?.type === "hosts.link.open.request")).toBe(true);
  expect(
    json.some((frame) => frame.message?.binary === true || frame.message?.payload?.binary === true),
  ).toBe(false);
  await first.close();
  second.input("STILL_SECOND\n");
  await expect.poll(() => second.output()).toContain("STILL_SECOND");
  await second.close();
  await one.kill();
  await two.kill();
  await remote.dispose();
});

import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  decodeHostRouteFrame,
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import {
  WSOutboundMessageSchema,
  type SessionOutboundMessage,
  type SessionInboundMessage,
} from "@getpaseo/protocol/messages";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
class RoutePeer {
  readonly messages: SessionOutboundMessage[] = [];
  readonly bytes: Uint8Array[] = [];
  private slot = -1;
  private detach = () => {};
  private constructor(
    private readonly origin: DaemonClient,
    private readonly routeId: string,
  ) {
    const binary = origin.subscribeHostFrames((frame) => {
      if (frame.routeId === routeId) this.bytes.push(frame.payload);
    });
    const text = origin.subscribeRawMessages((message) => {
      if (message.type !== "hosts.route.frame" || message.payload.subscriptionId !== routeId)
        return;
      {
        const frame = WSOutboundMessageSchema.parse(JSON.parse(message.payload.data));
        if (frame.type === "session") this.messages.push(frame.message);
      }
    });
    this.detach = () => {
      binary();
      text();
    };
  }
  static async open(origin: DaemonClient, serverId: string) {
    const peer = new RoutePeer(
      origin,
      await origin.openHostRoute(serverId, "same-untrusted-scope"),
    );
    origin.sendHostFrame(
      peer.routeId,
      JSON.stringify({
        type: "hello",
        clientId: "same-untrusted-client",
        clientType: "cli",
        protocolVersion: 1,
        capabilities: { owned_subscriptions: true },
      }),
    );
    await expect
      .poll(
        () =>
          peer.messages.filter(
            (message) => message.type === "status" && message.payload.status === "server_info",
          ).length,
      )
      .toBe(1);
    const info = peer.messages.find(
      (message) => message.type === "status" && message.payload.status === "server_info",
    );
    if (info?.type !== "status") throw new Error("Missing routed server info");
    expect(info.payload).toMatchObject({
      sourceId: `route:owner:${origin.getLastServerInfoMessage()!.serverId}:owner`,
    });
    expect(info.payload).not.toHaveProperty("principalId");
    return peer;
  }
  send(message: SessionInboundMessage) {
    this.origin.sendHostFrame(this.routeId, JSON.stringify({ type: "session", message }));
  }
  async subscribeTerminal(terminalId: string) {
    this.send({ type: "subscribe_terminal_request", terminalId, requestId: "same-request" });
    await expect
      .poll(
        () =>
          this.messages.filter((message) => message.type === "subscribe_terminal_response").length,
      )
      .toBe(1);
    const response = this.messages.find(
      (message) => message.type === "subscribe_terminal_response",
    );
    if (response?.type !== "subscribe_terminal_response" || response.payload.slot === null)
      throw new Error("Missing terminal response");
    this.slot = response.payload.slot!;
  }
  input(text: string) {
    this.origin.sendHostFrame(
      this.routeId,
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Input,
        slot: this.slot,
        payload: text,
      }),
    );
  }
  async upload(fileName: string, bytes: Uint8Array) {
    const requestId = "same-upload-request";
    const modifiedAt = new Date().toISOString();
    this.send({
      type: "file.upload.request",
      requestId,
      fileName,
      mimeType: "application/octet-stream",
      size: bytes.length,
      modifiedAt,
    });
    for (const frame of [
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: "application/octet-stream",
          size: bytes.length,
          encoding: "binary",
          modifiedAt,
          fileName,
        },
      }),
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileChunk, requestId, payload: bytes }),
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
    ])
      this.origin.sendHostFrame(this.routeId, frame);
    await expect
      .poll(() => this.messages.some((message) => message.type === "file.upload.response"))
      .toBe(true);
    const response = this.messages.find((message) => message.type === "file.upload.response");
    if (response?.type !== "file.upload.response" || !response.payload.file)
      throw new Error("Upload failed");
    return response.payload.file.path;
  }
  output() {
    return this.bytes
      .flatMap((bytes) => {
        const frame = decodeTerminalStreamFrame(bytes);
        return frame?.opcode === TerminalStreamOpcode.Output
          ? [new TextDecoder().decode(frame.payload)]
          : [];
      })
      .join("");
  }
  async close() {
    this.detach();
    this.origin.closeHostRoute(this.routeId);
  }
}

import { mkdir, writeFile, readFile, chmod, stat, mkdtemp, rm, realpath } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { resolveDaemonVersion } from "../daemon-version.js";

test("identity discovery failures remain inspectable and changing a pinned destination requires explicit replacement", async () => {
  const a = await daemon();
  const b = await daemon();
  const c = await daemon();
  const { paseo } = await api(a);
  const self = await paseo.hosts.add({ connection: `127.0.0.1:${a.port}` });
  await expect.poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code).toBe("self_host");
  expect((await paseo.hosts.list()).hosts[0]!.serverId).toBe(a.daemon.getServerId());
  await paseo.hosts.remove(self.registrationId);
  const original = await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const bId = (await online(paseo)).hosts[0]!.serverId;
  const duplicate = await paseo.hosts.add({ connection: `ws://127.0.0.1:${b.port}/ws` });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[1]!.error?.code)
    .toBe("duplicate_host");
  expect((await paseo.hosts.list()).hosts[1]!.serverId).toBe(bId);
  await paseo.hosts.remove(duplicate.registrationId);
  await paseo.hosts.update(original.registrationId, { connection: `127.0.0.1:${c.port}` });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code)
    .toBe("server_id_mismatch");
  expect((await paseo.hosts.list()).hosts[0]!.serverId).toBe(bId);
  await paseo.hosts.update(original.registrationId, {
    connection: `127.0.0.1:${c.port}`,
    replaceIdentity: true,
  });
  expect((await online(paseo)).hosts[0]!.serverId).toBe(c.daemon.getServerId());
});

test("disabled host configuration and source survive a fresh daemon instance", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-host-restart-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => a.close());
  const { paseo } = await api(a);
  const host = await paseo.hosts.add({
    connection: "tcp://127.0.0.1:1?password=secret",
    label: "Persistent",
    metadata: { team: "infra" },
    sourceKey: "stable",
  });
  await paseo.hosts.update(host.registrationId, { enabled: false });
  // Windows exposes inherited ACLs, not POSIX owner/group/other mode bits.
  if (process.platform !== "win32")
    expect((await stat(join(a.paseoHome, "hosts.json"))).mode & 0o777).toBe(0o600);
  await a.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  expect((await next.paseo.hosts.list()).hosts).toEqual([
    expect.objectContaining({
      registrationId: host.registrationId,
      label: "Persistent",
      metadata: { team: "infra" },
      source: { id: "owner", key: "stable" },
      enabled: false,
      status: "disabled",
    }),
  ]);
});

test("server plugins use ordinary remote SDK operations and retain qualified source ownership on B", async () => {
  const b = await daemon();
  const a = await daemon();
  const { paseo, client } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(paseo)).hosts[0]!.serverId!;
  const directory = join(a.staticDir, "host-plugin");
  await mkdir(directory);
  await writeFile(
    join(directory, "paseo-plugin.json"),
    JSON.stringify({
      id: "connected-host-test",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    join(directory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
const operate = defineRpc({ name: "operate", input: z.object({ serverId: z.string(), path: z.string() }), output: z.object({ workspaceId: z.string(), registrationId: z.string(), sourceId: z.string() }) });
export default function contribute(server) {
  server.handle(operate, async (input, context) => {
    const runtime = context.paseo.hosts.runtime();
    const remote = await runtime.client(input.serverId);
    try {
      const workspace = await remote.workspaces.create({ source: { kind: "directory", path: input.path }, title: "Plugin remote workspace" });
      const host = await remote.hosts.add({ connection: "127.0.0.1:1", sourceKey: "plugin-stable", metadata: { team: "plugin" } });
      return { workspaceId: workspace.id, registrationId: host.registrationId, sourceId: host.source.id };
    } finally { await runtime.dispose(); }
  });
  return () => {};
}`,
  );
  await client.patchDaemonConfig({ pluginsEnabled: true });
  await client.installDirectoryPlugin(directory);
  const result = await client.invokePluginRpc("connected-host-test", "operate", {
    serverId,
    path: b.staticDir,
  });
  expect(result).toEqual({
    workspaceId: expect.stringMatching(/^wks_/),
    registrationId: expect.stringMatching(/^hst_/),
    sourceId: `route:owner:${a.daemon.getServerId()}:plugin%3Aconnected-host-test`,
  });
  const direct = await api(b);
  expect((await direct.paseo.workspaces.list()).entries).toHaveLength(1);
  expect((await direct.paseo.hosts.list()).hosts[0]).toMatchObject({
    source: {
      id: `route:owner:${a.daemon.getServerId()}:plugin%3Aconnected-host-test`,
      key: "plugin-stable",
    },
    metadata: { team: "plugin" },
  });
  await client.removePlugin("connected-host-test");
  expect((await direct.paseo.workspaces.list()).entries).toHaveLength(1);
});

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

test("CLI host commands manage the selected daemon and emit secret-free structured output", async () => {
  const a = await daemon();
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [
            "--conditions=source",
            "--import",
            "tsx",
            fileURLToPath(new URL("../../../../cli/src/index.ts", import.meta.url)),
            "--host",
            `127.0.0.1:${a.port}`,
            "host",
            ...args,
            "--json",
          ],
          { timeout: 20000 },
        )
      ).stdout,
    );
  const malformed = await cli("add", "alice:example-secret@localhost:6767").catch(
    (error: unknown) => error,
  );
  expect(malformed).toHaveProperty("stderr");
  expect((malformed as { stderr: string }).stderr).toContain("invalid_connection");
  expect((malformed as { stderr: string }).stderr).not.toContain("example-secret");
  expect(await cli("ls")).toEqual([]);
  const saved = await cli(
    "add",
    "tcp://127.0.0.1:1?password=cli-secret",
    "--label",
    "CLI host",
    "--meta",
    "team=infra",
  );
  expect(saved).toMatchObject({
    label: "CLI host",
    metadata: { team: "infra" },
    registrationId: expect.stringMatching(/^hst_/),
  });
  expect(JSON.stringify(await cli("ls"))).not.toContain("cli-secret");
  expect(
    await cli(
      "update",
      saved.registrationId,
      "--meta",
      "team=tools",
      "--meta",
      "other=value",
      "--remove-meta",
      "team",
    ),
  ).toMatchObject({ metadata: { other: "value" } });
  expect(await cli("disable", saved.registrationId)).toMatchObject({
    status: "disabled",
    enabled: false,
  });
  expect(await cli("inspect", saved.registrationId)).toMatchObject({
    enabled: false,
    targetDescription: "tcp://127.0.0.1:1",
  });
  expect(await cli("enable", saved.registrationId)).toMatchObject({ enabled: true });
  await cli("rm", saved.registrationId);
  expect(await cli("ls")).toEqual([]);
}, 60000);

test("resuming an A session with narrower grants terminates existing routes and restores observations with current authority", async () => {
  const b = await daemon();
  const a = await daemon();
  const admin = await api(a);
  await admin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(admin.paseo)).hosts[0]!.serverId!;
  const origin = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: "resumed-authority",
    reconnect: { enabled: false },
  });
  await origin.connect();
  const paseo = createPaseoApi(origin);
  cleanup.push(async () => {
    await paseo.dispose();
    await origin.close();
  });
  const remote = await paseo.hosts.client(serverId);
  const observed = await remote.workspaces.list({ subscribe: {} });
  const snapshots: unknown[] = [];
  observed.subscription.subscribe({
    snapshot: (snapshot) => snapshots.push(snapshot),
    update() {},
  });
  const restricted = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: "resumed-authority",
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  await restricted.connect();
  cleanup.push(() => restricted.close());
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(2);
  await expect(
    remote.workspaces.create({ source: { kind: "directory", path: b.staticDir } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect((await remote.workspaces.list()).entries).toEqual([]);
  await remote.dispose();
});

import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { once } from "node:events";
import { hashSync } from "bcryptjs";

test("old capabilities fail before execution and authentication errors recover through credential replacement", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const operations: string[] = [];
  ws.on("connection", (socket) =>
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "srv_old",
                hostname: "old",
                version: "0.1.0",
              },
            },
          }),
        );
      else if (frame.type === "session") operations.push(frame.message.type);
    }),
  );
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing old daemon port");
  const old = createHostClient(`127.0.0.1:${address.port}`, {
    clientId: "old-capability",
    reconnect: { enabled: false },
  });
  await old.connect();
  cleanup.push(() => old.close());
  await expect(createPaseoApi(old).hosts.add({ connection: "127.0.0.1:1" })).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  expect(operations).toEqual([]);
  const a = await daemon();
  const { paseo } = await api(a);
  const registration = await paseo.hosts.add({ connection: `127.0.0.1:${address.port}` });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code)
    .toBe("unsupported_capability");
  await expect(paseo.hosts.client("srv_old")).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  expect(operations).toEqual([]);
  await paseo.hosts.remove(registration.registrationId);
  const b = await createTestPaseoDaemon({ auth: { password: hashSync("right-password", 4) } });
  cleanup.push(() => b.close());
  const saved = await paseo.hosts.add({
    connection: `tcp://127.0.0.1:${b.port}?password=wrong-password`,
  });
  await expect
    .poll(async () => (await paseo.hosts.list()).hosts[0]!.error?.code)
    .toBe("authentication_failed");
  expect(JSON.stringify(await paseo.hosts.list())).not.toContain("wrong-password");
  await paseo.hosts.update(saved.registrationId, {
    connection: `tcp://127.0.0.1:${b.port}?password=right-password`,
  });
  expect((await online(paseo)).hosts[0]!.serverId).toBe(b.daemon.getServerId());
});

test("an unreachable saved target becomes online after its daemon starts without being added again", async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("Missing reserved port");
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const a = await daemon();
  const { paseo } = await api(a);
  const host = await paseo.hosts.add({ connection: `127.0.0.1:${address.port}` });
  await expect.poll(async () => (await paseo.hosts.list()).hosts[0]!.status).toBe("offline");
  const b = await createTestPaseoDaemon({ listenPort: address.port });
  cleanup.push(() => b.close());
  expect((await online(paseo)).hosts[0]).toMatchObject({
    registrationId: host.registrationId,
    serverId: b.daemon.getServerId(),
    status: "online",
    nextRetryAt: null,
    error: null,
  });
});

test("losing a sent mutation result retains ordinary errors, identifies the destination and never replays it", async () => {
  const b = await daemon();
  const a = await daemon();
  const { paseo, client } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const serverId = (await online(paseo)).hosts[0]!.serverId!;
  const remote = await paseo.hosts.client(serverId);
  const pending = remote.config.patch({ pluginsEnabled: false });
  const result = pending.catch((error: unknown) => error);
  await client.close();
  expect(await result).toMatchObject({
    code: "DAEMON_CONNECTION_LOST",
    outcome: "unknown",
    serverId,
  });
  await expect(remote.workspaces.list()).rejects.toMatchObject({
    code: "DAEMON_CONNECTION_LOST",
    serverId,
  });
  const direct = await api(b);
  await direct.client.close();
  const terminalFailure = (await direct.paseo.terminals
    .list()
    .catch((error: unknown) => error)) as Error;
  await expect(remote.terminals.list()).rejects.toThrow(terminalFailure.message);
  const creation = {
    source: { kind: "directory" as const, path: "/tmp" },
    workspaceId: "offline-never-created",
  };
  const creationFailure = (await direct.paseo.workspaces
    .create(creation)
    .catch((error: unknown) => error)) as Error;
  await expect(remote.workspaces.create(creation)).rejects.toThrow(creationFailure.message);
  await remote.dispose();
});

test("disposing an origin during routed handshake settles acquisition and closes only its pending session", async () => {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  let connections = 0;
  let routeHello = false;
  let routeClosed = false;
  ws.on("connection", (socket) => {
    connections++;
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      if (frame.type === "hello")
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "srv_pending",
                hostname: "pending",
                version: "0.12.0",
                features: {
                  connectedHosts: true,
                  hostMultiplexing: true,
                  ownedSubscriptions: true,
                },
              },
            },
          }),
        );
      if (frame.message?.type === "hosts.link.open.request")
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "hosts.link.open.response",
              payload: { requestId: frame.message.requestId, routeId: "pending-channel" },
            },
          }),
        );
      if (frame.message?.type === "hosts.route.frame.request") routeHello = true;
      if (frame.message?.type === "hosts.route.close.request") routeClosed = true;
    });
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of ws.clients) socket.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing pending endpoint port");
  const a = await daemon();
  const { paseo } = await api(a);
  await paseo.hosts.add({ connection: `127.0.0.1:${address.port}` });
  await online(paseo);
  const pending = paseo.hosts.client("srv_pending");
  const result = pending.catch((error: unknown) => error);
  await expect.poll(() => routeHello).toBe(true);
  await paseo.dispose();
  expect(await result).toBeInstanceOf(Error);
  await expect.poll(() => routeClosed).toBe(true);
  expect(ws.clients.size).toBe(1);
  expect(connections).toBe(1);
  routeClosed = false;
  const next = await api(a);
  await expect(next.paseo.hosts.client("srv_pending")).rejects.toMatchObject({
    code: "host_offline",
    serverId: "srv_pending",
  });
  await expect.poll(() => routeClosed).toBe(true);
  expect(ws.clients.size).toBe(1);
  expect(connections).toBe(1);
  expect((await next.paseo.workspaces.list()).entries).toEqual([]);
  expect((await next.paseo.hosts.list()).hosts[0]?.status).toBe("online");
});

test("source-key registration remains idempotent at directory capacity", async () => {
  const { ConnectedHosts } = await import("./index.js");
  const home = await mkdtemp(join(tmpdir(), "hosts-capacity-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const rows = Array.from({ length: 128 }, (_, index) => ({
    registrationId: `saved-${index}`,
    serverId: null,
    label: null,
    source: { id: "plugin:capacity", key: `key-${index}` },
    metadata: {},
    enabled: false,
    status: "disabled",
    targetDescription: "127.0.0.1:1",
    lastOnlineAt: null,
    nextRetryAt: null,
    error: null,
    connection: "127.0.0.1:1",
  }));
  await writeFile(join(home, "hosts.json"), JSON.stringify(rows));
  const registry = new ConnectedHosts(home, { serverId: "self", label: "self" });
  cleanup.push(() => registry.close());
  const actor = { sourceId: "plugin:capacity", manageSources: false };
  await expect(
    registry.add({ connection: "127.0.0.1:1", sourceKey: "key-0" }, actor),
  ).resolves.toMatchObject({ registrationId: "saved-0", enabled: false });
  await expect(
    registry.add({ connection: "127.0.0.1:1", sourceKey: "new" }, actor),
  ).rejects.toMatchObject({ code: "resource_limit" });
});

/** Real WebSocket proxy records the A–B physical wire without replacing either daemon. */
async function hostWire(b: TestPaseoDaemon) {
  let destination = b;
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const frames: { binary: boolean; bytes: Buffer; direction: "toB" | "fromB" }[] = [];
  const responses: SessionOutboundMessage[] = [];
  const holds = new Set<{
    matches(message: SessionOutboundMessage): boolean;
    send: (() => void)[];
    captured(): void;
  }>();
  let connections = 0;
  wss.on("connection", (downstream) => {
    connections++;
    const upstream = new WebSocket(`ws://127.0.0.1:${destination.port}/ws`);
    const pending: (() => void)[] = [];
    upstream.on("open", () => {
      for (const send of pending.splice(0)) send();
    });
    downstream.on("message", (data, binary) => {
      const bytes = Buffer.from(data as Buffer);
      frames.push({ binary, bytes, direction: "toB" });
      const send = () => {
        if (upstream.readyState === 1) upstream.send(bytes, { binary });
      };
      if (upstream.readyState === 0) pending.push(send);
      else send();
    });
    upstream.on("message", (data, binary) => {
      const bytes = Buffer.from(data as Buffer);
      frames.push({ binary, bytes, direction: "fromB" });
      const send = () => {
        if (downstream.readyState === 1) downstream.send(bytes, { binary });
      };
      const payload = binary ? decodeHostRouteFrame(bytes)?.payload : bytes;
      if (payload) {
        try {
          let envelope = JSON.parse(Buffer.from(payload).toString());
          while (envelope.type === "session" && envelope.message?.type === "hosts.route.frame")
            envelope = JSON.parse(envelope.message.payload.data);
          if (envelope.type === "session") {
            const validated = WSOutboundMessageSchema.parse(envelope);
            if (validated.type === "session") responses.push(validated.message);
            const hold = [...holds].find((candidate) => candidate.matches(envelope.message));
            if (hold) {
              hold.send.push(send);
              hold.captured();
              return;
            }
          }
        } catch {
          /* Non-JSON binary frames remain ordinary transport traffic. */
        }
      }
      send();
    });
    upstream.on("error", () => downstream.close());
    upstream.on("close", () => downstream.close());
    downstream.on("close", () => upstream.close());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing wire port");
  return {
    responses,
    connection: `127.0.0.1:${address.port}`,
    frames,
    connections: () => connections,
    active: () => wss.clients.size,
    holdResponses(matches: (message: SessionOutboundMessage) => boolean) {
      let captured!: () => void;
      const ready = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const hold = { matches, send: [] as (() => void)[], captured };
      holds.add(hold);
      return {
        ready,
        release() {
          holds.delete(hold);
          for (const send of hold.send.splice(0)) send();
        },
      };
    },
    retarget(next: TestPaseoDaemon) {
      destination = next;
      for (const socket of wss.clients) socket.close();
    },
  };
}

test("a resumed physical link re-admits every logical session under its current grant ceiling", async () => {
  const b = await daemon();
  const parent = createHostClient(`127.0.0.1:${b.port}`, { clientId: "physical-grants" });
  cleanup.push(() => parent.close());
  await parent.connect();
  const serverId = parent.getLastServerInfoMessage()!.serverId;
  const logical = new DaemonClient({
    url: "ws://logical/ws",
    clientId: "logical",
    transportFactory: createHostChannelTransport(parent, serverId, "logical", null, true),
  });
  cleanup.push(() => logical.close());
  const connecting = logical.connect();
  expect(() => logical.ensureConnected()).not.toThrow();
  const scoped = createPaseoApi(logical);
  cleanup.push(() => scoped.dispose());
  const initialCall = scoped.workspaces.list();
  await connecting;
  expect((await initialCall).entries).toEqual([]);
  const recoveryCalls: Promise<unknown>[] = [];
  const stopRecovery = logical.subscribeConnectionStatus((state) => {
    if (state.status === "connecting")
      recoveryCalls.push(scoped.workspaces.list().catch((error: unknown) => error));
  });
  cleanup.push(async () => stopRecovery());
  const bytes = Uint8Array.from({ length: 256 * 1024 + 123 }, (_, index) => index % 251);
  const upload = await logical.uploadFile({
    fileName: "routed.bin",
    mimeType: "application/octet-stream",
    bytes,
  });
  expect(upload.error).toBeNull();
  const downloaded = await logical.readFile(
    dirname(upload.file!.path),
    basename(upload.file!.path),
  );
  expect(Buffer.from(downloaded.bytes).equals(bytes)).toBe(true);

  const observed = await scoped.workspaces.list({ subscribe: {} });
  const snapshots: unknown[] = [];
  observed.subscription.subscribe({ snapshot: (value) => snapshots.push(value), update() {} });
  const narrowed = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: "physical-grants",
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  cleanup.push(() => narrowed.close());
  await narrowed.connect();
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(2);
  expect(logical.getLastServerInfoMessage()?.permissions).toEqual([
    "daemon.read",
    "workspace.read",
  ]);
  await expect(
    scoped.workspaces.create({ source: { kind: "directory", path: b.staticDir } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  const restored = createHostClient(`127.0.0.1:${b.port}`, {
    clientId: "physical-grants",
    reconnect: { enabled: false },
  });
  cleanup.push(() => restored.close());
  await restored.connect();
  await expect.poll(() => snapshots.length, { timeout: 15000 }).toBe(3);
  expect(logical.getLastServerInfoMessage()?.permissions).toContain("workspace.write");
  expect(recoveryCalls.length).toBeGreaterThanOrEqual(2);
  for (const call of recoveryCalls) expect(await call).toMatchObject({ entries: [] });
  await scoped.workspaces.create({ source: { kind: "directory", path: b.staticDir } });
});

import { DaemonLinkEndpoint, VirtualHostSocket } from "./index.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import { sendBoundedPhysicalFrameAndWait } from "../websocket/physical-socket.js";

test("channel output accounts for escaped text, awaits physical drain, and preserves its sibling", async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  const accepted = once(wss, "connection");
  const tcpAccepted = once(http, "connection");
  const receiver = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const received: { binary: boolean; bytes: Buffer }[] = [];
  receiver.on("message", (bytes, binary) =>
    received.push({ bytes: Buffer.from(bytes as Buffer), binary }),
  );
  const [physical] = (await accepted) as [WebSocket];
  const [tcp] = (await tcpAccepted) as [Socket];
  await once(receiver, "open");
  cleanup.push(async () => {
    receiver.terminate();
    physical.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const delivery = new SessionDelivery(
    async (source, message) => {
      expect(delivery.permits(source, message)).toBe(true);
      await sendBoundedPhysicalFrameAndWait({
        socket: physical,
        frame: JSON.stringify({ type: "session", message }),
        onHighWater: () => {
          throw new Error("Shared link overflowed");
        },
      });
    },
    async (source, frame) => {
      expect(delivery.permitsBinary(source, frame)).toBe(true);
      await sendBoundedPhysicalFrameAndWait({
        socket: physical,
        frame,
        onHighWater: () => {
          throw new Error("Shared link overflowed");
        },
      });
    },
  );
  delivery.attach(physical, true);
  const channels: VirtualHostSocket[] = [];
  const endpoint = new DaemonLinkEndpoint({
    identity: "authenticated",
    permissions: () => ["daemon.read"],
    routed: () => false,
    bufferedAmount: () => physical.bufferedAmount,
    delivery,
    admit: async (socket) => {
      channels.push(socket);
    },
  });
  cleanup.push(async () => {
    endpoint.close();
    await delivery.close();
  });
  for (const channelId of ["slow", "sibling"]) {
    const request = { type: "hosts.link.open.request" as const, requestId: channelId, channelId };
    await delivery.request(physical, request, () => endpoint.dispatch(request));
  }
  await expect(channels[0]!.send('"'.repeat(34 * 1024 * 1024))).rejects.toThrow(
    "Host channel output limit reached",
  );
  expect(channels[0]!.readyState).toBe(3);
  expect(physical.readyState).toBe(1);
  await channels[1]!.send("sibling-before");
  await expect
    .poll(() => received.some((frame) => !frame.binary && frame.bytes.includes("sibling-before")))
    .toBe(true);
  receiver.pause();
  // Hold real physical writes independently of the OS receive-buffer size.
  // A paused receiver alone can still accept the entire frame on Windows.
  tcp.cork();
  let completed = false;
  const bytes = new Uint8Array(8 * 1024 * 1024).fill(173);
  const pending = channels[1]!.send(bytes).then(() => {
    completed = true;
    return undefined;
  });
  await expect.poll(() => physical.bufferedAmount).toBeGreaterThan(0);
  expect(completed).toBe(false);
  expect(physical.bufferedAmount).toBeLessThan(64 * 1024 * 1024);
  receiver.resume();
  tcp.uncork();
  await pending;
  await channels[1]!.send("sibling-after");
  await expect
    .poll(() => received.some((frame) => !frame.binary && frame.bytes.includes("sibling-after")))
    .toBe(true);
  const binary = received.find((frame) => frame.binary)!;
  expect(Buffer.from(decodeHostRouteFrame(binary.bytes)!.payload).equals(bytes)).toBe(true);
  expect(wss.clients.size).toBe(1);
});

import { existsSync, mkdirSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
test.skipIf(process.platform !== "linux" || !existsSync("/usr/sbin/sshd"))(
  "real SSH shares one tunnel across scopes and owns fresh attempts after recovery",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "hosts-ssh-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const run = promisify(execFile);
    for (const name of ["host", "client"])
      await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", join(root, name)]);
    const authorized = await readFile(join(root, "client.pub"));
    await writeFile(join(root, "authorized_keys"), authorized);
    const portServer = createServer();
    portServer.listen(0, "127.0.0.1");
    await once(portServer, "listening");
    const address = portServer.address();
    if (!address || typeof address === "string") throw new Error("Missing SSH port");
    await new Promise<void>((resolve) => portServer.close(() => resolve()));
    await writeFile(
      join(root, "sshd_config"),
      `Port ${address.port}\nListenAddress 127.0.0.1\nHostKey ${root}/host\nPidFile ${root}/pid\nAuthorizedKeysFile ${root}/authorized_keys\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAllowTcpForwarding yes\n`,
    );
    await writeFile(
      join(root, "ssh"),
      `#!/bin/sh\nprintf 'attempt\\n' >> '${root}/attempts'\nexec /usr/bin/ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile='${root}/known_hosts' -i '${root}/client' "$@"\n`,
    );
    await chmod(join(root, "ssh"), 0o700);
    const originalPath = process.env.PATH;
    process.env.PATH = `${root}:${originalPath}`;
    cleanup.push(async () => {
      process.env.PATH = originalPath;
    });
    const b = await createTestPaseoDaemon({ auth: { password: hashSync("ssh-password", 4) } });
    cleanup.push(() => b.close());
    const a = await daemon();
    const { paseo, client } = await api(a);
    const host = await paseo.hosts.add({
      connection: `ssh://${userInfo().username}@127.0.0.1:${address.port}?daemonPort=${b.port}&password=ssh-password`,
    });
    await expect.poll(async () => (await paseo.hosts.list()).hosts[0]?.status).toBe("offline");
    const sshd = spawn("/usr/sbin/sshd", [
      "-D",
      "-f",
      join(root, "sshd_config"),
      "-E",
      join(root, "sshd.log"),
    ]);
    cleanup.push(async () => {
      sshd.kill();
    });
    await online(paseo);
    const attempts = async () =>
      (await readFile(join(root, "attempts"), "utf8")).trim().split("\n").length;
    const before = await attempts();
    const first = await paseo.hosts.client(b.daemon.getServerId());
    const sibling = await paseo.hosts.client(b.daemon.getServerId());
    expect((await sibling.workspaces.list()).entries).toEqual([]);
    expect(await attempts()).toBe(before);
    await first.dispose();
    expect((await sibling.workspaces.list()).entries).toEqual([]);
    expect(await attempts()).toBe(before);
    const workspace = await sibling.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const terminal = await workspace.terminals.create({
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', data => process.stdout.write(data))"],
    });
    const stream = await RoutePeer.open(client, b.daemon.getServerId());
    await stream.subscribeTerminal(terminal.id);
    stream.input("SSH_BINARY_BEFORE\n");
    await expect.poll(() => stream.output()).toContain("SSH_BINARY_BEFORE");
    await stream.close();
    expect(await attempts()).toBe(before);

    await paseo.hosts.update(host.registrationId, { enabled: false });
    await paseo.hosts.update(host.registrationId, { enabled: true });
    await online(paseo);
    await expect
      .poll(
        async () => {
          try {
            return (await sibling.workspaces.list()).entries.length;
          } catch {
            return -1;
          }
        },
        { timeout: 15000 },
      )
      .toBe(1);
    expect(await attempts()).toBe(before + 1);
    const resumed = await RoutePeer.open(client, b.daemon.getServerId());
    await resumed.subscribeTerminal(terminal.id);
    resumed.input("SSH_BINARY_AFTER\n");
    await expect.poll(() => resumed.output()).toContain("SSH_BINARY_AFTER");
    await resumed.close();
    await terminal.kill();
    expect(await attempts()).toBe(before + 1);
    await sibling.dispose();
    await paseo.hosts.update(host.registrationId, { enabled: false });
    await writeFile(join(root, "authorized_keys"), "");
    await paseo.hosts.update(host.registrationId, { enabled: true });
    await expect
      .poll(async () => (await paseo.hosts.list()).hosts[0]?.error?.code, { timeout: 15000 })
      .toBe("authentication_failed");
    expect((await paseo.hosts.list()).hosts[0]?.nextRetryAt).toBeNull();
    await writeFile(join(root, "authorized_keys"), authorized);
    await paseo.hosts.update(host.registrationId, { enabled: true });
    await online(paseo);
  },
  60000,
);

test("malformed routing headers terminate their physical source and leave the daemon usable", async () => {
  const b = await daemon();
  const socket = new WebSocket(`ws://127.0.0.1:${b.port}/ws`);
  cleanup.push(async () => socket.terminate());
  await once(socket, "open");
  const info = once(socket, "message");
  socket.send(
    JSON.stringify({
      type: "hello",
      clientId: "malformed-route",
      clientType: "cli",
      protocolVersion: 1,
      capabilities: { owned_subscriptions: true },
    }),
  );
  await info;
  const opened = once(socket, "message");
  socket.send(
    JSON.stringify({
      type: "session",
      message: { type: "hosts.link.open.request", requestId: "channel", channelId: "channel" },
    }),
  );
  const [response] = await opened;
  expect(JSON.parse(String(response)).message.type).toBe("hosts.link.open.response");
  const closed = once(socket, "close");
  socket.send(new Uint8Array([0x30, 0, 3, 97]));
  expect((await closed)[0]).toBe(1008);
  expect((await (await api(b)).paseo.workspaces.list()).entries).toEqual([]);
});

test("cancelling a logical scope during admission settles it and releases its owned channel", async () => {
  const source = {};
  const messages: SessionOutboundMessage[] = [];
  const delivery = new SessionDelivery((_source, message) => {
    messages.push(message);
  });
  delivery.attach(source, true);
  let pendingSocket: VirtualHostSocket | undefined;
  const endpoint = new DaemonLinkEndpoint({
    identity: "physical",
    permissions: () => ["daemon.read"],
    routed: () => false,
    bufferedAmount: () => 0,
    delivery,
    admit: (socket) =>
      new Promise<void>((resolve) => {
        pendingSocket = socket;
        socket.once("close", resolve);
      }),
  });
  const open = {
    type: "hosts.link.open.request" as const,
    requestId: "pending",
    channelId: "logical-scope",
  };
  const acquiring = delivery.request(source, open, () => endpoint.dispatch(open));
  expect(pendingSocket).toBeDefined();
  const cancel = { type: "hosts.route.close.request" as const, scopeId: "logical-scope" };
  expect(endpoint.handles(cancel)).toBe(true);
  await delivery.request(source, cancel, () => endpoint.dispatch(cancel));
  await acquiring;
  expect(pendingSocket!.readyState).toBe(3);
  expect(messages.some((message) => message.type === "hosts.link.open.response")).toBe(false);
  expect(messages.filter((message) => message.type === "hosts.route.closed")).toHaveLength(1);
  endpoint.close();
  await delivery.close();
});

test("agent handles keep server identity when agent IDs collide across hosts", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const directory = await online(origin.paseo);
  const destination = directory.hosts[0]!.serverId!;
  const remote = await origin.paseo.hosts.client(destination);
  const id = crypto.randomUUID();
  const localAgent = await origin.paseo.agents.create({
    agentId: id,
    cwd: a.staticDir,
    config: { provider: "codex/test" },
    title: "On A",
  });
  const remoteAgent = await remote.agents.create({
    agentId: id,
    cwd: b.staticDir,
    config: { provider: "codex/test" },
    title: "On B",
  });
  expect(localAgent.address).toEqual({ serverId: directory.self.serverId, agentId: id });
  expect(remoteAgent.address).toEqual({ serverId: destination, agentId: id });
  expect(localAgent.serverId).toBe(directory.self.serverId);
  expect(remoteAgent.serverId).toBe(destination);
  expect(localAgent.current()?.title).toBe("On A");
  expect(remoteAgent.current()?.title).toBe("On B");
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  const direct = await api(b);
  const directRuntime = direct.paseo.hosts.runtime();
  cleanup.push(() => directRuntime.dispose());
  const [firstScope, secondScope] = await Promise.all([
    runtime.client(destination),
    runtime.client(destination),
  ]);
  expect(firstScope).not.toBe(secondScope);
  await firstScope.dispose();
  expect((await secondScope.workspaces.list()).entries).toHaveLength(1);
  for (const [owner, address, title] of [
    [runtime, localAgent.address, "On A"],
    [runtime, remoteAgent.address, "On B"],
    [directRuntime, remoteAgent.address, "On B"],
  ] as const) {
    const agent = await owner.agent(address);
    expect(agent.address).toEqual(address);
    expect((await agent.refresh())?.agent.title).toBe(title);
  }
  await origin.paseo.hosts.update(directory.hosts[0]!.registrationId, { enabled: false });
  expect(remoteAgent.address).toEqual({ serverId: destination, agentId: id });
  const unavailable = await runtime.agent(remoteAgent.address);
  await expect(unavailable.refresh()).rejects.toThrow();
  const stillDirect = await directRuntime.agent(remoteAgent.address);
  expect((await stillDirect.refresh())?.agent.title).toBe("On B");
  await runtime.dispose();
  await expect(runtime.agent(localAgent.address)).rejects.toThrow("disposed");
});

test("established agent identity survives disconnect and rejects a different server on reconnect", async () => {
  const a = await daemon();
  const b = await daemon();
  const wire = await hostWire(a);
  const client = createHostClient(wire.connection, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  cleanup.push(() => client.close());
  await client.connect();
  const paseo = createPaseoApi(client);
  cleanup.push(() => paseo.dispose());
  const agent = paseo.agents.ref(crypto.randomUUID());
  const address = agent.address;
  wire.retarget(b);
  await expect.poll(() => client.getConnectionState().status).toBe("disconnected");
  expect(client.getLastServerInfoMessage()).toBeNull();
  expect(agent.address).toEqual(address);
  await expect(client.connect()).rejects.toMatchObject({
    code: "server_id_mismatch",
    serverId: address.serverId,
  });
  expect(agent.address).toEqual(address);
  expect(client.getConnectionState().status).toBe("disconnected");
});

test("runtime disposal rejects every pending acquisition and releases the resulting scopes", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const directory = await online(origin.paseo);
  const serverId = directory.hosts[0]!.serverId!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired: ReturnType<typeof createPaseoApi>[] = [];
  // Delay an ordinary public acquisition; every connection and scope is real.
  const runtime = new HostRuntime({
    hosts: {
      ...origin.paseo.hosts,
      async client(target) {
        const client = await origin.paseo.hosts.client(target);
        acquired.push(client);
        await gate;
        return client;
      },
    },
  });
  cleanup.push(() => runtime.dispose());
  const calls = [
    runtime.client(serverId),
    runtime.client(serverId),
    runtime.agent({ serverId, agentId: crypto.randomUUID() }),
  ];
  const settled = Promise.allSettled(calls);
  await expect.poll(() => acquired.length).toBe(3);
  const disposed = runtime.dispose();
  release();
  const results = await settled;
  expect(
    results.every(
      (result) => result.status === "rejected" && /disposed/.test(String(result.reason)),
    ),
  ).toBe(true);
  await disposed;
  for (const client of acquired) await expect(client.workspaces.list()).rejects.toThrow();
});

test("MCP list_hosts uses the daemon host runtime and returns the same secret-free directory as SDK", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}`, label: "Build box" });
  await online(origin.paseo);
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const mcp = new Client({ name: "fleet-regression", version: "1.0.0" });
  cleanup.push(() => mcp.close());
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp/agents`)),
  );
  const result = await mcp.callTool({ name: "list_hosts", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual(await origin.paseo.hosts.list());
});

test("a changed daemon on physical reconnect remains an inspectable identity failure", async () => {
  const a = await daemon();
  const b = await daemon();
  const c = await daemon();
  const wire = await hostWire(b);
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: wire.connection });
  const directory = await online(origin.paseo);
  const registration = directory.hosts[0]!;
  wire.retarget(c);
  await expect
    .poll(async () => (await origin.paseo.hosts.list()).hosts[0]?.error?.code, { timeout: 10000 })
    .toBe("server_id_mismatch");
  expect((await origin.paseo.hosts.list()).hosts[0]).toMatchObject({
    serverId: registration.serverId,
    status: "error",
    nextRetryAt: null,
  });
  await origin.paseo.hosts.update(registration.registrationId, {
    connection: wire.connection,
    replaceIdentity: true,
  });
  expect((await online(origin.paseo)).hosts[0]?.serverId).toBe(c.daemon.getServerId());
}, 20000);

test("runtime disposal ends borrowed agent operations while preserving identity and origin ownership", async () => {
  const a = await daemon();
  const origin = await api(a);
  const local = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  const borrowed = await runtime.agent(local.address);
  await borrowed.refresh();
  await runtime.dispose();
  expect(borrowed.address).toEqual(local.address);
  expect(borrowed.current()?.id).toBe(local.id);
  await expect(borrowed.refresh()).rejects.toThrow("disposed");
  await expect(borrowed.send("must not dispatch")).rejects.toThrow("disposed");
  await expect(borrowed.archive()).rejects.toThrow("disposed");
  expect((await local.refresh())?.agent.archivedAt).toBeNull();
});

test("disposing a daemon-owned runtime closes its source session and failed admission leaves none", async () => {
  const a = await daemon();
  const origin = await api(a);
  const sessions = async () => {
    const { diagnostic } = await origin.client.collectDiagnostics();
    const runtimes = /Host runtimes: (\d+)/.exec(diagnostic);
    const ownedSessions = /Owned sessions: (\d+)/.exec(diagnostic);
    if (!runtimes || !ownedSessions) throw new Error("Missing host runtime diagnostics");
    return [Number(runtimes[1]), Number(ownedSessions[1])];
  };
  const before = await sessions();
  const runtime = await a.daemon.createHostRuntime({
    permissionCeiling: ["daemon.read", "workspace.read"],
    resolveAdmission: async () => ({
      principalId: "owner",
      permissions: ["daemon.read", "workspace.read", "workspace.manage"],
    }),
  });
  cleanup.push(() => runtime.dispose());
  expect((await runtime.directory()).self.serverId).toBe(a.daemon.getServerId());
  const scoped = await runtime.client(a.daemon.getServerId());
  await expect(
    scoped.workspaces.create({ source: { kind: "directory", path: a.staticDir } }),
  ).rejects.toMatchObject({ code: "access_denied" });
  await scoped.dispose();
  const active = await sessions();
  expect(active[0]).toBe(before[0]! + 1);
  expect(active[1]).toBe(before[1]! + 1);
  const disposing = runtime.dispose();
  expect(runtime.dispose()).toBe(disposing);
  await expect(runtime.client(a.daemon.getServerId())).rejects.toThrow("disposed");
  await disposing;
  await expect.poll(sessions).toEqual(before);
  await expect(runtime.directory()).rejects.toThrow("disposed");
  const revoked = Object.assign(new Error("Runtime authority was revoked"), {
    code: "access_denied",
  });
  await expect(
    a.daemon.createHostRuntime({
      permissionCeiling: ["daemon.read"],
      resolveAdmission: async () => {
        throw revoked;
      },
    }),
  ).rejects.toMatchObject({ code: "access_denied" });
  await expect.poll(sessions).toEqual(before);
});

test("SDK creation persists a qualified parent without resolving a colliding agent on the child host", async () => {
  const a = await daemon();
  const root = await mkdtemp(join(tmpdir(), "paseo-parent-address-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const b = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => b.close());
  const origin = await api(a);
  const destination = await api(b);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const id = crypto.randomUUID();
  const parent = await origin.paseo.agents.create({
    agentId: id,
    cwd: a.staticDir,
    config: { provider: "codex/test" },
    title: "Parent on A",
  });
  await destination.paseo.agents.create({
    agentId: id,
    cwd: b.staticDir,
    config: { provider: "codex/test" },
    title: "Unrelated on B",
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const child = await workspace.agents.create({
    config: { provider: "codex/test" },
    parent,
    title: "Child on B",
  });
  expect(child.current()?.parent).toEqual(parent.address);
  expect((await b.daemon.agentStorage.get(child.id))?.parent).toEqual(parent.address);
  await b.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  const restored = next.paseo.agents.ref(child.id);
  expect((await restored.refresh())?.agent.parent).toEqual(parent.address);
  expect((await restarted.daemon.agentStorage.get(child.id))?.parent).toEqual(parent.address);
});

test("managed membership is present on the first child snapshot and clears after forget", async () => {
  const a = await daemon();
  const { paseo, client } = await api(a);
  const parent = await paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const published: import("@getpaseo/protocol/messages").AgentSnapshotPayload[] = [];
  const directory = client.observeAgents();
  const stop = directory.subscribe({
    snapshot(value) {
      for (const entry of value.entries) published.push(entry.agent);
    },
    update(message) {
      if (message.type === "agent_update" && message.payload.kind === "upsert")
        published.push(message.payload.agent);
    },
  });
  await directory.ready;
  const child = await parent.subagents.create({ config: { provider: "codex/test" } });
  await expect.poll(() => published.find((snapshot) => snapshot.id === child.id)).toBeDefined();
  const first = published.find((snapshot) => snapshot.id === child.id)!;
  expect(first).toMatchObject({
    managedRelationship: {
      parent: parent.address,
      parentWorkspace: { serverId: parent.serverId, workspaceId: parent.current()!.workspaceId },
    },
  });
  expect((await child.refresh())?.agent).toMatchObject({
    managedRelationship: { parent: parent.address },
  });
  await parent.subagents.forget(child.address);
  await expect
    .poll(async () => (await child.refresh())?.agent)
    .toMatchObject({ managedRelationship: null });
  stop();
  await directory.release();
});

test("parent capability owns local and fleet membership, idempotent creation and restart recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-subagent-owner-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => a.close());
  const b = await daemon();
  const origin = await api(a);
  const destination = await api(b);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const local = await parent.subagents.create({
    config: { provider: "codex/test" },
    idempotencyKey: "local-child",
  });
  const input = {
    serverId: b.daemon.getServerId(),
    workspaceId: workspace.id,
    config: { provider: "codex/test" },
    idempotencyKey: "fleet-child",
  };
  const [first, second] = await Promise.all([
    parent.subagents.create(input),
    parent.subagents.create(input),
  ]);
  expect(first.address).toEqual(second.address);
  expect(local.address.serverId).toBe(parent.address.serverId);
  expect(first.address.serverId).toBe(b.daemon.getServerId());
  expect((await parent.subagents.list()).rows.map((row) => row.child)).toEqual(
    expect.arrayContaining([local.address, first.address]),
  );
  const viewer = createHostClient(`127.0.0.1:${a.port}`, {
    clientId: crypto.randomUUID(),
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  cleanup.push(async () => {
    await viewer.close();
  });
  await viewer.connect();
  const viewerApi = createPaseoApi(viewer);
  cleanup.push(() => viewerApi.dispose());
  await expect(
    viewerApi.agents.ref(parent.id).subagents.create({ ...input, idempotencyKey: "unauthorized" }),
  ).rejects.toMatchObject({ code: "access_denied" });
  expect(
    (await destination.paseo.agents.list({ includeBackground: true })).entries.filter(
      (entry) => entry.agent.parent?.agentId === parent.id,
    ),
  ).toHaveLength(1);
  await a.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  const restoredParent = next.paseo.agents.ref(parent.id);
  expect((await restoredParent.subagents.list()).rows.map((row) => row.child)).toEqual(
    expect.arrayContaining([local.address, first.address]),
  );
  await online(next.paseo);
  const recovered = await restoredParent.subagents.create(input);
  expect(recovered.address).toEqual(first.address);
});

test("startup upgrade adopts existing ordinary local children once without treating later labels as membership", async () => {
  const { AgentStorage } = await import("../agent/agent-storage.js");
  const { default: pino } = await import("pino");
  const root = await mkdtemp(join(tmpdir(), "paseo-legacy-membership-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const storage = new AgentStorage(join(root, ".paseo", "agents"), pino({ level: "silent" }));
  const parentId = crypto.randomUUID();
  const childId = crypto.randomUUID();
  const sameWorkspaceId = crypto.randomUUID();
  const otherWorkspaceId = crypto.randomUUID();
  const openTabId = crypto.randomUUID();
  const foreignId = crypto.randomUUID();
  const nullParentId = crypto.randomUUID();
  const executedId = crypto.randomUUID();
  const internalParentId = crypto.randomUUID();
  const internalChildId = crypto.randomUUID();
  const seed = async (
    id: string,
    overrides: Partial<import("../agent/agent-storage.js").StoredAgentRecord> = {},
  ) => {
    await storage.upsert({
      id,
      provider: "codex",
      cwd: root,
      workspaceId: "legacy-workspace",
      config: { model: "test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStatus: "closed",
      labels: {},
      ...overrides,
    });
  };
  const labels = { "paseo.parent-agent-id": parentId };
  await seed(parentId);
  await seed(childId, { labels });
  await seed(sameWorkspaceId, { labels });
  await seed(otherWorkspaceId, { labels, workspaceId: "other-workspace" });
  await seed(openTabId, { labels: { ...labels, "paseo.open-agent-tab.retained": "true" } });
  await seed(foreignId, { labels, parent: { serverId: "another-server", agentId: parentId } });
  await seed(nullParentId, { labels, parent: null });
  await seed(executedId, {
    labels,
    owner: { kind: "daemon", daemonId: "hub", executionId: "execution" },
  });
  await seed(internalParentId, { internal: true });
  await seed(internalChildId, { labels: { "paseo.parent-agent-id": internalParentId } });
  const first = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => first.close());
  const origin = await api(first);
  const parent = origin.paseo.agents.ref(parentId);
  const rows = (await parent.subagents.list()).rows;
  expect(rows.map((row) => row.child.agentId).sort()).toEqual(
    [childId, sameWorkspaceId, otherWorkspaceId, openTabId].sort(),
  );
  expect(
    rows.every((row) => row.child.serverId === parent.serverId && row.phase === "attached"),
  ).toBe(true);
  expect((await first.daemon.agentStorage.get(childId))?.parent).toEqual(parent.address);
  await parent.subagents.forget({ serverId: parent.serverId, agentId: childId });
  await parent.archive();
  await expect
    .poll(async () => (await first.daemon.agentStorage.get(sameWorkspaceId))?.archivedAt)
    .toEqual(expect.any(String));
  await expect
    .poll(async () => (await first.daemon.agentStorage.get(otherWorkspaceId))?.parent)
    .toBeNull();
  await expect
    .poll(async () => (await first.daemon.agentStorage.get(openTabId))?.parent)
    .toBeNull();
  // Forget leaves destination lifecycle alone; the old label cascade must not run too.
  expect((await first.daemon.agentStorage.get(childId))?.archivedAt).toBeUndefined();
  expect((await first.daemon.agentStorage.get(otherWorkspaceId))?.archivedAt).toBeUndefined();
  expect((await first.daemon.agentStorage.get(openTabId))?.archivedAt).toBeUndefined();
  const injectedId = crypto.randomUUID();
  await first.daemon.agentStorage.upsert({
    ...(await first.daemon.agentStorage.get(childId))!,
    id: injectedId,
    parent: undefined,
  });
  await first.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const restored = await api(restarted);
  const restoredRows = (await restored.paseo.agents.ref(parentId).subagents.list()).rows;
  expect(restoredRows.map((row) => row.child.agentId).sort()).toEqual(
    [sameWorkspaceId, otherWorkspaceId, openTabId].sort(),
  );
  expect(restoredRows.every((row) => ["archived", "detached"].includes(row.phase))).toBe(true);
  expect((await restarted.daemon.agentStorage.get(injectedId))?.parent).toBeUndefined();
});

test("an interrupted legacy upgrade resumes its bounded candidates before admitting new writes", async () => {
  const { AgentStorage } = await import("../agent/agent-storage.js");
  const { Subagents } = await import("../subagents/index.js");
  const { getOrCreateServerId } = await import("../server-id.js");
  const { default: pino } = await import("pino");
  const root = await mkdtemp(join(tmpdir(), "paseo-interrupted-legacy-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, ".paseo");
  await mkdir(home);
  const serverId = getOrCreateServerId(home);
  const storage = new AgentStorage(join(home, "agents"), pino({ level: "silent" }));
  const parentId = crypto.randomUUID();
  const childIds = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of [parentId, ...childIds])
    await storage.upsert({
      id,
      provider: "codex",
      cwd: root,
      workspaceId: "legacy-workspace",
      config: { model: "test" },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastStatus: "closed",
      labels: id === parentId ? {} : { "paseo.parent-agent-id": parentId },
    });
  let qualifications = 0;
  const interrupted = new Subagents({
    home,
    serverId,
    agents: {
      list: () => storage.list(),
      get: (id) => storage.get(id),
      upsert: async (record) => {
        if (++qualifications === 2) throw new Error("Injected qualification write failure");
        await storage.upsert(record);
      },
    },
    resolveAuthority: async () => ({
      principalId: "owner",
      permissions: ["daemon.read", "workspace.read", "workspace.write"],
    }),
    runtime: async () => {
      throw new Error("Upgrade must never acquire a client or submit creation");
    },
  });
  await expect(interrupted.initialize()).rejects.toThrow("Injected qualification write failure");
  const pending = JSON.parse(await readFile(join(home, "subagents.json"), "utf8"));
  expect(pending.legacyUpgrade).toMatchObject({ complete: false, candidates: expect.any(Array) });
  expect(pending.legacyUpgrade.candidates).toHaveLength(2);
  expect((await storage.list()).filter((record) => record.parent)).toHaveLength(1);
  const injectedId = crypto.randomUUID();
  await storage.upsert({
    ...(await storage.get(childIds[0]!))!,
    id: injectedId,
    parent: undefined,
  });
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const origin = await api(restarted);
  const parent = origin.paseo.agents.ref(parentId);
  expect((await parent.subagents.list()).rows.map((row) => row.child.agentId).sort()).toEqual(
    childIds.toSorted(),
  );
  for (const id of childIds)
    expect((await restarted.daemon.agentStorage.get(id))?.parent).toEqual(parent.address);
  expect((await restarted.daemon.agentStorage.get(injectedId))?.parent).toBeUndefined();
  const complete = JSON.parse(await readFile(join(home, "subagents.json"), "utf8"));
  expect(complete.legacyUpgrade.complete).toBe(true);
  expect(complete.legacyUpgrade.candidates).toEqual(pending.legacyUpgrade.candidates);
  const archived: string[] = [];
  const release = restarted.daemon.agentManager.onAgentArchived((id) => {
    archived.push(id);
  });
  try {
    await parent.archive();
    await expect.poll(() => archived.toSorted()).toEqual([parentId, ...childIds].toSorted());
    expect((await restarted.daemon.agentStorage.get(injectedId))?.archivedAt).toBeUndefined();
  } finally {
    release();
  }
});

test("retained derived sessions cannot supply durable principal authority", async () => {
  const a = await daemon();
  const owner = await api(a);
  const parent = await owner.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const permissions = ["daemon.read", "workspace.read", "workspace.write"] as const;
  let available = true;
  const runtime = await a.daemon.createHostRuntime({
    permissionCeiling: permissions,
    resolveAdmission: async () => {
      if (!available)
        throw Object.assign(new Error("Origin authority removed"), { code: "access_denied" });
      return { principalId: "external-principal", permissions };
    },
  });
  cleanup.push(() => runtime.dispose());
  const derived = await runtime.client(parent.serverId);
  cleanup.push(() => derived.dispose());
  const heldParent = derived.agents.ref(parent.id);
  await expect(
    heldParent.subagents.create({ config: { provider: "codex/test" } }),
  ).rejects.toMatchObject({ code: "unsupported_capability" });
  available = false;
  // The derived socket is still alive and readable; it must not become an authority owner.
  expect((await heldParent.refresh())?.agent.id).toBe(parent.id);
  await expect(
    heldParent.subagents.create({ config: { provider: "codex/test" } }),
  ).rejects.toMatchObject({ code: "unsupported_capability" });
  await expect(heldParent.subagents.list()).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  const observation = heldParent.subagents.observe();
  await expect(observation.ready).rejects.toMatchObject({ code: "unsupported_capability" });
  await observation.release();
  expect((await parent.subagents.list()).rows).toEqual([]);
});

test("qualified parent archive preserves workspace and open-tab policy", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  const destination = await api(b);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspaceId = parent.current()!.workspaceId!;
  const other = await origin.paseo.workspaces.create({
    source: { kind: "directory", path: a.staticDir },
  });
  await destination.paseo.workspaces.create({
    workspaceId,
    source: { kind: "directory", path: b.staticDir },
  });
  const same = await parent.subagents.create({ config: { provider: "codex/test" } });
  const separate = await parent.subagents.create({
    workspaceId: other.id,
    config: { provider: "codex/test" },
  });
  const open = await parent.subagents.create({
    config: { provider: "codex/test" },
    labels: { "paseo.open-agent-tab.test": "true" },
  });
  const fleet = await parent.subagents.create({
    serverId: b.daemon.getServerId(),
    workspaceId,
    config: { provider: "codex/test" },
  });
  await parent.archive();
  expect((await same.refresh())?.agent.archivedAt).toEqual(expect.any(String));
  for (const child of [separate, open, fleet]) {
    const snapshot = (await child.refresh())!.agent;
    expect(snapshot.archivedAt).toBeNull();
    expect(snapshot.parent).toBeNull();
  }
  const rows = (await parent.subagents.list()).rows;
  expect(rows.find((row) => row.child.agentId === same.id)?.phase).toBe("archived");
  expect(rows.filter((row) => row.phase === "detached")).toHaveLength(3);
});

test("parent archive retains a truthful detach obligation across unavailable destination and origin restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-pending-detach-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => a.close());
  const b = await daemon();
  const origin = await api(a);
  const destination = await api(b);
  const saved = await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const child = await parent.subagents.create({
    serverId: b.daemon.getServerId(),
    workspaceId: workspace.id,
    config: { provider: "codex/test" },
  });
  await origin.paseo.hosts.update(saved.registrationId, { enabled: false });
  await parent.archive();
  const pending = (await parent.subagents.list()).rows[0]!;
  expect(pending).toMatchObject({
    child: child.address,
    phase: "detach_pending",
    freshness: "unavailable",
  });
  const directChild = destination.paseo.agents.ref(child.id);
  expect((await directChild.refresh())?.agent).toMatchObject({
    parent: parent.address,
    archivedAt: null,
  });
  await expect(origin.paseo.hosts.remove(saved.registrationId)).rejects.toMatchObject({
    code: "relationships_pending",
  });
  await a.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  const restored = next.paseo.agents.ref(parent.id);
  expect((await restored.subagents.list()).rows[0]).toMatchObject({
    child: child.address,
    phase: "detach_pending",
  });
  expect((await directChild.refresh())?.agent.parent).toEqual(parent.address);
  await next.paseo.hosts.update(saved.registrationId, { enabled: true });
  await online(next.paseo);
  await expect.poll(async () => (await restored.subagents.list()).rows[0]?.phase).toBe("detached");
  expect((await directChild.refresh())?.agent).toMatchObject({ parent: null, archivedAt: null });
  expect(
    (await destination.paseo.agents.list({ includeBackground: true })).entries.filter(
      (entry) => entry.agent.id === child.id,
    ),
  ).toHaveLength(1);
});

test("explicit detach stays pending offline and forgetting releases only origin membership", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  const destination = await api(b);
  const saved = await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const backendRuntimeCount = async () =>
    Number(/Host runtimes: (\d+)/.exec((await origin.client.collectDiagnostics()).diagnostic)![1]);
  const beforeRuntimeCount = await backendRuntimeCount();
  const input = {
    serverId: b.daemon.getServerId(),
    workspaceId: workspace.id,
    config: { provider: "codex/test" },
    idempotencyKey: "kept-child",
  };
  const child = await parent.subagents.create(input);
  await origin.paseo.hosts.update(saved.registrationId, { enabled: false });
  expect(await parent.subagents.detach(child.address)).toMatchObject({
    child: child.address,
    phase: "detach_pending",
    freshness: "unavailable",
  });
  const directChild = destination.paseo.agents.ref(child.id);
  expect((await directChild.refresh())?.agent).toMatchObject({
    parent: parent.address,
    archivedAt: null,
  });
  await parent.subagents.forget(child.address);
  expect((await parent.subagents.list()).rows).toEqual([]);
  await expect.poll(backendRuntimeCount).toBe(beforeRuntimeCount);
  await origin.paseo.hosts.remove(saved.registrationId);
  expect((await directChild.refresh())?.agent).toMatchObject({
    parent: parent.address,
    archivedAt: null,
  });
  await expect(parent.subagents.create(input)).rejects.toMatchObject({
    code: "relationship_forgotten",
  });
});

test.each(["forget", "archive"] as const)(
  "a delayed creation response cannot overwrite newer %s intent",
  async (intent) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-delayed-intent-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
    cleanup.push(() => a.close());
    const b = await daemon();
    const wire = await hostWire(b);
    const origin = await api(a);
    const destination = await api(b);
    await origin.paseo.hosts.add({ connection: wire.connection });
    await online(origin.paseo);
    const parent = await origin.paseo.agents.create({
      cwd: a.staticDir,
      config: { provider: "codex/test" },
    });
    const workspace = await destination.paseo.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const heldCreation = wire.holdResponses((message) => message.type === "agent.create.response");
    const creating = parent.subagents.create({
      serverId: b.daemon.getServerId(),
      workspaceId: workspace.id,
      config: { provider: "codex/test" },
      idempotencyKey: "delayed",
    });
    void creating.catch(() => {});
    await Promise.race([
      heldCreation.ready,
      creating.then(() => {
        throw new Error("Creation resolved before its response was held");
      }),
    ]);
    const row = (await parent.subagents.list()).rows[0]!;
    expect(row.phase).toBe("creating");
    if (intent === "forget") await parent.subagents.forget(row.child);
    else await parent.archive();
    const responsesBeforeCompletion = wire.responses.length;
    const heldRefresh = wire.holdResponses((message) => message.type === "fetch_agent_response");
    heldCreation.release();
    // The completion can start ordinary reads, but must preserve the already committed lifecycle decision.
    await heldRefresh.ready;
    const directory = await parent.subagents.list();
    heldRefresh.release();
    const created = await creating;
    if (intent === "forget") expect(directory.rows).toEqual([]);
    else expect(directory.rows[0]?.phase).toBe("detached");
    expect(created.address).toEqual(row.child);
    expect(
      wire.responses
        .slice(responsesBeforeCompletion)
        .filter(
          (message) => message.type === "fetch_agents_response" && message.payload.subscriptionId,
        ),
    ).toEqual([]);
    if (intent === "forget") {
      await parent.archive();
      expect(
        (await destination.paseo.agents.ref(row.child.agentId).refresh())?.agent.archivedAt,
      ).toBeNull();
    }
    await a.close();
    const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
    cleanup.push(() => restarted.close());
    const next = await api(restarted);
    const restored = next.paseo.agents.ref(parent.id);
    if (intent === "forget") {
      expect((await restored.subagents.list()).rows).toEqual([]);
      await restored.archive();
      expect(
        (await destination.paseo.agents.ref(row.child.agentId).refresh())?.agent.archivedAt,
      ).toBeNull();
    } else expect((await restored.subagents.list()).rows[0]?.phase).toBe("detached");
  },
);

test("forget remains authoritative while a child snapshot observation is being established", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-refresh-intent-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => a.close());
  const b = await daemon();
  const wire = await hostWire(b);
  const origin = await api(a);
  const destination = await api(b);
  await origin.paseo.hosts.add({ connection: wire.connection });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const held = wire.holdResponses((message) => message.type === "fetch_agents_response");
  const child = await parent.subagents.create({
    serverId: b.daemon.getServerId(),
    workspaceId: workspace.id,
    config: { provider: "codex/test" },
  });
  const directChild = destination.paseo.agents.ref(child.id);
  await directChild.detach();

  await held.ready;
  const forgetting = parent.subagents.forget(child.address);
  await expect.poll(async () => (await parent.subagents.list()).rows.length).toBe(0);
  held.release();
  await forgetting;
  expect((await parent.subagents.list()).rows).toEqual([]);
  await parent.archive();
  expect((await directChild.refresh())?.agent.archivedAt).toBeNull();
  await a.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  expect((await next.paseo.agents.ref(parent.id).subagents.list()).rows).toEqual([]);
});

test("run checkpoints retain submission identity, permission/resume and terminal results across destination restart", async () => {
  const a = await daemon();
  const root = await mkdtemp(join(tmpdir(), "paseo-run-checkpoint-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const b = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => b.close());
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  const target = await runtime.client(b.daemon.getServerId());
  cleanup.push(() => target.dispose());
  const child = await target.agents.create({
    cwd: b.staticDir,
    config: { provider: "codex/test", modeId: "default" },
  });
  expect(await child.runs.get("never-submitted")).toBeNull();
  await child.send("Reply with CHECKPOINT_FIRST", { messageId: "first-submission" });
  await expect
    .poll(async () => (await child.runs.get("first-submission"))?.status)
    .toBe("completed");
  const first = (await child.runs.get("first-submission"))!;
  expect(first).toMatchObject({
    agent: child.address,
    submissionId: "first-submission",
    turnId: expect.any(String),
    status: "completed",
  });
  expect(first.checkpoints.at(-1)).toMatchObject({ kind: "completed", result: expect.any(String) });
  await child.send('printf "ok" > permission.txt', { messageId: "permission-submission" });
  await expect
    .poll(async () => (await child.runs.get("permission-submission"))?.status)
    .toBe("permission");
  const permission = (await child.refresh())!.agent.pendingPermissions[0]!;
  expect((await child.runs.get("permission-submission"))?.checkpoints.at(-1)).toMatchObject({
    kind: "permission",
    permissionRequestId: permission.id,
  });
  await child.respondToPermission({ requestId: permission.id, response: { behavior: "allow" } });
  await expect
    .poll(async () => (await child.runs.get("permission-submission"))?.status)
    .toBe("completed");
  const second = (await child.runs.get("permission-submission"))!;
  expect(second.turnId).not.toBe(first.turnId);
  expect(second.checkpoints.map((checkpoint) => checkpoint.kind)).toEqual(
    expect.arrayContaining(["submitted", "running", "permission", "resumed", "completed"]),
  );
  expect(await child.runs.get("first-submission")).toEqual(first);
  await b.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  const restored = next.paseo.agents.ref(child.id);
  expect(await restored.runs.get("first-submission")).toEqual(first);
  expect(await restored.runs.get("permission-submission")).toEqual(second);
  expect(await restored.runs.get("never-submitted")).toBeNull();
});

test.each(["detach", "archive"] as const)(
  "ordinary child %s confirms terminal membership and releases the relationship observation",
  async (action) => {
    const a = await daemon();
    const b = await daemon();
    const origin = await api(a);
    const destination = await api(b);
    await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await online(origin.paseo);
    const count = async () =>
      Number(
        /Host runtimes: (\d+)/.exec((await origin.client.collectDiagnostics()).diagnostic)![1],
      );
    const before = await count();
    const parent = await origin.paseo.agents.create({
      cwd: a.staticDir,
      config: { provider: "codex/test" },
    });
    const workspace = await destination.paseo.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    const child = await parent.subagents.create({
      serverId: b.daemon.getServerId(),
      workspaceId: workspace.id,
      config: { provider: "codex/test" },
    });
    await destination.paseo.agents.ref(child.id)[action]();
    await expect
      .poll(async () => (await parent.subagents.list()).rows[0]?.phase)
      .toBe(action === "detach" ? "detached" : "archived");
    await expect.poll(count).toBe(before);
  },
);

test("run result never inherits an earlier turn answer when the next turn fails without output", async () => {
  const instance = await daemon();
  const { paseo } = await api(instance);
  const agent = await paseo.agents.create({
    cwd: instance.staticDir,
    config: { provider: "codex/test" },
  });
  await agent.send("Reply with FIRST_ANSWER", { messageId: "answered" });
  await expect.poll(async () => (await agent.runs.get("answered"))?.status).toBe("completed");
  expect((await agent.runs.get("answered"))?.checkpoints.at(-1)?.result).not.toBe("");
  await agent.send("Emit a turn failure", { messageId: "empty-failure" });
  await expect.poll(async () => (await agent.runs.get("empty-failure"))?.status).toBe("failed");
  expect((await agent.runs.get("empty-failure"))?.checkpoints.at(-1)).toMatchObject({
    kind: "failed",
    result: "",
  });
});

test("permission run across destination restart exposes interrupted evidence without replaying its prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-interrupted-run-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => first.close());
  const origin = await api(first);
  const agent = await origin.paseo.agents.create({
    cwd: first.staticDir,
    config: { provider: "codex/test", modeId: "default" },
  });
  await agent.send('printf "ok" > interrupted.txt', { messageId: "unfinished" });
  await expect.poll(async () => (await agent.runs.get("unfinished"))?.status).toBe("permission");
  const before = (await agent.runs.get("unfinished"))!;
  await first.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  const restored = next.paseo.agents.ref(agent.id);
  const run = await restored.runs.get("unfinished");
  expect(run).toMatchObject({
    agent: agent.address,
    submissionId: "unfinished",
    turnId: before.turnId,
    status: "interrupted",
  });
  expect(run?.checkpoints.slice(0, -1)).toEqual(before.checkpoints);
  expect(run?.checkpoints.at(-1)).toMatchObject({ kind: "interrupted" });
  expect(await restored.runs.get("unfinished")).toEqual(run);
});

test("provider admission survives a journal write failure without being reported as a rejected turn", async () => {
  let journalPath = "";
  let release!: () => void;
  const terminalGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(async () => release());
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: () => {
        rmSync(journalPath);
        mkdirSync(journalPath);
      },
      beforeTurnComplete: () => terminalGate,
    }),
  });
  cleanup.push(() => instance.close());
  const { paseo } = await api(instance);
  const agent = await paseo.agents.create({
    cwd: instance.staticDir,
    config: { provider: "codex/test" },
  });
  journalPath = join(
    instance.paseoHome,
    "agent-runs",
    `${createHash("sha256").update(agent.id).digest("hex")}.json`,
  );
  await agent.send("Reply with ADMITTED_ONCE", { messageId: "accepted-with-storage-failure" });
  const run = await agent.runs.get("accepted-with-storage-failure");
  expect(run).toMatchObject({ status: "running", turnId: expect.any(String) });
  expect(run?.checkpoints.map((checkpoint) => checkpoint.kind)).not.toContain("failed");
  rmSync(journalPath, { recursive: true });
  release();
  await expect
    .poll(async () => (await agent.runs.get("accepted-with-storage-failure"))?.status)
    .toBe("completed");
});

test("terminal checkpoint storage failure preserves provider completion and retries durable evidence", async () => {
  let journalPath = "";
  let release!: () => void;
  let reached!: () => void;
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(async () => release());
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeTurnComplete: async () => {
        reached();
        await gate;
        await rm(journalPath);
        await mkdir(journalPath);
      },
    }),
  });
  cleanup.push(() => instance.close());
  const { paseo } = await api(instance);
  const agent = await paseo.agents.create({
    cwd: instance.staticDir,
    config: { provider: "codex/test" },
  });
  journalPath = join(
    instance.paseoHome,
    "agent-runs",
    `${createHash("sha256").update(agent.id).digest("hex")}.json`,
  );
  await agent.send("Reply with TERMINAL_EVIDENCE", { messageId: "terminal-storage-failure" });
  await ready;
  const finished = agent.waitForFinish(2000);
  release();
  expect((await finished).status).toBe("idle");
  expect(await agent.runs.get("terminal-storage-failure")).toMatchObject({
    status: "completed",
    durability: "pending",
  });
  await rm(journalPath, { recursive: true });
  expect(await agent.runs.get("terminal-storage-failure")).toMatchObject({
    status: "completed",
    durability: "persisted",
  });
});

test("creation cancellation survives destination restart and fences delayed submissions by reserved identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-create-cancel-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const first = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => first.close());
  const origin = await api(first);
  const agentId = crypto.randomUUID();
  const idempotencyKey = "reserved-before-admission";
  expect(await origin.paseo.creations.cancel({ kind: "agent", agentId, idempotencyKey })).toEqual({
    status: "canceled",
    reservation: {
      kind: "agent",
      reservedAgent: { serverId: first.daemon.getServerId(), agentId },
    },
  });
  await expect(
    origin.paseo.creations.cancel({ kind: "agent", agentId: crypto.randomUUID(), idempotencyKey }),
  ).rejects.toMatchObject({ code: "agent_request_key_conflict" });
  const viewer = createHostClient(`127.0.0.1:${first.port}`, {
    clientId: crypto.randomUUID(),
    sessionPermissions: ["daemon.read", "workspace.read"],
    reconnect: { enabled: false },
  });
  cleanup.push(() => viewer.close());
  await viewer.connect();
  const viewerApi = createPaseoApi(viewer);
  cleanup.push(() => viewerApi.dispose());
  await expect(
    viewerApi.creations.cancel({
      kind: "agent",
      agentId: crypto.randomUUID(),
      idempotencyKey: "unauthorized-cancellation",
    }),
  ).rejects.toMatchObject({ code: "access_denied" });
  await first.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  await expect(
    next.paseo.agents.create({
      agentId,
      idempotencyKey,
      cwd: restarted.staticDir,
      config: { provider: "codex/test" },
      prompt: "Never execute this delayed submission",
    }),
  ).rejects.toMatchObject({ code: "creation_canceled" });
  await expect(
    next.paseo.agents.create({
      agentId: crypto.randomUUID(),
      idempotencyKey,
      cwd: restarted.staticDir,
      config: { provider: "codex/test" },
    }),
  ).rejects.toMatchObject({ code: "agent_request_key_conflict" });
  expect(await next.paseo.agents.ref(agentId).refresh()).toBeNull();
  expect(
    await next.paseo.creations.cancel({ kind: "agent", agentId, idempotencyKey }),
  ).toMatchObject({
    status: "canceled",
  });
});

test("creation cancellation reports admitted work before provider resource readiness and never overwrites its runner", async () => {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  cleanup.push(async () => release());
  let prompts = 0;
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (!config.internal) {
          reached();
          await gate;
        }
      },
      onStartTurn: (_prompt, config) => {
        if (!config.internal) prompts++;
      },
    }),
  });
  cleanup.push(() => instance.close());
  const { paseo } = await api(instance);
  const agentId = crypto.randomUUID();
  const idempotencyKey = "admitted-before-cancel";
  const creating = paseo.agents.create({
    agentId,
    idempotencyKey,
    cwd: instance.staticDir,
    config: { provider: "codex/test" },
    prompt: "Execute exactly once",
  });
  void creating.catch(() => {});
  await ready;
  const cancellation = await paseo.creations.cancel({ kind: "agent", agentId, idempotencyKey });
  expect(cancellation).toMatchObject({
    status: "admitted",
    reservation: {
      kind: "agent",
      reservedAgent: { serverId: instance.daemon.getServerId(), agentId },
    },
    creation: { agentId, phase: "accepted" },
  });
  expect(cancellation.status === "admitted" && cancellation.creation.agent).toBeUndefined();
  release();
  await creating;
  expect(await paseo.creations.cancel({ kind: "agent", agentId, idempotencyKey })).toMatchObject({
    status: "admitted",
    creation: { phase: "completed" },
  });
  expect(prompts).toBe(1);
  const observation = paseo.creations.observe({ kind: "agent", idempotencyKey });
  expect((await observation.ready).snapshot).toMatchObject({ phase: "completed", agentId });
  await observation.release();
});

test.each(["agent", "workspace"] as const)(
  "parent archive cancels an unadmitted %s creation after origin restart without stray resources",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "paseo-unadmitted-child-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
    cleanup.push(() => a.close());
    const b = await daemon();
    const origin = await api(a);
    const destination = await api(b);
    const saved = await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
    await online(origin.paseo);
    const parent = await origin.paseo.agents.create({
      cwd: a.staticDir,
      config: { provider: "codex/test" },
    });
    const workspace = await destination.paseo.workspaces.create({
      source: { kind: "directory", path: b.staticDir },
    });
    await origin.paseo.hosts.update(saved.registrationId, { enabled: false });
    await expect(
      parent.subagents.create({
        serverId: b.daemon.getServerId(),
        ...(kind === "workspace"
          ? {
              workspace: { source: { kind: "directory" as const, path: b.staticDir } },
              cwd: b.staticDir,
            }
          : { workspaceId: workspace.id }),
        config: { provider: "codex/test" },
        idempotencyKey: "unadmitted",
        prompt: "Must never be replayed",
      }),
    ).rejects.toMatchObject({ code: "host_disabled" });
    const row = (await parent.subagents.list()).rows[0]!;
    expect(row.phase).toBe("creating");
    expect(await destination.paseo.agents.ref(row.child.agentId).refresh()).toBeNull();
    await parent.archive();
    expect((await parent.subagents.list()).rows[0]?.phase).toBe("detach_pending");
    await a.close();
    const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
    cleanup.push(() => restarted.close());
    const next = await api(restarted);
    const restored = next.paseo.agents.ref(parent.id);
    await next.paseo.hosts.update(saved.registrationId, { enabled: true });
    await online(next.paseo);
    await expect
      .poll(async () => (await restored.subagents.list()).rows[0]?.phase)
      .toBe("canceled");
    expect(await destination.paseo.agents.ref(row.child.agentId).refresh()).toBeNull();
    if (kind === "workspace") {
      const delayed = await destination.client.createWorkspace({
        idempotencyKey: `subagent:${row.id}`,
        workspaceId: row.workspace!.workspaceId,
        source: { kind: "directory", path: b.staticDir },
        agent: {
          agentId: row.child.agentId,
          config: { provider: "codex", cwd: b.staticDir },
          initialPrompt: "Must never be replayed",
        },
      });
      expect(delayed).toMatchObject({ workspace: null, errorCode: "creation_canceled" });
      expect(
        (await destination.paseo.workspaces.list()).entries.some(
          (entry) => entry.id === row.workspace!.workspaceId,
        ),
      ).toBe(false);
    }
    await next.paseo.hosts.remove(saved.registrationId);
  },
);

test("parent lifecycle recovers an admitted creation that becomes ready after origin restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-admitted-child-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const a = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => a.close());
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  cleanup.push(async () => release());
  const b = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (!config.internal) {
          reached();
          await gate;
        }
      },
    }),
  });
  cleanup.push(() => b.close());
  const origin = await api(a);
  const destination = await api(b);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  const creating = parent.subagents.create({
    serverId: b.daemon.getServerId(),
    workspaceId: workspace.id,
    config: { provider: "codex/test" },
    idempotencyKey: "admitted-child",
    prompt: "Run once after admission",
  });
  void creating.catch(() => {});
  await ready;
  const row = (await parent.subagents.list()).rows[0]!;
  await parent.archive();
  expect((await parent.subagents.list()).rows[0]).toMatchObject({
    phase: "detach_pending",
    error: { code: "creation_pending" },
  });
  await a.close();
  const restarted = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  await online(next.paseo);
  const restored = next.paseo.agents.ref(parent.id);
  await expect
    .poll(async () => (await restored.subagents.list()).rows[0]?.error?.code)
    .toBe("creation_pending");
  release();
  await expect.poll(async () => (await restored.subagents.list()).rows[0]?.phase).toBe("detached");
  expect((await destination.paseo.agents.ref(row.child.agentId).refresh())?.agent).toMatchObject({
    parent: null,
    archivedAt: null,
  });
});

test("failed admitted creation exposes its failure through lifecycle recovery and forget releases its receipt observation", async () => {
  const a = await daemon();
  let attempts = 0;
  const b = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (!config.internal) {
          attempts++;
          throw new Error("Provider startup rejected before resource creation");
        }
      },
    }),
  });
  cleanup.push(() => b.close());
  const origin = await api(a);
  const destination = await api(b);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const parent = await origin.paseo.agents.create({
    cwd: a.staticDir,
    config: { provider: "codex/test" },
  });
  const workspace = await destination.paseo.workspaces.create({
    source: { kind: "directory", path: b.staticDir },
  });
  await expect(
    parent.subagents.create({
      serverId: b.daemon.getServerId(),
      workspaceId: workspace.id,
      config: { provider: "codex/test" },
      idempotencyKey: "failed-admitted",
    }),
  ).rejects.toThrow("Provider startup rejected");
  const row = (await parent.subagents.list()).rows[0]!;
  await parent.archive();
  expect((await parent.subagents.list()).rows[0]).toMatchObject({
    phase: "detach_pending",
    freshness: "current",
    error: {
      code: "creation_failed",
      message: expect.stringContaining("Provider startup rejected"),
    },
  });
  expect(attempts).toBe(1);
  await parent.subagents.forget(row.child);
  await expect
    .poll(async () =>
      Number(
        /Host runtimes: (\d+)/.exec((await origin.client.collectDiagnostics()).diagnostic)![1],
      ),
    )
    .toBe(0);
  expect((await parent.subagents.list()).rows).toEqual([]);
  expect(attempts).toBe(1);
});

test("shared control and automation capabilities follow the same qualified workflow on every destination", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  const agentId = crypto.randomUUID();
  for (const destination of [a, b]) {
    const target = await runtime.client(destination.daemon.getServerId());
    cleanup.push(() => target.dispose());
    const agent = await target.agents.create({
      agentId,
      cwd: destination.staticDir,
      config: { provider: "codex/test", modeId: "default" },
    });
    await agent.update({ name: `Target ${agent.serverId}`, labels: { test: "qualified" } });
    await agent.setMode("default");
    expect((await agent.refresh())?.agent).toMatchObject({
      title: `Target ${agent.serverId}`,
      labels: { test: "qualified" },
      currentModeId: "default",
    });
    await agent.send('printf "ok" > sdk-control.txt', { messageId: "control-permission" });
    await expect
      .poll(async () => (await agent.runs.get("control-permission"))?.status)
      .toBe("permission");
    expect(await agent.cancel()).toEqual({ cancelled: true });
    expect(await agent.cancel()).toEqual({ cancelled: false });
    await expect
      .poll(async () => (await agent.runs.get("control-permission"))?.status)
      .toBe("canceled");
    const workspace = target.workspaces.ref((await agent.refresh())!.agent.workspaceId!);
    expect((await workspace.scripts.list()).scripts).toEqual([]);
    const created = await target.schedules.create({
      prompt: "Automation belongs to this destination",
      cadence: { type: "cron", expression: "0 0 * * *" },
      target: { type: "agent", agentId },
      runOnCreate: false,
    });
    expect(created.error).toBeNull();
    const id = created.schedule!.id;
    expect((await target.schedules.inspect({ id })).schedule?.target).toEqual({
      type: "agent",
      agentId,
    });
    expect((await target.schedules.pause({ id })).schedule?.status).toBe("paused");
    expect((await target.schedules.resume({ id })).schedule?.status).toBe("active");
    await target.schedules.delete({ id });
    await agent.close();
    expect(await agent.refresh()).not.toBeNull();
  }
});

test("disposing a same-server scope fences captured workspace scripts while sibling and origin remain usable", async () => {
  const instance = await daemon();
  await writeFile(
    join(instance.staticDir, "paseo.json"),
    JSON.stringify({
      scripts: {
        fixture: {
          type: "service",
          command: `node -e "require('node:fs').writeFileSync('scope-effect.txt','started')"`,
        },
      },
    }),
  );
  const origin = await api(instance);
  const workspace = await origin.paseo.workspaces.create({
    source: { kind: "directory", path: instance.staticDir },
  });
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  const scope = await runtime.client(instance.daemon.getServerId());
  const sibling = await runtime.client(instance.daemon.getServerId());
  cleanup.push(() => sibling.dispose());
  const captured = scope.workspaces.ref(workspace.id);
  expect((await captured.scripts.list()).scripts.map((script) => script.scriptName)).toContain(
    "fixture",
  );
  await scope.dispose();
  await expect(Promise.resolve().then(() => captured.scripts.start("fixture"))).rejects.toThrow(
    "disposed",
  );
  await expect(Promise.resolve().then(() => captured.scripts.stop("fixture"))).rejects.toThrow(
    "disposed",
  );
  await expect(Promise.resolve().then(() => captured.scripts.list())).rejects.toThrow("disposed");
  expect(
    (await sibling.workspaces.ref(workspace.id).scripts.list()).scripts.map(
      (script) => script.scriptName,
    ),
  ).toContain("fixture");
  expect(
    (await origin.paseo.workspaces.ref(workspace.id).scripts.list()).scripts.map(
      (script) => script.scriptName,
    ),
  ).toContain("fixture");
  await expect(stat(join(instance.staticDir, "scope-effect.txt"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("ordinary sends suppress archived recipients on every destination without starting tracked work", async () => {
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  for (const destination of [a, b]) {
    const target = await runtime.client(destination.daemon.getServerId());
    cleanup.push(() => target.dispose());
    const agent = await target.agents.create({
      cwd: destination.staticDir,
      config: { provider: "codex/test" },
    });
    await agent.archive();
    const dispatch = await agent.send("Do not wake this archived recipient", {
      messageId: "suppressed-delivery",
      unarchive: false,
      activeTurnBehavior: "steer",
    });
    expect((await agent.refresh())?.agent.archivedAt).toBeTruthy();
    expect(dispatch).toMatchObject({
      submissionId: "suppressed-delivery",
      disposition: "suppressed",
      tracking: "unavailable",
    });
    expect(await agent.runs.get("suppressed-delivery")).toBeNull();
    expect(
      await agent.send("Do not wake this archived recipient", {
        messageId: "suppressed-delivery",
        unarchive: false,
        activeTurnBehavior: "steer",
      }),
    ).toEqual(dispatch);
  }
});

test("accepted steering and out-of-band sends expose actual tracking on every destination", async () => {
  let release!: () => void;
  const terminal = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(async () => release());
  let starts = 0;
  let commands = 0;
  const clients = () =>
    createTestAgentClients({
      onStartTurn: () => {
        starts++;
      },
      beforeTurnComplete: () => terminal,
      steerActiveTurn: async () => ({ status: "accepted" }),
      tryHandleOutOfBand: (prompt) =>
        prompt === "/side-effect"
          ? {
              run: async () => {
                commands++;
              },
            }
          : null,
    });
  const a = await createTestPaseoDaemon({ agentClients: clients() });
  const b = await createTestPaseoDaemon({ agentClients: clients() });
  // Shutdown must not wait on a deliberately held provider completion.
  cleanup.push(() => a.close());
  cleanup.push(() => b.close());
  const origin = await api(a);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  await online(origin.paseo);
  const runtime = origin.paseo.hosts.runtime();
  cleanup.push(() => runtime.dispose());
  const agents = [];
  try {
    for (const destination of [a, b]) {
      const target = await runtime.client(destination.daemon.getServerId());
      cleanup.push(() => target.dispose());
      const agent = await target.agents.create({
        cwd: destination.staticDir,
        config: { provider: "codex/test" },
      });
      agents.push(agent);
      const checkpoints: string[] = [];
      const observing = agent.runs.observe("accepted-steer");
      cleanup.push(() => observing.release());
      observing.subscribe({
        snapshot: ({ run }) => {
          if (run) checkpoints.push(run.status);
        },
        update: () => {},
      });
      expect((await observing.ready).run).toBeNull();
      expect(await agent.send("Reply with initial output", { messageId: "initial" })).toMatchObject(
        { disposition: "turn_started", tracking: "turn" },
      );
      expect(
        await agent.send("Continue the existing turn", {
          messageId: "accepted-steer",
          activeTurnBehavior: "steer",
        }),
      ).toMatchObject({ disposition: "steered", tracking: "turn" });
      await expect.poll(() => checkpoints).toContain("running");
      expect((await agent.runs.get("accepted-steer"))?.turnId).toBe(
        (await agent.runs.get("initial"))?.turnId,
      );
      const command = await agent.send("/side-effect", { messageId: "accepted-command" });
      expect(command).toMatchObject({ disposition: "out_of_band", tracking: "unavailable" });
      expect(await agent.runs.get("accepted-command")).toBeNull();
      expect(await agent.send("/side-effect", { messageId: "accepted-command" })).toEqual(command);
    }
    expect(starts).toBe(2);
    expect(commands).toBe(2);
    release();
    for (const agent of agents) {
      await expect
        .poll(async () => (await agent.runs.get("accepted-steer"))?.status)
        .toBe("completed");
      expect((await agent.runs.get("initial"))?.status).toBe("completed");
      const completed = agent.runs.observe("accepted-steer");
      expect((await completed.ready).run?.status).toBe("completed");
      await completed.release();
    }
  } finally {
    release();
  }
});

test("pending message receipt across restart exposes unknown delivery and conflict without resending", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-message-receipt-restart-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let directory = "";
  let starts = 0;
  let injectFailure = true;
  const clients = () =>
    createTestAgentClients({
      onStartTurn: () => {
        starts++;
        if (!injectFailure) return;
        injectFailure = false;
        renameSync(directory, `${directory}.saved`);
        writeFileSync(directory, "Receipt storage temporarily unavailable");
      },
    });
  const first = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: clients(),
  });
  cleanup.push(() => first.close());
  directory = join(first.paseoHome, "agent-requests");
  const origin = await api(first);
  const agent = await origin.paseo.agents.create({
    cwd: first.staticDir,
    config: { provider: "codex/test" },
  });
  try {
    await expect(agent.send("Reply once", { messageId: "uncertain" })).rejects.toMatchObject({
      code: "agent_request_outcome_unknown",
      outcome: "unknown",
    });
  } finally {
    rmSync(directory, { force: true });
    renameSync(`${directory}.saved`, directory);
  }
  await first.close();
  const restarted = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: clients(),
  });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  const restored = next.paseo.agents.ref(agent.id);
  await expect(restored.send("Reply once", { messageId: "uncertain" })).rejects.toMatchObject({
    code: "agent_request_outcome_unknown",
    outcome: "unknown",
  });
  const conflict = await restored
    .send("Different request", { messageId: "uncertain" })
    .catch((error: unknown) => error);
  expect(conflict).toMatchObject({ code: "agent_request_key_conflict" });
  expect(conflict).not.toHaveProperty("outcome", "unknown");
  expect(starts).toBe(1);
});

test.each([false, true])(
  "archiving a parent completes its schedule and children despite failing observer: %s",
  async (failing) => {
    const instance = await daemon();
    const { paseo } = await api(instance);
    const parent = await paseo.agents.create({
      cwd: instance.staticDir,
      config: { provider: "codex/test" },
    });
    const child = await parent.subagents.create({ config: { provider: "codex/test" } });
    const schedule = await paseo.schedules.create({
      prompt: "Scheduled parent work",
      cadence: { type: "cron", expression: "0 0 * * *" },
      target: { type: "agent", agentId: parent.id },
      runOnCreate: false,
    });
    expect(schedule.error).toBeNull();
    const stop = instance.daemon.agentManager.onAgentArchived(() => {
      if (failing) throw new Error("Independent listener failed");
    });
    cleanup.push(async () => stop());
    await parent.archive();
    expect((await paseo.schedules.inspect({ id: schedule.schedule!.id })).schedule?.status).toBe(
      "completed",
    );
    expect((await parent.subagents.list()).rows[0]).toMatchObject({
      child: child.address,
      phase: "archived",
    });
    expect((await child.refresh())?.agent.archivedAt).toBeTruthy();
  },
);

test("parented modern creation retains one reserved identity and exact child directory across retries", async () => {
  let prompts = 0;
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: () => {
        prompts++;
      },
    }),
  });
  cleanup.push(() => instance.close());
  const origin = await api(instance);
  const parent = await origin.paseo.agents.create({
    cwd: instance.staticDir,
    config: { provider: "codex/test" },
  });
  const directory = join(instance.staticDir, "nested-child");
  await mkdir(directory);
  const request = {
    agentId: crypto.randomUUID(),
    idempotencyKey: "parented-original-key",
    callerAgentId: parent.id,
    config: { provider: "codex", model: "test", cwd: directory },
    initialPrompt: "Reply once for this child",
    clientMessageId: "original-initial-prompt",
  };
  const child = await origin.client.createAgent(request);
  expect(child).toMatchObject({ id: request.agentId, cwd: directory, parent: parent.address });
  expect((await parent.subagents.list()).rows).toHaveLength(1);
  expect((await origin.client.createAgent(request)).id).toBe(child.id);
  expect(prompts).toBe(1);
});

test("parented workspace creation retains its original receipt and both resources across retry", async () => {
  const prompts: AgentPromptInput[] = [];
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      onStartTurn: (prompt, config) => {
        if (!config.internal) prompts.push(prompt);
      },
    }),
  });
  cleanup.push(() => instance.close());
  const origin = await api(instance);
  const parent = await origin.paseo.agents.create({
    cwd: instance.staticDir,
    config: { provider: "codex/test" },
  });
  const directory = join(instance.staticDir, "workspace-child");
  await mkdir(directory);
  const workspaceId = "wks_0123456789abcdef";
  const agentId = crypto.randomUUID();
  const request = {
    idempotencyKey: "original-workspace-key",
    workspaceId,
    source: { kind: "directory" as const, path: instance.staticDir },
    agent: {
      agentId,
      callerAgentId: parent.id,
      config: { provider: "codex", model: "test", cwd: directory },
      initialPrompt: "Reply once from workspace child",
      clientMessageId: "workspace-initial",
    },
  };
  const created = await origin.client.createWorkspace(request);
  expect(created.error).toBeNull();
  expect(created.workspace?.id).toBe(workspaceId);
  const child = origin.paseo.agents.ref(agentId);
  expect((await child.refresh())?.agent).toMatchObject({
    workspaceId,
    cwd: directory,
    parent: parent.address,
  });
  expect((await parent.subagents.list()).rows).toHaveLength(1);
  const repeated = await origin.client.createWorkspace(request);
  expect(repeated.workspace?.id).toBe(workspaceId);
  expect(prompts).toHaveLength(1);
  expect(JSON.stringify(prompts[0])).toContain(request.agent.initialPrompt);
  const receipt = origin.paseo.creations.observe({
    kind: "workspace",
    idempotencyKey: request.idempotencyKey,
  });
  expect((await receipt.ready).snapshot).toMatchObject({
    kind: "workspace",
    agentId,
    workspaceId,
    phase: "completed",
  });
  await receipt.release();
});

test("workspace creation cancellation fences both resources across restart without crossing key namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-creation-cancel-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  let starts = 0;
  const clients = () =>
    createTestAgentClients({
      onStartTurn: () => {
        starts++;
      },
    });
  const first = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: clients(),
  });
  cleanup.push(() => first.close());
  const origin = await api(first);
  const idempotencyKey = "same-textual-key";
  const workspaceId = "wks_1234567890abcdef";
  const agentId = crypto.randomUUID();
  const reservation = { kind: "workspace" as const, workspaceId, agentId, idempotencyKey };
  expect(await origin.paseo.creations.cancel(reservation)).toMatchObject({
    status: "canceled",
    reservation: {
      kind: "workspace",
      reservedAgent: { serverId: first.daemon.getServerId(), agentId },
      reservedWorkspace: { serverId: first.daemon.getServerId(), workspaceId },
    },
  });
  for (const mismatch of [
    { ...reservation, agentId: crypto.randomUUID() },
    { ...reservation, workspaceId: "wks_1234567890abcdee" },
  ])
    await expect(origin.paseo.creations.cancel(mismatch)).rejects.toMatchObject({
      code: "agent_request_key_conflict",
    });
  const independent = await origin.paseo.agents.create({
    idempotencyKey,
    cwd: first.staticDir,
    config: { provider: "codex/test" },
  });
  expect(independent.id).not.toBe(agentId);
  const request = {
    idempotencyKey,
    workspaceId,
    source: { kind: "directory" as const, path: first.staticDir },
    agent: {
      agentId,
      config: { provider: "codex", model: "test", cwd: first.staticDir },
      initialPrompt: "Must never run",
    },
  };
  expect(await origin.client.createWorkspace(request)).toMatchObject({
    errorCode: "creation_canceled",
    workspace: null,
  });
  await first.close();
  const restarted = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: clients(),
  });
  cleanup.push(() => restarted.close());
  const next = await api(restarted);
  expect(await next.client.createWorkspace(request)).toMatchObject({
    errorCode: "creation_canceled",
    workspace: null,
  });
  expect(
    (await next.paseo.workspaces.list()).entries.some((workspace) => workspace.id === workspaceId),
  ).toBe(false);
  expect(await next.paseo.agents.ref(agentId).refresh()).toBeNull();
  expect(starts).toBe(0);
});

test("admitted workspace cancellation returns its existing receipt and leaves its runner intact", async () => {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    reached = resolve;
  });
  cleanup.push(async () => release());
  let prompts = 0;
  const instance = await createTestPaseoDaemon({
    agentClients: createTestAgentClients({
      beforeCreateSession: async (config) => {
        if (!config.internal) {
          reached();
          await gate;
        }
      },
      onStartTurn: (_prompt, config) => {
        if (!config.internal) prompts++;
      },
    }),
  });
  cleanup.push(() => instance.close());
  const origin = await api(instance);
  const agentId = crypto.randomUUID();
  const workspaceId = "wks_abcdef0123456789";
  const idempotencyKey = "workspace-won-admission";
  const request = {
    idempotencyKey,
    workspaceId,
    source: { kind: "directory" as const, path: instance.staticDir },
    agent: {
      agentId,
      config: { provider: "codex", model: "test", cwd: instance.staticDir },
      initialPrompt: "Run once after admission",
    },
  };
  const creating = origin.client.createWorkspace(request);
  void creating.catch(() => {});
  try {
    await ready;
    expect(
      await origin.paseo.creations.cancel({
        kind: "workspace",
        idempotencyKey,
        workspaceId,
        agentId,
      }),
    ).toMatchObject({
      status: "admitted",
      creation: { kind: "workspace", workspaceId, agentId, phase: "workspace_ready" },
    });
    await expect(
      origin.paseo.creations.cancel({
        kind: "workspace",
        idempotencyKey,
        workspaceId: "wks_abcdef0123456788",
        agentId,
      }),
    ).rejects.toMatchObject({ code: "agent_request_key_conflict" });
    expect(
      await origin.paseo.creations.cancel({ kind: "agent", idempotencyKey, agentId }),
    ).toMatchObject({ status: "canceled", reservation: { kind: "agent" } });
    release();
    expect((await creating).workspace?.id).toBe(workspaceId);
    expect(prompts).toBe(1);
    expect(
      await origin.paseo.creations.cancel({
        kind: "workspace",
        idempotencyKey,
        workspaceId,
        agentId,
      }),
    ).toMatchObject({ status: "admitted", creation: { phase: "completed" } });
  } finally {
    release();
  }
});

test.each([false, true])(
  "legacy parented creation preserves exact directory and prompt with worktree: %s",
  async (worktree) => {
    const prompts: AgentPromptInput[] = [];
    const instance = await createTestPaseoDaemon({
      agentClients: createTestAgentClients({
        onStartTurn: (prompt, config) => {
          if (!config.internal) prompts.push(prompt);
        },
      }),
    });
    cleanup.push(() => instance.close());
    const origin = await api(instance);
    const directory = join(instance.staticDir, "legacy-nested");
    await mkdir(directory);
    if (worktree) {
      const git = (args: string[]) => promisify(execFile)("git", args, { cwd: instance.staticDir });
      await git(["init", "-b", "main"]);
      await git(["config", "user.name", "Paseo Test"]);
      await git(["config", "user.email", "test@example.com"]);
      await writeFile(join(directory, "README.md"), "Track exact launch directory");
      await git(["add", "."]);
      await git(["commit", "-m", "Initial"]);
    }
    const parent = await origin.paseo.agents.create({
      cwd: instance.staticDir,
      config: { provider: "codex/test" },
    });
    const socket = new WebSocket(`ws://127.0.0.1:${instance.port}/ws`);
    cleanup.push(async () => socket.terminate());
    const messages: SessionOutboundMessage[] = [];
    socket.on("message", (data) => {
      const parsed = WSOutboundMessageSchema.parse(JSON.parse(String(data)));
      if (parsed.type === "session") messages.push(parsed.message);
    });
    await once(socket, "open");
    const hello = once(socket, "message");
    socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "legacy-parented",
        clientType: "cli",
        protocolVersion: 1,
      }),
    );
    await hello;
    const request = {
      type: "create_agent_request",
      ...(worktree ? { worktree: { mode: "branch-off", newBranch: "legacy-child" } } : {}),
      callerAgentId: parent.id,
      config: { provider: "codex", model: "test", cwd: directory },
      labels: {},
      attachments: [],
      initialPrompt: "Run legacy child once",
      clientMessageId: "legacy-initial",
    };
    for (const attempt of [1, 2]) {
      const requestId = "legacy-original";
      const receipt = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          socket.off("message", received);
          reject(
            new Error(
              `Timed out waiting for legacy creation receipt ${attempt}: ${JSON.stringify(messages)}`,
            ),
          );
        }, 20_000);
        function received() {
          if (
            messages.filter(
              (message) => message.type === "status" && message.payload.requestId === requestId,
            ).length !== attempt
          )
            return;
          clearTimeout(timeout);
          socket.off("message", received);
          resolve();
        }
        socket.on("message", received);
      });
      socket.send(JSON.stringify({ type: "session", message: { ...request, requestId } }));
      await receipt;
      const response = messages.find(
        (message) => message.type === "status" && message.payload.requestId === requestId,
      );
      expect(
        response?.type === "status" && "error" in response.payload
          ? response.payload.error
          : undefined,
      ).toBeUndefined();
      expect(response).toMatchObject({
        type: "status",
        payload: { status: "agent_created", agent: { parent: parent.address } },
      });
    }
    const rows = (await parent.subagents.list()).rows;
    expect(rows).toHaveLength(1);
    const child = origin.paseo.agents.ref(rows[0]!.child.agentId);
    const snapshot = (await child.refresh())!.agent;
    if (worktree) {
      expect(snapshot.cwd).not.toBe(directory);
      const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], {
        cwd: snapshot.cwd,
      });
      expect(await realpath(snapshot.cwd)).toBe(
        await realpath(join(stdout.trim(), "legacy-nested")),
      );
      expect(snapshot.workspaceId).not.toBe((await parent.refresh())!.agent.workspaceId);
    } else expect(snapshot.cwd).toBe(directory);
    expect(prompts).toHaveLength(1);
    expect(JSON.stringify(prompts[0])).toContain(request.initialPrompt);
  },
);

test("internal connection leases share ordinary host resolution and preserve borrowed origin and sibling lifetime", async () => {
  const { acquireHostConnection } = await import("@getpaseo/client/internal/host-connection");
  const a = await daemon();
  const b = await daemon();
  const origin = await api(a);
  const direct = await api(b);
  await origin.paseo.hosts.add({ connection: `127.0.0.1:${b.port}` });
  const directory = await online(origin.paseo);
  const controller = new AbortController();
  const [self, first, sibling] = await Promise.all([
    acquireHostConnection(origin.client, directory.self.serverId, controller.signal),
    acquireHostConnection(origin.client, b.daemon.getServerId(), controller.signal),
    acquireHostConnection(origin.client, b.daemon.getServerId(), controller.signal),
  ]);
  cleanup.push(() => sibling.release());
  cleanup.push(() => first.release());
  expect(self.client.getServerId()).toBe(origin.client.getServerId());
  await self.release();
  expect(await origin.paseo.hosts.list()).toMatchObject({
    self: { serverId: directory.self.serverId },
  });
  const firstApi = createPaseoApi(first.client);
  const siblingApi = createPaseoApi(sibling.client);
  cleanup.push(() => siblingApi.dispose());
  cleanup.push(() => firstApi.dispose());
  await first.release();
  await expect(firstApi.workspaces.list()).rejects.toThrow();
  expect((await siblingApi.workspaces.list()).entries).toEqual([]);
  await origin.paseo.hosts.update(directory.hosts[0]!.registrationId, { enabled: false });
  await expect(siblingApi.workspaces.list()).rejects.toThrow();
  expect((await direct.paseo.workspaces.list()).entries).toEqual([]);
  controller.abort();
  await sibling.release();
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    acquireHostConnection(origin.client, directory.self.serverId, aborted.signal),
  ).rejects.toThrow("disposed");
  expect((await origin.paseo.hosts.list()).self.serverId).toBe(directory.self.serverId);
});

test("released internal self connection capability rejects captured operations while the borrowed origin stays usable", async () => {
  const { acquireHostConnection } = await import("@getpaseo/client/internal/host-connection");
  const a = await daemon();
  const origin = await api(a);
  const control = new AbortController();
  const self = await acquireHostConnection(origin.client, a.daemon.getServerId(), control.signal);
  const scoped = createPaseoApi(self.client);
  cleanup.push(() => scoped.dispose());
  await self.release();
  await expect(scoped.workspaces.list()).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
  expect((await origin.paseo.workspaces.list()).entries).toEqual([]);
});

test("nested self scopes preserve the consumed hop while a direct self scope reaches its registered destination", async () => {
  const a = await daemon();
  const b = await daemon();
  const c = await daemon();
  const origin = await api(a);
  const directB = await api(b);
  const wire = await hostWire(b);
  await origin.paseo.hosts.add({ connection: wire.connection });
  await online(origin.paseo);
  await directB.paseo.hosts.add({ connection: `127.0.0.1:${c.port}` });
  await online(directB.paseo);
  const selfA = await origin.paseo.hosts.client(a.daemon.getServerId());
  cleanup.push(() => selfA.dispose());
  const viaB = await selfA.hosts.client(b.daemon.getServerId());
  cleanup.push(() => viaB.dispose());
  const nestedB = await viaB.hosts.client(b.daemon.getServerId());
  cleanup.push(() => nestedB.dispose());
  const twiceB = await nestedB.hosts.client(b.daemon.getServerId());
  cleanup.push(() => twiceB.dispose());
  expect((await twiceB.workspaces.list()).entries).toEqual([]);
  await expect(twiceB.hosts.client(c.daemon.getServerId())).rejects.toMatchObject({
    code: "unsupported_capability",
  });
  const directSelfB = await directB.paseo.hosts.client(b.daemon.getServerId());
  cleanup.push(() => directSelfB.dispose());
  const allowedC = await directSelfB.hosts.client(c.daemon.getServerId());
  cleanup.push(() => allowedC.dispose());
  expect((await allowedC.workspaces.list()).entries).toEqual([]);
  expect(wire.connections()).toBe(1);
  await nestedB.dispose();
  expect((await viaB.workspaces.list()).entries).toEqual([]);
  expect((await origin.paseo.workspaces.list()).entries).toEqual([]);
});

test("owned self session close settles pending RPC and observation and leaves sibling and physical origin usable", async () => {
  const { acquireHostConnection } = await import("@getpaseo/client/internal/host-connection");
  const a = await daemon();
  const wire = await hostWire(a);
  const origin = createHostClient(wire.connection, {
    clientId: crypto.randomUUID(),
    reconnect: { enabled: false },
  });
  cleanup.push(() => origin.close());
  await origin.connect();
  const originApi = createPaseoApi(origin);
  cleanup.push(() => originApi.dispose());
  const control = new AbortController();
  const self = await acquireHostConnection(origin, a.daemon.getServerId(), control.signal);
  cleanup.push(() => self.release());
  const sibling = await acquireHostConnection(
    origin,
    a.daemon.getServerId(),
    new AbortController().signal,
  );
  cleanup.push(() => sibling.release());
  const observed = self.client.observeHosts();
  const siblingObserved = sibling.client.observeHosts();
  let updates = 0;
  let siblingUpdates = 0;
  observed.subscribe({
    snapshot() {},
    update() {
      updates++;
    },
  });
  siblingObserved.subscribe({
    snapshot() {},
    update() {
      siblingUpdates++;
    },
  });
  await Promise.all([observed.ready, siblingObserved.ready]);
  const states: string[] = [];
  self.client.subscribeConnectionStatus((state) => states.push(state.status));
  const identity = self.client.getServerId();
  const capturedFetch = self.client.fetchWorkspaces.bind(self.client);
  const held = wire.holdResponses((message) => message.type === "fetch_workspaces_response");
  const pending = capturedFetch();
  void pending.catch(() => {});
  await held.ready;
  try {
    await self.release();
    await expect(pending).rejects.toThrow();
    expect(states.at(-1)).toBe("disposed");
    expect(self.client.getServerId()).toBe(identity);
    const rejected = capturedFetch();
    expect(rejected).toBeInstanceOf(Promise);
    await expect(rejected).rejects.toMatchObject({ code: "DAEMON_CONNECTION_LOST" });
    held.release();
    await originApi.hosts.add({ connection: "127.0.0.1:1", label: "After scope release" });
    await expect.poll(() => siblingUpdates).toBeGreaterThan(0);
    expect(updates).toBe(0);
    expect((await sibling.client.fetchWorkspaces()).entries).toEqual([]);
    expect((await originApi.workspaces.list()).entries).toEqual([]);
    control.abort();
    await self.release();
  } finally {
    held.release();
  }
});
