import { describe, expect, it } from "vitest";
import { goalControlsAvailable, goalGuidance, goalPhase, goalSteps } from "./goal-phase";
import { makeChangeSet, makeGoal, makeRun, makeTask } from "./test-utils/goal-fixture";

function states(goal: Parameters<typeof goalSteps>[0]): string[] | undefined {
  return goalSteps(goal)?.map((step) => `${step.id}:${step.state}`);
}

describe("goalPhase", () => {
  it("follows the goal status before work starts", () => {
    expect(goalPhase(makeGoal({ status: "planning" }))).toBe("planning");
    expect(goalPhase(makeGoal({ status: "awaiting_plan_approval" }))).toBe("plan_review");
    expect(goalPhase(makeGoal({ status: "planning", config: null }))).toBe("manual");
  });

  it("names the furthest-behind work while executing", () => {
    const executing = { status: "executing" as const };
    expect(
      goalPhase(makeGoal({ ...executing, tasks: [makeTask("t1", { status: "running" })] })),
    ).toBe("working");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "running" })],
          changeSets: [makeChangeSet("c", "t0", { status: "awaiting_human" })],
        }),
      ),
    ).toBe("change_review");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "succeeded" })],
          changeSets: [makeChangeSet("c", "t1", { status: "in_review" })],
        }),
      ),
    ).toBe("reviewing");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "succeeded" })],
          changeSets: [makeChangeSet("c", "t1", { status: "integrating" })],
        }),
      ),
    ).toBe("integrating");
    expect(
      goalPhase(
        makeGoal({
          ...executing,
          tasks: [makeTask("t1", { status: "succeeded" })],
          changeSets: [makeChangeSet("c", "t1", { status: "integrated" })],
        }),
      ),
    ).toBe("verifying");
  });

  it("reports a paused goal as paused", () => {
    expect(goalPhase(makeGoal({ status: "executing", pausedAt: "2026-10-21T00:00:00Z" }))).toBe(
      "paused",
    );
  });
});

describe("goalSteps", () => {
  it("has no steps for a manual goal", () => {
    expect(goalSteps(makeGoal({ config: null }))).toBeNull();
  });

  it("marks earlier steps done and the current one", () => {
    expect(states(makeGoal({ status: "awaiting_plan_approval" }))).toEqual([
      "planning:done",
      "plan_review:current",
      "working:upcoming",
      "review:upcoming",
      "integrating:upcoming",
      "done:upcoming",
    ]);
  });

  it("completes every step", () => {
    expect(goalSteps(makeGoal({ status: "completed" }))?.every((s) => s.state === "done")).toBe(
      true,
    );
  });

  it("stops at the step an ended goal reached", () => {
    expect(states(makeGoal({ status: "cancelled" }))?.[0]).toBe("planning:stopped");
    expect(states(makeGoal({ status: "cancelled", tasks: [makeTask("t1")] }))?.[1]).toBe(
      "plan_review:stopped",
    );
    const failedWhileWorking = makeGoal({
      status: "failed",
      tasks: [makeTask("t1", { status: "failed" })],
      runs: [makeRun("r1", "t1", { status: "failed" })],
    });
    expect(states(failedWhileWorking)?.slice(1, 4)).toEqual([
      "plan_review:done",
      "working:stopped",
      "review:upcoming",
    ]);
  });
});

describe("goalGuidance", () => {
  it("asks for the changes held for approval", () => {
    const guidance = goalGuidance(
      makeGoal({
        status: "executing",
        tasks: [makeTask("t1", { status: "succeeded" })],
        changeSets: [
          makeChangeSet("a", "t1", { status: "awaiting_human" }),
          makeChangeSet("b", "t1", { status: "awaiting_human" }),
        ],
      }),
    );
    expect(guidance).toEqual({
      phase: "change_review",
      tone: "warning",
      params: { running: 0, total: 1, held: 2, branch: "paseo-goal/goal-1" },
    });
  });
});

describe("goalControlsAvailable", () => {
  const plan = makeGoal({ status: "awaiting_plan_approval" });

  it("offers nothing without host support or for a manual goal", () => {
    expect(Object.values(goalControlsAvailable(plan, false)).some(Boolean)).toBe(false);
    expect(
      Object.values(goalControlsAvailable({ ...plan, config: null }, true)).some(Boolean),
    ).toBe(false);
  });

  it("allows sending a plan back up to the daemon's limit", () => {
    expect(goalControlsAvailable(plan, true).canRejectPlan).toBe(true);
    const rejection = { reason: "", tasks: [], at: "2026-10-21T00:00:00Z" };
    const exhausted = { ...plan, planRejections: Array.from({ length: 5 }, () => rejection) };
    expect(goalControlsAvailable(exhausted, true).canRejectPlan).toBe(false);
  });

  it("pauses a live goal and resumes a paused one", () => {
    const running = makeGoal({ status: "executing" });
    expect(goalControlsAvailable(running, true)).toMatchObject({
      canPause: true,
      canResume: false,
      canRetryTasks: true,
    });
    expect(
      goalControlsAvailable({ ...running, pausedAt: "2026-10-21T00:00:00Z" }, true),
    ).toMatchObject({ canPause: false, canResume: true });
    expect(goalControlsAvailable(makeGoal({ status: "completed" }), true).canPause).toBe(false);
  });

  it("retries a failed goal unless a change was rejected", () => {
    const failed = makeGoal({ status: "failed" });
    expect(goalControlsAvailable(failed, true).canRetry).toBe(true);
    const rejected = {
      ...failed,
      changeSets: [makeChangeSet("c", "t1", { status: "rejected" })],
    };
    expect(goalControlsAvailable(rejected, true).canRetry).toBe(false);
  });
});
