import type { GoalConfig } from "@getpaseo/protocol/goal/types";
import { deriveGoalTitle } from "./goal-chat-prefill";
import {
  DAEMON_GOAL_SETTINGS,
  GOAL_PRESETS,
  NO_GOAL_BUDGET,
  goalBudgetToLimits,
  goalSettingsToConfig,
  matchGoalSettingsChoice,
  normalizeGoalSettings,
  stepGoalBudget,
  stepGoalSetting,
  summarizeGoalSettings,
  type GoalBudget,
  type GoalBudgetKey,
  type GoalNumberSetting,
  type GoalPresetId,
  type GoalSettings,
  type GoalSettingsChoice,
  type GoalSettingsSummaryPart,
} from "./goal-settings";

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
  /** Empty means any registered provider. */
  allowedProviders: string[];
  settings: GoalSettings;
  budget: GoalBudget;
}

/** The plain fields `setValue` edits; settings, budget and the allow-list have their own commands. */
export type GoalFormTextKey = Exclude<
  keyof GoalFormValues,
  "settings" | "budget" | "allowedProviders"
>;

export interface GoalCreateInput {
  title: string;
  objective: string;
  criteria: string[];
  config?: GoalConfig;
}

/** Values a caller seeds the form with, such as a chat, a template or your last goal. */
export interface GoalFormPrefill {
  title?: string;
  objective?: string;
  criteriaText?: string;
  managed?: boolean;
  cwd?: string;
  /** A provider id, or "provider/model". */
  leadProvider?: string;
  /** A provider id, or "provider/model". */
  defaultProvider?: string;
  /** A provider id, or "provider/model". */
  reviewProvider?: string;
  testCommand?: string;
  allowedProviders?: string[];
  /** Starts from a preset; wins over `settings`. */
  preset?: GoalPresetId;
  settings?: Partial<GoalSettings>;
  budget?: GoalBudget;
  /** The chat the goal is started from; the daemon posts the outcome back there. */
  originAgentId?: string;
}

export interface GoalFormSnapshot {
  prefill?: GoalFormPrefill;
  /** Your remembered settings: the starting point when no preset is given, and the "Mine" choice. */
  personalSettings?: GoalSettings | null;
  /** The host enforces token and cost caps. Without it the budget is never sent. */
  budgetSupported?: boolean;
}

export type GoalFormField =
  | "title"
  | "criteria"
  | "cwd"
  | "leadProvider"
  | "defaultProvider"
  | "allowedProviders";

export type GoalFormIssue =
  | { field: GoalFormField; code: "required" }
  | { field: "allowedProviders"; code: "excludesRole"; provider: string };

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
  allowedProviders: [],
  settings: DAEMON_GOAL_SETTINGS,
  budget: NO_GOAL_BUDGET,
};

