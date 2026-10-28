import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Goal, GoalEvent, GoalTimeMode } from "@getpaseo/protocol/goal/types";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { goalRemainingRunMs } from "@/goals/goal-progress";
import {
  buildRecoverRequest,
  goalRecoveryControls,
  isTimeLimitRefusal,
  recoverBlockingLimits,
  recoverNeedsTimeMode,
  type RecoverRules,
} from "@/goals/goal-recovery";
import { useGoalDecisionMutations } from "@/hooks/use-goal-decision-mutations";
import { useHostFeature } from "@/runtime/host-features";
import { toErrorMessage } from "@/utils/error-messages";
import { formatDuration } from "@/utils/time";

const MINUTE_MS = 60_000;

/** No time mode picked yet; the segmented control shows none selected. */
type TimeChoice = GoalTimeMode | "unset";

/**
 * What a Recover sheet was opened for. Starting a recovery, or anything else that takes Recover
 * away (archive, a recovery started elsewhere, the goal reopened), changes it, so the open sheet
 * closes and does not come back by itself.
 */
function recoverSheetKey(goal: Goal): string {
  return [goal.status, goal.recoveries ?? 0, goal.recovery?.id ?? "", goal.archivedAt ?? ""].join(
    ":",
  );
}

/**
 * Recover, for a failed goal on a host with `goalRecovery`, with the sheet it opens. Renders
 * nothing when the goal cannot start a recovery. Distinct from Retry, which reopens blindly.
 */
export function GoalRecoverButton({
  serverId,
  goal,
  events,
}: {
  serverId: string;
  goal: Goal;
  events: readonly GoalEvent[];
}): ReactElement | null {
  const { t } = useTranslation();
  const hasRecovery = useHostFeature(serverId, "goalRecovery");
  const key = recoverSheetKey(goal);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const open = useCallback(() => setOpenFor(key), [key]);
  const close = useCallback(() => setOpenFor(null), []);
  if (!goalRecoveryControls(goal, hasRecovery).canRecover) {
    return null;
  }
  return (
    <>
      <Button size="sm" variant="secondary" onPress={open} testID="goal-recover">
        {t("goals.recovery.recover")}
      </Button>
      {openFor === key ? (
        <GoalRecoverSheet serverId={serverId} goal={goal} events={events} onClose={close} />
      ) : null}
    </>
  );
}

function failedTasks(goal: Goal): Goal["tasks"] {
  return goal.tasks.filter((task) => task.status === "failed" || task.status === "cancelled");
}

/** What the sheet reads once, when it opens: later pushes do not move what you are editing. */
interface RecoverSeed {
  openedAt: number;
  guidance: Goal["guidance"];
  tasks: Goal["tasks"];
  remainingMs: number | null;
  needsTimeMode: boolean;
  limits: ReturnType<typeof recoverBlockingLimits>;
}

/**
 * Asks a fresh Lead to decide how a failed goal goes on. Takes your instruction for the goal and
 * for each failed task, and, when the time limit passes before a recovery could apply, how it
 * restarts. Mount only while open, so every open starts from the goal's current guidance.
 */
