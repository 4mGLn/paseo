import { describe, expect, test } from "vitest";
import type { Goal, GoalEvent, TaskSpec } from "@getpaseo/protocol/goal/types";
import { GoalTransitionError, applyGoalEvent, replayGoal } from "./goal-reducer.js";
import { TaskGraphError, blockedTasks, readyTasks, validateTaskGraph } from "./task-graph.js";

const AT = "2026-01-01T00:00:00.000Z";

function task(id: string, dependsOn: string[] = []): TaskSpec {
  return { id, title: id, description: "", kind: "implement", dependsOn };
}

let counter = 0;
function ev(goal: Goal | null, partial: Record<string, unknown>): GoalEvent {
  counter += 1;
  return {
    id: `e${counter}`,
    goalId: "g1",
    seq: (goal?.lastSeq ?? 0) + 1,
    at: AT,
    ...partial,
  } as GoalEvent;
}

function run(events: Record<string, unknown>[]): Goal {
  let goal: Goal | null = null;
  for (const partial of events) {
    goal = applyGoalEvent(goal, ev(goal, partial));
  }
  if (!goal) throw new Error("no events");
  return goal;
}

const created = {
  type: "goal.created",
  title: "T",
  objective: "O",
  criteria: [{ id: "c1", text: "works" }],
};

describe("task graph", () => {
  test("rejects duplicate ids, unknown deps, self deps and cycles", () => {
    expect(() => validateTaskGraph([task("a"), task("a")])).toThrow(TaskGraphError);
    expect(() => validateTaskGraph([task("a", ["x"])])).toThrow(/unknown task x/);
    expect(() => validateTaskGraph([task("a", ["a"])])).toThrow(/itself/);
    expect(() => validateTaskGraph([task("a", ["b"]), task("b", ["a"])])).toThrow(/cycle/);
  });

  test("accepts a diamond", () => {
    expect(() =>
      validateTaskGraph([task("a"), task("b", ["a"]), task("c", ["a"]), task("d", ["b", "c"])]),
    ).not.toThrow();
  });

  test("readyTasks and blockedTasks follow dependency status", () => {
    const base = (id: string, deps: string[], status: string) =>
      ({ ...task(id, deps), status, attempts: 0, error: null }) as Goal["tasks"][number];
    const tasks = [
      base("a", [], "succeeded"),
      base("b", ["a"], "pending"),
      base("c", ["b"], "pending"),
      base("x", [], "failed"),
      base("y", ["x"], "pending"),
      base("z", ["y"], "pending"),
    ];
    expect(readyTasks(tasks).map((t) => t.id)).toEqual(["b"]);
    expect(blockedTasks(tasks).map((t) => t.id)).toEqual(["y", "z"]);
  });
});