/** One acceptance criterion per non-blank line. */
export function parseGoalCriteria(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The title as sent: the one typed, or the objective's first line. */
export function resolveGoalTitle(values: Pick<GoalFormValues, "title" | "objective">): string {
  return values.title.trim() || deriveGoalTitle(values.objective);
}

/** Every reason the values cannot be submitted; empty when they can. */
export function validateGoalForm(values: GoalFormValues): GoalFormIssue[] {
  const issues: GoalFormIssue[] = [];
  if (!resolveGoalTitle(values)) {
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
  if (values.allowedProviders.length > 0) {
    const roles = [values.leadProvider, values.defaultProvider, values.reviewProvider];
    const excluded = roles.find(
      (provider) => provider.trim() && !values.allowedProviders.includes(provider),
    );
    if (excluded) {
      issues.push({ field: "allowedProviders", code: "excludesRole", provider: excluded });
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

/**
 * The goal config exactly as `GoalConfigSchema` takes it, leaving out every optional field equal
 * to the daemon's default. Call only on values that validate.
 */
function buildGoalConfig(input: {
  values: GoalFormValues;
  originAgentId: string | null;
  budgetSupported: boolean;
}): GoalConfig {
  const { values } = input;
  const reviewProvider = values.reviewProvider.trim()
    ? composeProvider(values.reviewProvider, values.reviewModel)
    : "";
  const testCommand = values.testCommand.trim();
  const settingsConfig = goalSettingsToConfig(values.settings);
  const limits = {
    ...settingsConfig.limits,
    ...(input.budgetSupported ? goalBudgetToLimits(values.budget) : {}),
  };
  const hasLimits = Object.keys(limits).length > 0;
  return {
    ...settingsConfig,
    cwd: values.cwd.trim(),
    leadProvider: composeProvider(values.leadProvider, values.leadModel),
    defaultProvider: composeProvider(values.defaultProvider, values.defaultModel),
    ...(hasLimits ? { limits } : {}),
    ...(reviewProvider ? { reviewProvider } : {}),
    ...(testCommand ? { testCommand } : {}),
    ...(values.allowedProviders.length > 0
      ? { allowedProviders: [...values.allowedProviders] }
      : {}),
    ...(input.originAgentId ? { originAgentId: input.originAgentId } : {}),
  };
}

/** Returns null while the form cannot be submitted (see `validateGoalForm`). */
export function buildGoalCreateInput(
  values: GoalFormValues,
  options: { originAgentId?: string | null; budgetSupported?: boolean } = {},
): GoalCreateInput | null {
  if (validateGoalForm(values).length > 0) {
    return null;
  }
  const config = values.managed
    ? buildGoalConfig({
        values,
        originAgentId: options.originAgentId ?? null,
        budgetSupported: options.budgetSupported ?? false,
      })
    : null;
  return {
    title: resolveGoalTitle(values),
    objective: values.objective.trim(),
    criteria: parseGoalCriteria(values.criteriaText),
    ...(config ? { config } : {}),
  };
}

/** What happens after Create, sentence by sentence, under `goals.form.outcome`. */
export type GoalOutcomeStep =
  | "manual"
  | "planAuto"
  | "planReview"
  | "worktrees"
  | "mergeAsk"
  | "mergeReviewed"
  | "branch";

export function describeGoalOutcome(values: GoalFormValues): GoalOutcomeStep[] {
  if (!values.managed) {
    return ["manual"];
  }
  return [
    values.settings.autoApprovePlan ? "planAuto" : "planReview",
    "worktrees",
    values.settings.requireHumanApproval ? "mergeAsk" : "mergeReviewed",
    "branch",
  ];
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
  advancedExpanded: boolean;
  personalSettings: GoalSettings | null;
  budgetSupported: boolean;
  /** Fields you have edited; their issues show right away. The rest show after Create. */
  touched: readonly GoalFormField[];
  submitAttempted: boolean;
  issues: GoalFormIssue[];
  /** The issues to show now. */
  visibleIssues: GoalFormIssue[];
  createInput: GoalCreateInput | null;
  settingsChoice: GoalSettingsChoice;
  summary: GoalSettingsSummaryPart[];
  outcome: GoalOutcomeStep[];
  submitError: string | null;
}

export interface GoalFormModel {
  getState: () => GoalFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setValue: <Key extends GoalFormTextKey>(key: Key, value: GoalFormValues[Key]) => void;
  setSetting: <Key extends keyof GoalSettings>(key: Key, value: GoalSettings[Key]) => void;
  stepSetting: (key: GoalNumberSetting, direction: 1 | -1) => void;
  stepBudget: (key: GoalBudgetKey, direction: 1 | -1) => void;
  /** Replaces every setting with a preset's, or with your remembered ones. */
  chooseSettings: (choice: GoalPresetId | "mine") => void;
  toggleAllowedProvider: (provider: string) => void;
  setAdvancedExpanded: (expanded: boolean) => void;
  /** Reveals every issue; the caller submits only when `createInput` is set. */
  attemptSubmit: () => void;
  /**
   * Late data: the host's registered providers. Drops selections the host lacks, then fills an
   * empty Lead with the first allowed provider and empty workers with the Lead's.
   */
  applyProviderOptions: (options: readonly GoalProviderOption[]) => void;
  setSubmitError: (message: string | null) => void;
}

/** Each provider field and the model chosen for it. Changing the provider resets the model. */
const MODEL_FIELD_BY_PROVIDER = {
  leadProvider: "leadModel",
  defaultProvider: "defaultModel",
  reviewProvider: "reviewModel",
} as const satisfies Partial<Record<GoalFormTextKey, GoalFormTextKey>>;

const PROVIDER_FIELDS = Object.keys(
  MODEL_FIELD_BY_PROVIDER,
) as (keyof typeof MODEL_FIELD_BY_PROVIDER)[];

function isProviderField(key: GoalFormTextKey): key is keyof typeof MODEL_FIELD_BY_PROVIDER {
  return key in MODEL_FIELD_BY_PROVIDER;
}

const FIELD_OF_KEY: Partial<Record<GoalFormTextKey, GoalFormField>> = {
  title: "title",
  objective: "title",
  criteriaText: "criteria",
  cwd: "cwd",
  leadProvider: "leadProvider",
  defaultProvider: "defaultProvider",
  reviewProvider: "allowedProviders",
};

/** Drops selections the host's provider list rules out; an empty list rules nothing out. */
function reconcileWithOptions(
  values: GoalFormValues,
  options: readonly GoalProviderOption[],
): GoalFormValues {
  if (options.length === 0) {
    return values;
  }
  const next = {
    ...values,
    allowedProviders: values.allowedProviders.filter((id) =>
      options.some((option) => option.id === id),
    ),
  };
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
  const firstAllowed = options.find(
    (option) => next.allowedProviders.length === 0 || next.allowedProviders.includes(option.id),
  );
  if (!next.leadProvider) {
    next.leadProvider = next.defaultProvider || (firstAllowed?.id ?? "");
  }
  if (!next.defaultProvider) {
    next.defaultProvider = next.leadProvider;
  }
  return next;
}

type BaseState = Omit<
  GoalFormState,
  "issues" | "visibleIssues" | "createInput" | "settingsChoice" | "summary" | "outcome"
>;

function withDerived(state: BaseState): GoalFormState {
  const issues = validateGoalForm(state.values);
  return {
    ...state,
    issues,
    visibleIssues: state.submitAttempted
      ? issues
      : issues.filter((issue) => state.touched.includes(issue.field)),
    createInput: buildGoalCreateInput(state.values, {
      originAgentId: state.originAgentId,
      budgetSupported: state.budgetSupported,
    }),
    settingsChoice: matchGoalSettingsChoice(state.values.settings, state.personalSettings),
    summary: summarizeGoalSettings(state.values.settings, {
      hasTestCommand: state.values.testCommand.trim().length > 0,
    }),
    outcome: describeGoalOutcome(state.values),
  };
}

function initialSettings(snapshot: GoalFormSnapshot): GoalSettings {
  const prefill = snapshot.prefill ?? {};
  if (prefill.preset) {
    return GOAL_PRESETS[prefill.preset];
  }
  if (prefill.settings) {
    return normalizeGoalSettings(prefill.settings);
  }
  return snapshot.personalSettings ?? DAEMON_GOAL_SETTINGS;
}

export function openGoalForm(snapshot: GoalFormSnapshot): GoalFormModel {
  const prefill = snapshot.prefill ?? {};
  const listeners = new Set<() => void>();
  let closed = false;
  const lead = splitProvider(prefill.leadProvider ?? "");
  const fallback = splitProvider(prefill.defaultProvider ?? "");
  const review = splitProvider(prefill.reviewProvider ?? "");
  let state = withDerived({
    values: {
      ...EMPTY_GOAL_FORM_VALUES,
      title: prefill.title ?? "",
      objective: prefill.objective ?? "",
      criteriaText: prefill.criteriaText ?? "",
      managed: prefill.managed ?? false,
      cwd: prefill.cwd ?? "",
      leadProvider: lead.provider,
      leadModel: lead.model,
      defaultProvider: fallback.provider,
      defaultModel: fallback.model,
      reviewProvider: review.provider,
      reviewModel: review.model,
      testCommand: prefill.testCommand ?? "",
      allowedProviders: prefill.allowedProviders ?? [],
      settings: initialSettings(snapshot),
      budget: prefill.budget ?? NO_GOAL_BUDGET,
    },
    originAgentId: prefill.originAgentId ?? null,
    providerOptions: [],
    advancedExpanded: false,
    personalSettings: snapshot.personalSettings ?? null,
    budgetSupported: snapshot.budgetSupported ?? false,
    touched: [],
    submitAttempted: false,
    submitError: null,
  });

  function publish(next: BaseState): void {
    if (closed) {
      return;
    }
    state = withDerived(next);
    for (const listener of listeners) {
      listener();
    }
  }

  function touch(field: GoalFormField | undefined): readonly GoalFormField[] {
    return field && !state.touched.includes(field) ? [...state.touched, field] : state.touched;
  }

  function setSettings(settings: GoalSettings): void {
    publish({ ...state, values: { ...state.values, settings } });
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
      publish({ ...state, values, touched: touch(FIELD_OF_KEY[key]), submitError: null });
    },
    setSetting(key, value) {
      setSettings({ ...state.values.settings, [key]: value });
    },
    stepSetting(key, direction) {
      setSettings({
        ...state.values.settings,
        [key]: stepGoalSetting(key, state.values.settings[key], direction),
      });
    },
    stepBudget(key, direction) {
      const budget = {
        ...state.values.budget,
        [key]: stepGoalBudget(key, state.values.budget[key], direction),
      };
      publish({ ...state, values: { ...state.values, budget } });
    },
    chooseSettings(choice) {
      const settings = choice === "mine" ? state.personalSettings : GOAL_PRESETS[choice];
      if (settings) {
        setSettings(settings);
      }
    },
    toggleAllowedProvider(provider) {
      const current = state.values.allowedProviders;
      const allowedProviders = current.includes(provider)
        ? current.filter((id) => id !== provider)
        : [...current, provider];
      publish({
        ...state,
        values: { ...state.values, allowedProviders },
        touched: touch("allowedProviders"),
      });
    },
    setAdvancedExpanded(expanded) {
      publish({ ...state, advancedExpanded: expanded });
    },
    attemptSubmit() {
      publish({ ...state, submitAttempted: true });
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
