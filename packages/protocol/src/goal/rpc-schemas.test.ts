import { describe, expect, test } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "../messages.js";
import { GoalConfigSchema } from "./types.js";

const config = {
  cwd: "/repo",
  leadProvider: "claude",
  defaultProvider: "codex",
  maxParallel: 2,
  maxAttempts: 2,
  autoApprovePlan: false,
  notifyLead: true,
};

describe("goal RPC schemas", () => {
  test("inbound requests parse through the session union", () => {
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.create.request",
        requestId: "r1",
        title: "Ship",
        objective: "",
        criteria: ["tests pass"],
      }).type,
    ).toBe("goal.create.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "goal.propose_plan.request",
        requestId: "r2",
        goalId: "g1",
        eventId: "e1",
        tasks: [{ id: "a", title: "A", description: "", kind: "implement", dependsOn: [] }],
      }).type,
    ).toBe("goal.propose_plan.request");
  });

  test("rejects a plan task with an unknown kind", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "goal.propose_plan.request",
        requestId: "r2",
        goalId: "g1",
        tasks: [{ id: "a", title: "A", description: "", kind: "deploy", dependsOn: [] }],
      }).success,
    ).toBe(false);
  });

  test("responses parse through the session union", () => {
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.list.response",
        payload: { requestId: "r1", goals: [], error: null },
      }).type,
    ).toBe("goal.list.response");
  });

  test("goal control requests parse with and without their optional fields", () => {
    for (const message of [
      { type: "goal.reject_plan.request", requestId: "r", goalId: "g" },
      {
        type: "goal.reject_plan.request",
        requestId: "r",
        goalId: "g",
        feedback: "x",
        eventId: "e",
      },
      { type: "goal.retry.request", requestId: "r", goalId: "g" },
      { type: "goal.retry.request", requestId: "r", goalId: "g", taskId: "a" },
      { type: "goal.pause.request", requestId: "r", goalId: "g" },
      { type: "goal.resume.request", requestId: "r", goalId: "g", eventId: "e" },
    ]) {
      expect(SessionInboundMessageSchema.parse(message).type).toBe(message.type);
    }
  });

  test("a goal from a daemon without goal controls still parses", () => {
    const goal = {
      id: "g",
      title: "T",
      objective: "",
      status: "executing",
      config,
      leadAgentId: null,
      leadWorkspaceId: null,
      criteria: [],
      tasks: [],
      runs: [],
      changeSets: [],
      integration: null,
      lastSeq: 3,
      failureReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      SessionOutboundMessageSchema.parse({
        type: "goal.pause.response",
        payload: { requestId: "r", goal, error: null },
      }).type,
    ).toBe("goal.pause.response");
  });

  test("config accepts the new settings and refuses an unsafe branch prefix", () => {
    const rich = {
      ...config,
      verifyProvider: "opencode/some-model",
      branchPrefix: "goals/team-a",
      limits: { maxTotalTokens: 2_000_000, maxCostUsd: 12.5, deadlineAt: "2026-12-01T00:00:00Z" },
    };
    expect(GoalConfigSchema.safeParse(rich).success).toBe(true);
    for (const branchPrefix of ["../x", "-x", "a//b", "a b", ".hidden"]) {
      expect(GoalConfigSchema.safeParse({ ...config, branchPrefix }).success).toBe(false);
    }
    expect(GoalConfigSchema.safeParse({ ...config, limits: { maxCostUsd: 0 } }).success).toBe(
      false,
    );
  });
});
