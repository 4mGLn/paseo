import type { ReactElement } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

export type GoalBarTone = "neutral" | "success" | "warning" | "danger";

/**
 * A thin horizontal bar: a fill from `offset` across `fraction` of the track. Used for overall
 * progress, budgets and the per-task timeline.
 */
export function GoalBar({
  fraction,
  offset = 0,
  tone = "neutral",
  testID,
}: {
  fraction: number;
  offset?: number;
  tone?: GoalBarTone;
  testID?: string;
}): ReactElement {
  const width = `${Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 10}%` as const;
  const left = `${Math.round(Math.min(1, Math.max(0, offset)) * 1000) / 10}%` as const;
  return (
    <View style={styles.track} testID={testID}>
      <View
        style={[
          styles.fill,
          tone === "success" && styles.fillSuccess,
          tone === "warning" && styles.fillWarning,
          tone === "danger" && styles.fillDanger,
          inlineUnistylesStyle({ width, left }),
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  track: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  fill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
  },
  fillSuccess: {
    backgroundColor: theme.colors.statusSuccess,
  },
  fillWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  fillDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
}));
