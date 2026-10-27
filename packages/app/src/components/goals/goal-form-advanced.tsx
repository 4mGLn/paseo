import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import type { GoalFormModel, GoalFormState } from "@/goals/goal-form-model";
import { durationLabel } from "@/goals/goal-labels";
import { formatCompactCount, formatUsd } from "@/goals/goal-progress";
import { GOAL_BUDGET_FIELDS, GOAL_SETTING_FIELDS } from "@/goals/goal-number-fields";
import {
  minutesToDuration,
  secondsToDuration,
  type GoalBudgetKey,
  type GoalNumberSetting,
  type GoalPermissionPolicy,
  type GoalSettings,
} from "@/goals/goal-settings";
import {
  ModelSelect,
  ProviderSelect,
  SettingRow,
  SwitchSetting,
  ThinkingSelect,
} from "./goal-form-fields";
import { ScrubNumberField } from "./scrub-number-field";

interface AdvancedProps {
  model: GoalFormModel;
  state: GoalFormState;
  serverId: string;
  providersLoading: boolean;
  size: FieldControlSize;
}

/** Everything past the essentials, in four plain-language groups. */
export function GoalFormAdvanced(props: AdvancedProps): ReactElement {
  const { t } = useTranslation();
  return (
    <View style={styles.container} testID="goal-advanced">
      <Group title={t("goals.form.sections.team")}>
        <TeamSettings {...props} />
      </Group>
      <Group title={t("goals.form.sections.time")}>
        <NumberSetting {...props} setting="runTimeoutMinutes" />
        <NumberSetting {...props} setting="goalTimeoutMinutes" />
        <NumberSetting {...props} setting="retryBackoffSeconds" />
      </Group>
      {props.state.budgetSupported ? (
        <Group title={t("goals.form.sections.budget")}>
          <BudgetSetting {...props} budgetKey="maxTotalTokens" format={formatCompactCount} />
          <BudgetSetting {...props} budgetKey="maxCostUsd" format={formatUsd} />
        </Group>
      ) : null}
      <Group title={t("goals.form.sections.safety")}>
        <SafetySettings {...props} />
      </Group>
    </View>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      {children}
    </View>
  );
}

