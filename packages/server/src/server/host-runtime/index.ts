import { createPaseoApi, HostRuntime, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import { VirtualSessionSocket } from "../websocket/virtual-session-socket.js";
import type { DaemonPermission } from "@getpaseo/protocol/messages";
import type { SessionAdmission } from "../websocket-server.js";

export interface HostRuntimeAuthority {
  permissionCeiling: readonly DaemonPermission[];
  resolveAdmission(): Promise<SessionAdmission>;
}

/** Admission is supplied by the host; this adapter never manufactures authority. */
export async function createDaemonHostRuntime(input: {
  attach(socket: VirtualSessionSocket): Promise<void>;
  clientId: string;
  permissionCeiling: readonly DaemonPermission[];
  disposed(runtime: HostRuntime): void;
}): Promise<HostRuntime> {
  const transportFactory: DaemonTransportFactory = () => {
    const opens = new Set<() => void>();
    const closes = new Set<(event?: unknown) => void>();
    const errors = new Set<(error: unknown) => void>();
    const messages = new Set<(data: unknown, binary: boolean) => void>();
    const socket = new VirtualSessionSocket(
      async (data) => {
        for (const handler of messages) handler(data, typeof data !== "string");
      },
      (code, reason) => {
        for (const handler of closes) handler({ code, reason });
      },
      () => 0,
      (hello) => hello,
    );
    void input.attach(socket).then(
      () => {
        if (socket.readyState === 1) for (const handler of opens) handler();
        return undefined;
      },
      (error: unknown) => {
        for (const handler of errors) handler(error);
        socket.close();
      },
    );
    return {
      send: (data) => socket.feed(data instanceof ArrayBuffer ? new Uint8Array(data) : data),
      close: (code, reason) => socket.close(code, reason),
      onOpen(handler) {
        opens.add(handler);
        return () => {
          opens.delete(handler);
        };
      },
      onClose(handler) {
        closes.add(handler);
        return () => {
          closes.delete(handler);
        };
      },
      onError(handler) {
        errors.add(handler);
        return () => {
          errors.delete(handler);
        };
      },
      onMessage(handler) {
        messages.add(handler);
        return () => {
          messages.delete(handler);
        };
      },
    };
  };
  const client = new DaemonClient({
    url: "ws://host-runtime/ws",
    clientId: input.clientId,
    sessionPermissions: [...input.permissionCeiling],
    transportFactory,
    reconnect: { enabled: false },
  });
  const origin = createPaseoApi(client);
  const runtime = new OwnedHostRuntime(origin, client, input.disposed);
  try {
    await client.connect();
    client.setReconnectEnabled(true);
    return runtime;
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

class OwnedHostRuntime extends HostRuntime {
  private ownedDisposal: Promise<void> | null = null;

  constructor(
    private readonly originApi: PaseoApi,
    private readonly originClient: DaemonClient,
    private readonly onDisposed: (runtime: HostRuntime) => void,
  ) {
    super(originApi);
  }

  override dispose(): Promise<void> {
    if (this.ownedDisposal) return this.ownedDisposal;
    this.ownedDisposal = (async () => {
      try {
        await super.dispose();
      } finally {
        try {
          await this.originApi.dispose();
        } finally {
          try {
            await this.originClient.close();
          } finally {
            this.onDisposed(this);
          }
        }
      }
    })();
    return this.ownedDisposal;
  }
}
