/** @vitest-environment jsdom */
import {
  createWorkspaceLayoutStore,
  useWorkspaceLayoutStoreApi,
} from "@/stores/workspace-layout-store";
import React, { act } from "react";
import { useHasHydratedWorkspaces } from "@/stores/session-store-hooks";
import {
  createProviderSubagentStore,
  useProviderSubagentStoreApi,
} from "@/subagents/provider-store";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { createSessionStore, useSessionStoreApi } from "@/stores/session-store";
import { useCreateFlowStoreApi } from "@/stores/create-flow-store";
import { HostRuntimeStore, useHostRuntimeStore, type HostAuthorityBinding } from "./host-runtime";
import { HostAuthorityProvider } from "./host-authority-provider";

it("ordinary consumer hooks retain the runtime, store and creation owner of each authority", async () => {
  const binding = (originServerId: string): HostAuthorityBinding => {
    const sessionStore = createSessionStore();
    return {
      reference: { originServerId, serverId: "B" },
      namespace: JSON.stringify(["host-authority-v1", originServerId, "B"]),
      sessionStore,
      queries: new QueryClient(),
      providerSubagents: createProviderSubagentStore(),
      layout: createWorkspaceLayoutStore(),
      runtime: new HostRuntimeStore({ sessionStore }),
      ready: Promise.resolve(),
    };
  };
  const direct = binding("B");
  const routed = binding("A");
  for (const owner of [direct, routed]) {
    owner.sessionStore.getState().initializeSession("B", null);
    owner.sessionStore.getState().setHasHydratedWorkspaces("B", owner === routed);
  }
  function OrdinaryConsumer({ expected }: { expected: HostAuthorityBinding }) {
    expect(useHasHydratedWorkspaces("B")).toBe(expected === routed);
    const runtime = useHostRuntimeStore();
    const store = useSessionStoreApi();
    const creates = useCreateFlowStoreApi();
    expect(useQueryClient()).toBe(expected.queries);
    expect(useProviderSubagentStoreApi()).toBe(expected.providerSubagents);
    expect(useWorkspaceLayoutStoreApi()).toBe(expected.layout);
    expect(runtime).toBe(expected.runtime);
    expect(store).toBe(expected.sessionStore);
    expect(creates).toBe(expected.sessionStore.createFlows);
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <>
          <HostAuthorityProvider binding={direct}>
            <OrdinaryConsumer expected={direct} />
          </HostAuthorityProvider>
          <HostAuthorityProvider binding={routed}>
            <OrdinaryConsumer expected={routed} />
          </HostAuthorityProvider>
        </>,
      ),
    );
  } finally {
    await act(async () => root.unmount());
  }
});
