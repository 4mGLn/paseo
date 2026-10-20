import type { HostDirectory } from "@getpaseo/protocol/hosts";
import { shouldDetachFromArchivedParent } from "@getpaseo/protocol/agent-lifecycle";
import { hasOpenAgentTab, getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import { WorkspaceAddressSchema, type WorkspaceAddress } from "@getpaseo/protocol/addresses";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  ManagedAgentRelationship,
} from "@getpaseo/protocol/messages";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { HostRuntime } from "@getpaseo/client";
import { AgentAddressSchema, type AgentAddress } from "@getpaseo/protocol/addresses";
import {
  DaemonPermissionSchema,
  SubagentCreateInputSchema,
  SubagentRelationshipSchema,
  type DaemonPermission,
  type SubagentCreateInput,
  type SubagentDirectory,
} from "@getpaseo/protocol/messages";
import { writeJsonFileAtomic } from "../atomic-file.js";
import type { HostRuntimeAuthority } from "../host-runtime/index.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { buildStoredAgentPayload } from "../agent/agent-projections.js";

/** Stored authority contains identity and a ceiling; live admission belongs to the host. */
export interface SubagentAuthority {
  principalId: string;
  sourceId: string;
  permissionCeiling: readonly DaemonPermission[];
}
const AuthoritySchema = z.object({
  principalId: z.string(),
  sourceId: z.string(),
  permissionCeiling: z.array(DaemonPermissionSchema),
});
const RelationshipStateSchema = z.object({
  row: SubagentRelationshipSchema,
  authority: AuthoritySchema,
  confirmed: z.enum(["attached", "detached", "archived", "canceled"]).nullable(),
  intent: z.object({
    revision: z.number().int().nonnegative(),
    kind: z.enum(["attached", "detach", "archive-parent", "forgotten"]),
    parentWorkspace: WorkspaceAddressSchema.optional(),
    authority: AuthoritySchema,
  }),
});
const RecordSchema = z.discriminatedUnion("provenance", [
  RelationshipStateSchema.extend({
    provenance: z.literal("creation"),
    creation: SubagentCreateInputSchema,
    fingerprint: z.string(),
  }),
  RelationshipStateSchema.extend({
    provenance: z.literal("legacy-local-lifecycle"),
    creation: z.null(),
    fingerprint: z.null(),
  }),
]);
type RelationshipRecord = z.infer<typeof RecordSchema>;
type RelationshipIntent = RelationshipRecord["intent"];
const LedgerSchema = z.object({
  records: z.array(RecordSchema),
  legacyUpgrade: z.object({ complete: z.boolean(), candidates: z.array(z.string()) }),
});

/** Authoritative parent membership, independent of views and destination metadata. */
export class Subagents {
  private readonly records = new Map<string, RelationshipRecord>();
  private readonly listeners = new Set<() => void>();
  private readonly membershipListeners = new Set<(agentId: string) => void>();
  private readonly publishedMembership = new Map<string, string>();
  private readonly settling = new Map<string, Promise<void>>();
  private readonly startingObservers = new Map<string, Promise<void>>();
  private readonly running = new Map<string, Promise<AgentAddress>>();
  private readonly activeAuthorities = new Map<string, number>();
  private readonly runtimes = new Map<string, Promise<HostRuntime>>();
  private readonly observers = new Map<
    string,
    {
      intent: RelationshipIntent;
      release(): Promise<void>;
      creation?: () => CreationSnapshot | null;
    }
  >();
  private recovering: Promise<void> | null = null;
  private recoveryRequested = false;
  private mutation: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private closed = false;
  private legacyUpgrade = { complete: false, candidates: [] as string[] };

  constructor(
    private readonly options: {
      home: string;
      serverId: string;
      agents: Pick<AgentStorage, "list" | "get" | "upsert">;
      runtime(authority: HostRuntimeAuthority): Promise<HostRuntime>;
      resolveAuthority(principalId: string): ReturnType<HostRuntimeAuthority["resolveAdmission"]>;
    },
  ) {
    this.ready = this.load();
    void this.ready.catch(() => {});
  }

