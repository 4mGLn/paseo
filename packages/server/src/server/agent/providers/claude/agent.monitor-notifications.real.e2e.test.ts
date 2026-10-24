import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pino from "pino";

import type { AgentStreamEvent, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import { ClaudeAgentClient } from "./agent.js";

function notifications(events: AgentStreamEvent[]): ToolCallTimelineItem[] {
  return events.flatMap((event) =>
    event.type === "timeline" &&
    event.item.type === "tool_call" &&
    event.item.name === "task_notification"
      ? [event.item]
      : [],
  );
}

test("shows all four Monitor events live as well as after reopening the session", async () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-monitor-notifications-"));
  const client = new ClaudeAgentClient({ logger: pino({ level: "silent" }) });
  const session = await client.createSession({
    provider: "claude",
    cwd,
    modeId: "bypassPermissions",
    model: "haiku",
  });
  const live: AgentStreamEvent[] = [];
  let resolveEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });
  const unsubscribe = session.subscribe((event) => {
    live.push(event);
    if (
      event.type === "timeline" &&
      event.item.type === "tool_call" &&
      event.item.name === "task_notification" &&
      event.item.detail?.type === "plain_text" &&
      event.item.detail.label.includes("stream ended")
    )
      resolveEnded();
  });
  try {
    await session.startTurn(
      "Use the Monitor tool to run exactly this command: for i in 1 2 3 4; do echo monitor-event-$i; sleep 2; done. " +
        "Do not substitute Bash or another tool. Wait for all four events and the stream-ended notification, then reply DONE.",
    );
    await ended;
    const handle = session.describePersistence();
    expect(handle).not.toBeNull();
    await session.close();
    const restored = await client.resumeSession(handle!, { cwd });
    const history: AgentStreamEvent[] = [];
    try {
      for await (const event of restored.streamHistory()) history.push(event);
    } finally {
      await restored.close();
    }
    const restoredIds = new Set(notifications(history).map((item) => item.callId));
    expect(restoredIds.size, "four Monitor events and stream completion in history").toBe(5);
    expect(
      new Set(notifications(live).map((item) => item.callId)).size,
      "four Monitor events and stream completion live",
    ).toBe(5);
  } finally {
    unsubscribe();
    await session.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 90_000);
