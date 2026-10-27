import path from "node:path";
import { describe, expect, test } from "vitest";
import { buildConfigChanges } from "./config.js";
import { parseGoalListFilter } from "./ls.js";
import { confirmGoalDelete, describeRetained } from "./manage.js";

describe("goal ls filters", () => {
  test("no flags sends no filter", () => {
    expect(parseGoalListFilter({} as never)).toEqual({});
  });

  test("flags map to goal.list filters; the project path is made absolute", () => {
    expect(
      parseGoalListFilter({
        search: "login",
        status: ["failed", "cancelled"],
        priority: ["high"],
        archived: "only",
        project: "repo",
      } as never),
    ).toEqual({
      query: "login",
      status: ["failed", "cancelled"],
      priority: ["high"],
      archived: "only",
      cwd: path.resolve("repo"),
    });
  });

  test("an unknown value is refused before anything is sent", () => {
    expect(() => parseGoalListFilter({ status: ["done"] } as never)).toThrow(
      /--status must be one of planning/,
    );
    expect(() => parseGoalListFilter({ priority: ["urgent"] } as never)).toThrow(
      /--priority must be one of low, normal, high/,
    );
    expect(() => parseGoalListFilter({ archived: "all" } as never)).toThrow(
      /--archived must be one of exclude, only, include/,
    );
  });
});

describe("goal delete confirmation", () => {
  const asked: string[] = [];
  const terminal = (answer: boolean) => ({
    interactive: true,
    structured: false,
    confirm: async (message: string) => {
      asked.push(message);
      return answer;
    },
  });

  test("--yes skips the question", async () => {
    asked.length = 0;
    expect(await confirmGoalDelete("g1", { yes: true }, terminal(false))).toBe(true);
    expect(asked).toEqual([]);
  });

  test("a terminal is asked, and the answer decides", async () => {
    asked.length = 0;
    expect(await confirmGoalDelete("g1", {}, terminal(false))).toBe(false);
    expect(await confirmGoalDelete("g1", {}, terminal(true))).toBe(true);
    expect(asked[0]).toContain("Delete goal g1");
  });

  test("without a terminal, or with JSON output, --yes is required", async () => {
    await expect(
      confirmGoalDelete("g1", {}, { ...terminal(true), interactive: false }),
    ).rejects.toThrow(/rerun with --yes/);
    await expect(
      confirmGoalDelete("g1", {}, { ...terminal(true), structured: true }),
    ).rejects.toThrow(/rerun with --yes/);
  });

  test("what delete left in place is listed", () => {
    expect(describeRetained([])).toBe("-");
    expect(
      describeRetained([
        { kind: "branch", name: "paseo-goal/g1", reason: "Branches are never deleted" },
        { kind: "worktree", name: "/wt/a", reason: "It has uncommitted changes" },
      ]),
    ).toBe(
      "branch paseo-goal/g1 (Branches are never deleted); worktree /wt/a (It has uncommitted changes)",
    );
  });
});

describe("goal config flags", () => {
  test("only the flags given become changes; none clears an optional setting", () => {
    expect(
      buildConfigChanges({
        onPermission: "auto",
        notifyLead: false,
        maxParallel: "3",
        maxRework: "none",
        testCommand: "none",
        maxRuns: "120",
        maxCost: "2.5",
        maxTokens: "none",
        deadline: "2026-12-01T00:00:00Z",
      } as never),
    ).toEqual({
      onPermissionRequest: "auto",
      notifyLead: false,
      maxParallel: 3,
      maxReworkRounds: null,
      testCommand: null,
      limits: {
        maxRuns: 120,
        maxCostUsd: 2.5,
        maxTotalTokens: null,
        deadlineAt: "2026-12-01T00:00:00Z",
      },
    });
  });

  test("a bad value or no change is refused before anything is sent", () => {
    expect(() => buildConfigChanges({ onPermission: "ask" } as never)).toThrow(
      /--on-permission must be one of fail, wait, auto/,
    );
    expect(() => buildConfigChanges({ maxRuns: "many" } as never)).toThrow(
      /--max-runs must be a number or none/,
    );
    expect(() => buildConfigChanges({ maxParallel: "none" } as never)).toThrow(
      /--max-parallel cannot be cleared/,
    );
    expect(() => buildConfigChanges({} as never)).toThrow(/at least one setting/);
  });
});
