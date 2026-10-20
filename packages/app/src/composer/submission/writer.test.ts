import { afterEach, expect, test } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createSessionStore, useSessionStore } from "@/stores/session-store";
import type { UserMessageItem } from "@/types/stream";
import { createMessageSubmissionWriter } from "./writer";

const CANONICAL_ONLY_SERVER_ID = "canonical-only";

function submittedMessage(clientMessageId: string): UserMessageItem {
  return {
    kind: "user_message",
    id: clientMessageId,
    clientMessageId,
    text: "hello",
    timestamp: new Date("2026-07-31T10:00:00.000Z"),
  };
}

function initializeSession(serverId: string, features: Record<string, boolean>): void {
  const store = useSessionStore.getState();
  store.initializeSession(serverId, null as unknown as DaemonClient);
  store.updateSessionServerInfo(serverId, {
    serverId,
    hostname: null,
    version: "0.2.6",
    features,
  });
}

function submissionIds(serverId: string): string[] {
  return (
    useSessionStore.getState().sessions[serverId]?.messageSubmissions.get("agent-1") ?? []
  ).map((submission) => submission.clientMessageId);
}

afterEach(() => {
  useSessionStore.getState().clearSession(CANONICAL_ONLY_SERVER_ID);
});

test("tracks submissions when canonical prompts are supported", () => {
  initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: true });

  createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID, useSessionStore).begin(
    "agent-1",
    submittedMessage("canonical-only-message"),
  );

  expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual(["canonical-only-message"]);
});

test.each([true, false])(
  "writes and rejects only in its captured authority store (tracked=%s)",
  (tracked) => {
    initializeSession(CANONICAL_ONLY_SERVER_ID, { canonicalSubmittedPrompts: tracked });
    const scoped = createSessionStore();
    scoped.getState().initializeSession(CANONICAL_ONLY_SERVER_ID, null);
    scoped.getState().updateSessionServerInfo(CANONICAL_ONLY_SERVER_ID, {
      serverId: CANONICAL_ONLY_SERVER_ID,
      hostname: null,
      version: "0.12.0",
      features: { canonicalSubmittedPrompts: tracked },
    });
    const writer = createMessageSubmissionWriter(CANONICAL_ONLY_SERVER_ID, scoped);
    writer.begin("agent-1", submittedMessage("scoped-message"));
    const session = scoped.getState().sessions[CANONICAL_ONLY_SERVER_ID];
    if (tracked)
      expect(
        session.messageSubmissions.get("agent-1")?.map((submission) => submission.clientMessageId),
      ).toEqual(["scoped-message"]);
    else
      expect(
        session.agentStreamTail
          .get("agent-1")
          ?.map((item) => (item.kind === "user_message" ? item.clientMessageId : null)),
      ).toEqual(["scoped-message"]);
    expect(submissionIds(CANONICAL_ONLY_SERVER_ID)).toEqual([]);
    expect(
      useSessionStore
        .getState()
        .sessions[CANONICAL_ONLY_SERVER_ID]?.agentStreamTail.get("agent-1") ?? [],
    ).toEqual([]);
    expect(writer.reject("agent-1", "scoped-message")).toBe("rejected");
  },
);
