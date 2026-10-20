import { AgentDispatchSchema, type AgentDispatch } from "@getpaseo/protocol/agent-dispatch";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const ReceiptSchema = z.object({
  fingerprint: z.string(),
  state: z.enum(["pending", "completed"]),
  agentId: z.string(),
  dispatch: AgentDispatchSchema.optional(),
});
interface SendMessageInput {
  agentId: string;
  messageId: string;
  request: unknown;
  send: () => Promise<AgentDispatch | void>;
  prepare?: () => Promise<void>;
}

/** Owns message delivery receipts; creation is owned by CreationService. */
export class MessageReceipts {
  private readonly pending = new Map<string, Promise<AgentDispatch | void>>();
  constructor(private readonly directory: string) {}

  send(input: SendMessageInput): Promise<AgentDispatch | void> {
    // Preserve the existing on-disk identity and shape across daemon upgrades.
    const key = digest(["send", input.agentId, input.messageId]);
    const previous = this.pending.get(key);
    const result = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(() =>
      this.sendOnce(key, input),
    );
    this.pending.set(key, result);
    void result
      .finally(() => {
        if (this.pending.get(key) === result) this.pending.delete(key);
      })
      .catch(() => undefined);
    return result;
  }

  private async sendOnce(key: string, input: SendMessageInput): Promise<AgentDispatch | void> {
    const file = path.join(this.directory, `${key}.json`);
    const fingerprint = digest(input.request);
    const existing = await readReceipt(file);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw Object.assign(new Error("agent_request_key_conflict"), {
          code: "agent_request_key_conflict",
        });
      if (existing.state === "completed") return existing.dispatch;
      // A provider may have accepted the message before its receipt was committed.
      throw Object.assign(new Error("agent_request_outcome_unknown"), {
        code: "agent_request_outcome_unknown",
        outcome: "unknown",
      });
    }
    await input.prepare?.();
    const receipt = { fingerprint, agentId: input.agentId };
    await writeJsonFileAtomic(file, { ...receipt, state: "pending" });
    const dispatch = await input.send();
    try {
      await writeJsonFileAtomic(file, {
        ...receipt,
        state: "completed",
        ...(dispatch ? { dispatch } : {}),
      });
    } catch (cause) {
      throw Object.assign(
        new Error("Message was dispatched but its receipt could not be committed", { cause }),
        {
          code: "agent_request_outcome_unknown",
          outcome: "unknown",
        },
      );
    }
    return dispatch;
  }
}

async function readReceipt(file: string): Promise<z.infer<typeof ReceiptSchema> | null> {
  try {
    return ReceiptSchema.parse(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, candidate: unknown) => {
        if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
          return Object.fromEntries(
            Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)),
          );
        }
        return candidate;
      }),
    )
    .digest("hex");
}
