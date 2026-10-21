import { afterAll, describe, expect, test } from "vitest";
import type { Goal, GoalEvent, GoalEventInput } from "@getpaseo/protocol/goal/types";
import { GoalEventLog } from "./event-log.js";
import { CONFIG, createGoalTestEnv, task } from "./goal-test-env.js";

const REQUEST = JSON.stringify({ verdict: "request_changes", findings: ["tighten it"] });

/**
 * A scenario that touches every stage: two dependent implement tasks, a review
 * round that asks for rework, a merge conflict, a failing test command, and
 * verification. Its event log is the script for the crash tests below.
 */
async function recordFullRun(): Promise<GoalEvent[]> {
  const env = createGoalTestEnv();
  await env.init();
  try {
    env.script([task("a"), task("b", { dependsOn: ["a"] })]);
    let reviews = 0;
    env.stageReplies.review = () => {
      reviews += 1;
      return {
        outcome: "completed",
        text: env.fenced(
          reviews === 1 ? REQUEST : JSON.stringify({ verdict: "approve", findings: [] }),
        ),
      };
    };
    env.harness.git.mergeQueue.push(
      { ok: true, headCommit: "m1" },
      { ok: false, conflicts: ["x.ts"] },
    );
    env.harness.git.commandQueue.push(
      { exitCode: 0, timedOut: false, output: "ok" },
      { exitCode: 1, timedOut: false, output: "1 failing" },
    );
    const { store, manager } = await env.boot();
    await env.createGoal(store, { ...CONFIG, testCommand: "npm test", maxReworkRounds: 3 });
    await env.settle(manager);
    expect(env.goalOf(store).status).toBe("completed");
    return await env.readEvents();
  } finally {
    await env.cleanup();
  }
}

function strip(event: GoalEvent): GoalEventInput {
  const { seq: _seq, at: _at, ...input } = event;
  return input as GoalEventInput;
}

/** The integration head a restarted daemon would find in the worktree. */
function recordedHead(prefix: GoalEvent[]): string {
  const merged = prefix.findLast(
    (e) => e.type === "changeset.transitioned" && e.integratedCommit,
  ) as { integratedCommit: string } | undefined;
  return merged?.integratedCommit ?? "base0";
}

function assertSound(goal: Goal): void {
  expect(goal.runs.filter((r) => r.status === "running")).toEqual([]);
  expect(goal.tasks.filter((t) => t.status === "running")).toEqual([]);
  expect(
    goal.changeSets.filter((c) => c.status !== "integrated" && c.status !== "superseded"),
  ).toEqual([]);
  expect(goal.criteria.every((c) => c.verifiedAt)).toBe(true);
  for (const implemented of goal.tasks.filter((t) => t.kind === "implement")) {
    expect(implemented.captured).toBe(true);
  }
}

describe("recovery after a crash at every point", () => {
  let events: GoalEvent[] = [];

  test("the scenario itself reaches completion through every stage", async () => {
    events = await recordFullRun();
    const types = new Set(events.map((e) => e.type));
    for (const expected of [
      "plan.proposed",
      "run.started",
      "changeset.captured",
      "task.added",
      "integration.prepared",
      "criterion.verified",
      "goal.completed",
    ]) {
      expect(types.has(expected as GoalEvent["type"])).toBe(true);
    }
    const statuses = events
      .filter((e) => e.type === "changeset.transitioned")
      .map((e) => (e as { to: string }).to);
    expect(statuses).toEqual(
      expect.arrayContaining(["changes_requested", "conflicted", "test_failed", "integrated"]),
    );
  }, 30_000);

  test("a daemon that restarts after any recorded event finishes the goal", async () => {
    const failures: string[] = [];
    // The last event is goal.completed; restarting after it has nothing to resume.
    for (let keep = 1; keep < events.length; keep += 1) {
      const env = createGoalTestEnv();
      await env.init();
      try {
        const log = new GoalEventLog({ dir: env.logDir() });
        for (const event of events.slice(0, keep)) await log.append("g1", strip(event));
        env.script([task("a"), task("b", { dependsOn: ["a"] })]);
        // A real restart sees the commits and branch head that were recorded.
        env.harness.git.counter = 1000;
        env.harness.git.headValue = recordedHead(events.slice(0, keep));
        const { store, manager } = await env.boot();
        await env.settle(manager);
        const goal = store.get("g1");
        try {
          expect(goal?.status).toBe("completed");
          assertSound(goal as Goal);
        } catch (error) {
          failures.push(
            `after event ${keep} (${events[keep - 1]?.type}): status=${goal?.status} reason=${goal?.failureReason ?? "-"} ${error instanceof Error ? error.message.split("\n")[0] : ""}`,
          );
        }
      } finally {
        await env.cleanup();
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);

  afterAll(() => {
    events = [];
  });
});
