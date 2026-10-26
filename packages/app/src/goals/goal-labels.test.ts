import { createInstance, type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import { rowUsageLabel } from "./goal-labels";
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
