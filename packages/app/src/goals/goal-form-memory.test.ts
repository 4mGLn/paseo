import { describe, expect, it } from "vitest";
import { openGoalForm } from "./goal-form-model";
import { goalFormMemoryFromConfig, prefillFromGoalFormMemory } from "./goal-form-memory";
import { GOAL_PRESETS } from "./goal-settings";
import { GOAL_TEMPLATES, buildTemplatePrefill } from "./goal-templates";

const memory = goalFormMemoryFromConfig(
  {
    cwd: "/repo",
    leadProvider: "claude/opus",
    defaultProvider: "codex",
    reviewProvider: "opencode",
    testCommand: "npm test",
    maxParallel: 1,
    maxAttempts: 2,
    autoApprovePlan: false,
    notifyLead: true,
  },
  GOAL_PRESETS.careful,
);

describe("prefillFromGoalFormMemory", () => {
  it("starts a managed goal in the current directory without memory", () => {
    expect(prefillFromGoalFormMemory(null, { cwd: "/here" })).toEqual({
      managed: true,
      cwd: "/here",
    });
    expect(prefillFromGoalFormMemory(null, {})).toEqual({ managed: true });
  });

  it("brings back the roles and, for the same directory, the test command", () => {
    expect(prefillFromGoalFormMemory(memory, {})).toEqual({
      managed: true,
      cwd: "/repo",
      leadProvider: "claude/opus",
      defaultProvider: "codex",
      reviewProvider: "opencode",
      testCommand: "npm test",
    });
    expect(prefillFromGoalFormMemory(memory, { cwd: "/other" }).testCommand).toBeUndefined();
  });
});

describe("buildTemplatePrefill", () => {
  it("fills the objective, criteria and the template's preset over the base", () => {
    const template = GOAL_TEMPLATES.find((entry) => entry.id === "refactor_review");
    if (!template) {
      throw new Error("missing template");
    }
    const prefill = buildTemplatePrefill(
      template,
      { objective: "Refactor X", criteria: "Behavior unchanged\nTests pass" },
      prefillFromGoalFormMemory(memory, {}),
    );
    const state = openGoalForm({ prefill }).getState();
    expect(state.values).toMatchObject({
      objective: "Refactor X",
      cwd: "/repo",
      leadProvider: "claude",
      leadModel: "opus",
    });
    expect(state.settingsChoice).toBe("careful");
    expect(state.createInput?.criteria).toEqual(["Behavior unchanged", "Tests pass"]);
  });
});
