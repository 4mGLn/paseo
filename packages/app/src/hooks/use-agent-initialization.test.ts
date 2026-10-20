import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionStore, useSessionStore } from "@/stores/session-store";
import { TIMELINE_FETCH_PAGE_SIZE } from "@/timeline/timeline-fetch-policy";
import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { getInitDeferred, getInitKey, resolveInitDeferred } from "@/utils/agent-initialization";
import {
  createSetAgentInitializing,
  ensureAgentIsInitialized,
  refreshAgentInitializationTimeout,
  refreshAgent,
} from "./use-agent-initialization";

const serverId = "server-1";
const agentId = "agent-1";

class FakeDaemonClient {
  readonly refreshedAgentIds: string[] = [];

  async refreshAgent(requestedAgentId: string): Promise<void> {
    this.refreshedAgentIds.push(requestedAgentId);
  }
}

class FakeTimelineRuntime {
  readonly requests: Array<{
    serverId: string;
    agentId: string;
    request: Parameters<HostRuntimeStore["fetchAgentTimeline"]>[2];
  }> = [];

  fetchAgentTimeline: HostRuntimeStore["fetchAgentTimeline"] = async (
    requestedServerId,
    requestedAgentId,
    request,
  ) => {
    this.requests.push({ serverId: requestedServerId, agentId: requestedAgentId, request });
    return undefined as never;
  };
}

function bindSetAgentInitializing() {
  return createSetAgentInitializing(serverId, useSessionStore.getState().setInitializingAgents);
}

afterEach(() => {
  resolveInitDeferred(getInitKey(serverId, agentId));
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  vi.restoreAllMocks();
});

describe("ensureAgentIsInitialized", () => {
  it("catches up after loaded authoritative history", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);
    useSessionStore
      .getState()
      .setAgentTimelineCursor(
        serverId,
        new Map([[agentId, { epoch: "epoch-1", startSeq: 1, endSeq: 42 }]]),
      );
    useSessionStore.getState().setAgentAuthoritativeHistoryApplied(serverId, agentId, true);

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "after",
          cursor: { epoch: "epoch-1", seq: 42 },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("after");
  });

  it("requests a bounded projected tail when no authoritative cursor is available", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("tail");
  });

  it("requests a bounded projected tail after restoring painted replica items", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, null);
    useSessionStore.getState().applyAgentTimelineResponseState(serverId, agentId, {
      items: [
        {
          kind: "assistant_message",
          id: "painted-item",
          text: "Painted before hydration",
          timestamp: new Date("2026-07-27T10:00:00.000Z"),
        },
      ],
      head: [],
      range: null,
      older: "none",
      newer: false,
      synchronized: false,
      acknowledgedClientMessageIds: [],
    });

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
  });

  it("catches up after the restored canonical replica range", () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, null);
    useSessionStore.getState().applyAgentTimelineResponseState(serverId, agentId, {
      items: [
        {
          kind: "assistant_message",
          id: "canonical-item",
          text: "Canonical before restart",
          timelineCursor: { epoch: "epoch-1", seq: 12 },
          timestamp: new Date("2026-07-27T10:00:00.000Z"),
        },
      ],
      head: [],
      range: { epoch: "epoch-1", startSeq: 10, endSeq: 12 },
      older: "available",
      newer: false,
      synchronized: true,
      acknowledgedClientMessageIds: [],
    });

    void ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "after",
          cursor: { epoch: "epoch-1", seq: 12 },
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
    expect(getInitDeferred(getInitKey(serverId, agentId))?.requestDirection).toBe("after");
  });

  it("times out initialization after 65 seconds", async () => {
    vi.useFakeTimers();
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    const promise = ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    vi.advanceTimersByTime(64_999);
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeDefined();

    vi.advanceTimersByTime(1);

    await expect(promise).rejects.toThrow("History sync timed out after 65s");
    expect(getInitDeferred(getInitKey(serverId, agentId))).toBeUndefined();
    expect(useSessionStore.getState().sessions[serverId]?.initializingAgents.get(agentId)).toBe(
      false,
    );
    vi.useRealTimers();
  });

  it("refreshes the initialization timeout after paged catch-up progress", async () => {
    vi.useFakeTimers();
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);
    const setAgentInitializing = bindSetAgentInitializing();
    const key = getInitKey(serverId, agentId);

    const promise = ensureAgentIsInitialized({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing,
    });

    vi.advanceTimersByTime(64_999);
    refreshAgentInitializationTimeout({ key, agentId, setAgentInitializing });

    vi.advanceTimersByTime(1);
    expect(getInitDeferred(key)).toBeDefined();

    const rejection = expect(promise).rejects.toThrow("History sync timed out after 65s");

    vi.advanceTimersByTime(64_998);
    expect(getInitDeferred(key)).toBeDefined();

    vi.advanceTimersByTime(1);

    await rejection;
    expect(getInitDeferred(key)).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("refreshAgent", () => {
  it("fetches a bounded projected tail after refreshing the agent", async () => {
    const client = new FakeDaemonClient();
    const runtime = new FakeTimelineRuntime();
    useSessionStore.getState().initializeSession(serverId, client as never);

    await refreshAgent({
      serverId,
      agentId,
      client: client as never,
      runtime,
      setAgentInitializing: bindSetAgentInitializing(),
    });

    expect(client.refreshedAgentIds).toEqual([agentId]);
    expect(runtime.requests).toEqual([
      {
        serverId,
        agentId,
        request: {
          direction: "tail",
          limit: TIMELINE_FETCH_PAGE_SIZE,
          projection: "projected",
        },
      },
    ]);
  });
});

it.each(["complete", "fail"] as const)(
  "keeps routed initialization pending when direct initialization for the same address %s",
  async (outcome) => {
    const direct = createSessionStore();
    const routed = createSessionStore();
    for (const store of [direct, routed]) store.getState().initializeSession(serverId, null);
    const directRuntime = new FakeTimelineRuntime();
    const routedRuntime = new FakeTimelineRuntime();
    const client = new FakeDaemonClient();
    const start = (store: typeof direct, runtime: FakeTimelineRuntime) =>
      ensureAgentIsInitialized({
        store,
        serverId,
        agentId,
        client: client as never,
        runtime,
        setAgentInitializing: createSetAgentInitializing(
          serverId,
          store.getState().setInitializingAgents,
        ),
      });
    const directReady = start(direct, directRuntime);
    const routedReady = start(routed, routedRuntime);
    void directReady.catch(() => {});
    void routedReady.catch(() => {});
    try {
      expect(directReady).not.toBe(routedReady);
      const key = getInitKey(serverId, agentId);
      if (outcome === "complete") direct.initializations.resolveInitDeferred(key);
      else direct.initializations.rejectInitDeferred(key, new Error("Direct history failed"));
      await Promise.allSettled([directReady]);
      expect(routed.initializations.getInitDeferred(key)?.promise).toBe(routedReady);
      routed.initializations.resolveInitDeferred(key);
      await routedReady;
    } finally {
      direct.initializations.resolveInitDeferred(getInitKey(serverId, agentId));
      routed.initializations.resolveInitDeferred(getInitKey(serverId, agentId));
      resolveInitDeferred(getInitKey(serverId, agentId));
    }
  },
);
