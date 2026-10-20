import { formatFinishNotificationBody } from "../agent-prompt.js";
import { createHash } from "node:crypto";
import type { PaseoAgentHandle } from "@getpaseo/client";
import type { AgentRunRecord } from "@getpaseo/protocol/agent-runs";

/** One completion consumer for a qualified child, independent of its transport. */
export function observeRunCompletion(input: {
  child: PaseoAgentHandle;
  recipient: PaseoAgentHandle;
  submissionId: string;
  title: string;
  active(): boolean;
  failed(error: unknown): void;
}): { ready: Promise<unknown>; release(): Promise<void> } {
  const observation = input.child.runs.observe(input.submissionId);
  let closed = false;
  const submitted = new Set<number>();
  let delivery: Promise<unknown> = Promise.resolve();
  const accept = (run: AgentRunRecord | null) => {
    if (closed || !input.active() || !run || run.durability === "pending") return;
    const checkpoint = run.checkpoints.at(-1);
    if (
      !checkpoint ||
      submitted.has(checkpoint.sequence) ||
      !["completed", "failed", "canceled", "permission"].includes(checkpoint.kind)
    )
      return;
    submitted.add(checkpoint.sequence);
    const identity = {
      serverId: run.agent.serverId,
      agentId: run.agent.agentId,
      submissionId: run.submissionId,
      turnId: run.turnId,
      checkpoint: checkpoint.sequence,
    };
    const messageId = `run-notification:${createHash("sha256")
      .update(JSON.stringify([input.recipient.address, identity]))
      .digest("hex")}`;
    delivery = delivery
      .then(async () => {
        if (closed || !input.active()) return;
        const permissionRequest =
          checkpoint.kind === "permission"
            ? (await input.child.refresh())?.agent.pendingPermissions.find(
                (request) => request.id === checkpoint.permissionRequestId,
              )
            : undefined;
        if (checkpoint.kind === "permission" && !permissionRequest) return;
        if (closed || !input.active()) return;
        const reason = notificationReason(checkpoint.kind);
        const text = `${formatFinishNotificationBody({
          childAgentId: run.agent.agentId,
          title: input.title,
          reason,
          lastAssistantMessage: checkpoint.result ?? null,
          permissionRequest,
        })}\n${JSON.stringify(identity)}${checkpoint.error ? `\n${checkpoint.error}` : ""}`;
        await input.recipient.send(text, {
          messageId,
          unarchive: false,
          activeTurnBehavior: "steer",
          source: {
            agent: run.agent,
            title: input.title,
            event: notificationEvent(checkpoint.kind),
          },
        });
        return undefined;
      })
      .catch(input.failed);
  };
  observation.subscribe({
    snapshot: ({ run }) => accept(run),
    update: (message) => {
      if (message.type === "agent.runs.changed") accept(message.payload.run);
    },
    error: input.failed,
  });
  return {
    ready: observation.ready,
    async release() {
      closed = true;
      await observation.release();
      await delivery;
    },
  };
}

function notificationReason(
  kind: string,
): "finished" | "errored" | "was canceled" | "needs permission" {
  if (kind === "completed") return "finished";
  if (kind === "canceled") return "was canceled";
  if (kind === "permission") return "needs permission";
  return "errored";
}

function notificationEvent(kind: string): "permission-required" | "finished" | "errored" {
  if (kind === "permission") return "permission-required";
  if (kind === "completed") return "finished";
  return "errored";
}
