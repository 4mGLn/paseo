import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import {
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
    expect(rowUsageLabel(t, makeGoal({ usage: USAGE }))).toBe("Tokens 1k · Cost $0.50");
    expect(rowUsageLabel(t, makeGoal({ usage: { ...USAGE, costUsd: 0 } }))).toBe("Tokens 1k");
    const capped = makeGoal({
      usage: USAGE,
      config: { ...makeGoal().config!, limits: { maxTotalTokens: 4000 } },
    });
    expect(rowUsageLabel(t, capped)).toBe("Tokens 1k of 4k · Cost $0.50");
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