describe("goal reducer", () => {
  const planned = [
    created,
    { type: "plan.proposed", tasks: [task("a"), task("b", ["a"])] },
    { type: "plan.approved" },
  ];

  test("runs a goal from creation to completion", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
      { type: "criterion.verified", criterionId: "c1" },
      { type: "goal.completed" },
    ]);
    expect(goal.status).toBe("completed");
    expect(goal.lastSeq).toBe(9);
    expect(goal.criteria[0]?.verifiedAt).toBe(AT);
  });

  test("refuses to start a task whose dependency has not succeeded", () => {
    expect(() => run([...planned, { type: "task.started", taskId: "b" }])).toThrow(/not ready/);
  });

  test("refuses completion with open tasks or unverified criteria", () => {
    const running = [...planned, { type: "task.started", taskId: "a" }];
    expect(() => run([...running, { type: "goal.completed" }])).toThrow(/tasks not succeeded/);

    const allDone = [
      ...running,
      { type: "task.succeeded", taskId: "a" },
      { type: "task.started", taskId: "b" },
      { type: "task.succeeded", taskId: "b" },
    ];
    expect(() => run([...allDone, { type: "goal.completed" }])).toThrow(/criteria not verified/);
  });

  test("retry returns a failed task to pending and counts attempts", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "task.failed", taskId: "a", error: "boom" },
      { type: "task.retried", taskId: "a" },
      { type: "task.started", taskId: "a" },
    ]);
    expect(goal.tasks[0]).toMatchObject({ status: "running", attempts: 2, error: null });
  });

  test("cancel marks open tasks cancelled and rejects later events", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "goal.cancelled" },
    ]);
    expect(goal.tasks.map((t) => t.status)).toEqual(["cancelled", "cancelled"]);
    expect(() => applyGoalEvent(goal, ev(goal, { type: "plan.approved" }))).toThrow(/cancelled/);
  });

  test("failing a goal closes out running tasks and runs, and leaves pending tasks alone", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "goal.failed", reason: "boom" },
    ]);
    expect(goal.tasks.map((t) => t.status)).toEqual(["cancelled", "pending"]);
    expect(goal.runs.map((r) => r.status)).toEqual(["interrupted"]);
  });

  test("tracks runs apart from tasks", () => {
    const goal = run([
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a1", taskId: "a", provider: "codex" },
      { type: "run.attached", runId: "a-a1", agentId: "ag", workspaceId: "ws" },
      { type: "run.finished", runId: "a-a1", outcome: "failed", error: "x" },
      { type: "task.failed", taskId: "a", error: "x" },
      { type: "task.retried", taskId: "a" },
      { type: "task.started", taskId: "a" },
      { type: "run.started", runId: "a-a2", taskId: "a", provider: "codex" },
    ]);
    expect(goal.runs.map((r) => [r.id, r.status, r.agentId, r.error])).toEqual([
      ["a-a1", "failed", "ag", "x"],
      ["a-a2", "running", null, null],
    ]);
    expect(goal.tasks[0]).toMatchObject({ status: "running", attempts: 2 });
  });

  test("a task cannot have two live runs, and a run needs a running task", () => {
    const started = [...planned, { type: "task.started", taskId: "a" }];
    const withRun = [...started, { type: "run.started", runId: "r1", taskId: "a", provider: "p" }];
    expect(() =>
      run([...withRun, { type: "run.started", runId: "r2", taskId: "a", provider: "p" }]),
    ).toThrow(/live run/);
    expect(() =>
      run([...planned, { type: "run.started", runId: "r1", taskId: "a", provider: "p" }]),
    ).toThrow(/not running/);
  });

  test("rejects plan task ids reserved for rework tasks", () => {
    expect(() => run([created, { type: "plan.proposed", tasks: [task("a-rw1")] }])).toThrow(
      /reserved for rework/,
    );
    expect(() => validateTaskGraph([task("x-rw12")])).toThrow(TaskGraphError);
  });

  test("rejects cyclic and empty plans", () => {
    expect(() =>
      run([created, { type: "plan.proposed", tasks: [task("a", ["b"]), task("b", ["a"])] }]),
    ).toThrow(GoalTransitionError);
    expect(() => run([created, { type: "plan.proposed", tasks: [] }])).toThrow(/no tasks/);
  });

  test("rejecting a plan returns to planning with no tasks", () => {
    const goal = run([
      created,
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.rejected", reason: "too big" },
    ]);
    expect(goal).toMatchObject({ status: "planning", tasks: [] });
  });

  test("rejects an event whose seq is not contiguous", () => {
    const goal = run([created]);
    const bad = { ...ev(goal, { type: "plan.approved" }), seq: 5 } as GoalEvent;
    expect(() => applyGoalEvent(goal, bad)).toThrow(/expected seq 2/);
  });

  test("replay of the same events yields the same state", () => {
    const events: GoalEvent[] = [];
    let goal: Goal | null = null;
    for (const partial of [
      ...planned,
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
    ]) {
      const e = ev(goal, partial);
      goal = applyGoalEvent(goal, e);
      events.push(e);
    }
    expect(replayGoal(events)).toEqual(goal);
  });
});

