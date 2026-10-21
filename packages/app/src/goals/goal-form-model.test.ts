import { describe, expect, it } from "vitest";
import {
  EMPTY_GOAL_FORM_VALUES,
  buildGoalCreateInput,
  openGoalForm,
  parseGoalCriteria,
  validateGoalForm,
  type GoalFormValues,
} from "./goal-form-model";

function values(overrides: Partial<GoalFormValues>): GoalFormValues {
  return { ...EMPTY_GOAL_FORM_VALUES, ...overrides };
}

const MANAGED: Partial<GoalFormValues> = {
  title: "Rate limiting",
  objective: "Limit the API",
  criteriaText: "Over the limit gets 429",
  managed: true,
  cwd: " /repo ",
  leadProvider: "claude",
  defaultProvider: "codex",
};

describe("parseGoalCriteria", () => {
  it("keeps one trimmed criterion per non-blank line", () => {
    expect(parseGoalCriteria("  Tests pass \r\n\n Docs updated\n   \n")).toEqual([
      "Tests pass",
      "Docs updated",
    ]);
  });
});

describe("buildGoalCreateInput", () => {
  it("cannot submit without a title", () => {
    expect(buildGoalCreateInput(values({ title: "   ", objective: "Ship" }))).toBeNull();
  });

  it("builds a manual goal without a config", () => {
    expect(
      buildGoalCreateInput(
        values({
          title: " Release 1.0 ",
          objective: " Ship it \n",
          criteriaText: "CI green\nChangelog written",
        }),
      ),
    ).toEqual({
      title: "Release 1.0",
      objective: "Ship it",
      criteria: ["CI green", "Changelog written"],
    });
  });

  it("allows a manual goal without criteria", () => {
    expect(buildGoalCreateInput(values({ title: "Notes" }))).toEqual({
      title: "Notes",
      objective: "",
      criteria: [],
    });
  });

  it("builds the required config and omits every unset optional", () => {
    expect(buildGoalCreateInput(values(MANAGED))).toEqual({
      title: "Rate limiting",
      objective: "Limit the API",
      criteria: ["Over the limit gets 429"],
      config: {
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "codex",
        maxParallel: 2,
        maxAttempts: 2,
        autoApprovePlan: false,
        notifyLead: true,
      },
    });
  });

  it("includes the optionals the user set and the origin chat", () => {
    const input = buildGoalCreateInput(
      values({
        ...MANAGED,
        reviewProvider: "opencode",
        testCommand: " npm test ",
        autoApprovePlan: true,
        requireHumanApproval: true,
        maxParallel: "4",
        maxTasks: "10",
        maxRuns: "",
        runTimeoutMinutes: "30",
        goalTimeoutMinutes: " 600 ",
        onPermissionRequest: "wait",
      }),
      "agent-1",
    );

    expect(input?.config).toEqual({
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 4,
      maxAttempts: 2,
      autoApprovePlan: true,
      notifyLead: true,
      reviewProvider: "opencode",
      testCommand: "npm test",
      requireHumanApproval: true,
      limits: { maxTasks: 10, runTimeoutMinutes: 30, goalTimeoutMinutes: 600 },
      onPermissionRequest: "wait",
      originAgentId: "agent-1",
    });
  });

  it("does not send managed fields for a manual goal", () => {
    expect(
      buildGoalCreateInput(values({ ...MANAGED, managed: false }), "agent-1")?.config,
    ).toBeUndefined();
  });
});

describe("validateGoalForm", () => {
  it("requires a criterion, the working directory and both providers when managed", () => {
    expect(
      validateGoalForm(
        values({
          title: "Goal",
          managed: true,
          criteriaText: " \n ",
          cwd: " ",
          leadProvider: "",
          defaultProvider: "",
        }),
      ),
    ).toEqual([
      { field: "criteria", code: "required" },
      { field: "cwd", code: "required" },
      { field: "leadProvider", code: "required" },
      { field: "defaultProvider", code: "required" },
    ]);
  });

  it("checks every number against the schema range", () => {
    expect(
      validateGoalForm(
        values({
          ...MANAGED,
          maxParallel: "9",
          maxTasks: "0",
          maxRuns: "501",
          runTimeoutMinutes: "1.5",
          goalTimeoutMinutes: "10081",
        }),
      ),
    ).toEqual([
      { field: "maxParallel", code: "range", min: 1, max: 8 },
      { field: "maxTasks", code: "range", min: 1, max: 100 },
      { field: "maxRuns", code: "range", min: 1, max: 500 },
      { field: "runTimeoutMinutes", code: "range", min: 1, max: 1440 },
      { field: "goalTimeoutMinutes", code: "range", min: 1, max: 10080 },
    ]);
  });

  it("accepts the range bounds and requires max parallel", () => {
    expect(
      validateGoalForm(
        values({
          ...MANAGED,
          maxParallel: "8",
          maxTasks: "100",
          maxRuns: "1",
          runTimeoutMinutes: "1440",
          goalTimeoutMinutes: "10080",
        }),
      ),
    ).toEqual([]);
    expect(validateGoalForm(values({ ...MANAGED, maxParallel: "" }))).toEqual([
      { field: "maxParallel", code: "required" },
    ]);
  });

  it("ignores managed fields while the goal is manual", () => {
    expect(validateGoalForm(values({ title: "Goal", maxParallel: "99" }))).toEqual([]);
  });
});

describe("openGoalForm", () => {
  it("seeds values from the prefill and derives the create input", () => {
    const model = openGoalForm({
      prefill: {
        title: "Fix login",
        objective: "Fix the login bug",
        managed: true,
        cwd: "/repo",
        leadProvider: "claude",
        defaultProvider: "claude",
        originAgentId: "agent-7",
      },
    });

    expect(model.getState().createInput).toBeNull();
    model.setValue("criteriaText", "Login works");
    expect(model.getState().createInput?.config).toMatchObject({
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "claude",
      originAgentId: "agent-7",
    });
  });

  it("drops a prefilled provider the host has not registered once providers arrive", () => {
    const model = openGoalForm({
      prefill: { managed: true, leadProvider: "custom-acp", defaultProvider: "codex" },
    });

    model.applyProviderOptions([]);
    expect(model.getState().values.leadProvider).toBe("custom-acp");

    model.applyProviderOptions([
      { id: "codex", label: "Codex" },
      { id: "claude", label: "Claude" },
    ]);
    expect(model.getState().values).toMatchObject({ leadProvider: "", defaultProvider: "codex" });
    expect(model.getState().providerOptions.map((option) => option.id)).toEqual([
      "codex",
      "claude",
    ]);
  });

  it("clears the submit error on the next edit and stops publishing after close", () => {
    const model = openGoalForm({});
    let notified = 0;
    model.subscribe(() => {
      notified += 1;
    });

    model.setSubmitError("cwd is not a git repository");
    expect(model.getState().submitError).toBe("cwd is not a git repository");
    model.setValue("cwd", "/other");
    expect(model.getState().submitError).toBeNull();
    expect(notified).toBe(2);

    model.close();
    model.setValue("title", "ignored");
    expect(model.getState().values.title).toBe("");
    expect(notified).toBe(2);
  });
});
