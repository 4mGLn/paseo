import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { addConnectedHostAndReload } from "./hosts";
import { buildSeededHost } from "./daemon-registry";
import { openAgentRoute } from "./mock-agent";
import { openSessions, clickSessionRow } from "./archive-tab";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { randomUUID } from "node:crypto";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient, loadPaseoApiFactory } from "./daemon-client-loader";
import { startIsolatedHostDaemon } from "./isolated-host-daemon";
import { seedWorkspace } from "./seed-client";
import { inspectSessionWireRequest } from "./session-wire";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { expect, type Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";
import type { SeededWorkspace } from "./seed-client";

type WebSocketMessage = string | Buffer;

export interface ManagedSubagentArchiveGate {
  release(): void;
  waitForRequest(): Promise<void>;
}

export interface ManagedSubagentArchiveRejection {
  waitForRejection(): Promise<void>;
}

export interface SeededSubagentPair {
  parent: {
    id: string;
    title: string;
  };
  child: {
    id: string;
    title: string;
  };
  workspaceId: string;
}

export interface SeededCrossWorkspaceSubagentPair {
  parent: {
    id: string;
    workspaceId: string;
  };
  child: {
    id: string;
    workspaceId: string;
  };
}

export async function seedParentWithSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId">,
  input: { parentTitle: string; childTitle: string },
): Promise<SeededSubagentPair> {
  const parent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.parentTitle,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const child = await seedSubagent(workspace, { parentId: parent.id, title: input.childTitle });

  return {
    parent: {
      id: parent.id,
      title: input.parentTitle,
    },
    child,
    workspaceId: workspace.workspaceId,
  };
}

/** Seeds an idle Paseo subagent of an existing agent in the same workspace. */
export async function seedSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId">,
  input: { parentId: string; title: string },
): Promise<{ id: string; title: string }> {
  const child = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.title,
    modeId: "load-test",
    model: "ten-second-stream",
    labels: {
      [PARENT_AGENT_ID_LABEL]: input.parentId,
    },
  });
  return { id: child.id, title: input.title };
}

export async function seedParentWithCrossWorkspaceSubagent(
  workspace: Pick<SeededWorkspace, "client" | "repoPath" | "workspaceId" | "projectId">,
  input: { parentTitle: string; childTitle: string },
): Promise<SeededCrossWorkspaceSubagentPair> {
  const parent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title: input.parentTitle,
    modeId: "load-test",
    model: "ten-second-stream",
  });
  const createdWorkspace = await workspace.client.createWorkspace({
    source: {
      kind: "directory",
      path: workspace.repoPath,
      projectId: workspace.projectId,
    },
    title: "Subagent workspace",
  });
  if (!createdWorkspace.workspace) {
    throw new Error(createdWorkspace.error ?? "Failed to create subagent workspace");
  }

  const child = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: createdWorkspace.workspace.id,
    title: input.childTitle,
    modeId: "load-test",
    model: "five-minute-stream",
    initialPrompt: "stay running",
    labels: {
      [PARENT_AGENT_ID_LABEL]: parent.id,
    },
  });
  await workspace.client.waitForAgentUpsert(
    child.id,
    (snapshot) => snapshot.status === "running",
    15_000,
  );

  return {
    parent: {
      id: parent.id,
      workspaceId: workspace.workspaceId,
    },
    child: {
      id: child.id,
      workspaceId: createdWorkspace.workspace.id,
    },
  };
}

/**
 * Opens the subagents panel, and leaves it open if it already is — the pill is a toggle, and a
 * second click would close the thing the caller is about to assert on. The panel also closes on
 * its own whenever a row navigates away, so a flow that comes back to the parent reopens it.
 */
export async function openSubagentsTrack(page: Page): Promise<void> {
  const panel = page.getByTestId("subagents-track-header-panel");
  if ((await panel.count()) === 0) {
    await page.getByTestId("subagents-track-header").click();
  }
  await expect(panel).toBeVisible({ timeout: 30_000 });
}

/** On compact the track opens as a sheet, which closes once a row is chosen. */
export async function openSubagentFromCompactTrack(page: Page, childId: string): Promise<void> {
  await page.getByTestId("subagents-track-header").click();
  await page.getByTestId(`subagents-track-row-${childId}`).click();
}

export async function expectSubagentRowVisible(page: Page, childId: string): Promise<void> {
  await expect(page.getByTestId(`subagents-track-row-${childId}`)).toBeVisible({
    timeout: 30_000,
  });
}

