import { AgentAddressSchema, type AgentAddress } from "@getpaseo/protocol/addresses";
import type { HostDirectory } from "@getpaseo/protocol/hosts";
import type { PaseoApi, PaseoAgentHandle } from "../index.js";

/** One origin authority owns resolution and the lifetime of its destination scopes. */
export class HostRuntime {
  private readonly agentClients = new Map<string, Promise<PaseoApi>>();
  private readonly pending = new Set<Promise<PaseoApi>>();
  private readonly scopes = new Set<PaseoApi>();
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(private readonly origin: Pick<PaseoApi, "hosts">) {}

  async directory(): Promise<HostDirectory> {
    if (this.disposed) throw new Error("Host runtime is disposed");
    return this.origin.hosts.list();
  }

  /** Caller-owned scope. Disposing it never invalidates another consumer's scope. */
  async client(serverId: string): Promise<PaseoApi> {
    if (this.disposed) throw new Error("Host runtime is disposed");
    const acquiring = this.origin.hosts.client(serverId).then(async (api) => {
      if (this.disposed) {
        await api.dispose();
        throw new Error("Host runtime is disposed");
      }
      let disposal: Promise<void> | null = null;
      const scope = {
        ...api,
        dispose: () => {
          if (!disposal) {
            this.scopes.delete(scope);
            disposal = api.dispose();
          }
          return disposal;
        },
      };
      this.scopes.add(scope);
      return scope;
    });
    this.pending.add(acquiring);
    void acquiring.then(
      () => this.pending.delete(acquiring),
      () => this.pending.delete(acquiring),
    );
    return acquiring;
  }

  /** Handles borrow a runtime-owned scope and remain bound to its origin authority. */
  async agent(address: AgentAddress): Promise<PaseoAgentHandle> {
    if (this.disposed) throw new Error("Host runtime is disposed");
    const { serverId, agentId } = AgentAddressSchema.parse(address);
    let client = this.agentClients.get(serverId);
    if (!client) {
      client = this.client(serverId);
      this.agentClients.set(serverId, client);
      const acquiring = client;
      void acquiring.catch(() => {
        if (this.agentClients.get(serverId) === acquiring) this.agentClients.delete(serverId);
      });
    }
    const api = await client;
    if (this.disposed) throw new Error("Host runtime is disposed");
    return api.agents.ref(agentId);
  }

  protected stopAcquisitions(): void {
    this.disposed = true;
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.stopAcquisitions();
    this.disposal = (async () => {
      const results = await Promise.allSettled([...this.scopes].map((scope) => scope.dispose()));
      // Acquisitions that finish after disposal release themselves before rejecting callers.
      await Promise.allSettled(this.pending);
      this.agentClients.clear();
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Failed to dispose host runtime");
    })();
    return this.disposal;
  }
}
