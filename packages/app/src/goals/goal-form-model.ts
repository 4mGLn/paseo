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
  /** Empty means the provider's default model. Sent as "provider/model". */
  leadModel: string;
  defaultProvider: string;
  defaultModel: string;
  /** Empty means the reviewer uses the Lead's provider and model. */
  reviewProvider: string;
  reviewModel: string;
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
  /** A provider id, or "provider/model". */
  leadProvider?: string;
  /** A provider id, or "provider/model". */
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
  leadModel: "",
  defaultProvider: "",
  defaultModel: "",
  reviewProvider: "",
  reviewModel: "",
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

/** The daemon takes "provider/model" wherever it takes a provider id; no model means its default. */
function composeProvider(provider: string, model: string): string {
  const trimmedProvider = provider.trim();
  const trimmedModel = model.trim();
  return trimmedModel ? `${trimmedProvider}/${trimmedModel}` : trimmedProvider;
}

/** Splits at the first slash, the way the daemon does (packages/server/src/server/goal/goal-ports.ts). */
function splitProvider(value: string): { provider: string; model: string } {
  const slash = value.indexOf("/");
  return slash < 0
    ? { provider: value, model: "" }
    : { provider: value.slice(0, slash), model: value.slice(slash + 1) };
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
  const reviewProvider = values.reviewProvider.trim()
    ? composeProvider(values.reviewProvider, values.reviewModel)
    : "";
  const testCommand = values.testCommand.trim();
  const limits = buildLimits(values);
  return {
    cwd: values.cwd.trim(),
    leadProvider: composeProvider(values.leadProvider, values.leadModel),
    defaultProvider: composeProvider(values.defaultProvider, values.defaultModel),
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

export interface GoalModelOption {
  id: string;
  label: string;
  description?: string;
}

export interface GoalProviderOption {
  id: string;
  label: string;
  /** Selectable models; absent or empty while the provider has not listed any. */
  models?: GoalModelOption[];
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
  /**
   * Late data: the host's registered providers. Drops a selected provider the host lacks, and a
   * selected model its provider does not list.
   */
  applyProviderOptions: (options: readonly GoalProviderOption[]) => void;
  setSubmitError: (message: string | null) => void;
}

/** Each provider field and the model chosen for it. Changing the provider resets the model. */
const MODEL_FIELD_BY_PROVIDER = {
  leadProvider: "leadModel",
  defaultProvider: "defaultModel",
  reviewProvider: "reviewModel",
} as const satisfies Partial<Record<keyof GoalFormValues, keyof GoalFormValues>>;

const PROVIDER_FIELDS = Object.keys(
  MODEL_FIELD_BY_PROVIDER,
) as (keyof typeof MODEL_FIELD_BY_PROVIDER)[];

function isProviderField(key: keyof GoalFormValues): key is keyof typeof MODEL_FIELD_BY_PROVIDER {
  return key in MODEL_FIELD_BY_PROVIDER;
}

/** Drops selections the host's provider list rules out; an empty list rules nothing out. */
function reconcileWithOptions(
  values: GoalFormValues,
  options: readonly GoalProviderOption[],
): GoalFormValues {
  if (options.length === 0) {
    return values;
  }
  const next = { ...values };
  for (const field of PROVIDER_FIELDS) {
    const modelField = MODEL_FIELD_BY_PROVIDER[field];
    const option = options.find((candidate) => candidate.id === next[field]);
    if (next[field] && !option) {
      next[field] = "";
      next[modelField] = "";
      continue;
    }
    const models = option?.models ?? [];
    if (next[modelField] && models.length > 0 && !models.some((m) => m.id === next[modelField])) {
      next[modelField] = "";
    }
  }
  return next;
}

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
  const lead = splitProvider(prefill.leadProvider ?? "");
  const fallback = splitProvider(prefill.defaultProvider ?? "");
  let state = withDerived({
    values: {
      ...EMPTY_GOAL_FORM_VALUES,
      title: prefill.title ?? "",
      objective: prefill.objective ?? "",
      managed: prefill.managed ?? false,
      cwd: prefill.cwd ?? "",
      leadProvider: lead.provider,
      leadModel: lead.model,
      defaultProvider: fallback.provider,
      defaultModel: fallback.model,
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
      const values = { ...state.values, [key]: value };
      if (isProviderField(key) && value !== state.values[key]) {
        values[MODEL_FIELD_BY_PROVIDER[key]] = "";
      }
      publish({ ...state, values, submitError: null });
    },
    setLimitsExpanded(expanded) {
      publish({ ...state, limitsExpanded: expanded });
    },
    applyProviderOptions(options) {
      publish({
        ...state,
        values: reconcileWithOptions(state.values, options),
        providerOptions: [...options],
      });
    },
    setSubmitError(message) {
      publish({ ...state, submitError: message });
    },
  };
}