export async function expectSubagentRowGone(page: Page, childId: string): Promise<void> {
  await expect(page.getByTestId(`subagents-track-row-${childId}`)).toHaveCount(0, {
    timeout: 30_000,
  });
}

export async function expectManagedSubagentUnarchived(
  workspace: Pick<SeededWorkspace, "client">,
  childId: string,
): Promise<void> {
  await expect(workspace.client.fetchAgent({ agentId: childId })).resolves.toMatchObject({
    agent: { id: childId, archivedAt: null },
  });
}

export async function expectManagedSubagentArchived(
  workspace: Pick<SeededWorkspace, "client">,
  childId: string,
): Promise<void> {
  await expect
    .poll(() => workspace.client.fetchAgent({ agentId: childId }), { timeout: 30_000 })
    .toMatchObject({ agent: { id: childId, archivedAt: expect.any(String) } });
}

export async function archiveFinishedSubagents(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Archive finished subagents" }).click();
}

export async function expectArchiveFinishedInProgress(
  page: Page,
  completed: number,
  total: number,
): Promise<void> {
  await expect(page.getByRole("button", { name: "Archive finished subagents" })).toBeDisabled();
  await expect(page.getByText(`${completed}/${total}`, { exact: true })).toBeVisible();
}

export async function expectArchiveFinishedRetry(
  page: Page,
  failed: number,
  total: number,
): Promise<void> {
  await expect(page.getByText(`Retry (${failed}/${total})`, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Archive finished subagents" })).toBeEnabled();
}

export async function holdManagedSubagentArchiveRequest(
  page: Page,
  subagentId: string,
): Promise<ManagedSubagentArchiveGate> {
  let released = false;
  let resolveRequest: (() => void) | undefined;
  const delayedForwards: Array<() => void> = [];
  const request = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (isArchiveRequestForSubagent(message, subagentId) && !released) {
        delayedForwards.push(() => server.send(message));
        resolveRequest?.();
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  return {
    release() {
      released = true;
      for (const forward of delayedForwards.splice(0)) forward();
    },
    waitForRequest: () => request,
  };
}

export async function rejectNextManagedSubagentArchiveRequest(
  page: Page,
  subagentId: string,
): Promise<ManagedSubagentArchiveRejection> {
  let resolveRejection: (() => void) | undefined;
  const rejection = new Promise<void>((resolve) => {
    resolveRejection = resolve;
  });
  let rejected = false;

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const intercepted = archiveRequest(message, subagentId);
      if (intercepted && !rejected) {
        rejected = true;
        // A daemon-rejected archive RPC: the request never reaches the daemon, and its normal
        // correlated error travels back through the real browser client and mutation rollback.
        ws.send(
          intercepted.reply({
            type: "rpc_error",
            payload: {
              requestId: intercepted.request.requestId,
              requestType: "archive_agent_request",
              error: "Archive rejected for test",
              code: "archive_rejected",
            },
          }),
        );
        resolveRejection?.();
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });

  return { waitForRejection: () => rejection };
}

function isArchiveRequestForSubagent(message: WebSocketMessage, subagentId: string): boolean {
  return archiveRequest(message, subagentId) !== null;
}

function archiveRequest(message: WebSocketMessage, subagentId: string) {
  const inspected = inspectSessionWireRequest(message);
  if (
    inspected?.request.type === "archive_agent_request" &&
    inspected.request.agentId === subagentId &&
    typeof inspected.request.requestId === "string"
  )
    return inspected;
  return null;
}

export async function detachSubagentFromTrack(page: Page, childId: string): Promise<void> {
  const row = page.getByTestId(`subagents-track-row-${childId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  page.once("dialog", (dialog) => {
    expect(dialog.message()).toContain("Detach subagent?");
    void dialog.accept();
  });

  const detachButton = page.getByTestId(`subagents-track-detach-${childId}`);
  await expect(detachButton).toBeVisible({ timeout: 30_000 });
  await detachButton.click();
}

/** Real equal-ID children in equal-ID workspaces, with both route authorities independently live. */
export async function seedFleetSubagents() {
  const workspace = await seedWorkspace({ repoPrefix: "fleet-track-" });
  const destination = await startIsolatedHostDaemon(`fleet_${randomUUID()}`);
  const clients: DaemonClient[] = [];
  const apis: ReturnType<Awaited<ReturnType<typeof loadPaseoApiFactory>>>[] = [];
  const close = async () => {
    await Promise.allSettled(apis.map((api) => api.dispose()));
    await Promise.allSettled(clients.map((client) => client.close()));
    await destination.close();
    await workspace.cleanup();
  };
  try {
    const createApi = await loadPaseoApiFactory();
    const aClient = await connectDaemonClient<DaemonClient>({ clientIdPrefix: "fleet-origin" });
    clients.push(aClient);
    const bClient = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "fleet-destination",
      port: destination.port,
    });
    clients.push(bClient);
    const origin = createApi(aClient);
    const direct = createApi(bClient);
    apis.push(origin, direct);
    const registered = await origin.hosts.add({ connection: `127.0.0.1:${destination.port}` });
    await expect
      .poll(
        async () =>
          (await origin.hosts.list()).hosts.find(
            (host) => host.registrationId === registered.registrationId,
          )?.status,
      )
      .toBe("online");
    const destinationWorkspace = await direct.workspaces.create({
      workspaceId: workspace.workspaceId,
      source: { kind: "directory", path: workspace.repoPath },
    });
    expect(destinationWorkspace.id).toBe(workspace.workspaceId);
    const config = { provider: "mock/ten-second-stream", modeId: "load-test" };
    const parent = await origin.workspaces
      .ref(workspace.workspaceId)
      .agents.create({ title: "Fleet parent", config });
    const agentId = randomUUID();
    const local = await parent.subagents.create({ agentId, title: "Fleet child on A", config });
    const remote = await parent.subagents.create({
      agentId,
      serverId: destination.serverId,
      workspaceId: destinationWorkspace.id,
      title: "Fleet child on B",
      config,
    });
    return {
      workspace,
      destination,
      origin,
      direct,
      parent,
      local,
      remote,
      disable: () => origin.hosts.update(registered.registrationId, { enabled: false }),
      enable: () => origin.hosts.update(registered.registrationId, { enabled: true }),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function connectFleetDirectHost(
  page: Page,
  fleet: Awaited<ReturnType<typeof seedFleetSubagents>>,
) {
  await openAgentRoute(page, {
    workspaceId: fleet.workspace.workspaceId,
    agentId: fleet.parent.id,
  });
  await addConnectedHostAndReload(page, {
    serverId: fleet.destination.serverId,
    port: fleet.destination.port,
    label: "Fleet B",
  });
  await page.evaluate(
    (host) => localStorage.setItem("@paseo:e2e-extra-hosts", JSON.stringify([host])),
    buildSeededHost({
      serverId: fleet.destination.serverId,
      endpoint: `127.0.0.1:${fleet.destination.port}`,
      nowIso: new Date().toISOString(),
      label: "Fleet B",
    }),
  );
  await page.goto(
    buildHostAgentDetailRoute(
      fleet.destination.serverId,
      fleet.remote.id,
      fleet.workspace.workspaceId,
    ),
  );
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
}

export async function openFleetParentTrack(page: Page) {
  await openSessions(page);
  await clickSessionRow(page, "Fleet parent");
  await openSubagentsTrack(page);
}

export async function readFleetAuthorityState(
  page: Page,
  originServerId: string,
  serverId: string,
) {
  return page.evaluate(
    ({ originServerId: sourceId, serverId: destinationId }) => {
      const runtime = Reflect.get(globalThis, "__paseoHostRuntimeStore") as HostRuntimeStore;
      const read = (origin: string) => {
        const binding = runtime
          .getAuthorityBindings()
          .find(
            (candidate) =>
              candidate.reference.originServerId === origin &&
              candidate.reference.serverId === destinationId,
          );
        const queries =
          binding?.queries
            .getQueryCache()
            .findAll({ queryKey: ["providersSnapshot", destinationId] }) ?? [];
        return {
          status: binding?.runtime.getSnapshot(destinationId)?.connectionStatus ?? "absent",
          catalogVersion: Math.max(0, ...queries.map((query) => query.state.dataUpdatedAt)),
        };
      };
      return { direct: read(destinationId), routed: read(sourceId) };
    },
    { originServerId, serverId },
  );
}

export async function expectFleetRouteUnavailable(
  page: Page,
  originServerId: string,
  serverId: string,
) {
  await expect
    .poll(async () => (await readFleetAuthorityState(page, originServerId, serverId)).routed.status)
    .toMatch(/^(offline|error)$/);
  const unavailable = page.getByText(/^(Cannot reach .+|.+ is offline)$/).filter({ visible: true });
  const composer = page.getByRole("textbox", { name: "Message agent..." });
  await expect(unavailable.or(composer)).toBeVisible();
  if (await composer.isVisible()) {
    if (await composer.isEditable()) {
      await composer.fill("MUST_NOT_USE_DIRECT_AUTHORITY");
      await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
    } else await expect(composer).toBeDisabled();
  } else
    await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveCount(0);
}