  private async load(): Promise<void> {
    let records: RelationshipRecord[] = [];
    let existing = false;
    try {
      const ledger = LedgerSchema.parse(JSON.parse(await readFile(this.path(), "utf8")));
      records = ledger.records;
      this.legacyUpgrade = ledger.legacyUpgrade;
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const record of records) {
      record.row.freshness = "stale";
      this.records.set(record.row.id, record);
    }
    if (!this.legacyUpgrade.complete) await this.upgradeLegacyMembership(existing);
  }
  initialize(): Promise<void> {
    return this.ready;
  }

  private async upgradeLegacyMembership(existing: boolean): Promise<void> {
    if (!existing) {
      const agents = await this.options.agents.list();
      const byId = new Map(agents.map((agent) => [agent.id, agent]));
      const admission = await this.options.resolveAuthority("owner");
      const authority: z.infer<typeof AuthoritySchema> = {
        principalId: "owner",
        sourceId: "owner",
        permissionCeiling: admission.permissions.filter((permission) =>
          ["daemon.read", "workspace.read", "workspace.write"].includes(permission),
        ),
      };
      for (const child of agents) {
        const parentId = getParentAgentIdFromLabels(child.labels);
        const parent = parentId ? byId.get(parentId) : undefined;
        if (
          !legacyManagedAgent(child) ||
          child.archivedAt ||
          !parent ||
          !legacyManagedAgent(parent) ||
          child.parent !== undefined
        )
          continue;
        if (
          [...this.records.values()].some(
            (record) =>
              record.row.child.serverId === this.options.serverId &&
              record.row.child.agentId === child.id,
          )
        )
          continue;
        const id = createHash("sha256")
          .update(JSON.stringify(["legacy-local-lifecycle", this.options.serverId, child.id]))
          .digest("hex");
        const address = { serverId: this.options.serverId, agentId: parent.id };
        this.records.set(id, {
          row: {
            id,
            parent: address,
            child: { serverId: this.options.serverId, agentId: child.id },
            ...(child.workspaceId
              ? { workspace: { serverId: this.options.serverId, workspaceId: child.workspaceId } }
              : {}),
            phase: "attached",
            freshness: "stale",
            observedAt: null,
            error: null,
            snapshot: buildStoredAgentPayload({ ...child, parent: address }, [child.provider]),
          },
          provenance: "legacy-local-lifecycle",
          creation: null,
          fingerprint: null,
          authority,
          confirmed: "attached",
          intent: { kind: "attached", revision: 0, authority },
        });
        this.legacyUpgrade.candidates.push(id);
      }
      // Persist the bounded candidate set before qualifying agent metadata. A restart
      // resumes these candidates, never a new scan of subsequently edited labels.
      await this.persist();
    }
    for (const id of this.legacyUpgrade.candidates) {
      const record = this.records.get(id)!;
      const child = await this.options.agents.get(record.row.child.agentId);
      if (!child) continue;
      if (child.parent === undefined)
        await this.options.agents.upsert({ ...child, parent: record.row.parent });
      else if (!child.parent || !sameAddress(child.parent, record.row.parent))
        throw new Error("Legacy child parent changed during membership upgrade");
    }
    this.legacyUpgrade.complete = true;
    await this.persist();
  }
  private path(): string {
    return join(this.options.home, "subagents.json");
  }
  private transact<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(async () => {
      await this.ready;
      if (this.closed) throw new Error("Subagent relationships are closed");
      return operation();
    });
    this.mutation = result.catch(() => {});
    return result;
  }
  private async persist(): Promise<void> {
    for (const record of this.records.values()) record.row.phase = relationshipPhase(record);
    await writeJsonFileAtomic(this.path(), {
      records: [...this.records.values()],
      legacyUpgrade: this.legacyUpgrade,
    });
    this.publishMembershipChanges();
    for (const changed of this.listeners) changed();
  }
  async assertHostRemovable(serverId: string): Promise<void> {
    await this.ready;
    if (
      [...this.records.values()].some(
        ({ row }) => row.child.serverId === serverId && !terminalPhase(row.phase),
      )
    )
      throw failure(
        "relationships_pending",
        "Detach children or explicitly forget their relationships before removing this host",
      );
  }
  observe(changed: () => void): () => void {
    this.listeners.add(changed);
    return () => {
      this.listeners.delete(changed);
    };
  }
  async list(parent: AgentAddress, authority: SubagentAuthority): Promise<SubagentDirectory> {
    await this.authorize(authority, "workspace.read");
    await this.ready;
    return {
      parent: AgentAddressSchema.parse(parent),
      rows: [...this.records.values()]
        .filter(({ row }) => sameAddress(row.parent, parent) && row.phase !== "forgotten")
        .map(({ row }) => structuredClone(row)),
    };
  }
  /** Only the relationship owner attests membership; a destination's parent pointer is metadata. */
  async membership(child: AgentAddress): Promise<ManagedAgentRelationship | null> {
    await this.ready;
    if (child.serverId !== this.options.serverId) return null;
    const record = [...this.records.values()].find(
      (candidate) => sameAddress(candidate.row.child, child) && this.attestsMembership(candidate),
    );
    if (!record) return null;
    const intent = record.intent;
    const parent = await this.options.agents.get(record.row.parent.agentId);
    if (record.intent !== intent || !this.attestsMembership(record)) return null;
    return {
      id: record.row.id,
      parent: { ...record.row.parent },
      parentWorkspace: parent?.workspaceId
        ? { serverId: record.row.parent.serverId, workspaceId: parent.workspaceId }
        : null,
    };
  }

  observeMembership(changed: (agentId: string) => void): () => void {
    this.membershipListeners.add(changed);
    return () => {
      this.membershipListeners.delete(changed);
    };
  }

  private attestsMembership(record: RelationshipRecord): boolean {
    return (
      record.row.parent.serverId === this.options.serverId &&
      record.row.child.serverId === this.options.serverId &&
      record.intent.kind !== "forgotten" &&
      (record.confirmed === null || record.confirmed === "attached")
    );
  }

  private publishMembershipChanges(): void {
    for (const record of this.records.values()) {
      if (record.row.child.serverId !== this.options.serverId) continue;
      const key = this.attestsMembership(record) ? JSON.stringify(record.row.parent) : "";
      const id = record.row.child.agentId;
      if (this.publishedMembership.get(id) === key) continue;
      this.publishedMembership.set(id, key);
      for (const changed of this.membershipListeners) changed(id);
    }
  }

  private authorityKey(authority: SubagentAuthority): string {
    return JSON.stringify([
      authority.principalId,
      authority.sourceId,
      [...authority.permissionCeiling].sort(),
    ]);
  }
  private async usingAuthority<T>(
    authority: SubagentAuthority,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = this.authorityKey(authority);
    this.activeAuthorities.set(key, (this.activeAuthorities.get(key) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = this.activeAuthorities.get(key)! - 1;
      if (remaining) this.activeAuthorities.set(key, remaining);
      else this.activeAuthorities.delete(key);
      await this.releaseUnusedRuntimes();
    }
  }
  private async releaseUnusedRuntimes(): Promise<void> {
    const used = new Set(this.activeAuthorities.keys());
    for (const record of this.records.values()) {
      if (terminalPhase(record.row.phase)) continue;
      used.add(this.authorityKey(record.authority));
      used.add(this.authorityKey(record.intent.authority));
    }
    const releases: Promise<unknown>[] = [];
    for (const [key, runtime] of this.runtimes) {
      if (used.has(key)) continue;
      this.runtimes.delete(key);
      releases.push(runtime.then((scope) => scope.dispose()));
    }
    await Promise.allSettled(releases);
  }
  private runtime(authority: SubagentAuthority): Promise<HostRuntime> {
    if (this.closed) throw new Error("Subagent relationships are closed");
    const key = this.authorityKey(authority);
    let pending = this.runtimes.get(key);
    if (!pending) {
      pending = this.options.runtime({
        sourceId: authority.sourceId,
        permissionCeiling: authority.permissionCeiling,
        resolveAdmission: () => this.options.resolveAuthority(authority.principalId),
      });
      this.runtimes.set(key, pending);
      const acquiring = pending;
      void acquiring.catch(() => {
        if (this.runtimes.get(key) === acquiring) this.runtimes.delete(key);
      });
    }
    return pending;
  }
  private async authorize(
    authority: SubagentAuthority,
    permission: DaemonPermission,
  ): Promise<void> {
    const admission = await this.options.resolveAuthority(authority.principalId);
    if (admission.hubExecutionAgents)
      throw failure(
        "unsupported_capability",
        "Execution-scoped subagent relationships are not supported",
      );
    if (
      !admission.permissions.includes(permission) ||
      !authority.permissionCeiling.includes(permission)
    )
      throw failure("access_denied", `Subagent relationships require ${permission}`);
  }
  async create(
    parent: AgentAddress,
    creation: SubagentCreateInput,
    authority: SubagentAuthority,
  ): Promise<AgentAddress> {
    return this.usingAuthority(authority, () =>
      this.createRelationship(parent, creation, authority),
    );
  }
  private async createRelationship(
    parent: AgentAddress,
    creation: SubagentCreateInput,
    authority: SubagentAuthority,
  ): Promise<AgentAddress> {
    parent = AgentAddressSchema.parse(parent);
    if (parent.serverId !== this.options.serverId)
      throw failure("invalid_parent", "Create subagents through the parent's host");
    await this.authorize(authority, "workspace.write");
    const runtime = await this.runtime(authority);
    const parentHandle = await runtime.agent(parent);
    const refreshed = await parentHandle.refresh();
    if (!refreshed) throw failure("invalid_parent", "Parent agent not found");
    const snapshot = refreshed.agent;
    if (snapshot.archivedAt)
      throw failure("invalid_parent", "Cannot attach a child to an archived parent");
    creation = SubagentCreateInputSchema.parse(creation);
    const id = createHash("sha256")
      .update(JSON.stringify([authority.sourceId, parent, creation.idempotencyKey]))
      .digest("hex");
    let workspaceId = creation.input.workspaceId;
    if (creation.workspace) {
      if (workspaceId)
        throw failure("invalid_placement", "Choose a new workspace or an existing workspace");
      workspaceId = creation.workspace.workspaceId ?? `wks_${id.slice(0, 16)}`;
      creation.workspace.workspaceId = workspaceId;
    } else if (!workspaceId) {
      if (creation.serverId !== parent.serverId)
        throw failure("workspace_required", "Choose a workspace on the destination host");
      workspaceId = snapshot.workspaceId;
      if (!workspaceId) throw failure("workspace_required", "The parent has no workspace");
    }
    creation.input.workspaceId = workspaceId;
    const fingerprint = JSON.stringify(creation);
    const record = await this.transact(async () => {
      const existing = this.records.get(id);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw failure("idempotency_conflict", "This subagent creation key has different inputs");
        return existing;
      }
      const fresh: RelationshipRecord = {
        provenance: "creation",
        row: {
          id,
          parent,
          child: { serverId: creation.serverId, agentId: creation.input.agentId ?? randomUUID() },
          workspace: { serverId: creation.serverId, workspaceId },
          phase: "creating",
          observedAt: null,
          freshness: "stale",
          error: null,
        },
        authority: { ...authority, permissionCeiling: [...authority.permissionCeiling] },
        creation,
        fingerprint,
        confirmed: null,
        intent: {
          revision: 0,
          kind: "attached",
          authority: { ...authority, permissionCeiling: [...authority.permissionCeiling] },
        },
      };
      this.records.set(id, fresh);
      try {
        await this.persist();
      } catch (error) {
        this.records.delete(id);
        throw error;
      }
      return fresh;
    });
    if (record.intent.kind === "forgotten")
      throw failure(
        "relationship_forgotten",
        "This relationship was explicitly forgotten; choose a new creation key to start different work",
      );
    if (record.confirmed !== null || record.intent.kind !== "attached") {
      void this.observeChild(record).catch(() => {});
      return record.row.child;
    }
    let running = this.running.get(id);
    if (!running) {
      running = this.createChild(record);
      this.running.set(id, running);
      void running.finally(() => this.running.delete(id)).catch(() => {});
    }
    return running;
  }
  private creationKey(record: RelationshipRecord): string {
    return creationRequest(record).input.idempotencyKey ?? `subagent:${record.row.id}`;
  }
  private async createChild(record: RelationshipRecord): Promise<AgentAddress> {
    const { row } = record;
    const creation = creationRequest(record);
    const creationIntent = record.intent;
    try {
      const runtime = await this.runtime(record.authority);
      const api = await runtime.client(row.child.serverId);
      try {
        const { config, initialPrompt, ...input } = creation.input;
        const agentOptions = {
          ...input,
          agentId: row.child.agentId,
          config: {
            ...config,
            provider: config.model ? `${config.provider}/${config.model}` : config.provider,
          },
          parent: row.parent,
          prompt: initialPrompt,
          clientMessageId: input.clientMessageId ?? `subagent:${row.id}:initial`,
        };
        let agent;
        if (creation.workspace) {
          await api.workspaces.create({
            ...creation.workspace,
            workspaceId: creation.input.workspaceId,
            idempotencyKey: this.creationKey(record),
            agent: { ...agentOptions, cwd: config.cwd },
          });
          agent = api.agents.ref(row.child.agentId);
          await agent.refresh();
        } else {
          const workspace = api.workspaces.ref(creation.input.workspaceId!);
          agent = await workspace.agents.create({
            ...agentOptions,
            ...(config.cwd ? { cwd: config.cwd } : {}),
            idempotencyKey: this.creationKey(record),
          });
        }
        await this.transact(async () => {
          // Creation confirms a resource; it never owns a newer lifecycle decision.
          if (!terminalConfirmation(record)) record.confirmed = "attached";
          if (record.intent.kind === "attached") this.captureSnapshot(record, agent.current());
          await this.persist();
        });
      } finally {
        await api.dispose();
      }
      if (record.intent.kind === "attached") void this.observeChild(record).catch(() => {});
      else void this.settleObligation(record).catch(() => {});
      return row.child;
    } catch (error) {
      await this.transact(async () => {
        if (record.intent !== creationIntent || terminalPhase(record.row.phase)) return;
        row.freshness = "unavailable";
        row.error = {
          code: error instanceof Error && "code" in error ? String(error.code) : "host_error",
          message: error instanceof Error ? error.message : String(error),
        };
        await this.persist();
      });
      throw error;
    }
  }
  async hostsChanged(directory: HostDirectory): Promise<void> {
    await this.ready;
    const unavailable = new Set(
      directory.hosts.filter((host) => host.status !== "online").map((host) => host.serverId),
    );
    await this.transact(async () => {
      let changed = false;
      for (const record of this.records.values()) {
        if (unavailable.has(record.row.child.serverId) && !terminalPhase(record.row.phase)) {
          record.row.freshness = "unavailable";
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
    await this.recover();
  }
  async detach(parent: AgentAddress, child: AgentAddress, authority: SubagentAuthority) {
    await this.authorize(authority, "workspace.write");
    const record = await this.find(parent, child);
    if (record.intent.kind === "forgotten")
      throw failure("relationship_forgotten", "This relationship was forgotten");
    if (record.row.phase === "detached") return structuredClone(record.row);
    await this.transact(async () => {
      if (record.intent.kind === "forgotten")
        throw failure("relationship_forgotten", "This relationship was forgotten");
      if (record.intent.kind !== "detach")
        record.intent = {
          revision: record.intent.revision + 1,
          kind: "detach",
          authority: {
            ...authority,
            permissionCeiling: authority.permissionCeiling.filter((permission) =>
              record.authority.permissionCeiling.includes(permission),
            ),
          },
        };
      await this.persist();
    });
    await this.settleObligation(record);
    return structuredClone(record.row);
  }
  async forget(
    parent: AgentAddress,
    child: AgentAddress,
    authority: SubagentAuthority,
  ): Promise<void> {
    await this.authorize(authority, "workspace.write");
    const record = await this.find(parent, child);
    await this.transact(async () => {
      record.intent = {
        revision: record.intent.revision + 1,
        kind: "forgotten",
        authority: { ...authority, permissionCeiling: [...authority.permissionCeiling] },
      };
      await this.persist();
    });
    await this.releaseObservation(record);
    await this.releaseUnusedRuntimes();
  }
  private async find(parent: AgentAddress, child: AgentAddress): Promise<RelationshipRecord> {
    await this.ready;
    const record = [...this.records.values()].find(
      ({ row }) => sameAddress(row.parent, parent) && sameAddress(row.child, child),
    );
    if (!record)
      throw failure("relationship_not_found", "This child is not attached to the selected parent");
    return record;
  }
  /** Called by the host lifecycle, never by a mounted view. */
  recover(): Promise<void> {
    this.recoveryRequested = true;
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      while (this.recoveryRequested && !this.closed) {
        this.recoveryRequested = false;
        await this.recoverAll();
      }
    })().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }
  private async recoverAll(): Promise<void> {
    await this.ready;
    if (this.closed) return;
    await Promise.allSettled(
      [...this.records.values()].map(async (record) => {
        if (terminalPhase(record.row.phase)) return;
        const runtime = await this.runtime(record.authority);
        const parent = await runtime.agent(record.row.parent);
        const refreshed = await parent.refresh();
        if (refreshed?.agent.archivedAt) {
          await this.parentArchived(
            record.row.parent,
            refreshed.agent.workspaceId
              ? { serverId: record.row.parent.serverId, workspaceId: refreshed.agent.workspaceId }
              : undefined,
          );
          return;
        }
        if (record.intent.kind !== "attached") {
          await this.settleObligation(record);
          return;
        }
        if (record.confirmed === null) await this.createChild(record);
        await this.observeChild(record);
      }),
    );
  }
  async parentArchived(
    parent: AgentAddress,
    workspace: WorkspaceAddress | undefined,
  ): Promise<void> {
    await this.transact(async () => {
      for (const record of this.records.values()) {
        if (
          !sameAddress(record.row.parent, parent) ||
          record.intent.kind !== "attached" ||
          terminalConfirmation(record)
        )
          continue;
        record.intent = {
          revision: record.intent.revision + 1,
          kind: "archive-parent",
          parentWorkspace: workspace,
          authority: record.authority,
        };
      }
      await this.persist();
    });
    await Promise.allSettled(
      [...this.records.values()]
        .filter(
          (record) =>
            sameAddress(record.row.parent, parent) &&
            record.intent.kind !== "attached" &&
            record.intent.kind !== "forgotten",
        )
        .map((record) => this.settleObligation(record)),
    );
  }
  private observeChild(record: RelationshipRecord): Promise<void> {
    let starting = this.startingObservers.get(record.row.id);
    if (!starting) {
      starting = this.startObservation(record);
      this.startingObservers.set(record.row.id, starting);
      void starting.finally(() => this.startingObservers.delete(record.row.id)).catch(() => {});
    }
    return starting;
  }
  private async startObservation(record: RelationshipRecord): Promise<void> {
    const intent = record.intent;
    if (this.closed || !observesChild(record) || this.observers.has(record.row.id)) return;
    const runtime = await this.runtime(record.authority);
    const child = await runtime.agent(record.row.child);
    if (
      this.closed ||
      record.intent !== intent ||
      !observesChild(record) ||
      this.observers.has(record.row.id)
    )
      return;
    const observation = child.observe();
    let applying: Promise<void> = Promise.resolve();
    const accept = (snapshot: AgentSnapshotPayload): void => {
      applying = applying
        .then(async () => {
          await this.transact(async () => {
            if (record.intent !== intent || !observesChild(record)) return;
            this.captureSnapshot(record, snapshot);
            await this.persist();
          });
          if (!observesChild(record)) {
            this.observers.delete(record.row.id);
            await observation.release();
            await this.releaseUnusedRuntimes();
          }
          return undefined;
        })
        .catch(async (error) => {
          if (record.intent === intent) await this.markUnavailable(record, error);
        });
    };
    this.observers.set(record.row.id, {
      intent,
      release: async () => {
        await observation.release();
        await applying;
      },
    });
    observation.subscribe({
      snapshot: accept,
      update: (message) => {
        if (
          message.type === "agent_update" &&
          message.payload.kind === "upsert" &&
          message.payload.agent.id === record.row.child.agentId
        )
          accept(message.payload.agent);
      },
      error: (error) => {
        void this.markUnavailable(record, error);
      },
    });
    try {
      await observation.ready;
      await applying;
    } catch (error) {
      this.observers.delete(record.row.id);
      await observation.release();
      if (record.intent === intent) await this.markUnavailable(record, error);
      throw error;
    }
  }
  private captureSnapshot(record: RelationshipRecord, snapshot: AgentSnapshotPayload | null): void {
    if (!snapshot) return;
    record.row.snapshot = snapshot;
    record.row.observedAt = new Date().toISOString();
    record.row.freshness = "current";
    record.row.error = null;
    if (snapshot.workspaceId)
      record.row.workspace = {
        serverId: record.row.child.serverId,
        workspaceId: snapshot.workspaceId,
      };
    if (snapshot.archivedAt) record.confirmed = "archived";
    else if (snapshot.parent === null) record.confirmed = "detached";
    else record.confirmed = "attached";
  }
  private async markUnavailable(record: RelationshipRecord, error: unknown): Promise<void> {
    if (this.closed) return;
    await this.transact(async () => {
      record.row.freshness = "unavailable";
      record.row.error = {
        code: error instanceof Error && "code" in error ? String(error.code) : "host_error",
        message: error instanceof Error ? error.message : String(error),
      };
      await this.persist();
    });
  }
  private settleObligation(record: RelationshipRecord): Promise<void> {
    if (
      record.intent.kind === "attached" ||
      record.intent.kind === "forgotten" ||
      terminalConfirmation(record)
    )
      return Promise.resolve();
    let settling = this.settling.get(record.row.id);
    if (!settling) {
      settling = Promise.resolve().then(() => this.settleCurrentIntent(record));
      this.settling.set(record.row.id, settling);
      void settling.finally(() => this.settling.delete(record.row.id)).catch(() => {});
    }
    return settling;
  }
  private async settleCurrentIntent(record: RelationshipRecord): Promise<void> {
    while (
      !this.closed &&
      record.intent.kind !== "attached" &&
      record.intent.kind !== "forgotten"
    ) {
      const intent = record.intent;
      await this.performSettlement(record, intent);
      if (record.intent === intent) break;
    }
  }
  private async observeCreation(
    record: RelationshipRecord,
    intent: RelationshipIntent,
    runtime: HostRuntime,
  ): Promise<CreationSnapshot | null> {
    const existing = this.observers.get(record.row.id);
    if (existing?.creation && existing.intent === intent) return existing.creation();
    await existing?.release();
    this.observers.delete(record.row.id);
    const api = await runtime.client(record.row.child.serverId);
    if (this.closed || record.intent !== intent) {
      await api.dispose();
      return null;
    }
    const observation = api.creations.observe({
      kind: creationRequest(record).workspace ? "workspace" : "agent",
      idempotencyKey: this.creationKey(record),
    });
    let latest: CreationSnapshot | null = null;
    const accept = (snapshot: CreationSnapshot | null) => {
      latest = snapshot;
      if (record.intent === intent && (snapshot?.agent || snapshot?.phase === "failed"))
        void this.recover().catch(() => {});
    };
    observation.subscribe({
      snapshot: (snapshot) => accept(snapshot.snapshot),
      update: (message) => {
        if (message.type === "agent.create.update") accept(message.payload);
      },
      error: (error) => {
        if (record.intent === intent) void this.markUnavailable(record, error);
      },
    });
    const owner = { intent, creation: () => latest, release: () => api.dispose() };
    this.observers.set(record.row.id, owner);
    try {
      const initial = await observation.ready;
      if (initial.error) throw new Error(initial.error);
      if (this.closed || record.intent !== intent) {
        if (this.observers.get(record.row.id) === owner) this.observers.delete(record.row.id);
        await owner.release();
      }
      return latest;
    } catch (error) {
      if (this.observers.get(record.row.id) === owner) this.observers.delete(record.row.id);
      await owner.release();
      throw error;
    }
  }
  private async releaseObservation(record: RelationshipRecord): Promise<void> {
    const observation = this.observers.get(record.row.id);
    this.observers.delete(record.row.id);
    await observation?.release();
  }

  private async performSettlement(
    record: RelationshipRecord,
    intent: RelationshipIntent,
  ): Promise<void> {
    try {
      await this.authorize(intent.authority, "workspace.write");
      const runtime = await this.runtime(intent.authority);
      const child = await runtime.agent(record.row.child);
      let current = await child.refresh();
      if (!current) {
        const creation = creationRequest(record);
        const destination = await runtime.client(record.row.child.serverId);
        try {
          if (record.intent !== intent) return;
          const cancellation = await destination.creations.cancel({
            ...(creation.workspace
              ? { kind: "workspace" as const, workspaceId: creation.input.workspaceId! }
              : { kind: "agent" as const }),
            idempotencyKey: this.creationKey(record),
            agentId: record.row.child.agentId,
          });
          if (cancellation.status === "canceled") {
            await this.transact(async () => {
              if (record.intent !== intent) return;
              record.confirmed = "canceled";
              record.row.error = null;
              record.row.freshness = "current";
              record.row.observedAt = new Date().toISOString();
              await this.persist();
            });
            await this.releaseObservation(record);
            await this.releaseUnusedRuntimes();
            return;
          }
          // Admission reserves an identity before the resource is ready. Inspect
          // its existing receipt; never resubmit an uncertain initial prompt.
          const receipt =
            (await this.observeCreation(record, intent, runtime)) ?? cancellation.creation;
          current = await child.refresh();
          if (!current) {
            await this.transact(async () => {
              if (record.intent !== intent) return;
              record.row.freshness = "current";
              record.row.error =
                receipt.phase === "failed"
                  ? {
                      code: receipt.outcomeUnknown ? "creation_outcome_unknown" : "creation_failed",
                      message: receipt.error ?? "Creation failed before its child became available",
                    }
                  : {
                      code: "creation_pending",
                      message:
                        "Creation was admitted but its child is not yet available; reconciliation remains pending",
                    };
              await this.persist();
            });
            return;
          }
        } finally {
          await destination.dispose();
        }
      }
      const action = await this.transact(async () => {
        // Completion ownership is tested inside the same serialization boundary as the write.
        if (record.intent !== intent) return null;
        this.captureSnapshot(record, current.agent);
        if (terminalConfirmation(record)) {
          await this.persist();
          return null;
        }
        const detach =
          intent.kind === "detach" ||
          shouldDetachFromArchivedParent({
            parentWorkspace: intent.parentWorkspace,
            childWorkspace: record.row.workspace,
            hasOpenTab: hasOpenAgentTab(current.agent.labels),
          });
        await this.persist();
        return detach ? "detach" : "archive";
      });
      if (!action || record.intent !== intent) return;
      // Forget can suppress future dispatch; an operation already submitted to the child cannot be undone.
      if (action === "detach") await child.detach();
      else await child.archive();
      await this.transact(async () => {
        if (record.intent !== intent) return;
        record.confirmed = action === "detach" ? "detached" : "archived";
        record.row.error = null;
        record.row.freshness = "current";
        record.row.observedAt = new Date().toISOString();
        await this.persist();
      });
      await this.releaseObservation(record);
      await this.releaseUnusedRuntimes();
    } catch (error) {
      if (record.intent === intent) await this.markUnavailable(record, error);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    // Owned transports stop before subscription cleanup; a stopping daemon no
    // longer forwards new requests, including graceful release acknowledgments.
    await Promise.allSettled(
      [...this.runtimes.values()].map(async (runtime) => (await runtime).dispose()),
    );
    this.runtimes.clear();
    await Promise.allSettled(
      [...this.observers.values()].map((observation) => observation.release()),
    );
    this.observers.clear();
    this.listeners.clear();
    this.membershipListeners.clear();
    await Promise.allSettled(this.running.values());
    await this.mutation;
  }
}
function sameAddress(a: AgentAddress, b: AgentAddress): boolean {
  return a.serverId === b.serverId && a.agentId === b.agentId;
}
function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function observesChild(record: RelationshipRecord): boolean {
  return record.intent.kind === "attached" && !terminalConfirmation(record);
}
function relationshipPhase(record: RelationshipRecord): RelationshipRecord["row"]["phase"] {
  if (record.intent.kind === "forgotten") return "forgotten";
  if (record.confirmed !== null && record.confirmed !== "attached") return record.confirmed;
  if (record.intent.kind === "detach") return "detach_pending";
  if (record.intent.kind === "archive-parent")
    return shouldDetachFromArchivedParent({
      parentWorkspace: record.intent.parentWorkspace,
      childWorkspace: record.row.workspace,
      hasOpenTab: hasOpenAgentTab(record.row.snapshot?.labels),
    })
      ? "detach_pending"
      : "lifecycle_pending";
  return record.confirmed === null ? "creating" : "attached";
}

function terminalConfirmation(record: RelationshipRecord): boolean {
  return record.confirmed !== null && record.confirmed !== "attached";
}
function terminalPhase(phase: RelationshipRecord["row"]["phase"]): boolean {
  return (
    phase === "detached" || phase === "archived" || phase === "forgotten" || phase === "canceled"
  );
}

function legacyManagedAgent(agent: StoredAgentRecord): boolean {
  return !agent.internal && !agent.owner;
}

function creationRequest(record: RelationshipRecord): SubagentCreateInput {
  if (record.provenance !== "creation" || !record.creation)
    throw failure(
      "agent_not_found",
      "The adopted existing child is absent; there is no creation to replay or cancel",
    );
  return record.creation;
}
