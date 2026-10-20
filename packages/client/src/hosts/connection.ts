import { safeRandomId } from "../daemon-client-transport-utils.js";
import { DaemonClient } from "../daemon-client.js";
import type { DaemonTransportFactory } from "../daemon-client-transport-types.js";

export function createHostChannelTransport(
  origin: DaemonClient,
  serverId: string,
  scopeId: string,
  initialRouteId: string | null,
  link = false,
): DaemonTransportFactory {
  let first: string | null = initialRouteId;
  return () => {
    const opens = new Set<() => void>();
    const closes = new Set<(event?: unknown) => void>();
    const messages = new Set<(data: unknown, binary: boolean) => void>();
    const errors = new Set<(error: unknown) => void>();
    let routeId: string | null = null;
    let closed = false;
    const cleanups: (() => void)[] = [];
    const close = (error?: unknown) => {
      if (closed) return;
      closed = true;
      if (error instanceof Error) Object.assign(error, { serverId });
      for (const cleanup of cleanups) cleanup();
      try {
        if (routeId) origin.closeHostRoute(routeId);
        else origin.cancelHostRoute(scopeId);
      } catch {
        /* Transport already closed. */
      }
      if (error) for (const handler of errors) handler(error);
      for (const handler of closes) handler(error);
    };
    cleanups.push(
      origin.subscribeRawMessages((message) => {
        if (message.type === "hosts.route.frame" && message.payload.subscriptionId === routeId) {
          for (const handler of messages) handler(message.payload.data, false);
        }
        if (message.type === "hosts.route.closed" && message.payload.subscriptionId === routeId)
          close(
            Object.assign(new Error(message.payload.message), {
              code: message.payload.code,
              serverId,
            }),
          );
      }),
    );
    cleanups.push(
      origin.subscribeHostFrames((frame) => {
        if (frame.routeId === routeId) for (const handler of messages) handler(frame.payload, true);
      }),
    );
    cleanups.push(
      origin.subscribeConnectionStatus((connectionState) => {
        if (connectionState.status !== "connected") close();
      }),
    );
    let opening: Promise<string>;
    if (first) opening = Promise.resolve(first);
    else opening = link ? origin.openHostLink(scopeId) : origin.openHostRoute(serverId, scopeId);
    first = null;
    void opening
      .then((id) => {
        if (closed) {
          origin.closeHostRoute(id);
          return;
        }
        routeId = id;
        for (const handler of opens) handler();
        return undefined;
      })
      .catch(close);
    return {
      send(data) {
        if (closed || !routeId)
          throw Object.assign(new Error(`Host ${serverId} is offline`), {
            code: "host_offline",
            serverId,
          });
        origin.sendHostFrame(
          routeId,
          typeof data === "string" || data instanceof Uint8Array ? data : new Uint8Array(data),
        );
      },
      close: () => close(),
      onOpen(handler) {
        opens.add(handler);
        return () => opens.delete(handler);
      },
      onClose(handler) {
        closes.add(handler);
        return () => closes.delete(handler);
      },
      onError(handler) {
        errors.add(handler);
        return () => errors.delete(handler);
      },
      onMessage(handler) {
        messages.add(handler);
        return () => messages.delete(handler);
      },
    };
  };
}

/** Internal adapter for clients that own a low-level replica pipeline. */
export interface HostConnectionLease {
  readonly client: DaemonClient;
  release(): Promise<void>;
}

/** The origin alone resolves the destination; leases never probe another authority. */
export async function acquireHostConnection(
  origin: DaemonClient,
  serverId: string,
  signal: AbortSignal,
): Promise<HostConnectionLease> {
  const assertActive = () => {
    if (signal.aborted) throw new Error("Host connection acquisition is disposed");
  };
  assertActive();
  origin.requireConnectedHosts();
  if (
    origin.getServerId() === serverId &&
    origin.getLastServerInfoMessage()?.features?.hostSessionScopes !== true
  )
    throw Object.assign(new Error("Update the managing daemon to acquire owned session scopes"), {
      code: "unsupported_capability",
      serverId,
    });

  const scopeId = safeRandomId();
  let client: DaemonClient | null = null;
  let release: Promise<void> | null = null;
  const cancel = () => {
    origin.cancelHostRoute(scopeId);
    if (client) void client.close().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  const close = () => {
    if (!release) {
      signal.removeEventListener("abort", cancel);
      release = client ? client.close() : Promise.resolve();
    }
    return release;
  };
  try {
    const routeId = await origin.openHostRoute(serverId, scopeId);
    if (signal.aborted) {
      origin.closeHostRoute(routeId);
      assertActive();
    }
    client = new DaemonClient({
      url: "ws://routed-host/ws",
      clientId: scopeId,
      transportFactory: createHostChannelTransport(origin, serverId, scopeId, routeId),
      reconnect: { enabled: false },
    });
    await client.connect();
    assertActive();
    client.setReconnectEnabled(true);
    return { client, release: close };
  } catch (error) {
    await close().catch(() => {});
    throw Object.assign(error instanceof Error ? error : new Error("Host handshake failed"), {
      code: error instanceof Error && "code" in error ? error.code : "host_offline",
      serverId,
    });
  }
}
