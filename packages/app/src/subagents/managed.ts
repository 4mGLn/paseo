import { createPaseoApi, type PaseoApi, type PaseoAgentHandle } from "@getpaseo/client";
import type { AgentAddress } from "@getpaseo/protocol/addresses";
import type { SubagentDirectory, SubagentRelationship } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export interface ManagedSubagentState {
  readonly parent: AgentAddress;
  readonly rows: readonly SubagentRelationship[];
  readonly status: "loading" | "current" | "unavailable";
  readonly error: string | null;
  readonly archiving: ReadonlySet<string>;
}

export interface ManagedSubagentDirectory {
  getSnapshot(): ManagedSubagentState;
  subscribe(changed: () => void): () => void;
  archive(child: AgentAddress): Promise<void>;
  detach(child: AgentAddress): Promise<SubagentRelationship>;
  forget(child: AgentAddress): Promise<void>;
}

interface MembershipRuntime {
  getClient(serverId: string): DaemonClient | null;
  getSnapshot(serverId: string): { connectionStatus: string } | null;
  subscribe(serverId: string, changed: () => void): () => void;
  withAgent<T>(
    address: AgentAddress,
    operation: (agent: PaseoAgentHandle) => Promise<T>,
  ): Promise<T>;
}

/** Retains authoritative membership for the runtime, independently of view mounting. */
export class ManagedSubagents {
  private readonly parents = new Map<string, ParentMembership>();
  constructor(private readonly runtime: MembershipRuntime) {}

  directory(parent: AgentAddress): ManagedSubagentDirectory {
    const key = JSON.stringify([parent.serverId, parent.agentId]);
    let directory = this.parents.get(key);
    if (!directory) {
      directory = new ParentMembership(parent, this.runtime);
      this.parents.set(key, directory);
    }
    return directory;
  }

  async releaseServer(serverId: string): Promise<void> {
    const releasing: Promise<void>[] = [];
    for (const [key, parent] of this.parents) {
      if (parent.getSnapshot().parent.serverId !== serverId) continue;
      this.parents.delete(key);
      releasing.push(parent.close());
    }
    await Promise.allSettled(releasing);
  }
}

class ParentMembership implements ManagedSubagentDirectory {
  private state: ManagedSubagentState;
  private readonly listeners = new Set<() => void>();
  private stopConnection: (() => void) | null = null;
  private client: DaemonClient | null = null;
  private api: PaseoApi | null = null;
  private generation = 0;
  private closed = false;
  private readonly releasing = new Set<Promise<unknown>>();

  constructor(
    private readonly parent: AgentAddress,
    private readonly runtime: MembershipRuntime,
  ) {
    this.state = { parent, rows: [], status: "loading", error: null, archiving: new Set() };
  }
  getSnapshot = (): ManagedSubagentState => this.state;
  subscribe = (changed: () => void): (() => void) => {
    this.listeners.add(changed);
    if (!this.stopConnection && !this.closed) {
      this.stopConnection = this.runtime.subscribe(this.parent.serverId, this.syncConnection);
      this.syncConnection();
    }
    // The runtime owns observation/recovery; unmounting a view only removes its listener.
    return () => {
      this.listeners.delete(changed);
    };
  };
  private publish(state: ManagedSubagentState): void {
    this.state = state;
    for (const changed of this.listeners) changed();
  }
  private unavailable(error: string): void {
    this.publish({
      ...this.state,
      status: "unavailable",
      error,
      rows: this.state.rows.map((row) => ({ ...row, freshness: "unavailable" })),
    });
  }
  private retireApi(): void {
    if (!this.api) return;
    const releasing = this.api.dispose();
    this.api = null;
    this.releasing.add(releasing);
    void releasing.finally(() => this.releasing.delete(releasing)).catch(() => {});
  }
  private syncConnection = (): void => {
    if (this.closed) return;
    const client = this.runtime.getClient(this.parent.serverId);
    if (client !== this.client) {
      this.generation++;
      this.retireApi();
      this.client = client;
    }
    if (!client || this.runtime.getSnapshot(this.parent.serverId)?.connectionStatus !== "online") {
      this.unavailable("Parent authority is unavailable");
      return;
    }
    if (this.api) return;
    const generation = this.generation;
    const accept = (directory: SubagentDirectory) => {
      if (this.closed || generation !== this.generation) return;
      if (
        directory.parent.serverId !== this.parent.serverId ||
        directory.parent.agentId !== this.parent.agentId
      )
        throw new Error("Subagent directory does not match its owning parent");
      this.publish({
        ...this.state,
        parent: this.parent,
        rows: directory.rows,
        status: "current",
        error: null,
      });
    };
    try {
      this.api = createPaseoApi(client);
      const observation = this.api.agents.ref(this.parent.agentId).subagents.observe();
      observation.subscribe({
        snapshot: accept,
        update: (message) => {
          if (message.type === "agent.subagents.changed") accept(message.payload.directory);
        },
        error: (error) => {
          if (!this.closed && generation === this.generation)
            this.unavailable(
              error instanceof Error ? error.message : "Subagent membership is unavailable",
            );
        },
      });
      void observation.ready.catch((error) => {
        if (!this.closed && generation === this.generation)
          this.unavailable(
            error instanceof Error ? error.message : "Subagent membership is unavailable",
          );
      });
    } catch (error) {
      this.retireApi();
      this.unavailable(
        error instanceof Error ? error.message : "Subagent membership is unavailable",
      );
    }
  };
  private requireMembership(child: AgentAddress): SubagentRelationship {
    if (this.closed || !this.api || this.state.status !== "current")
      throw new Error("Parent authority is unavailable");
    const row = this.state.rows.find(
      (candidate) =>
        candidate.child.serverId === child.serverId && candidate.child.agentId === child.agentId,
    );
    if (!row || ["forgotten", "archived", "detached", "canceled"].includes(row.phase))
      throw new Error("Subagent membership is no longer attached");
    return row;
  }
  archive = async (child: AgentAddress): Promise<void> => {
    this.requireMembership(child);
    const key = JSON.stringify([child.serverId, child.agentId]);
    if (this.state.archiving.has(key)) return;
    this.publish({ ...this.state, archiving: new Set([...this.state.archiving, key]) });
    try {
      await this.runtime.withAgent(child, (agent) => agent.archive());
    } finally {
      const archiving = new Set(this.state.archiving);
      archiving.delete(key);
      this.publish({ ...this.state, archiving });
    }
  };
  detach = async (child: AgentAddress): Promise<SubagentRelationship> => {
    this.requireMembership(child);
    return this.api!.agents.ref(this.parent.agentId).subagents.detach(child);
  };
  forget = async (child: AgentAddress): Promise<void> => {
    this.requireMembership(child);
    await this.api!.agents.ref(this.parent.agentId).subagents.forget(child);
  };
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.stopConnection?.();
    this.retireApi();
    this.listeners.clear();
    await Promise.allSettled(this.releasing);
  }
}
