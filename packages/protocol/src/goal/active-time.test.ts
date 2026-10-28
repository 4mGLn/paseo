import { describe, expect, test } from "vitest";
import { goalActiveMs } from "./active-time.js";
import type { GoalEvent } from "./types.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

function events(list: [number, Record<string, unknown>][]): GoalEvent[] {
  return list.map(([minute, partial], i) => ({
    id: `e${i + 1}`,
    goalId: "g1",
    seq: i + 1,
    at: new Date(T0 + minute * MIN).toISOString(),
    ...partial,
  })) as GoalEvent[];
}

// Ran 10 minutes, failed; a recovery started at 20 and decided at 25.
const failedThenRecovering: [number, Record<string, unknown>][] = [
  [0, { type: "goal.created", title: "T", objective: "", criteria: [] }],
  [10, { type: "goal.failed", reason: "x" }],
  [20, { type: "recovery.started", recoveryId: "r1", startedBy: "person" }],
  [
    25,
    { type: "recovery.decided", recoveryId: "r1", decision: { decision: "retry", reason: "r" } },
  ],
];

describe("goalActiveMs and recoveries", () => {
  test("a failed goal stays stopped while its recovery decides", () => {
    expect(goalActiveMs(events(failedThenRecovering), T0 + 60 * MIN)).toBe(10 * MIN);
  });

  test("an applied recovery with remaining starts the clock again from where it stopped", () => {
    const log = events([
      ...failedThenRecovering,
      [
        30,
        { type: "recovery.resolved", recoveryId: "r1", outcome: "applied", timeMode: "remaining" },
      ],
    ]);
    expect(goalActiveMs(log, T0 + 45 * MIN)).toBe(25 * MIN);
  });

  test("an applied recovery with fresh resets the clock", () => {
    const log = events([
      ...failedThenRecovering,
      [30, { type: "recovery.resolved", recoveryId: "r1", outcome: "applied", timeMode: "fresh" }],
    ]);
    expect(goalActiveMs(log, T0 + 45 * MIN)).toBe(15 * MIN);
  });

  test("a recovery that ends without applying leaves the goal stopped", () => {
    const log = events([
      ...failedThenRecovering,
      [30, { type: "recovery.resolved", recoveryId: "r1", outcome: "cancelled" }],
    ]);
    expect(goalActiveMs(log, T0 + 45 * MIN)).toBe(10 * MIN);
  });
});
