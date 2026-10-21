import { describe, expect, it } from "vitest";
import { buildGoalCreateInput, parseGoalCriteria } from "./goal-form-model";

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
    expect(buildGoalCreateInput({ title: "   ", objective: "Ship", criteriaText: "" })).toBeNull();
  });

  it("trims the title and objective and parses criteria", () => {
    expect(
      buildGoalCreateInput({
        title: " Release 1.0 ",
        objective: " Ship it \n",
        criteriaText: "CI green\nChangelog written",
      }),
    ).toEqual({
      title: "Release 1.0",
      objective: "Ship it",
      criteria: ["CI green", "Changelog written"],
    });
  });
});
