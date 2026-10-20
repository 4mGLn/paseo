import { DaemonClient } from "../daemon-client.js";
import type { OwnedSubscription } from "../connection/index.js";
import type { PaseoApi, createPaseoApi } from "../index.js";
import type { HostAdd, HostUpdate, HostSummary, HostDirectory } from "@getpaseo/protocol/hosts";
import { HostRuntime } from "./runtime.js";
import { acquireHostConnection } from "./connection.js";
export { createHostChannelTransport } from "./connection.js";

export interface PaseoHostActions {
  list(): Promise<HostDirectory>;
  observe(): OwnedSubscription<HostDirectory>;
  add(input: HostAdd): Promise<HostSummary>;
  update(registrationId: string, patch: HostUpdate): Promise<HostSummary>;
  remove(registrationId: string): Promise<void>;
  client(serverId: string): Promise<PaseoApi>;
  runtime(): HostRuntime;
}

export function createHostActions(
  origin: DaemonClient,
  owner: {
    own<T extends { release(): Promise<void> }>(create: () => T): T;
    signal: AbortSignal;
    api: typeof createPaseoApi;
  },
): PaseoHostActions {
  const assertActive = () => {
    if (owner.signal.aborted) throw new Error("Paseo API is disposed");
  };
  const actions: PaseoHostActions = {
    list: () => {
      assertActive();
      return origin.listHosts();
    },
    observe: () => owner.own(() => origin.observeHosts()),
    add: (input) => {
      assertActive();
      return origin.addHost(input);
    },
    update: (id, patch) => {
      assertActive();
      return origin.updateHost(id, patch);
    },
    remove: (id) => {
      assertActive();
      return origin.removeHost(id);
    },
    async client(serverId) {
      assertActive();
      origin.requireConnectedHosts();
      const lease = await acquireHostConnection(origin, serverId, owner.signal);
      try {
        assertActive();
        const api = owner.api(lease.client, { signal: owner.signal });
        const scope = owner.own(() => ({
          release: async () => {
            try {
              await api.dispose();
            } finally {
              await lease.release();
            }
          },
        }));
        return { ...api, dispose: () => scope.release() };
      } catch (error) {
        await lease.release().catch(() => {});
        throw error;
      }
    },
    runtime() {
      assertActive();
      const runtime = new HostRuntime({ hosts: actions });
      const dispose = runtime.dispose.bind(runtime);
      const scope = owner.own(() => ({ release: dispose }));
      runtime.dispose = () => scope.release();
      return runtime;
    },
  };
  return actions;
}
