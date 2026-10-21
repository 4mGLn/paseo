import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { GoalSchema } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import { GoalManager } from "./goal-manager.js";
import { GoalStore } from "./goal-store.js";
import { FakeClock, Harness } from "./goal-test-env.js";

/**
 * Logs are append-only and there is no migration step, so every change to an event
 * must keep old logs replayable. These fixtures are logs as earlier phases wrote
 * them: frozen text, not built from the current schemas.
 */
const AT = "2026-01-01T00:00:00.000Z";

function jsonl(goalId: string, events: Record<string, unknown>[]): string {
  return `${events
    .map((e, i) => JSON.stringify({ id: `${goalId}-${i + 1}`, goalId, seq: i + 1, at: AT, ...e }))
    .join("\n")}\n`;
}

const spec = (id: string, kind = "implement") => ({
  id,
  title: `Task ${id}`,
  description: "",
  kind,
  dependsOn: [],
});

const phase1Log = (goalId: string) =>
  jsonl(goalId, [
    {
      type: "goal.created",
      title: "Manual",
      objective: "",
      criteria: [{ id: "c1", text: "works" }],
    },
    { type: "plan.proposed", tasks: [spec("a")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "task.succeeded", taskId: "a" },
    { type: "criterion.verified", criterionId: "c1" },
    { type: "goal.completed" },
  ]);

const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: true,
  notifyLead: false,
};

const phase2Log = (goalId: string) =>
  jsonl(goalId, [
    {
      type: "goal.created",
      title: "Managed",
      objective: "o",
      criteria: [{ id: "c1", text: "w" }],
      config,
    },
    { type: "lead.attached", agentId: "lead-1" },
    { type: "plan.proposed", tasks: [spec("a", "read")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
    { type: "run.attached", runId: "a-a1", agentId: "ag", workspaceId: "ws" },
    { type: "task.succeeded", taskId: "a", summary: "read it" },
    { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
    { type: "lead.notified", key: "all-tasks-finished" },
  ]);

// A managed goal that failed before notifications were recorded: the Lead was told
// with lead.notified, the originating chat with no event at all.
const preNotificationLog = (goalId: string) =>
  jsonl(goalId, [
    {
      type: "goal.created",
      title: "Told",
      objective: "o",
      criteria: [{ id: "c1", text: "w" }],
      config: { ...config, notifyLead: true, originAgentId: "chat-1" },
    },
    { type: "lead.attached", agentId: "lead-1", workspaceId: "lead-ws" },
    { type: "plan.proposed", tasks: [spec("a", "read")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
    { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" },
    { type: "task.failed", taskId: "a", error: "x" },
    { type: "lead.notified", key: "task-a-failed" },
    { type: "goal.failed", reason: "No task can make progress. Failed or blocked: a" },
  ]);

describe("goal logs written by earlier phases", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-compat-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load() {
    const store = new GoalStore(new GoalEventLog({ dir }));
    await store.recover();
    return store;
  }

  test("a phase 1 log replays into a valid completed goal", async () => {
    await writeFile(join(dir, "m1.jsonl"), phase1Log("m1"));
    const goal = (await load()).get("m1");
    expect(goal?.status).toBe("completed");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal).toMatchObject({ config: null, runs: [], changeSets: [], integration: null });
    expect(goal?.criteria[0]).toMatchObject({ verifiedAt: AT, evidence: null });
  });

  test("a phase 2 log replays, with fields added later defaulting sensibly", async () => {
    await writeFile(join(dir, "p2.jsonl"), phase2Log("p2"));
    const goal = (await load()).get("p2");
    expect(goal?.status).toBe("executing");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal).toMatchObject({ leadAgentId: "lead-1", leadWorkspaceId: null });
    expect(goal?.runs[0]).toMatchObject({ id: "a-a1", cwd: null, status: "succeeded" });
  });

  test("a log from before notifications were recorded replays with none and sends nothing", async () => {
    await writeFile(join(dir, "n1.jsonl"), preNotificationLog("n1"));
    const store = await load();
    const goal = store.get("n1");
    expect(goal?.status).toBe("failed");
    expect(GoalSchema.safeParse(goal).success).toBe(true);
    expect(goal?.notifications).toEqual([]);

    const harness = new Harness();
    const manager = new GoalManager({
      store,
      agents: harness.agentPort,
      workspaces: harness.workspacePort,
      git: harness.git,
      clock: new FakeClock(),
      logger: pino({ level: "silent" }),
    });
    await manager.start();
    await manager.idle();
    manager.stop();
    // Neither the Lead nor the chat hears about a goal that ended before the upgrade.
    expect(harness.notifyAttempts).toBe(0);
    expect(store.get("n1")?.lastSeq).toBe(10);
  });

  test("an event carrying fields this version does not know is still accepted", async () => {
    const log = phase1Log("x1").replace(
      '"type":"plan.approved"',
      '"type":"plan.approved","futureField":42',
    );
    await writeFile(join(dir, "x1.jsonl"), log);
    expect((await load()).get("x1")?.status).toBe("completed");
  });

  test("a log from a newer version is set aside without stopping the others", async () => {
    await writeFile(join(dir, "m1.jsonl"), phase1Log("m1"));
    await writeFile(
      join(dir, "future.jsonl"),
      jsonl("future", [
        { type: "goal.created", title: "T", objective: "", criteria: [] },
        { type: "plan.teleported", destination: "mars" },
      ]),
    );
    const store = await load();
    expect(store.get("m1")?.status).toBe("completed");
    expect(store.get("future")).toBeUndefined();
    expect([...store.unreadable.keys()]).toEqual(["future"]);
  });

  test("a live goal from before work capture existed fails loudly rather than completing unreviewed", async () => {
    // An implement task that succeeded in phase 2, before change sets existed.
    await writeFile(
      join(dir, "old.jsonl"),
      jsonl("old", [
        {
          type: "goal.created",
          title: "Old",
          objective: "o",
          criteria: [{ id: "c1", text: "w" }],
          config,
        },
        { type: "plan.proposed", tasks: [spec("a")] },
        { type: "plan.approved" },
        { type: "task.started", taskId: "a" },
        { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
        { type: "run.attached", runId: "a-a1", agentId: "ag", workspaceId: "ws" },
        { type: "task.succeeded", taskId: "a", summary: "done" },
        { type: "run.finished", runId: "a-a1", outcome: "succeeded" },
      ]),
    );
    const store = await load();
    const harness = new Harness();
    const manager = new GoalManager({
      store,
      agents: harness.agentPort,
      workspaces: harness.workspacePort,
      git: harness.git,
      clock: new FakeClock(),
      logger: pino({ level: "silent" }),
    });
    await manager.start();
    await manager.idle();
    manager.stop();

    const goal = store.get("old");
    expect(goal?.status).toBe("failed");
    expect(goal?.failureReason).toMatch(/Could not recover the work of task a/);
    expect(harness.git.merges).toHaveLength(0);
  });
});
