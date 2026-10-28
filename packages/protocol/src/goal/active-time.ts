import type { GoalEvent } from "./types.js";

/**
 * Milliseconds the goal ran, as of `untilMs`, since it was created or a retry last restarted
 * its time limit fresh. It runs from goal.created, a reopen or goal.resumed until it fails,
 * is paused, cancelled or completed; time paused or failed does not count. Planning and
 * waiting for plan approval count as running, as they do for the wall-clock limit timer.
 * An event whose time does not parse is skipped.
 */
export function goalActiveMs(events: readonly GoalEvent[], untilMs: number): number {
  let activeMs = 0;
  let since: number | null = null;
  let state: RunState = { ended: false, paused: false };
  for (const event of events) {
    const at = Date.parse(event.at);
    const next = Number.isNaN(at) ? null : stateAfter(event, state);
    if (!next) continue;
    const wasRunning = since !== null;
    const { fresh, ...nextState } = next;
    if (fresh) {
      activeMs = 0;
      // A goal still paused does not start running until it is resumed.
      if (wasRunning) since = at;
    }
    state = nextState;
    const running = !state.ended && !state.paused;
    if (wasRunning && !running && since !== null) {
      activeMs += Math.max(0, at - since);
      since = null;
    } else if (!wasRunning && running) {
      since = at;
    }
  }
  return since === null ? activeMs : activeMs + Math.max(0, untilMs - since);
}

interface RunState {
  ended: boolean;
  paused: boolean;
}

/** How an event changes whether the goal runs, or null when it does not. */
function stateAfter(event: GoalEvent, state: RunState): (RunState & { fresh?: boolean }) | null {
  switch (event.type) {
    case "goal.created":
      return { ...state, ended: false };
    case "goal.retried":
    case "goal.reopened":
    case "changeset.integration_retried":
      return { ...state, ended: false, fresh: event.timeMode === "fresh" };
    // The goal stays failed while a recovery decides; it runs again once the recovery applies.
    case "recovery.resolved":
      return event.outcome === "applied"
        ? { ...state, ended: false, fresh: event.timeMode === "fresh" }
        : null;
    case "goal.resumed":
      return { ...state, paused: false };
    case "goal.paused":
      return { ...state, paused: true };
    case "goal.failed":
    case "goal.cancelled":
    case "goal.completed":
      return { ...state, ended: true };
    default:
      return null;
  }
}
