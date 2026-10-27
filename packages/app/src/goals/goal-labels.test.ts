import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import {
  goalBadge,
  priorityBadgeLabel,
  retainedSummary,
  rowUsageLabel,
  settingsSummaryText,
} from "./goal-labels";
import { makeGoal } from "./test-utils/goal-fixture";

let t: TFunction;

beforeAll(async () => {
  t = await createInstance().init({
    lng: "en",
    compatibilityJSON: "v4",
    interpolation: { escapeValue: false },
    resources: { en: { translation: en } },
  });
});

const USAGE = {
  inputTokens: 800,
  outputTokens: 200,
  cachedInputTokens: 0,
  totalTokens: 1000,
  costUsd: 0.5,
  reportedTurns: 2,
  totalTurns: 3,
};

describe("rowUsageLabel", () => {
  it("is null for a manual goal and says when nothing was reported", () => {
    expect(rowUsageLabel(t, makeGoal({ config: null }))).toBeNull();
    expect(rowUsageLabel(t, makeGoal())).toBe("Usage not reported");
  });

  it("shows usage, against the cap when one is set", () => {
    const complete = { ...USAGE, reportedTurns: 3 };
    expect(rowUsageLabel(t, makeGoal({ usage: complete }))).toBe("Tokens 1k · Cost $0.50");
    // An older host sums no cost without saying whether any turn reported one.
    expect(rowUsageLabel(t, makeGoal({ usage: { ...complete, costUsd: 0 } }))).toBe("Tokens 1k");
    const capped = makeGoal({
      usage: complete,
      config: { ...makeGoal().config!, limits: { maxTotalTokens: 4000 } },
    });
    expect(rowUsageLabel(t, capped)).toBe("Tokens 1k of 4k · Cost $0.50");
  });

  it("marks totals that only some turns reported as a lower bound, as the CLI does", () => {
    expect(rowUsageLabel(t, makeGoal({ usage: USAGE }))).toBe("Tokens ≥1k · Cost $0.50");
    const counted = { ...USAGE, reportedTurns: 3, tokenReportedTurns: 3 };
    expect(rowUsageLabel(t, makeGoal({ usage: { ...counted, costReportedTurns: 1 } }))).toBe(
      "Tokens 1k · Cost ≥$0.50",
    );
    expect(
      rowUsageLabel(t, makeGoal({ usage: { ...counted, costUsd: 0, costReportedTurns: 0 } })),
    ).toBe("Tokens 1k · Cost not reported");
  });
});

describe("retainedSummary", () => {
  it("lists what delete kept, a few lines at most", () => {
    const retained = [
      { kind: "branch" as const, name: "paseo-goal/g1", reason: "holds the result" },
      { kind: "worktree" as const, name: "/tmp/wt", reason: "has uncommitted changes" },
      ...["a", "b", "c", "d"].map((name) => ({ kind: "branch" as const, name, reason: "history" })),
    ];
    expect(retainedSummary(t, retained).split("\n")).toEqual([
      "Goal deleted. Kept:",
      "Branch paseo-goal/g1: holds the result",
      "Worktree /tmp/wt: has uncommitted changes",
      "Branch a: history",
      "Branch b: history",
      "and 2 more",
    ]);
  });
});

describe("priorityBadgeLabel", () => {
  it("marks high and low, never normal", () => {
    expect(priorityBadgeLabel(t, "high")).toBe("High priority");
    expect(priorityBadgeLabel(t, "low")).toBe("Low priority");
    expect(priorityBadgeLabel(t, "normal")).toBeNull();
  });
});

describe("settingsSummaryText", () => {
  it("names a role's thinking level inside the sentence", () => {
    expect(
      settingsSummaryText(t, [
        { key: "parallel", n: 2 },
        { key: "thinking", role: "lead", label: "High" },
      ]),
    ).toBe("Up to 2 agents at once, high thinking for the Lead");
  });
});

describe("goalBadge", () => {
  const badge = (overrides: Parameters<typeof makeGoal>[0]) => goalBadge(t, makeGoal(overrides));

  it("labels each status and gives it a tone", () => {
    expect(badge({ status: "executing" })).toEqual({ label: "Running", variant: "running" });
    expect(badge({ status: "planning" })).toEqual({ label: "Planning", variant: "running" });
    expect(badge({ status: "completed" })).toEqual({ label: "Completed", variant: "success" });
    expect(badge({ status: "failed" })).toEqual({ label: "Failed", variant: "error" });
    expect(badge({ status: "cancelled" })).toEqual({ label: "Canceled", variant: "muted" });
  });

  it("shows a paused live goal as Paused", () => {
    expect(badge({ status: "executing", pausedAt: "2026-10-27T01:00:00.000Z" })).toEqual({
      label: "Paused",
      variant: "warning",
    });
  });

  it("keeps an ended goal's status even if it was paused before it ended", () => {
    expect(badge({ status: "failed", pausedAt: "2026-10-27T01:00:00.000Z" }).label).toBe("Failed");
  });
});
