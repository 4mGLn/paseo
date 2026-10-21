import type { GoalConfig } from "@getpaseo/protocol/goal/types";

export type GoalPermissionPolicy = "fail" | "wait";

export interface GoalFormValues {
  title: string;
  objective: string;
  criteriaText: string;
  /** Off: a manual goal that only records plans and state. On: the Manager runs it. */
  managed: boolean;
  cwd: string;
  leadProvider: string;
  defaultProvider: string;
  /** Empty means the reviewer uses the Lead's provider. */
  reviewProvider: string;
  testCommand: string;
  autoApprovePlan: boolean;
  requireHumanApproval: boolean;
  maxParallel: string;
  maxTasks: string;
  maxRuns: string;
  runTimeoutMinutes: string;
  goalTimeoutMinutes: string;
  onPermissionRequest: GoalPermissionPolicy;
}

export interface GoalCreateInput {
  title: string;
  objective: string;
  criteria: string[];
  config?: GoalConfig;
}

/** Values a caller seeds the form with, such as a chat the goal is started from. */
export interface GoalFormPrefill {
  title?: string;
  objective?: string;
  managed?: boolean;
  cwd?: string;
  leadProvider?: string;
  defaultProvider?: string;
  /** The chat the goal is started from; the daemon posts the outcome back there. */
  originAgentId?: string;
}

export type GoalFormField =
  | "title"
  | "criteria"
  | "cwd"
  | "leadProvider"
  | "defaultProvider"
  | "maxParallel"
  | "maxTasks"
  | "maxRuns"
  | "runTimeoutMinutes"
  | "goalTimeoutMinutes";

export type GoalFormIssue =
  | { field: GoalFormField; code: "required" }
  | { field: GoalFormField; code: "range"; min: number; max: number };

type NumberField = Extract<
  GoalFormField,
  "maxParallel" | "maxTasks" | "maxRuns" | "runTimeoutMinutes" | "goalTimeoutMinutes"
>;

/** Ranges from `GoalConfigSchema` (packages/protocol/src/goal/types.ts). */
export const GOAL_NUMBER_RANGES: Record<NumberField, { min: number; max: number }> = {
  maxParallel: { min: 1, max: 8 },
  maxTasks: { min: 1, max: 100 },
  maxRuns: { min: 1, max: 500 },
  runTimeoutMinutes: { min: 1, max: 1440 },
  goalTimeoutMinutes: { min: 1, max: 10080 },
};

const OPTIONAL_LIMIT_FIELDS = [
  "maxTasks",
  "maxRuns",
  "runTimeoutMinutes",
  "goalTimeoutMinutes",
] as const satisfies readonly NumberField[];

// docs/goals.md "Configuration": the CLI defaults for fields the form does not expose.
const DEFAULT_MAX_PARALLEL = "2";
const DEFAULT_MAX_ATTEMPTS = 2;

export const EMPTY_GOAL_FORM_VALUES: GoalFormValues = {
  title: "",
  objective: "",
  criteriaText: "",
  managed: false,
  cwd: "",
  leadProvider: "",
  defaultProvider: "",
  reviewProvider: "",
  testCommand: "",
  autoApprovePlan: false,
  requireHumanApproval: false,
  maxParallel: DEFAULT_MAX_PARALLEL,
  maxTasks: "",
  maxRuns: "",
  runTimeoutMinutes: "",
  goalTimeoutMinutes: "",
  onPermissionRequest: "fail",
};

/** One acceptance criterion per non-blank line. */
export function parseGoalCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** A whole number, or null for blank or anything else. */
function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : null;
}

function numberIssue(field: NumberField, raw: string, required: boolean): GoalFormIssue | null {
  if (!raw.trim()) {
    return required ? { field, code: "required" } : null;
  }
  const range = GOAL_NUMBER_RANGES[field];
  const value = parseWholeNumber(raw);
  if (value === null || value < range.min || value > range.max) {
    return { field, code: "range", ...range };
  }
  return null;
}

/** Every reason the values cannot be submitted; empty when they can. */
export function validateGoalForm(values: GoalFormValues): GoalFormIssue[] {
  const issues: GoalFormIssue[] = [];
  if (!values.title.trim()) {
    issues.push({ field: "title", code: "required" });
  }
  if (!values.managed) {
    return issues;
  }
  if (parseGoalCriteria(values.criteriaText).length === 0) {
    issues.push({ field: "criteria", code: "required" });
  }
  for (const field of ["cwd", "leadProvider", "defaultProvider"] as const) {
    if (!values[field].trim()) {
      issues.push({ field, code: "required" });
    }
  }
  for (const field of ["maxParallel", ...OPTIONAL_LIMIT_FIELDS] as const) {
    const issue = numberIssue(field, values[field], field === "maxParallel");
    if (issue) {
      issues.push(issue);
    }
  }
  return issues;
}

