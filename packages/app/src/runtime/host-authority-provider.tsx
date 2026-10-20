import { WorkspaceLayoutStoreContext } from "@/stores/workspace-layout-store";
import { ProviderSubagentStoreContext } from "@/subagents/provider-store";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { SessionStoreContext } from "@/stores/session-store";
import { CreateFlowStoreContext } from "@/stores/create-flow-store";
import { HostRuntimeContext, type HostAuthorityBinding } from "./host-runtime";

/** The retained screen owns acquisition/release; descendants receive one bound capability. */
export function HostAuthorityProvider({
  binding,
  children,
}: {
  binding: HostAuthorityBinding;
  children: ReactNode;
}) {
  return (
    <QueryClientProvider client={binding.queries}>
      <ProviderSubagentStoreContext.Provider value={binding.providerSubagents}>
        <HostRuntimeContext.Provider value={binding.runtime}>
          <SessionStoreContext.Provider value={binding.sessionStore}>
            <CreateFlowStoreContext.Provider value={binding.sessionStore.createFlows}>
              <WorkspaceLayoutStoreContext.Provider value={binding.layout}>
                {children}
              </WorkspaceLayoutStoreContext.Provider>
            </CreateFlowStoreContext.Provider>
          </SessionStoreContext.Provider>
        </HostRuntimeContext.Provider>
      </ProviderSubagentStoreContext.Provider>
    </QueryClientProvider>
  );
}
