import type { GoalDiagnosis } from "@getpaseo/protocol/goal/diagnosis";
import type { Recovery } from "@getpaseo/protocol/goal/types";
import { describe, expect, it } from "vitest";
import { en } from "@/i18n/resources/en";
import {
  MAX_RECOVERIES,
  buildRecoverRequest,
  diagnosisView,
  endedRecovery,
  goalDiagnosisView,
  goalRecoveryControls,
  guidanceTextCut,
  isTimeLimitRefusal,
  liveRecovery,
  recoverBlockingLimits,
  recoverNeedsTimeMode,
  taskGuidance,
  type RecoverRules,
} from "./goal-recovery";
import { FIXTURE_AT, makeChangeSet, makeGoal, makeTask } from "./test-utils/goal-fixture";

function recovery(status: string, overrides: Partial<Recovery> = {}): Recovery {
  return {
    id: "r1",
    status,
    startedAt: FIXTURE_AT,
    startedBy: "person",
    failureReason: "Task t7 failed",
    ...overrides,
  };
}

const failed = makeGoal({
  status: "failed",
  tasks: [makeTask("t7", { title: "Capture", status: "failed" }), makeTask("t8")],
});

describe("liveRecovery", () => {
  it("is the recovery of a failed goal that has not ended", () => {
    for (const status of ["deciding", "decided", "awaiting_approval"]) {
      expect(liveRecovery({ ...failed, recovery: recovery(status) })?.status).toBe(status);
    }
    expect(liveRecovery({ ...failed, recovery: recovery("ended") })).toBeNull();
    // Applied reopens the goal; it is no longer a recovery to show.
    expect(
      liveRecovery({ ...failed, status: "executing", recovery: recovery("applied") }),
    ).toBeNull();
  });
});

describe("goalRecoveryControls", () => {
  it("offers Recover only on a failed managed goal with a plan, on a host with goalRecovery", () => {
    expect(goalRecoveryControls(failed, true).canRecover).toBe(true);
    expect(goalRecoveryControls(failed, false).canRecover).toBe(false);
    expect(goalRecoveryControls({ ...failed, config: null }, true).canRecover).toBe(false);
    expect(goalRecoveryControls({ ...failed, tasks: [] }, true).canRecover).toBe(false);
    expect(
      goalRecoveryControls({ ...failed, archivedAt: "2026-10-22T00:00:00Z" }, true).canRecover,
    ).toBe(false);
    expect(goalRecoveryControls({ ...failed, status: "executing" }, true).canRecover).toBe(false);
  });

  it("hides Recover once the goal used its recoveries or a review rejected a change", () => {
    expect(goalRecoveryControls({ ...failed, recoveries: MAX_RECOVERIES }, true).canRecover).toBe(
      false,
    );
    const rejected = makeChangeSet("cs", "t7", { status: "rejected", rejectionReason: "review" });
    expect(goalRecoveryControls({ ...failed, changeSets: [rejected] }, true).canRecover).toBe(
      false,
    );
    const mergeFailed = { ...rejected, rejectionReason: "integration_failed" };
    expect(goalRecoveryControls({ ...failed, changeSets: [mergeFailed] }, true).canRecover).toBe(
      true,
    );
  });

  it("allows no second recovery while one is live", () => {
    const deciding = goalRecoveryControls({ ...failed, recovery: recovery("deciding") }, true);
    expect(deciding).toEqual({ canRecover: false, canCancel: true, canDecide: false });
  });

  it("hides Cancel while the decision is being applied", () => {
    expect(goalRecoveryControls({ ...failed, recovery: recovery("decided") }, true)).toEqual({
      canRecover: false,
      canCancel: false,
      canDecide: false,
    });
  });

  it("offers Approve, Reject and Cancel while a plan change waits", () => {
    expect(
      goalRecoveryControls({ ...failed, recovery: recovery("awaiting_approval") }, true),
    ).toEqual({ canRecover: false, canCancel: true, canDecide: true });
  });

  it("lets an ended recovery be followed by another", () => {
    const ended = goalRecoveryControls(
      { ...failed, recovery: recovery("ended", { outcome: "needs_person" }), recoveries: 1 },
      true,
    );
    expect(ended).toEqual({ canRecover: true, canCancel: false, canDecide: false });
  });
});