function buildLimits(values: GoalFormValues): GoalConfig["limits"] {
  const limits: NonNullable<GoalConfig["limits"]> = {};
  for (const field of OPTIONAL_LIMIT_FIELDS) {
    const value = parseWholeNumber(values[field]);
    if (value !== null) {
      limits[field] = value;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * The goal config exactly as `GoalConfigSchema` takes it, leaving out every optional field the
 * user did not set so the daemon applies its own default. Call only on values that validate.
 */
function buildGoalConfig(values: GoalFormValues, originAgentId: string | null): GoalConfig {
  const reviewProvider = values.reviewProvider.trim();
  const testCommand = values.testCommand.trim();
  const limits = buildLimits(values);
  return {
    cwd: values.cwd.trim(),
    leadProvider: values.leadProvider.trim(),
    defaultProvider: values.defaultProvider.trim(),
    maxParallel: parseWholeNumber(values.maxParallel) ?? Number(DEFAULT_MAX_PARALLEL),
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    autoApprovePlan: values.autoApprovePlan,
    notifyLead: true,
    ...(reviewProvider ? { reviewProvider } : {}),
    ...(testCommand ? { testCommand } : {}),
    ...(values.requireHumanApproval ? { requireHumanApproval: true } : {}),
    ...(limits ? { limits } : {}),
    ...(values.onPermissionRequest === "wait" ? { onPermissionRequest: "wait" as const } : {}),
    ...(originAgentId ? { originAgentId } : {}),
  };
}

/** Returns null while the form cannot be submitted (see `validateGoalForm`). */
export function buildGoalCreateInput(
  values: GoalFormValues,
  originAgentId: string | null = null,
): GoalCreateInput | null {
  if (validateGoalForm(values).length > 0) {
    return null;
  }
  return {
    title: values.title.trim(),
    objective: values.objective.trim(),
    criteria: parseGoalCriteria(values.criteriaText),
    ...(values.managed ? { config: buildGoalConfig(values, originAgentId) } : {}),
  };
}

export interface GoalProviderOption {
  id: string;
  label: string;
}

export interface GoalFormState {
  values: GoalFormValues;
  originAgentId: string | null;
  /** Providers registered on the host; empty until the providers snapshot arrives. */
  providerOptions: GoalProviderOption[];
  limitsExpanded: boolean;
  issues: GoalFormIssue[];
  createInput: GoalCreateInput | null;
  submitError: string | null;
}

export interface GoalFormModel {
  getState: () => GoalFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setValue: <Key extends keyof GoalFormValues>(key: Key, value: GoalFormValues[Key]) => void;
  setLimitsExpanded: (expanded: boolean) => void;
  /** Late data: the host's registered providers. Drops a selected provider the host lacks. */
  applyProviderOptions: (options: readonly GoalProviderOption[]) => void;
  setSubmitError: (message: string | null) => void;
}

const PROVIDER_FIELDS = ["leadProvider", "defaultProvider", "reviewProvider"] as const;

function withDerived(state: Omit<GoalFormState, "issues" | "createInput">): GoalFormState {
  return {
    ...state,
    issues: validateGoalForm(state.values),
    createInput: buildGoalCreateInput(state.values, state.originAgentId),
  };
}

export function openGoalForm(snapshot: { prefill?: GoalFormPrefill }): GoalFormModel {
  const prefill = snapshot.prefill ?? {};
  const listeners = new Set<() => void>();
  let closed = false;
  let state = withDerived({
    values: {
      ...EMPTY_GOAL_FORM_VALUES,
      title: prefill.title ?? "",
      objective: prefill.objective ?? "",
      managed: prefill.managed ?? false,
      cwd: prefill.cwd ?? "",
      leadProvider: prefill.leadProvider ?? "",
      defaultProvider: prefill.defaultProvider ?? "",
    },
    originAgentId: prefill.originAgentId ?? null,
    providerOptions: [],
    limitsExpanded: false,
    submitError: null,
  });

  function publish(next: Omit<GoalFormState, "issues" | "createInput">): void {
    if (closed) {
      return;
    }
    state = withDerived(next);
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      if (closed) {
        return () => {};
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setValue(key, value) {
      publish({ ...state, values: { ...state.values, [key]: value }, submitError: null });
    },
    setLimitsExpanded(expanded) {
      publish({ ...state, limitsExpanded: expanded });
    },
    applyProviderOptions(options) {
      const known = new Set(options.map((option) => option.id));
      const values = { ...state.values };
      if (options.length > 0) {
        for (const field of PROVIDER_FIELDS) {
          if (values[field] && !known.has(values[field])) {
            values[field] = "";
          }
        }
      }
      publish({ ...state, values, providerOptions: [...options] });
    },
    setSubmitError(message) {
      publish({ ...state, submitError: message });
    },
  };
}
