import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentRunRecordSchema,
  type AgentRunRecord,
  type AgentRunCheckpoint,
} from "@getpaseo/protocol/agent-runs";
import type { AgentStreamEvent } from "../agent-sdk-types.js";
import { writeJsonFileAtomic } from "../../atomic-file.js";

/** Durable submission/turn identity and checkpoints; idle agent state is never a run result. */
export class AgentRuns {
  private readonly records = new Map<string, AgentRunRecord>();
  private readonly submissionsByTurn = new Map<string, string>();
  private readonly loadedAgents = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { serverId: string; directory?: string }) {}

  private identity(agentId: string, submissionId: string): string {
    return JSON.stringify([agentId, submissionId]);
  }
  private async load(agentId: string): Promise<void> {
    if (this.loadedAgents.has(agentId)) return;
    let records: AgentRunRecord[] = [];
    if (this.options.directory) {
      try {
        const saved: unknown = JSON.parse(await readFile(this.path(agentId), "utf8"));
        records = AgentRunRecordSchema.array().parse(saved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const record of records) {
      if (record.agent.serverId !== this.options.serverId || record.agent.agentId !== agentId)
        throw new Error("Run journal identity does not match its owning agent");
      if (!terminal(record) && record.status !== "interrupted")
        this.append(record, {
          kind: "interrupted",
          error: "Destination restarted before terminal provider evidence was recorded",
        });
      this.records.set(this.identity(agentId, record.submissionId), record);
      if (record.turnId && !terminal(record))
        this.submissionsByTurn.set(this.identity(agentId, record.turnId), record.submissionId);
    }
    if (records.length && this.options.directory)
      await writeJsonFileAtomic(this.path(agentId), records);
    this.loadedAgents.add(agentId);
  }
  private async read(agentId: string, submissionId: string): Promise<AgentRunRecord | null> {
    await this.load(agentId);
    const record = this.records.get(this.identity(agentId, submissionId));
    return record ? structuredClone(record) : null;
  }
  private path(agentId: string): string {
    if (!this.options.directory) throw new Error("Run journal has no persistence directory");
    return join(
      this.options.directory,
      `${createHash("sha256").update(agentId).digest("hex")}.json`,
    );
  }
  private async persistAgent(agentId: string): Promise<void> {
    const records = [...this.records.values()]
      .filter((record) => record.agent.agentId === agentId)
      .map((record) => Object.assign({}, record, { durability: "persisted" as const }));
    if (this.options.directory) await writeJsonFileAtomic(this.path(agentId), records);
    for (const record of records)
      this.records.set(this.identity(agentId, record.submissionId), record);
  }
  private async write(record: AgentRunRecord, retainEvidence = false): Promise<void> {
    const key = this.identity(record.agent.agentId, record.submissionId);
    const previous = this.records.get(key);
    this.records.set(key, { ...record, durability: "pending" });
    try {
      await this.persistAgent(record.agent.agentId);
    } catch (error) {
      if (!retainEvidence) {
        if (previous) this.records.set(key, previous);
        else this.records.delete(key);
      }
      throw error;
    }
  }
  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async get(agentId: string, submissionId: string): Promise<AgentRunRecord | null> {
    return this.mutate(async () => {
      await this.load(agentId);
      if (
        [...this.records.values()].some(
          (record) => record.agent.agentId === agentId && record.durability === "pending",
        )
      ) {
        // Keep observed evidence readable while storage is unavailable. A later
        // read or checkpoint retries the same atomic collection, without replay.
        await this.persistAgent(agentId).catch(() => {});
      }
      return this.read(agentId, submissionId);
    });
  }
  prepare(agentId: string, submissionId: string): Promise<void> {
    return this.mutate(async () => {
      if (await this.read(agentId, submissionId))
        throw Object.assign(
          new Error(
            "This run submission already exists; inspect it before submitting different work",
          ),
          { code: "submission_exists" },
        );
      await this.write({
        agent: { serverId: this.options.serverId, agentId },
        submissionId,
        turnId: null,
        status: "submitted",
        checkpoints: [{ sequence: 1, kind: "submitted", at: new Date().toISOString() }],
      });
    });
  }
  start(agentId: string, submissionId: string, turnId: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(agentId, submissionId);
      if (!record) throw new Error("Run was not prepared before provider admission");
      if (record.turnId !== null && record.turnId !== turnId)
        throw new Error("Run submission cannot bind to a different provider turn");
      record.turnId = turnId;
      this.append(record, { kind: "running" });
      // Admission has happened. Retain its binding even if durable storage fails;
      // subsequent provider evidence can retry persistence without replaying work.
      this.records.set(this.identity(agentId, submissionId), record);
      this.submissionsByTurn.set(this.identity(agentId, turnId), submissionId);
      await this.write(record, true);
    });
  }
  capture(
    agentId: string,
    turnId: string | undefined,
    event: AgentStreamEvent,
    result: string,
  ): Promise<void> {
    if (!turnId) return Promise.resolve();
    const checkpoint = checkpointFor(event, result);
    if (!checkpoint) return Promise.resolve();
    return this.mutate(async () => {
      await this.load(agentId);
      const submissionId = this.submissionsByTurn.get(this.identity(agentId, turnId));
      if (!submissionId) return;
      const record = await this.read(agentId, submissionId);
      if (!record || terminal(record)) return;
      if (
        checkpoint.permissionRequestId &&
        record.checkpoints.some(
          (existing) =>
            existing.kind === checkpoint.kind &&
            existing.permissionRequestId === checkpoint.permissionRequestId,
        )
      )
        return;
      this.append(record, checkpoint);
      if (terminal(record)) this.submissionsByTurn.delete(this.identity(agentId, turnId));
      await this.write(record, true);
    });
  }
  failAdmission(agentId: string, submissionId: string, error: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(agentId, submissionId);
      if (!record || terminal(record)) return;
      this.append(record, { kind: "failed", error });
      await this.write(record, true);
    });
  }
  private append(record: AgentRunRecord, input: Omit<AgentRunCheckpoint, "sequence" | "at">): void {
    record.checkpoints.push({
      ...input,
      sequence: record.checkpoints.length + 1,
      at: new Date().toISOString(),
    });
    record.status = input.kind === "resumed" ? "running" : input.kind;
  }
  async flush(): Promise<void> {
    await this.queue;
  }
}
function terminal(record: AgentRunRecord): boolean {
  return (
    record.status === "completed" || record.status === "failed" || record.status === "canceled"
  );
}
function checkpointFor(
  event: AgentStreamEvent,
  result: string,
): Omit<AgentRunCheckpoint, "sequence" | "at"> | null {
  switch (event.type) {
    case "permission_requested":
      return { kind: "permission", permissionRequestId: event.request.id };
    case "permission_resolved":
      return { kind: "resumed", permissionRequestId: event.requestId };
    case "turn_completed":
      return { kind: "completed", result };
    case "turn_failed":
      return { kind: "failed", error: event.error, result };
    case "turn_canceled":
      return { kind: "canceled", error: event.reason, result };
    default:
      return null;
  }
}
