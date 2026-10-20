import { useSyncExternalStore } from "react";
import { SessionProvider } from "@/contexts/session-context";
import { WorkspaceLayoutModePublisher } from "@/workspace-tabs/layout-mode-publisher";
import { HostAuthorityProvider } from "./host-authority-provider";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  type HostAuthorityBinding,
} from "./host-runtime";

/** One ordinary session adapter per runtime-owned binding, shared by all retained screens. */
export function HostAuthoritySessions() {
  const registry = getHostRuntimeStore();
  const bindings = useSyncExternalStore(
    (changed) => registry.subscribeAll(changed),
    registry.getAuthorityBindings,
    registry.getAuthorityBindings,
  );
  return bindings.map((binding) => (
    <HostAuthorityProvider key={binding.namespace} binding={binding}>
      <WorkspaceLayoutModePublisher />
      <AuthoritySession binding={binding} />
    </HostAuthorityProvider>
  ));
}

function AuthoritySession({ binding }: { binding: HostAuthorityBinding }) {
  const client = useHostRuntimeClient(binding.reference.serverId);
  if (!client) return null;
  return (
    <SessionProvider serverId={binding.reference.serverId} client={client}>
      {null}
    </SessionProvider>
  );
}
