import {
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Goal } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { useProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { ComboboxItem } from "@/components/ui/combobox";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import type {
  GoalFormField,
  GoalFormIssue,
  GoalFormModel,
  GoalFormPrefill,
  GoalFormState,
  GoalFormValues,
  GoalPermissionPolicy,
} from "@/goals/goal-form-model";
import { useGoalFormModel, useGoalFormProviderOptions } from "@/goals/use-goal-form-model";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { toErrorMessage } from "@/utils/error-messages";

type ProvidersSnapshot = ReturnType<typeof useGoalFormProviderOptions>;
type NumberValueKey = Extract<
  keyof GoalFormValues,
  "maxParallel" | "maxTasks" | "maxRuns" | "runTimeoutMinutes" | "goalTimeoutMinutes"
>;

/**
 * Mount only while open: the caller renders this conditionally, so every open
 * starts from the prefill (docs/forms.md, fresh mount per open).
 */
export function GoalFormSheet({
  serverId,
  prefill,
  onClose,
  onCreated,
}: {
  serverId: string;
  prefill?: GoalFormPrefill;
  onClose: () => void;
  onCreated?: (goal: Goal) => void;
}): ReactElement {
  const { t } = useTranslation();
  const controlSize: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const { createGoal, isCreating } = useGoalMutations({ serverId });
  const model = useGoalFormModel(prefill);
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providersSnapshot = useGoalFormProviderOptions({
    model,
    serverId,
    enabled: state.values.managed,
  });
  const { createInput } = state;

  const handleSubmit = useCallback(async () => {
    if (!createInput) {
      return;
    }
    model.setSubmitError(null);
    try {
      const goal = await createGoal(createInput);
      onClose();
      if (goal) {
        onCreated?.(goal);
      }
    } catch (error) {
      model.setSubmitError(toErrorMessage(error));
    }
  }, [createGoal, createInput, model, onClose, onCreated]);

  const handleSubmitPress = useCallback(() => {
    void handleSubmit();
  }, [handleSubmit]);

  const header = useMemo<SheetHeader>(() => ({ title: t("goals.form.title") }), [t]);

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button
          style={styles.footerButton}
          variant="secondary"
          onPress={onClose}
          disabled={isCreating}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleSubmitPress}
          disabled={!createInput}
          loading={isCreating}
          testID="goal-form-submit"
        >
          {t("goals.form.create")}
        </Button>
      </View>
    ),
    [createInput, handleSubmitPress, isCreating, onClose, t],
  );

  const setTitle = useCallback((value: string) => model.setValue("title", value), [model]);
  const setObjective = useCallback((value: string) => model.setValue("objective", value), [model]);
  const setCriteriaText = useCallback(
    (value: string) => model.setValue("criteriaText", value),
    [model],
  );
  const setManaged = useCallback((value: boolean) => model.setValue("managed", value), [model]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="goal-form-sheet"
    >
      <Field label={t("goals.form.titleLabel")}>
        <FormTextInput
          size={controlSize}
          testID="goal-title-input"
          accessibilityLabel={t("goals.form.titleLabel")}
          initialValue={state.values.title}
          onChangeText={setTitle}
        />
      </Field>
      <Field label={t("goals.form.objectiveLabel")}>
        <FormTextInput
          size={controlSize}
          testID="goal-objective-input"
          accessibilityLabel={t("goals.form.objectiveLabel")}
          initialValue={state.values.objective}
          onChangeText={setObjective}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>
      <Field
        label={t("goals.form.criteriaLabel")}
        error={issueMessage(t, state.issues, "criteria", t("goals.form.errors.criteriaRequired"))}
      >
        <FormTextInput
          size={controlSize}
          testID="goal-criteria-input"
          accessibilityLabel={t("goals.form.criteriaLabel")}
          initialValue={state.values.criteriaText}
          onChangeText={setCriteriaText}
          placeholder={t("goals.form.criteriaPlaceholder")}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>
      <Field label={t("goals.form.managedLabel")}>
        <Switch
          value={state.values.managed}
          onValueChange={setManaged}
          accessibilityLabel={t("goals.form.managedLabel")}
          testID="goal-managed-switch"
        />
      </Field>
      {state.values.managed ? (
        <ManagedGoalFields
          model={model}
          state={state}
          serverId={serverId}
          providersSnapshot={providersSnapshot}
          size={controlSize}
        />
      ) : null}
      {state.submitError ? <Text style={styles.submitError}>{state.submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

/**
 * Only range errors and the missing criterion are shown inline: an empty required text field
 * or picker already reads as unfilled, and the disabled Create button says the rest.
 */
function issueMessage(
  t: TFunction,
  issues: readonly GoalFormIssue[],
  field: GoalFormField,
  requiredMessage?: string,
): string | null {
  const issue = issues.find((candidate) => candidate.field === field);
  if (!issue) {
    return null;
  }
  if (issue.code === "range") {
    return t("goals.form.errors.range", { min: issue.min, max: issue.max });
  }
  return requiredMessage ?? null;
}

function ManagedGoalFields({
  model,
  state,
  serverId,
  providersSnapshot,
  size,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  serverId: string;
  providersSnapshot: ProvidersSnapshot;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const { values } = state;
  const setCwd = useCallback((value: string) => model.setValue("cwd", value), [model]);
  const setLead = useCallback((value: string) => model.setValue("leadProvider", value), [model]);
  const setDefault = useCallback(
    (value: string) => model.setValue("defaultProvider", value),
    [model],
  );
  const setReview = useCallback(
    (value: string) => model.setValue("reviewProvider", value),
    [model],
  );
  const setTestCommand = useCallback(
    (value: string) => model.setValue("testCommand", value),
    [model],
  );
  const setAutoApprove = useCallback(
    (value: boolean) => model.setValue("autoApprovePlan", value),
    [model],
  );
  const setRequireApproval = useCallback(
    (value: boolean) => model.setValue("requireHumanApproval", value),
    [model],
  );
  const toggleLimits = useCallback(
    () => model.setLimitsExpanded(!state.limitsExpanded),
    [model, state.limitsExpanded],
  );
  const providersLoading = providersSnapshot.isLoading || providersSnapshot.isFetching;
  const limitsAccessibilityState = useMemo(
    () => ({ expanded: state.limitsExpanded }),
    [state.limitsExpanded],
  );

  return (
    <>
      {state.originAgentId ? <Text style={styles.note}>{t("goals.form.postsBack")}</Text> : null}
      <Field label={t("goals.form.cwdLabel")}>
        <FormTextInput
          size={size}
          testID="goal-cwd-input"
          accessibilityLabel={t("goals.form.cwdLabel")}
          initialValue={values.cwd}
          onChangeText={setCwd}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <ProviderSelect
        label={t("goals.form.leadProviderLabel")}
        value={values.leadProvider}
        onChange={setLead}
        options={state.providerOptions}
        serverId={serverId}
        loading={providersLoading}
        size={size}
        testID="goal-lead-provider"
      />
      <ProviderSelect
        label={t("goals.form.defaultProviderLabel")}
        value={values.defaultProvider}
        onChange={setDefault}
        options={state.providerOptions}
        serverId={serverId}
        loading={providersLoading}
        size={size}
        testID="goal-default-provider"
      />
      <ProviderSelect
        label={t("goals.form.reviewProviderLabel")}
        value={values.reviewProvider}
        onChange={setReview}
        options={state.providerOptions}
        serverId={serverId}
        loading={providersLoading}
        size={size}
        emptyLabel={t("goals.form.sameAsLead")}
        testID="goal-review-provider"
      />
      <Field label={t("goals.form.testCommandLabel")}>
        <FormTextInput
          size={size}
          testID="goal-test-command-input"
          accessibilityLabel={t("goals.form.testCommandLabel")}
          initialValue={values.testCommand}
          onChangeText={setTestCommand}
          placeholder={t("goals.form.optional")}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
      <Field label={t("goals.form.autoApproveLabel")}>
        <Switch
          value={values.autoApprovePlan}
          onValueChange={setAutoApprove}
          accessibilityLabel={t("goals.form.autoApproveLabel")}
          testID="goal-auto-approve-switch"
        />
      </Field>
      <Field label={t("goals.form.requireApprovalLabel")}>
        <Switch
          value={values.requireHumanApproval}
          onValueChange={setRequireApproval}
          accessibilityLabel={t("goals.form.requireApprovalLabel")}
          testID="goal-require-approval-switch"
        />
      </Field>
      <NumberField
        model={model}
        state={state}
        field="maxParallel"
        label={t("goals.form.maxParallelLabel")}
        size={size}
      />
      <View style={styles.disclosure}>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={state.limitsExpanded ? ChevronDown : ChevronRight}
          onPress={toggleLimits}
          accessibilityState={limitsAccessibilityState}
          testID="goal-limits-toggle"
        >
          {t("goals.form.limitsLabel")}
        </Button>
      </View>
      {state.limitsExpanded ? <LimitFields model={model} state={state} size={size} /> : null}
    </>
  );
}

// docs/goals.md "Configuration": what the daemon uses when a limit is left blank.
const LIMIT_DEFAULTS: Record<Exclude<NumberValueKey, "maxParallel">, string> = {
  maxTasks: "25",
  maxRuns: "60",
  runTimeoutMinutes: "60",
  goalTimeoutMinutes: "1440",
};

function LimitFields({
  model,
  state,
  size,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const permissionOptions = useMemo<SegmentedControlOption<GoalPermissionPolicy>[]>(
    () => [
      { value: "fail", label: t("goals.form.permissionFail"), testID: "goal-permission-fail" },
      { value: "wait", label: t("goals.form.permissionWait"), testID: "goal-permission-wait" },
    ],
    [t],
  );
  const setPermission = useCallback(
    (value: GoalPermissionPolicy) => model.setValue("onPermissionRequest", value),
    [model],
  );

  return (
    <>
      <NumberField
        model={model}
        state={state}
        field="maxTasks"
        label={t("goals.form.maxTasksLabel")}
        placeholder={LIMIT_DEFAULTS.maxTasks}
        size={size}
      />
      <NumberField
        model={model}
        state={state}
        field="maxRuns"
        label={t("goals.form.maxRunsLabel")}
        placeholder={LIMIT_DEFAULTS.maxRuns}
        size={size}
      />
      <NumberField
        model={model}
        state={state}
        field="runTimeoutMinutes"
        label={t("goals.form.runTimeoutLabel")}
        placeholder={LIMIT_DEFAULTS.runTimeoutMinutes}
        size={size}
      />
      <NumberField
        model={model}
        state={state}
        field="goalTimeoutMinutes"
        label={t("goals.form.goalTimeoutLabel")}
        placeholder={LIMIT_DEFAULTS.goalTimeoutMinutes}
        size={size}
      />
      <Field label={t("goals.form.permissionLabel")}>
        <SegmentedControl
          options={permissionOptions}
          value={state.values.onPermissionRequest}
          onValueChange={setPermission}
          size={size}
          testID="goal-permission"
        />
      </Field>
    </>
  );
}

function NumberField({
  model,
  state,
  field,
  label,
  placeholder,
  size,
}: {
  model: GoalFormModel;
  state: GoalFormState;
  field: NumberValueKey;
  label: string;
  placeholder?: string;
  size: FieldControlSize;
}): ReactElement {
  const { t } = useTranslation();
  const handleChange = useCallback((value: string) => model.setValue(field, value), [field, model]);
  return (
    <Field label={label} error={issueMessage(t, state.issues, field)}>
      <FormTextInput
        size={size}
        testID={`goal-${field}-input`}
        accessibilityLabel={label}
        initialValue={state.values[field]}
        onChangeText={handleChange}
        placeholder={placeholder}
        keyboardType="number-pad"
      />
    </Field>
  );
}

function ProviderSelect({
  label,
  value,
  onChange,
  options,
  serverId,
  loading,
  size,
  emptyLabel,
  testID,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: GoalFormState["providerOptions"];
  serverId: string;
  loading: boolean;
  size: FieldControlSize;
  /** When set, an extra first option that clears the selection. */
  emptyLabel?: string;
  testID: string;
}): ReactElement {
  const { t } = useTranslation();
  const selectOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const providerOptions = options.map((option) => ({
      id: option.id,
      value: option.id,
      label: option.label,
      testID: `${testID}-option-${option.id}`,
    }));
    return emptyLabel
      ? [
          { id: "", value: "", label: emptyLabel, testID: `${testID}-option-none` },
          ...providerOptions,
        ]
      : providerOptions;
  }, [emptyLabel, options, testID]);
  // The prefilled id stands in for its label until the providers snapshot arrives.
  const selectedDisplay = useMemo<SelectFieldDisplay | null>(() => {
    if (!value) {
      return emptyLabel ? { label: emptyLabel } : null;
    }
    return { label: options.find((option) => option.id === value)?.label ?? value };
  }, [emptyLabel, options, value]);
  const handleChange = useCallback((next: string) => onChange(next), [onChange]);
  const renderOption = useCallback(
    (input: SelectFieldRenderOptionInput<string>) => (
      <ProviderOptionItem {...input} serverId={serverId} />
    ),
    [serverId],
  );
  const triggerLeading = useMemo(
    () => (value ? <ProviderGlyph provider={value} serverId={serverId} /> : undefined),
    [serverId, value],
  );

  return (
    <SelectField
      label={label}
      value={emptyLabel || value ? value : null}
      selectedDisplay={selectedDisplay}
      options={selectOptions}
      onChange={handleChange}
      placeholder={t("goals.form.providerPlaceholder")}
      emptyText={t("goals.form.providerEmpty")}
      loading={loading}
      searchable={false}
      title={label}
      size={size}
      renderOption={renderOption}
      triggerLeading={triggerLeading}
      testID={testID}
      triggerTestID={`${testID}-trigger`}
    />
  );
}

function ProviderOptionItem({
  option,
  selected,
  active,
  onPress,
  serverId,
}: SelectFieldRenderOptionInput<string> & { serverId: string }): ReactElement {
  const leadingSlot = useMemo<ReactNode>(
    () => (option.value ? <ProviderGlyph provider={option.value} serverId={serverId} /> : null),
    [option.value, serverId],
  );
  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={leadingSlot}
    />
  );
}

function ProviderGlyph({ provider, serverId }: { provider: string; serverId: string }) {
  const Icon = useProviderIcon(provider, serverId);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

const styles = StyleSheet.create((theme) => ({
  multilineInput: {
    minHeight: 96,
  },
  note: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  disclosure: {
    alignItems: "flex-start",
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  submitError: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
}));