function GoalRecoverSheet({
  serverId,
  goal,
  events,
  onClose,
}: {
  serverId: string;
  goal: Goal;
  events: readonly GoalEvent[];
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const timeBase = useHostFeature(serverId, "goalTimeBase");
  const { startRecovery, isStartingRecovery } = useGoalDecisionMutations({ serverId });
  const [seed] = useState<RecoverSeed>(() => {
    const openedAt = Date.now();
    return {
      openedAt,
      guidance: goal.guidance,
      tasks: failedTasks(goal),
      remainingMs: goalRemainingRunMs(goal, events, openedAt),
      needsTimeMode: recoverNeedsTimeMode(goal, openedAt),
      limits: recoverBlockingLimits(goal, events, openedAt),
    };
  });
  const [refusedForTime, setRefusedForTime] = useState(false);
  const [goalText, setGoalText] = useState(seed.guidance?.goal ?? "");
  const [taskTexts, setTaskTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(seed.tasks.map((task) => [task.id, seed.guidance?.tasks?.[task.id] ?? ""])),
  );
  const [timeChoice, setTimeChoice] = useState<TimeChoice>("unset");
  const [error, setError] = useState<string | null>(null);

  // The host refuses a recovery whose time limit passes while the Lead decides.
  const needsTimeMode = timeBase && (refusedForTime || seed.needsTimeMode);
  const rules = useMemo<RecoverRules>(
    () => ({
      needsTimeMode,
      noneLeft: seed.remainingMs !== null && seed.remainingMs <= 0,
      current: seed.guidance,
    }),
    [needsTimeMode, seed],
  );
  const timeMode = timeChoice === "unset" ? null : timeChoice;
  const request = buildRecoverRequest({ goalText, taskTexts, timeMode }, rules);

  // A host error is about what was sent; changing the draft makes it stale.
  const changeGoalText = useCallback((text: string) => {
    setError(null);
    setGoalText(text);
  }, []);
  const changeTaskText = useCallback((taskId: string, text: string) => {
    setError(null);
    setTaskTexts((current) => ({ ...current, [taskId]: text }));
  }, []);
  const changeTimeChoice = useCallback((choice: TimeChoice) => {
    setError(null);
    setTimeChoice(choice);
  }, []);
  const handleStart = useCallback(() => {
    if (!request.ok) {
      return;
    }
    setError(null);
    startRecovery({ goalId: goal.id, ...request.input })
      .then(onClose)
      .catch((cause: unknown) => {
        // This device's clock can be behind the host's.
        if (timeBase && isTimeLimitRefusal(cause) && !needsTimeMode) {
          setRefusedForTime(true);
        }
        setError(toErrorMessage(cause));
      });
  }, [goal.id, needsTimeMode, onClose, request, startRecovery, timeBase]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: t("goals.recovery.sheetTitle"),
      subtitle: (
        <Text style={styles.subtitle} numberOfLines={1}>
          {goal.title}
        </Text>
      ),
    }),
    [goal.title, t],
  );
  const canStart = request.ok && !isStartingRecovery;
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          variant="default"
          onPress={handleStart}
          disabled={!canStart}
          loading={isStartingRecovery}
          testID="goal-recover-start"
        >
          {t("goals.recovery.start")}
        </Button>
      </View>
    ),
    [canStart, handleStart, isStartingRecovery, onClose, t],
  );
  const tooLong = !request.ok && request.error === "tooLong" ? request : null;
  const tooLongText = t("goals.recovery.tooLong");

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      testID="goal-recover-sheet"
    >
      <View style={styles.body}>
        <Text style={styles.message}>{t("goals.recovery.sheetExplain")}</Text>
        {/* Read once at open, so it never moves the fields below. */}
        {seed.limits.length > 0 ? (
          <Text style={styles.warning} testID="goal-recover-limits">
            {t("goals.recovery.limitsFirst", {
              limits: seed.limits
                .map((limit) => t(`goals.diagnosis.limits.${limit.limit}`))
                .join(", "),
            })}
          </Text>
        ) : null}
        <Field
          label={t("goals.recovery.goalInstruction")}
          hint={t("goals.recovery.instructionHint")}
          error={tooLong?.goal ? tooLongText : null}
        >
          <FormTextInput
            size={size}
            testID="goal-recover-goal-instruction"
            accessibilityLabel={t("goals.recovery.goalInstruction")}
            initialValue={seed.guidance?.goal ?? ""}
            onChangeText={changeGoalText}
            style={styles.input}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </Field>
        {seed.tasks.map((task) => (
          <TaskInstructionField
            key={task.id}
            taskId={task.id}
            title={task.title}
            initialValue={seed.guidance?.tasks?.[task.id] ?? ""}
            error={tooLong?.tasks.includes(task.id) ? tooLongText : null}
            size={size}
            onChange={changeTaskText}
          />
        ))}
        {needsTimeMode ? (
          <TimeModeField
            choice={timeChoice}
            remainingMs={seed.remainingMs}
            noneLeft={rules.noneLeft}
            size={size}
            onChange={changeTimeChoice}
          />
        ) : null}
        {/* The host's answer to Start; field problems show under their fields instead. */}
        {error ? <Text style={styles.error}>{error}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function TaskInstructionField({
  taskId,
  title,
  initialValue,
  error,
  size,
  onChange,
}: {
  taskId: string;
  title: string;
  initialValue: string;
  error: string | null;
  size: "sm" | "md";
  onChange: (taskId: string, text: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const label = t("goals.recovery.taskInstruction", { title });
  const handleChange = useCallback((text: string) => onChange(taskId, text), [onChange, taskId]);
  return (
    <Field label={label} error={error}>
      <FormTextInput
        size={size}
        testID={`goal-recover-task-${taskId}`}
        accessibilityLabel={label}
        initialValue={initialValue}
        onChangeText={handleChange}
        multiline
        numberOfLines={2}
        textAlignVertical="top"
      />
    </Field>
  );
}

function TimeModeField({
  choice,
  remainingMs,
  noneLeft,
  size,
  onChange,
}: {
  choice: TimeChoice;
  remainingMs: number | null;
  noneLeft: boolean;
  size: "sm" | "md";
  onChange: (choice: TimeChoice) => void;
}): ReactElement {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<TimeChoice>[]>(() => {
    const remainingLabel =
      remainingMs !== null && remainingMs > 0
        ? t("goals.detail.retryTimeRemainingLeft", {
            time: formatDuration(
              Math.max(MINUTE_MS, Math.floor(remainingMs / MINUTE_MS) * MINUTE_MS),
            ),
          })
        : t("goals.detail.retryTimeRemaining");
    return [
      {
        value: "fresh",
        label: t("goals.detail.retryTimeFresh"),
        testID: "goal-recover-time-fresh",
      },
      {
        value: "remaining",
        label: remainingLabel,
        disabled: noneLeft,
        testID: "goal-recover-time-remaining",
      },
    ];
  }, [noneLeft, remainingMs, t]);
  return (
    <Field
      label={t("goals.recovery.timeLabel")}
      hint={noneLeft ? t("goals.detail.retryTimeNoneLeft") : t("goals.recovery.timeHint")}
    >
      <SegmentedControl
        options={options}
        value={choice}
        onValueChange={onChange}
        size={size}
        testID="goal-recover-time"
      />
    </Field>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[4],
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  input: {
    minHeight: 96,
  },
  warning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  error: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.sm,
  },
}));