describe("change set rules", () => {
  const base = [
    created,
    { type: "plan.proposed", tasks: [task("a")] },
    { type: "plan.approved" },
    { type: "task.started", taskId: "a" },
    { type: "task.succeeded", taskId: "a" },
  ];
  const captured = {
    type: "changeset.captured",
    changeSetId: "cs1",
    taskId: "a",
    runId: "a-a1",
    round: 0,
    supersedes: null,
    workspaceId: "ws",
    cwd: "/w",
    branch: "b",
    baseCommit: "base",
    headCommit: "head",
    files: [],
  };
  const moveTo = (...to: string[]) =>
    to.map((status) => ({ type: "changeset.transitioned", changeSetId: "cs1", to: status }));
  const integrationPrepared = {
    type: "integration.prepared",
    branch: "int",
    workspaceId: "wi",
    cwd: "/i",
    baseCommit: "base",
  };

  test("a change set can reach integrating only through a review verdict or a person", () => {
    const withSet = [...base, integrationPrepared, captured];
    expect(() => run([...withSet, ...moveTo("integrating")])).toThrow(/cannot go from captured/);
    expect(() => run([...withSet, ...moveTo("in_review", "integrating")])).toThrow(
      /cannot go from in_review to integrating/,
    );
    expect(() =>
      run([...withSet, ...moveTo("in_review", "awaiting_human", "integrating")]),
    ).toThrow(/cannot go from awaiting_human/);
    expect(
      run([...withSet, ...moveTo("in_review", "approved", "integrating")]).changeSets[0]?.status,
    ).toBe("integrating");
  });

  test("only a succeeded implement task can have a change set", () => {
    expect(() =>
      run([
        created,
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "plan.approved" },
        captured,
      ]),
    ).toThrow(/not a succeeded implement task/);
  });

  test("integrated needs a commit and moves the integration head", () => {
    const withSet = [
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "approved", "integrating"),
    ];
    expect(() => run([...withSet, ...moveTo("integrated")])).toThrow(/integratedCommit/);
    const goal = run([
      ...withSet,
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "integrated",
        integratedCommit: "m1",
      },
    ]);
    expect(goal.integration?.headCommit).toBe("m1");
    expect(goal.changeSets[0]).toMatchObject({ status: "integrated", integratedCommit: "m1" });
  });

  test("the goal cannot complete while a change set is not integrated", () => {
    const withSet = [
      ...base,
      integrationPrepared,
      captured,
      { type: "criterion.verified", criterionId: "c1", evidence: "ok" },
    ];
    expect(() => run([...withSet, { type: "goal.completed" }])).toThrow(
      /change sets not integrated: cs1/,
    );

    const done = run([
      ...withSet,
      ...moveTo("in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "integrated",
        integratedCommit: "m1",
      },
      { type: "goal.completed" },
    ]);
    expect(done.status).toBe("completed");
    expect(done.criteria[0]?.evidence).toBe("ok");
  });

  test("a superseded or rejected change set keeps the reason it was fixed", () => {
    const goal = run([
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "conflicted",
        error: "Conflicts in: a.ts",
      },
      ...moveTo("superseded"),
    ]);
    expect(goal.changeSets[0]).toMatchObject({ status: "superseded", error: "Conflicts in: a.ts" });
  });

  test("a rework task needs an existing change set and a fresh id", () => {
    const withSet = [...base, integrationPrepared, captured];
    const rework = {
      type: "task.added",
      task: task("a-rw1"),
      rework: { changeSetId: "cs1", reason: "review", round: 1 },
    };
    expect(() =>
      run([...withSet, { ...rework, rework: { ...rework.rework, changeSetId: "nope" } }]),
    ).toThrow(/unknown change set/);
    expect(() => run([...withSet, rework, rework])).toThrow(/already exists/);
    expect(run([...withSet, rework]).tasks.map((t) => t.id)).toEqual(["a", "a-rw1"]);
  });

  test("a rework's change set supersedes the old one in the same step", () => {
    const withRework = [
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "changes_requested"),
      {
        type: "task.added",
        task: task("a-rw1"),
        rework: { changeSetId: "cs1", reason: "review", round: 1 },
      },
      { type: "task.started", taskId: "a-rw1" },
      { type: "task.succeeded", taskId: "a-rw1" },
    ];
    const goal = run([
      ...withRework,
      {
        ...captured,
        changeSetId: "cs2",
        taskId: "a-rw1",
        runId: "a-rw1-a1",
        round: 1,
        supersedes: "cs1",
      },
    ]);
    expect(goal.changeSets.map((c) => [c.id, c.status])).toEqual([
      ["cs1", "superseded"],
      ["cs2", "captured"],
    ]);
    expect(goal.tasks.find((t) => t.id === "a-rw1")?.captured).toBe(true);
  });

  test("a change set that is already integrated cannot be superseded", () => {
    const integrated = [
      ...base,
      integrationPrepared,
      captured,
      ...moveTo("in_review", "approved", "integrating"),
      {
        type: "changeset.transitioned",
        changeSetId: "cs1",
        to: "integrated",
        integratedCommit: "m",
      },
      {
        type: "task.added",
        task: task("a-rw1"),
        rework: { changeSetId: "cs1", reason: "review", round: 1 },
      },
      { type: "task.started", taskId: "a-rw1" },
      { type: "task.succeeded", taskId: "a-rw1" },
    ];
    expect(() =>
      run([...integrated, { ...captured, changeSetId: "cs2", taskId: "a-rw1", supersedes: "cs1" }]),
    ).toThrow(/cannot be superseded/);
  });

  test("a managed goal cannot complete while an implement task's work is uncaptured", () => {
    const managedCreated = {
      ...created,
      config: {
        cwd: "/repo",
        leadProvider: "p",
        defaultProvider: "p",
        maxParallel: 1,
        maxAttempts: 1,
        autoApprovePlan: true,
        notifyLead: false,
      },
    };
    const events = [
      managedCreated,
      { type: "plan.proposed", tasks: [task("a")] },
      { type: "plan.approved" },
      { type: "task.started", taskId: "a" },
      { type: "task.succeeded", taskId: "a" },
      { type: "criterion.verified", criterionId: "c1" },
    ];
    expect(() => run([...events, { type: "goal.completed" }])).toThrow(/work not captured for: a/);
    expect(
      run([
        ...events,
        { type: "capture.skipped", taskId: "a", runId: "a-a1" },
        { type: "goal.completed" },
      ]).status,
    ).toBe("completed");
  });

  test("a change set held for a person can be sent back or rejected, not merged", () => {
    const held = [...base, integrationPrepared, captured, ...moveTo("in_review", "awaiting_human")];
    expect(run([...held, ...moveTo("changes_requested")]).changeSets[0]?.status).toBe(
      "changes_requested",
    );
    expect(run([...held, ...moveTo("rejected")]).changeSets[0]?.status).toBe("rejected");
    expect(() => run([...held, ...moveTo("integrating")])).toThrow(/cannot go from awaiting_human/);
  });

  test("every change set transition outside the table is refused", () => {
    const allowed: Record<string, string[]> = {
      captured: ["in_review"],
      in_review: ["approved", "awaiting_human", "changes_requested", "rejected"],
      awaiting_human: ["approved", "changes_requested", "rejected"],
      approved: ["integrating"],
      integrating: ["integrated", "conflicted", "test_failed", "approved", "rejected"],
      integrated: [],
      changes_requested: ["superseded", "rejected"],
      conflicted: ["superseded", "rejected"],
      test_failed: ["superseded", "rejected"],
      superseded: [],
      rejected: [],
    };
    // Each status is reached by a legal route first, then every other target is tried.
    const route: Record<string, string[]> = {
      captured: [],
      in_review: ["in_review"],
      awaiting_human: ["in_review", "awaiting_human"],
      approved: ["in_review", "approved"],
      integrating: ["in_review", "approved", "integrating"],
      integrated: ["in_review", "approved", "integrating", "integrated"],
      changes_requested: ["in_review", "changes_requested"],
      conflicted: ["in_review", "approved", "integrating", "conflicted"],
      test_failed: ["in_review", "approved", "integrating", "test_failed"],
      superseded: ["in_review", "changes_requested", "superseded"],
      rejected: ["in_review", "rejected"],
    };
    const to = (status: string) =>
      status === "integrated"
        ? { type: "changeset.transitioned", changeSetId: "cs1", to: status, integratedCommit: "m" }
        : { type: "changeset.transitioned", changeSetId: "cs1", to: status };
    const all = Object.keys(allowed);
    for (const from of all) {
      for (const target of all) {
        const attempt = () =>
          run([...base, integrationPrepared, captured, ...route[from].map(to), to(target)]);
        if (allowed[from].includes(target)) expect(attempt, `${from} -> ${target}`).not.toThrow();
        else expect(attempt, `${from} -> ${target}`).toThrow(/cannot go from/);
      }
    }
  });
});

