import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildGoalCreateInput, type GoalFormValues } from "@/goals/goal-form-model";
import { useGoalMutations } from "@/hooks/use-goal-mutations";
import { toErrorMessage } from "@/utils/error-messages";

const INITIAL_VALUES: GoalFormValues = { title: "", objective: "", criteriaText: "" };

/**
 * Mount only while open: the caller renders this conditionally, so every open
 * starts from empty values (docs/forms.md, fresh mount per open).
 */
export function GoalFormSheet({
  serverId,
  onClose,
}: {
  serverId: string;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const controlSize = isCompact ? "md" : "sm";
  const { createGoal, isCreating } = useGoalMutations({ serverId });
  const [values, setValues] = useState<GoalFormValues>(INITIAL_VALUES);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const createInput = useMemo(() => buildGoalCreateInput(values), [values]);

  const setTitle = useCallback((title: string) => setValues((prev) => ({ ...prev, title })), []);
  const setObjective = useCallback(
    (objective: string) => setValues((prev) => ({ ...prev, objective })),
    [],
  );
  const setCriteriaText = useCallback(
    (criteriaText: string) => setValues((prev) => ({ ...prev, criteriaText })),
    [],
  );

  const handleSubmit = useCallback(() => {
    if (!createInput) {
      return;
    }
    setSubmitError(null);
    createGoal(createInput).then(onClose, (error: unknown) => {
      setSubmitError(toErrorMessage(error));
    });
  }, [createGoal, createInput, onClose]);

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
          onPress={handleSubmit}
          disabled={!createInput}
          loading={isCreating}
          testID="goal-form-submit"
        >
          {t("goals.form.create")}
        </Button>
      </View>
    ),
    [createInput, handleSubmit, isCreating, onClose, t],
  );

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
          initialValue={values.title}
          onChangeText={setTitle}
        />
      </Field>
      <Field label={t("goals.form.objectiveLabel")}>
        <FormTextInput
          size={controlSize}
          testID="goal-objective-input"
          accessibilityLabel={t("goals.form.objectiveLabel")}
          initialValue={values.objective}
          onChangeText={setObjective}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>
      <Field label={t("goals.form.criteriaLabel")}>
        <FormTextInput
          size={controlSize}
          testID="goal-criteria-input"
          accessibilityLabel={t("goals.form.criteriaLabel")}
          initialValue={values.criteriaText}
          onChangeText={setCriteriaText}
          placeholder={t("goals.form.criteriaPlaceholder")}
          style={styles.multilineInput}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />
      </Field>
      {submitError ? <Text style={styles.submitError}>{submitError}</Text> : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  multilineInput: {
    minHeight: 96,
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
}));
