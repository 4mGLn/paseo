import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { createSessionStore, useSessionStoreApi } from "@/stores/session-store";
import { useCreateFlowStoreApi } from "@/stores/create-flow-store";
import { HostRuntimeStore, useHostRuntimeStore, type HostAuthorityBinding } from "./host-runtime";
import { HostAuthorityProvider } from "./host-authority-provider";

it("ordinary consumer hooks retain the runtime, store and creation owner of each authority", () => {
  const binding = (originServerId: string): HostAuthorityBinding => {
    const sessionStore = createSessionStore();
    return {
      reference: { originServerId, serverId: "B" },
      namespace: JSON.stringify(["host-authority-v1", originServerId, "B"]),
      sessionStore,
      queries: new QueryClient(),
      runtime: new HostRuntimeStore({ sessionStore }),
      ready: Promise.resolve(),
    };
  };
  const direct = binding("B");
  const routed = binding("A");
  function OrdinaryConsumer({ expected }: { expected: HostAuthorityBinding }) {
    const runtime = useHostRuntimeStore();
    const store = useSessionStoreApi();
    const creates = useCreateFlowStoreApi();
    expect(useQueryClient()).toBe(expected.queries);
    expect(runtime).toBe(expected.runtime);
    expect(store).toBe(expected.sessionStore);
    expect(creates).toBe(expected.sessionStore.createFlows);
    return null;
  }
  renderToStaticMarkup(
    <>
      <HostAuthorityProvider binding={direct}>
        <OrdinaryConsumer expected={direct} />
      </HostAuthorityProvider>
      <HostAuthorityProvider binding={routed}>
        <OrdinaryConsumer expected={routed} />
      </HostAuthorityProvider>
    </>,
  );
});