describe("diagnosisView", () => {
  const diagnosis: GoalDiagnosis = {
    kind: "time",
    findings: [
      { kind: "time", remedy: "", personNeeded: "no" },
      { kind: "stuck", remedy: "", personNeeded: "depends" },
    ],
    failedAt: FIXTURE_AT,
    timePassedAtFailure: true,
    timePassedNow: true,
    failureReason: "Time limit of 60 minutes reached",
    tasks: [
      {
        taskId: "t7",
        status: "failed",
        cause: "timeout",
        lastError: "Turn timed out after 60 minutes",
        failedRuns: 3,
        countedFailures: 2,
        interruptedRuns: 1,
        blockedDependents: ["t8", "t9"],
      },
    ],
    blocked: ["t8", "t9"],
    openChangeSets: [],
    merged: [{ changeSetId: "cs-1", taskId: "t1" }],
    runs: { used: 12, max: 60 },
    blockingLimits: [{ limit: "goalTimeoutMinutes", current: 60, used: 75, minimum: 76 }],
    recoverable: true,
  };

  it("names tasks by title and keeps what the card shows", () => {
    expect(diagnosisView(diagnosis, failed)).toEqual({
      kind: "time",
      personNeeded: "depends",
      findings: [
        { kind: "time", personNeeded: "no" },
        { kind: "stuck", personNeeded: "depends" },
      ],
      tasks: [
        {
          taskId: "t7",
          title: "Capture",
          cause: "timeout",
          failedRuns: 3,
          interruptedRuns: 1,
          blocks: ["Task t8", "t9"],
          lastError: "Turn timed out after 60 minutes",
        },
      ],
      limits: diagnosis.blockingLimits,
      runs: { used: 12, max: 60 },
      merged: 1,
      recoverable: true,
    });
  });

  it("needs you when any finding does, and only then", () => {
    const withYes = {
      ...diagnosis,
      findings: [
        ...diagnosis.findings,
        { kind: "budget" as const, remedy: "", personNeeded: "yes" as const },
      ],
    };
    expect(diagnosisView(withYes, failed).personNeeded).toBe("yes");
    const allNo = {
      ...diagnosis,
      findings: [{ kind: "verification" as const, remedy: "", personNeeded: "no" as const }],
    };
    expect(diagnosisView(allNo, failed).personNeeded).toBe("no");
    expect(diagnosisView({ ...diagnosis, findings: [] }, failed).personNeeded).toBe("depends");
  });

  it("has a sentence for every failure kind, cause and blocking limit", () => {
    const kinds = [
      "review_rejected",
      "planning",
      "time",
      "budget",
      "run_limit",
      "integration_failed",
      "verification",
      "stuck",
      "capture",
      "recovery_failed",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      expect(en.goals.diagnosis.kind[kind]).toBeTypeOf("string");
      expect(en.goals.diagnosis.remedy[kind]).toBeTypeOf("string");
    }
    const causes = [
      "timeout",
      "pending_request",
      "lead_stopped",
      "canceled",
      "worker_error",
      "interrupted",
      "cancelled",
    ] as const;
    for (const cause of causes) {
      expect(en.goals.diagnosis.cause[cause]).toBeTypeOf("string");
    }
    const limits = [
      "goalTimeoutMinutes",
      "deadlineAt",
      "maxRuns",
      "maxTotalTokens",
      "maxCostUsd",
    ] as const;
    for (const limit of limits) {
      expect(en.goals.diagnosis.limits[limit]).toBeTypeOf("string");
    }
  });
});