function TeamSettings(props: AdvancedProps): ReactElement {
  const { t } = useTranslation();
  const { model, state, serverId, providersLoading, size } = props;
  const { values } = state;
  const setLeadModel = useCallback((value: string) => model.setValue("leadModel", value), [model]);
  const setDefaultModel = useCallback(
    (value: string) => model.setValue("defaultModel", value),
    [model],
  );
  const setReview = useCallback(
    (value: string) => model.setValue("reviewProvider", value),
    [model],
  );
  const setReviewModel = useCallback(
    (value: string) => model.setValue("reviewModel", value),
    [model],
  );
  const setLeadThinking = useCallback(
    (value: string) => model.setValue("leadThinking", value),
    [model],
  );
  const setWorkerThinking = useCallback(
    (value: string) => model.setValue("workerThinking", value),
    [model],
  );
  const setReviewThinking = useCallback(
    (value: string) => model.setValue("reviewThinking", value),
    [model],
  );
  const setVerifyThinking = useCallback(
    (value: string) => model.setValue("verifyThinking", value),
    [model],
  );
  const excludedIssue = state.visibleIssues.find((issue) => issue.code === "excludesRole");

  return (
    <>
      <NumberSetting {...props} setting="maxParallel" />
      <NumberSetting {...props} setting="maxAttempts" />
      <NumberSetting {...props} setting="maxTasks" />
      <NumberSetting {...props} setting="maxRuns" />
      <View style={styles.block}>
        <SettingRow
          label={t("goals.form.settings.allowedProviders.label")}
          hint={t("goals.form.settings.allowedProviders.hint")}
        />
        <View style={styles.chips}>
          {state.providerOptions.map((option) => (
            <ProviderChip
              key={option.id}
              id={option.id}
              label={option.label}
              selected={values.allowedProviders.includes(option.id)}
              onToggle={model.toggleAllowedProvider}
            />
          ))}
        </View>
        {excludedIssue && excludedIssue.code === "excludesRole" ? (
          <Text style={styles.error}>
            {t("goals.form.errors.excludesRole", { provider: excludedIssue.provider })}
          </Text>
        ) : null}
      </View>
      <ModelSelect
        label={t("goals.form.leadModelLabel")}
        provider={values.leadProvider}
        value={values.leadModel}
        onChange={setLeadModel}
        options={state.providerOptions}
        size={size}
        testID="goal-lead-model"
      />
      <ThinkingSelect
        label={t("goals.form.leadThinkingLabel")}
        value={values.leadThinking}
        onChange={setLeadThinking}
        options={state.thinkingOptions.lead}
        size={size}
        testID="goal-lead-thinking"
      />
      <ModelSelect
        label={t("goals.form.defaultModelLabel")}
        provider={values.defaultProvider}
        value={values.defaultModel}
        onChange={setDefaultModel}
        options={state.providerOptions}
        size={size}
        testID="goal-default-model"
      />
      <ThinkingSelect
        label={t("goals.form.defaultThinkingLabel")}
        value={values.workerThinking}
        onChange={setWorkerThinking}
        options={state.thinkingOptions.worker}
        size={size}
        testID="goal-worker-thinking"
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
      <ModelSelect
        label={t("goals.form.reviewModelLabel")}
        provider={values.reviewProvider}
        value={values.reviewModel}
        onChange={setReviewModel}
        options={state.providerOptions}
        size={size}
        testID="goal-review-model"
      />
      <ThinkingSelect
        label={t("goals.form.reviewThinkingLabel")}
        value={values.reviewThinking}
        onChange={setReviewThinking}
        options={state.thinkingOptions.reviewer}
        size={size}
        testID="goal-review-thinking"
      />
      <ThinkingSelect
        label={t("goals.form.verifyThinkingLabel")}
        value={values.verifyThinking}
        onChange={setVerifyThinking}
        options={state.thinkingOptions.verifier}
        size={size}
        testID="goal-verify-thinking"
      />
    </>
  );
}

