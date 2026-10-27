import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { GoalEventLog } from "../../goal/event-log.js";
import { GoalService } from "../../goal/goal-service.js";
import { GoalStore } from "../../goal/goal-store.js";
import { GoalSession } from "./goal-session.js";

const task = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id,
  description: "",
  kind: "implement" as const,
  dependsOn,
});

describe("GoalSession", () => {
  let dir: string;
  let emitted: SessionOutboundMessage[];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-goal-session-"));
    emitted = [];
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function openSession(
    controlEvents?: boolean,
    acknowledgeEvents?: boolean,
    managementEvents?: boolean,
    configEdit?: boolean,
  ): Promise<GoalSession> {
    const log = new GoalEventLog({ dir });
    const service = new GoalService(new GoalStore(log), log);
    await service.start();
    return new GoalSession({
      host: {
        emit: (msg) => emitted.push(msg),
        ...(controlEvents === undefined ? {} : { supportsGoalControlEvents: () => controlEvents }),
        ...(acknowledgeEvents === undefined
          ? {}
          : { supportsGoalAcknowledgeEvents: () => acknowledgeEvents }),
        ...(managementEvents === undefined
          ? {}
          : { supportsGoalManagementEvents: () => managementEvents }),
        ...(configEdit === undefined ? {} : { supportsGoalConfigEdit: () => configEdit }),
      },
      goalService: service,
      logger: pino({ level: "silent" }),
    });
  }

  async function send(session: GoalSession, msg: SessionInboundMessage): Promise<void> {
    await session.dispatch(msg);
  }

  test("creates, plans, approves, lists and inspects a goal", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "Ship",
      objective: "obj",
      criteria: ["tests pass"],
    });
    await send(session, {
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [task("a"), task("b", ["a"])],
    });
    await send(session, { type: "goal.approve_plan.request", requestId: "r3", goalId: "g1" });
    await send(session, { type: "goal.list.request", requestId: "r4" });
    await send(session, { type: "goal.inspect.request", requestId: "r5", goalId: "g1" });

    const approved = emitted.find((m) => m.type === "goal.approve_plan.response") as {
      payload: { goal: { status: string } };
    };
    const listed = emitted.find((m) => m.type === "goal.list.response") as {
      payload: { goals: unknown[] };
    };
    const inspected = emitted.find((m) => m.type === "goal.inspect.response") as {
      payload: { events: { type: string }[]; goal: { tasks: { id: string }[] } };
    };
    expect(approved.payload.goal.status).toBe("executing");
    expect(listed.payload.goals).toHaveLength(1);
    const inspect = inspected.payload;
    expect(inspect.events.map((e) => e.type)).toEqual([
      "goal.created",
      "plan.proposed",
      "plan.approved",
    ]);
    expect(inspect.goal.tasks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("a retried create returns the same goal without a second event", async () => {
    const session = await openSession();
    const create = {
      type: "goal.create.request" as const,
      requestId: "r1",
      goalId: "g1",
      title: "Ship",
      objective: "obj",
      criteria: [],
    };
    await send(session, create);
    await send(session, { ...create, requestId: "r2" });
    await send(session, { type: "goal.inspect.request", requestId: "r3", goalId: "g1" });
    const inspect = emitted.find((m) => m.type === "goal.inspect.response") as {
      payload: { events: unknown[] };
    };
    expect(inspect.payload.events).toHaveLength(1);
  });

  test("illegal transitions and unknown goals come back as rpc_error", async () => {
    const session = await openSession();
    await send(session, { type: "goal.approve_plan.request", requestId: "r1", goalId: "nope" });
    await send(session, {
      type: "goal.create.request",
      requestId: "r2",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, { type: "goal.approve_plan.request", requestId: "r3", goalId: "g1" });
    const errors = emitted.filter((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string; code: string };
    }[];
    expect(errors.map((e) => e.payload.requestId)).toEqual(["r1", "r3"]);
    expect(errors[0]?.payload.error).toMatch(/not found/);
    expect(errors[1]?.payload.error).toMatch(/awaiting_plan_approval/);
    expect(errors[0]?.payload.code).toBe("goal_request_failed");
  });

  test("ignores messages that are not goal requests", async () => {
    const session = await openSession();
    expect(session.dispatch({ type: "schedule/list", requestId: "x" })).toBeUndefined();
  });

  test("goals survive a restart", async () => {
    const first = await openSession();
    await send(first, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    const second = await openSession();
    await send(second, { type: "goal.list.request", requestId: "r2" });
    const list = emitted.findLast((m) => m.type === "goal.list.response") as {
      payload: { goals: { id: string }[] };
    };
    expect(list.payload.goals.map((g) => g.id)).toEqual(["g1"]);
  });

  test("rejects a plan with feedback, pauses and resumes, and refuses to retry a manual goal", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, {
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [task("a")],
    });
    await send(session, {
      type: "goal.reject_plan.request",
      requestId: "r3",
      goalId: "g1",
      feedback: "smaller steps",
    });
    await send(session, { type: "goal.retry.request", requestId: "r4", goalId: "g1" });
    const rejected = emitted.find((m) => m.type === "goal.reject_plan.response") as {
      payload: { goal: { status: string; planRejections: { reason: string }[] } };
    };
    expect(rejected.payload.goal.status).toBe("planning");
    expect(rejected.payload.goal.planRejections.map((r) => r.reason)).toEqual(["smaller steps"]);
    const error = emitted.find((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string };
    };
    expect(error.payload).toMatchObject({ requestId: "r4" });
    expect(error.payload.error).toMatch(/manual/);
  });

  for (const [label, capable, expected] of [
    ["sends", true, ["goal.created", "goal.paused", "goal.resumed"]],
    ["omits", false, ["goal.created"]],
  ] as const) {
    test(`${label} goal control events to clients ${capable ? "with" : "without"} the capability`, async () => {
      const session = await openSession(capable);
      await send(session, {
        type: "goal.create.request",
        requestId: "r1",
        goalId: "g1",
        title: "T",
        objective: "",
        criteria: ["works"],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "codex",
          maxParallel: 1,
          maxAttempts: 1,
          autoApprovePlan: false,
          notifyLead: false,
        },
      });
      await send(session, { type: "goal.pause.request", requestId: "r2", goalId: "g1" });
      await send(session, { type: "goal.resume.request", requestId: "r3", goalId: "g1" });
      await send(session, { type: "goal.inspect.request", requestId: "r4", goalId: "g1" });
      const paused = emitted.find((m) => m.type === "goal.pause.response") as {
        payload: { goal: { pausedAt: string | null } };
      };
      expect(paused.payload.goal.pausedAt).toBeTruthy();
      const inspected = emitted.find((m) => m.type === "goal.inspect.response") as {
        payload: { events: { type: string }[]; goal: { pausedAt: string | null } };
      };
      expect(inspected.payload.goal.pausedAt).toBeNull();
      expect(inspected.payload.events.map((e) => e.type)).toEqual(expected);
    });
  }

  test("goal.list carries task progress next to each goal", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, {
      type: "goal.propose_plan.request",
      requestId: "r2",
      goalId: "g1",
      tasks: [task("a"), task("b", ["a"])],
    });
    await send(session, { type: "goal.list.request", requestId: "r3" });
    const list = emitted.find((m) => m.type === "goal.list.response") as {
      payload: { goals: { progress: unknown }[] };
    };
    expect(list.payload.goals[0]?.progress).toEqual({
      tasksTotal: 2,
      tasksDone: 0,
      tasksFailed: 0,
      tasksRunning: 0,
    });
  });

  test("acknowledges an ended goal once, refuses a live one, and keeps the mark across a restart", async () => {
    const session = await openSession();
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, { type: "goal.acknowledge.request", requestId: "r2", goalId: "g1" });
    await send(session, { type: "goal.cancel.request", requestId: "r3", goalId: "g1" });
    await send(session, {
      type: "goal.acknowledge.request",
      requestId: "r4",
      goalId: "g1",
      eventId: "e1",
    });
    await send(session, {
      type: "goal.acknowledge.request",
      requestId: "r5",
      goalId: "g1",
      eventId: "e1",
    });
    await send(session, { type: "goal.acknowledge.request", requestId: "r6", goalId: "g1" });

    const error = emitted.find((m) => m.type === "rpc_error") as {
      payload: { requestId: string; error: string };
    };
    expect(error.payload.requestId).toBe("r2");
    expect(error.payload.error).toMatch(/only an ended goal/);
    const acks = emitted.filter((m) => m.type === "goal.acknowledge.response") as {
      payload: { goal: { status: string; acknowledgedAt: string | null } };
    }[];
    expect(acks).toHaveLength(3);
    const first = acks[0]?.payload.goal.acknowledgedAt;
    expect(first).toBeTruthy();
    expect(acks.map((a) => a.payload.goal.acknowledgedAt)).toEqual([first, first, first]);
    expect(acks[0]?.payload.goal.status).toBe("cancelled");

    const restarted = await openSession();
    await send(restarted, { type: "goal.inspect.request", requestId: "r7", goalId: "g1" });
    const inspected = emitted.findLast((m) => m.type === "goal.inspect.response") as {
      payload: { events: { type: string }[]; goal: { acknowledgedAt: string | null } };
    };
    expect(inspected.payload.goal.acknowledgedAt).toBe(first);
    expect(inspected.payload.events.map((e) => e.type)).toEqual([
      "goal.created",
      "goal.cancelled",
      "goal.acknowledged",
    ]);
  });

  test("omits goal.acknowledged from inspect for clients without the capability", async () => {
    const session = await openSession(true, false);
    await send(session, {
      type: "goal.create.request",
      requestId: "r1",
      goalId: "g1",
      title: "T",
      objective: "",
      criteria: [],
    });
    await send(session, { type: "goal.cancel.request", requestId: "r2", goalId: "g1" });
    await send(session, { type: "goal.acknowledge.request", requestId: "r3", goalId: "g1" });
    await send(session, { type: "goal.inspect.request", requestId: "r4", goalId: "g1" });
    const inspected = emitted.find((m) => m.type === "goal.inspect.response") as {
      payload: { events: { type: string }[]; goal: { acknowledgedAt: string | null } };
    };
    expect(inspected.payload.goal.acknowledgedAt).toBeTruthy();
    expect(inspected.payload.events.map((e) => e.type)).toEqual(["goal.created", "goal.cancelled"]);
  });

  async function createManual(session: GoalSession, goalId: string, title: string) {
    await send(session, {
      type: "goal.create.request",
      requestId: `create-${goalId}`,
      goalId,
      title,
      objective: "",
      criteria: [],
    });
  }

  function lastOf<T extends SessionOutboundMessage["type"]>(type: T) {
    return emitted.findLast((m) => m.type === type) as Extract<SessionOutboundMessage, { type: T }>;
  }

  test("renames, reprioritises, archives, filters and deletes goals", async () => {
    const session = await openSession();
    await createManual(session, "g1", "Fix login");
    await send(session, {
      type: "goal.create.request",
      requestId: "c2",
      goalId: "g2",
      title: "Write docs",
      objective: "",
      criteria: [],
      priority: "high",
    });
    await send(session, {
      type: "goal.rename.request",
      requestId: "r1",
      goalId: "g1",
      title: " Fix signup ",
    });
    expect(lastOf("goal.rename.response").payload.goal?.title).toBe("Fix signup");
    await send(session, {
      type: "goal.set_priority.request",
      requestId: "r2",
      goalId: "g1",
      priority: "low",
    });
    expect(lastOf("goal.set_priority.response").payload.goal?.priority).toBe("low");

    await send(session, { type: "goal.list.request", requestId: "l1" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2", "g1"]);
    await send(session, { type: "goal.list.request", requestId: "l2", query: "SIGNUP" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g1"]);
    await send(session, { type: "goal.list.request", requestId: "l3", priority: ["high"] });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2"]);

    // A live goal must be stopped first.
    await send(session, { type: "goal.archive.request", requestId: "a0", goalId: "g1" });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "a0",
      error: expect.stringMatching(/stop it before it can be archived/),
    });
    await send(session, { type: "goal.cancel.request", requestId: "x1", goalId: "g1" });
    await send(session, { type: "goal.archive.request", requestId: "a1", goalId: "g1" });
    expect(lastOf("goal.archive.response").payload.goal?.archivedAt).toBeTruthy();

    // Old clients send no filter and get archived goals hidden.
    await send(session, { type: "goal.list.request", requestId: "l4" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2"]);
    await send(session, { type: "goal.list.request", requestId: "l5", includeArchived: true });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2", "g1"]);
    await send(session, {
      type: "goal.list.request",
      requestId: "l6",
      includeArchived: true,
      archived: "only",
    });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g1"]);
    await send(session, {
      type: "goal.list.request",
      requestId: "l7",
      archived: "include",
      status: ["cancelled"],
    });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g1"]);

    await send(session, { type: "goal.unarchive.request", requestId: "u1", goalId: "g1" });
    expect(lastOf("goal.unarchive.response").payload.goal?.archivedAt).toBeNull();

    await send(session, { type: "goal.delete.request", requestId: "d0", goalId: "g2" });
    expect(lastOf("rpc_error").payload).toMatchObject({
      requestId: "d0",
      requestType: "goal.delete.request",
      error: expect.stringMatching(/stop it before it can be deleted/),
    });
    await send(session, { type: "goal.delete.request", requestId: "d1", goalId: "g1" });
    expect(lastOf("goal.delete.response").payload).toEqual({
      requestId: "d1",
      goalId: "g1",
      deleted: true,
      retained: [],
      error: null,
    });
    await send(session, { type: "goal.delete.request", requestId: "d2", goalId: "g1" });
    expect(lastOf("goal.delete.response").payload.deleted).toBe(false);
    await send(session, { type: "goal.list.request", requestId: "l8", archived: "include" });
    expect(lastOf("goal.list.response").payload.goals.map((g) => g.id)).toEqual(["g2"]);
  });

  for (const capable of [true, false]) {
    test(`${capable ? "keeps" : "omits"} goal management events for clients ${capable ? "with" : "without"} the capability`, async () => {
      const session = await openSession(true, true, capable);
      await createManual(session, "g1", "T");
      await send(session, {
        type: "goal.rename.request",
        requestId: "r1",
        goalId: "g1",
        title: "U",
      });
      await send(session, {
        type: "goal.set_priority.request",
        requestId: "r2",
        goalId: "g1",
        priority: "high",
      });
      await send(session, { type: "goal.cancel.request", requestId: "r3", goalId: "g1" });
      await send(session, { type: "goal.archive.request", requestId: "r4", goalId: "g1" });
      await send(session, { type: "goal.unarchive.request", requestId: "r5", goalId: "g1" });
      await send(session, { type: "goal.inspect.request", requestId: "r6", goalId: "g1" });
      const inspected = lastOf("goal.inspect.response").payload;
      expect(inspected.goal?.title).toBe("U");
      expect(inspected.events.map((e) => e.type)).toEqual(
        capable
          ? [
              "goal.created",
              "goal.renamed",
              "goal.priority_set",
              "goal.cancelled",
              "goal.archived",
              "goal.unarchived",
            ]
          : ["goal.created", "goal.cancelled"],
      );
    });
  }

  for (const capable of [true, false]) {
    test(`config edits and the auto policy ${capable ? "reach" : "are hidden from"} clients ${capable ? "with" : "without"} the capability`, async () => {
      const session = await openSession(true, true, true, capable);
      await send(session, {
        type: "goal.create.request",
        requestId: "r0",
        goalId: "g1",
        title: "T",
        objective: "o",
        criteria: ["works"],
        config: {
          cwd: "/repo",
          leadProvider: "claude",
          defaultProvider: "claude",
          maxParallel: 2,
          maxAttempts: 2,
          autoApprovePlan: false,
          notifyLead: true,
          onPermissionRequest: "auto",
        },
      });
      await send(session, {
        type: "goal.update_config.request",
        requestId: "r1",
        goalId: "g1",
        changes: { maxParallel: 3, limits: { maxRuns: 80 } },
        eventId: "edit-1",
      });
      await send(session, { type: "goal.list.request", requestId: "r2" });
      await send(session, { type: "goal.inspect.request", requestId: "r3", goalId: "g1" });

      const policy = capable ? "auto" : "wait";
      const updated = lastOf("goal.update_config.response").payload.goal;
      expect(updated?.config).toMatchObject({
        maxParallel: 3,
        limits: { maxRuns: 80 },
        onPermissionRequest: policy,
      });
      expect(lastOf("goal.list.response").payload.goals[0]?.config?.onPermissionRequest).toBe(
        policy,
      );
      const inspected = lastOf("goal.inspect.response").payload;
      expect(inspected.goal?.config?.onPermissionRequest).toBe(policy);
      expect(inspected.events.map((e) => e.type)).toEqual(
        capable ? ["goal.created", "goal.config_updated"] : ["goal.created"],
      );
      const created = inspected.events[0];
      expect(created?.type === "goal.created" && created.config?.onPermissionRequest).toBe(policy);
    });
  }
});