describe("notifications", () => {
  const queued = { type: "notification.queued", target: "origin", key: "goal-ended", text: "hi" };
  const attempted = (attempt: number, outcome: "delivered" | "failed", error?: string) => ({
    type: "notification.attempted",
    target: "origin",
    key: "goal-ended",
    attempt,
    outcome,
    ...(error ? { error } : {}),
  });

  test("a new goal has none", () => {
    expect(run([created]).notifications).toEqual([]);
  });

  test("are recorded after the goal has ended, and nothing else is", () => {
    for (const ending of [{ type: "goal.cancelled" }, { type: "goal.failed", reason: "x" }]) {
      const goal = run([created, ending, queued, attempted(1, "delivered")]);
      expect(goal.notifications).toEqual([
        {
          key: "goal-ended",
          target: "origin",
          text: "hi",
          status: "delivered",
          attempts: 1,
          lastError: null,
          updatedAt: AT,
        },
      ]);
      for (const other of [
        { type: "plan.proposed", tasks: [task("a")] },
        { type: "lead.notified", key: "k" },
        { type: "criterion.verified", criterionId: "c1" },
        { type: "goal.cancelled" },
      ]) {
        expect(() => run([created, ending, other]), other.type).toThrow(/goal is/);
      }
    }
  });

  test("a failure stays pending until the last attempt, which leaves it failed", () => {
    const afterTwo = run([created, queued, attempted(1, "failed", "down"), attempted(2, "failed")]);
    expect(afterTwo.notifications?.[0]).toMatchObject({
      status: "pending",
      attempts: 2,
      lastError: "unknown error",
    });
    const afterThree = run([
      created,
      queued,
      attempted(1, "failed", "a"),
      attempted(2, "failed", "b"),
      attempted(3, "failed", "c"),
    ]);
    expect(afterThree.notifications?.[0]).toMatchObject({
      status: "failed",
      attempts: 3,
      lastError: "c",
    });
  });

  test("rejects a duplicate queue, an unknown notice, a skipped or extra attempt", () => {
    expect(() => run([created, queued, queued])).toThrow(/already queued/);
    expect(() => run([created, attempted(1, "delivered")])).toThrow(/unknown notification/);
    expect(() => run([created, queued, attempted(2, "failed")])).toThrow(/expected attempt 1/);
    expect(() =>
      run([created, queued, attempted(1, "delivered"), attempted(2, "delivered")]),
    ).toThrow(/is delivered/);
    expect(() =>
      run([
        created,
        queued,
        attempted(1, "failed"),
        attempted(2, "failed"),
        attempted(3, "failed"),
        attempted(4, "failed"),
      ]),
    ).toThrow(/is failed/);
  });

  test("the same key may be queued once per target", () => {
    const goal = run([created, queued, { ...queued, target: "lead" }]);
    expect(goal.notifications?.map((n) => n.target)).toEqual(["origin", "lead"]);
  });
});