function ProviderChip({
  id,
  label,
  selected,
  onToggle,
}: {
  id: string;
  label: string;
  selected: boolean;
  onToggle: (id: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => onToggle(id), [id, onToggle]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      size="xs"
      leftIcon={selected ? Check : undefined}
      onPress={handlePress}
      accessibilityState={accessibilityState}
      testID={`goal-allowed-provider-${id}`}
    >
      {label}
    </Button>
  );
}

function SafetySettings({ model, state, size }: AdvancedProps): ReactElement {
  const { t } = useTranslation();
  const { settings } = state.values;
  const setRequireApproval = useCallback(
    (value: boolean) => model.setSetting("requireHumanApproval", value),
    [model],
  );
  const setAutoApprove = useCallback(
    (value: boolean) => model.setSetting("autoApprovePlan", value),
    [model],
  );
  const setNotifyLead = useCallback(
    (value: boolean) => model.setSetting("notifyLead", value),
    [model],
  );
  const setPermission = useCallback(
    (value: GoalPermissionPolicy) => model.setSetting("onPermissionRequest", value),
    [model],
  );
  const permissionOptions = useMemo<SegmentedControlOption<GoalPermissionPolicy>[]>(
    () => [
      { value: "fail", label: t("goals.form.permissionFail"), testID: "goal-permission-fail" },
      { value: "wait", label: t("goals.form.permissionWait"), testID: "goal-permission-wait" },
    ],
    [t],
  );
  return (
    <>
      <SwitchSetting
        label={t("goals.form.settings.requireHumanApproval.label")}
        hint={t("goals.form.settings.requireHumanApproval.hint")}
        value={settings.requireHumanApproval}
        onChange={setRequireApproval}
        testID="goal-require-approval-switch"
      />
      <SwitchSetting
        label={t("goals.form.settings.autoApprovePlan.label")}
        hint={t("goals.form.settings.autoApprovePlan.hint")}
        value={settings.autoApprovePlan}
        onChange={setAutoApprove}
        testID="goal-auto-approve-switch"
      />
      <NumberSetting model={model} state={state} size={size} setting="maxReworkRounds" />
      <View style={styles.block}>
        <SettingRow
          label={t("goals.form.settings.onPermissionRequest.label")}
          hint={t("goals.form.settings.onPermissionRequest.hint")}
        />
        <SegmentedControl
          options={permissionOptions}
          value={settings.onPermissionRequest}
          onValueChange={setPermission}
          size={size}
          testID="goal-permission"
        />
      </View>
      <SwitchSetting
        label={t("goals.form.settings.notifyLead.label")}
        hint={t("goals.form.settings.notifyLead.hint")}
        value={settings.notifyLead}
        onChange={setNotifyLead}
        testID="goal-notify-lead-switch"
      />
    </>
  );
}

function describeSetting(
  t: ReturnType<typeof useTranslation>["t"],
  setting: GoalNumberSetting,
  value: number,
): string {
  if (setting === "runTimeoutMinutes" || setting === "goalTimeoutMinutes") {
    return durationLabel(t, minutesToDuration(value));
  }
  if (setting === "retryBackoffSeconds") {
    return durationLabel(t, secondsToDuration(value));
  }
  return String(value);
}

function NumberSetting({
  model,
  state,
  size,
  setting,
}: Pick<AdvancedProps, "model" | "state" | "size"> & {
  setting: GoalNumberSetting;
}): ReactElement {
  const { t } = useTranslation();
  const value: GoalSettings[GoalNumberSetting] = state.values.settings[setting];
  const field = GOAL_SETTING_FIELDS[setting];
  const label = t(`goals.form.settings.${setting}.label`);
  const handleChange = useCallback(
    (next: number | null) => {
      if (next !== null) {
        model.setSetting(setting, next);
      }
    },
    [model, setting],
  );
  const describeValue = useCallback(
    (next: number | null) => (next === null ? "" : describeSetting(t, setting, next)),
    [setting, t],
  );
  return (
    <SettingRow label={label} hint={t(`goals.form.settings.${setting}.hint`)}>
      <ScrubNumberField
        label={label}
        value={value}
        onChange={handleChange}
        scale={field.scale}
        format={field.format}
        describeValue={describeValue}
        size={size}
        testID={`goal-setting-${setting}`}
      />
    </SettingRow>
  );
}

function BudgetSetting({
  model,
  state,
  size,
  budgetKey,
  format,
}: Pick<AdvancedProps, "model" | "state" | "size"> & {
  budgetKey: GoalBudgetKey;
  format: (value: number) => string;
}): ReactElement {
  const { t } = useTranslation();
  const value = state.values.budget[budgetKey];
  const field = GOAL_BUDGET_FIELDS[budgetKey];
  const label = t(`goals.form.settings.${budgetKey}.label`);
  const noLimit = t("goals.form.noLimit");
  const handleChange = useCallback(
    (next: number | null) => model.setBudget(budgetKey, next),
    [budgetKey, model],
  );
  const describeValue = useCallback(
    (next: number | null) => (next === null ? noLimit : format(next)),
    [format, noLimit],
  );
  return (
    <SettingRow label={label} hint={t(`goals.form.settings.${budgetKey}.hint`)}>
      <ScrubNumberField
        label={label}
        value={value}
        onChange={handleChange}
        scale={field.scale}
        format={field.format}
        describeValue={describeValue}
        placeholder={noLimit}
        size={size}
        testID={`goal-budget-${budgetKey}`}
      />
    </SettingRow>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[6],
  },
  group: {
    gap: theme.spacing[4],
  },
  groupTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  block: {
    gap: theme.spacing[2],
  },
  chips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
