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

  async function openSession(controlEvents?: boolean): Promise<GoalSession> {
    const log = new GoalEventLog({ dir });
    const service = new GoalService(new GoalStore(log), log);
    await service.start();
    return new GoalSession({
      host: {
        emit: (msg) => emitted.push(msg),
        ...(controlEvents === undefined ? {} : { supportsGoalControlEvents: () => controlEvents }),
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
});