describe("buildRecoverRequest", () => {
  const rules: RecoverRules = {
    needsTimeMode: false,
    noneLeft: false,
    current: { goal: "Use the staging API", tasks: { t7: "Skip the flaky test" } },
  };

  it("sends nothing but the request when you changed nothing", () => {
    expect(
      buildRecoverRequest(
        {
          goalText: " Use the staging API ",
          taskTexts: { t7: "Skip the flaky test" },
          timeMode: null,
        },
        rules,
      ),
    ).toEqual({ ok: true, input: {} });
  });

  it("sends new texts, and null for a text you emptied", () => {
    expect(
      buildRecoverRequest(
        { goalText: "", taskTexts: { t7: "Split the screenshots", t8: "" }, timeMode: null },
        rules,
      ),
    ).toEqual({
      ok: true,
      input: { guidance: { goal: null, tasks: { t7: "Split the screenshots" } } },
    });
  });

  it("requires a time mode once the limit passes before the recovery could apply", () => {
    const timed = { ...rules, needsTimeMode: true };
    expect(buildRecoverRequest({ goalText: "", taskTexts: {}, timeMode: null }, timed)).toEqual({
      ok: false,
      error: "timeModeRequired",
    });
    expect(
      buildRecoverRequest(
        { goalText: "Use the staging API", taskTexts: {}, timeMode: "fresh" },
        timed,
      ),
    ).toEqual({ ok: true, input: { timeMode: "fresh" } });
  });

  it("refuses remaining when it leaves no time, as the retry sheet does", () => {
    expect(
      buildRecoverRequest(
        { goalText: "Use the staging API", taskTexts: {}, timeMode: "remaining" },
        { ...rules, needsTimeMode: true, noneLeft: true },
      ),
    ).toEqual({ ok: false, error: "noneLeft" });
  });

  it("refuses a text longer than the host accepts", () => {
    expect(
      buildRecoverRequest({ goalText: "x".repeat(4001), taskTexts: {}, timeMode: null }, rules),
    ).toEqual({ ok: false, error: "tooLong", goal: true, tasks: [] });
    expect(
      buildRecoverRequest(
        { goalText: "", taskTexts: { t7: "x".repeat(4001), t8: "fine" }, timeMode: null },
        rules,
      ),
    ).toEqual({ ok: false, error: "tooLong", goal: false, tasks: ["t7"] });
  });
});

describe("taskGuidance", () => {
  it("returns your instruction and the Lead's advice for a task, or null", () => {
    const goal = makeGoal({
      guidance: {
        tasks: { t7: "Skip the flaky test" },
        lead: { recoveryId: "r1", tasks: { t7: "Run only the home screen", t8: "Reuse t7" } },
      },
    });
    expect(taskGuidance(goal, "t7")).toEqual({
      person: "Skip the flaky test",
      personCut: false,
      lead: "Run only the home screen",
    });
    expect(taskGuidance(goal, "t8")).toEqual({ person: null, personCut: false, lead: "Reuse t7" });
    expect(taskGuidance(goal, "t9")).toBeNull();
    expect(taskGuidance(makeGoal(), "t7")).toBeNull();
  });
});

describe("endedRecovery", () => {
  const ended = (overrides: Partial<Recovery> = {}) =>
    recovery("ended", {
      outcome: "needs_person",
      resolvedAt: "2026-10-21T02:00:00.000Z",
      ...overrides,
    });

  it("is the recovery whose end is the goal's current failure", () => {
    const goal = { ...failed, failedAt: "2026-10-21T02:00:00.000Z", recovery: ended() };
    expect(endedRecovery(goal)?.id).toBe("r1");
  });

  it("ignores a recovery that ended before a later failure", () => {
    // The goal was retried after the recovery ended and failed again later.
    const goal = { ...failed, failedAt: "2026-10-21T05:00:00.000Z", recovery: ended() };
    expect(endedRecovery(goal)).toBeNull();
  });

  it("ignores an applied recovery, whose goal then failed again", () => {
    const goal = {
      ...failed,
      failedAt: "2026-10-21T02:00:00.000Z",
      recovery: ended({ outcome: "applied" }),
    };
    expect(endedRecovery(goal)).toBeNull();
  });

  it("ignores a recovery without an end time, and a live goal", () => {
    expect(endedRecovery({ ...failed, recovery: ended({ resolvedAt: undefined }) })).toBeNull();
    expect(
      endedRecovery({
        ...failed,
        status: "executing",
        failedAt: "2026-10-21T02:00:00.000Z",
        recovery: ended(),
      }),
    ).toBeNull();
  });
});

