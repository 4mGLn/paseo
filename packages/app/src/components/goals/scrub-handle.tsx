import { useMemo, useRef, type ReactElement } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import {
  SCRUB_ACTIVE_OFFSET_X,
  SCRUB_FAIL_OFFSET_Y,
  type ScrubHandleProps,
} from "./scrub-handle.types";

/**
 * Native: a horizontal pan on the handle only. A mostly vertical move fails the pan, so the
 * sheet's scroll view keeps vertical drags that start on the handle.
 */
export function ScrubHandle(props: ScrubHandleProps): ReactElement {
  const callbacks = useRef(props);
  callbacks.current = props;
  const { disabled } = props;

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled)
        .runOnJS(true)
        .activeOffsetX([-SCRUB_ACTIVE_OFFSET_X, SCRUB_ACTIVE_OFFSET_X])
        .failOffsetY([-SCRUB_FAIL_OFFSET_Y, SCRUB_FAIL_OFFSET_Y])
        .onStart(() => callbacks.current.onScrubStart())
        .onUpdate((event) => callbacks.current.onScrubMove(event.translationX, false))
        .onFinalize(() => callbacks.current.onScrubEnd()),
    [disabled],
  );
  const accessibilityValue = useMemo(
    () => ({ text: props.accessibilityValueText }),
    [props.accessibilityValueText],
  );
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);

  return (
    <GestureDetector gesture={gesture}>
      <View
        collapsable={false}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityValue={accessibilityValue}
        accessibilityState={accessibilityState}
        accessibilityActions={props.accessibilityActions}
        onAccessibilityAction={props.onAccessibilityAction}
        style={props.style}
        testID={props.testID}
      >
        {props.children}
      </View>
    </GestureDetector>
  );
}
