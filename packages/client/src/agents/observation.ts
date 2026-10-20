import type { DaemonClient } from "../daemon-client.js";
import type { OwnedSubscription } from "../connection/index.js";
type SubscriptionSnapshot<T> = Awaited<OwnedSubscription<T>["ready"]>;
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

/** Exact-ID observation over the ordinary owned agent directory stream. */
export function observeAgent(
  client: DaemonClient,
  agentId: string,
): OwnedSubscription<AgentSnapshotPayload> {
  client.requireFleetSubagents();
  const source = client.observeAgents({
    includeBackground: true,
    filter: { agentIds: [agentId], includeArchived: true, includeBackground: true },
  });
  const project = (
    snapshot: Awaited<typeof source.ready>,
  ): SubscriptionSnapshot<AgentSnapshotPayload> => {
    const agent = snapshot.entries.find((entry) => entry.agent.id === agentId)?.agent;
    if (!agent)
      throw Object.assign(new Error(`Agent ${agentId} was not found`), { code: "agent_not_found" });
    return { ...agent, subscriptionId: snapshot.subscriptionId };
  };
  const ready = source.ready.then(project).catch(async (error: unknown) => {
    await source.release();
    throw error;
  });
  void ready.catch(() => {});
  return {
    get subscriptionId() {
      return source.subscriptionId;
    },
    ready,
    subscribe(observer) {
      return source.subscribe({
        snapshot(snapshot) {
          try {
            observer.snapshot(project(snapshot));
          } catch (error) {
            observer.error?.(error);
            void source.release();
          }
        },
        update: observer.update,
        error: observer.error,
      });
    },
    release: () => source.release(),
  };
}
