import type { DaemonClient } from "../daemon-client.js";

/** Presents atomic current run evidence and subsequent checkpoints through one snapshot callback. */
export function observeAgentRun(client: DaemonClient, agentId: string, submissionId: string) {
  const source = client.observeAgentRun(agentId, submissionId);
  return {
    get subscriptionId() {
      return source.subscriptionId;
    },
    ready: source.ready,
    release: () => source.release(),
    subscribe(observer: Parameters<typeof source.subscribe>[0]) {
      return source.subscribe({
        snapshot: observer.snapshot,
        update(message) {
          if (message.type === "agent.runs.changed") observer.snapshot(message.payload);
          else observer.update(message);
        },
        error: observer.error,
      });
    },
  };
}