describe("isTimeLimitRefusal", () => {
  it("knows both refusals the host words, and nothing else", () => {
    expect(
      isTimeLimitRefusal(
        new Error(
          "goal.retried: the goal's time limit has passed; choose time mode fresh (the full limit from now) or remaining (the limit minus the time the goal ran)",
        ),
      ),
    ).toBe(true);
    expect(
      isTimeLimitRefusal(
        new Error(
          "recovery.started: the Lead has 20 minutes to decide, and by then the goal's time limit has passed; choose time mode fresh or remaining",
        ),
      ),
    ).toBe(true);
    expect(isTimeLimitRefusal(new Error("the run limit is used up"))).toBe(false);
  });
});

describe("recoverNeedsTimeMode and recoverBlockingLimits", () => {
  const created = Date.parse(FIXTURE_AT);
  const hourGoal = {
    ...failed,
    config: { ...failed.config!, limits: { goalTimeoutMinutes: 60 } },
  };

  it("asks for a time mode when the limit passes while the Lead decides", () => {
    expect(recoverNeedsTimeMode(hourGoal, created + 30 * 60_000)).toBe(false);
    // 50 minutes in: the 20 minutes the Lead has run past the hour.
    expect(recoverNeedsTimeMode(hourGoal, created + 50 * 60_000)).toBe(true);
    expect(recoverNeedsTimeMode(hourGoal, created + 90 * 60_000)).toBe(true);
  });

  it("lists a deadline that passes while the Lead decides, and leaves the time limit to the choice", () => {
    const deadline = new Date(created + 60 * 60_000).toISOString();
    const goal = {
      ...hourGoal,
      config: { ...hourGoal.config, limits: { goalTimeoutMinutes: 60, deadlineAt: deadline } },
    };
    const limits = recoverBlockingLimits(goal, [], created + 50 * 60_000);
    expect(limits.map((limit) => limit.limit)).toEqual(["deadlineAt"]);
    expect(recoverBlockingLimits(goal, [], created + 10 * 60_000)).toEqual([]);
  });
});

describe("goalDiagnosisView", () => {
  it("reads a live recovery's time mode as settling the passed time limit", () => {
    const created = Date.parse(FIXTURE_AT);
    const goal = {
      ...failed,
      config: { ...failed.config!, limits: { goalTimeoutMinutes: 60 } },
      failedAt: new Date(created + 61 * 60_000).toISOString(),
    };
    const now = created + 120 * 60_000;
    const without = goalDiagnosisView(goal, [], now);
    expect(without.findings[0]).toEqual({ kind: "time", personNeeded: "yes" });
    expect(without.limits.map((limit) => limit.limit)).toEqual(["goalTimeoutMinutes"]);
    const recovering = goalDiagnosisView(
      { ...goal, recovery: recovery("deciding", { timeMode: "fresh" }) },
      [],
      now,
    );
    expect(recovering.findings[0]).toEqual({ kind: "time", personNeeded: "no" });
    expect(recovering.limits).toEqual([]);
  });
});

describe("guidanceTextCut", () => {
  it("marks only a text a list payload cut short", () => {
    const cut = `${"x".repeat(499)}…`;
    expect(guidanceTextCut(makeGoal({ guidance: { goal: cut, truncated: true } }), cut)).toBe(true);
    expect(
      guidanceTextCut(makeGoal({ guidance: { goal: "short", truncated: true } }), "short"),
    ).toBe(false);
    expect(guidanceTextCut(makeGoal({ guidance: { goal: cut } }), cut)).toBe(false);
  });
});
