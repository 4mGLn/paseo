import { z } from "zod";
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

const StoredRunSchema = AgentRunRecordSchema.extend({
  admission: z.enum(["pending", "rejected", "accepted"]).optional(),
  inputFingerprint: z.string().optional(),
});
type StoredRun = z.infer<typeof StoredRunSchema>;

/** Durable submission/turn identity and checkpoints; idle agent state is never a run result. */
export class AgentRuns {
  private readonly records = new Map<string, StoredRun>();
  private readonly submissionsByTurn = new Map<string, Set<string>>();
  private readonly loadedAgents = new Set<string>();
  private readonly observers = new Map<string, Set<(record: AgentRunRecord | null) => void>>();
  observe(
    agentId: string,
    submissionId: string,
    snapshot: (record: AgentRunRecord | null) => void,
    changed: (record: AgentRunRecord | null) => void,
  ): Promise<() => void> {
    return this.mutate(async () => {
      const key = this.identity(agentId, submissionId);
      const record = await this.read(agentId, submissionId);
      const observers = this.observers.get(key) ?? new Set();
      observers.add(changed);
      this.observers.set(key, observers);
      try {
        snapshot(record ? AgentRunRecordSchema.parse(record) : null);
      } catch (error) {
        observers.delete(changed);
        if (!observers.size) this.observers.delete(key);
        throw error;
      }
      return () => {
        observers.delete(changed);
        if (!observers.size) this.observers.delete(key);
      };
    });
  }
  private publish(agentId: string): void {
    for (const record of this.records.values()) {
      if (record.agent.agentId !== agentId) continue;
      for (const changed of this.observers.get(this.identity(agentId, record.submissionId)) ?? [])
        changed(AgentRunRecordSchema.parse(record));
    }
  }
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: { serverId: string; directory?: string }) {}

  private identity(agentId: string, submissionId: string): string {
    return JSON.stringify([agentId, submissionId]);
  }
  /** Restore turn ownership before subscribing to live provider evidence. */
  restore(agentId: string): Promise<void> {
    return this.mutate(() => this.load(agentId));
  }
  private async load(agentId: string): Promise<void> {
    if (this.loadedAgents.has(agentId)) return;
    let records: StoredRun[] = [];
    if (this.options.directory) {
      try {
        const saved: unknown = JSON.parse(await readFile(this.path(agentId), "utf8"));
        records = StoredRunSchema.array().parse(saved);
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
        this.bind(agentId, record.turnId, record.submissionId);
    }
    if (records.length && this.options.directory)
      await writeJsonFileAtomic(this.path(agentId), records);
    this.loadedAgents.add(agentId);
  }
  private async read(agentId: string, submissionId: string): Promise<StoredRun | null> {
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
    try {
      if (this.options.directory) await writeJsonFileAtomic(this.path(agentId), records);
      for (const record of records)
        this.records.set(this.identity(agentId, record.submissionId), record);
    } finally {
      // Publish accepted evidence with its current durability even when storage fails.
      this.publish(agentId);
    }
  }
  private async write(record: StoredRun, retainEvidence = false): Promise<void> {
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
      const record = await this.read(agentId, submissionId);
      return record ? AgentRunRecordSchema.parse(record) : null;
    });
  }
  prepare(agentId: string, submissionId: string, input: unknown = null): Promise<void> {
    return this.mutate(async () => {
      const existing = await this.read(agentId, submissionId);
      const inputFingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (
        existing?.admission === "rejected" &&
        existing.status === "submitted" &&
        existing.turnId === null &&
        existing.inputFingerprint === inputFingerprint
      ) {
        await this.write({ ...existing, admission: "pending" });
        return;
      }
      if (existing)
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
        admission: "pending",
        inputFingerprint,
        status: "submitted",
        checkpoints: [{ sequence: 1, kind: "submitted", at: new Date().toISOString() }],
      });
    });
  }
  /** The admission owner calls this only for a definitive pre-admission rejection. */
  rejectUnadmitted(agentId: string, submissionId: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(agentId, submissionId);
      if (
        !record ||
        record.status !== "submitted" ||
        record.turnId !== null ||
        record.admission !== "pending"
      )
        throw new Error("Cannot reject an admission that is no longer pending");
      await this.write({ ...record, admission: "rejected" }, true);
    });
  }
  start(agentId: string, submissionId: string, turnId: string): Promise<void> {
    return this.mutate(async () => {
      const record = await this.read(agentId, submissionId);
      if (!record) throw new Error("Run was not prepared before provider admission");
      if (record.turnId !== null && record.turnId !== turnId)
        throw new Error("Run submission cannot bind to a different provider turn");
      record.turnId = turnId;
      record.admission = "accepted";
      this.append(record, { kind: "running" });
      // Admission has happened. Retain its binding even if durable storage fails;
      // subsequent provider evidence can retry persistence without replaying work.
      this.records.set(this.identity(agentId, submissionId), record);
      this.bind(agentId, turnId, submissionId);
      await this.write(record, true);
    });
  }
  private bind(agentId: string, turnId: string, submissionId: string): void {
    const key = this.identity(agentId, turnId);
    const submissions = this.submissionsByTurn.get(key) ?? new Set<string>();
    submissions.add(submissionId);
    this.submissionsByTurn.set(key, submissions);
  }
  /** Called only after the provider accepted a steer, before staged events drain. */
  acceptSteer(agentId: string, submissionId: string, turnId: string): Promise<void> {
    return this.mutate(async () => {
      const existing = await this.read(agentId, submissionId);
      if (existing) {
        if (existing.turnId !== turnId)
          throw new Error("Run submission already belongs to another turn");
        return;
      }
      const record: AgentRunRecord = {
        agent: { serverId: this.options.serverId, agentId },
        submissionId,
        turnId,
        status: "submitted",
        checkpoints: [{ sequence: 1, kind: "submitted", at: new Date().toISOString() }],
      };
      this.append(record, { kind: "running" });
      this.bind(agentId, turnId, submissionId);
      await this.write(record, true);
    });
  }
  capture(
    agentId: string,
    turnId: string | undefined,
    event: AgentStreamEvent,
    result: string,
  ): Promise<void> | undefined {
    if (!turnId) return undefined;
    if (
      this.loadedAgents.has(agentId) &&
      !this.submissionsByTurn.has(this.identity(agentId, turnId))
    )
      return undefined;
    const checkpoint = checkpointFor(event, result);
    if (!checkpoint) return undefined;
    return this.mutate(async () => {
      await this.load(agentId);
      const submissions = this.submissionsByTurn.get(this.identity(agentId, turnId));
      if (!submissions) return;
      let changed = false;
      for (const submissionId of submissions) {
        const record = await this.read(agentId, submissionId);
        if (!record || terminal(record)) continue;
        if (
          checkpoint.permissionRequestId &&
          record.checkpoints.some(
            (existing) =>
              existing.kind === checkpoint.kind &&
              existing.permissionRequestId === checkpoint.permissionRequestId,
          )
        )
          continue;
        this.append(record, checkpoint);
        this.records.set(this.identity(agentId, submissionId), {
          ...record,
          durability: "pending",
        });
        changed = true;
      }
      if (
        [...submissions].every((id) => {
          const record = this.records.get(this.identity(agentId, id));
          return !record || terminal(record);
        })
      )
        this.submissionsByTurn.delete(this.identity(agentId, turnId));
      // Retain evidence for every accepted submission even if this write fails.
      if (changed) await this.persistAgent(agentId);
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
