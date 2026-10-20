import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { HostAuthorityProvider } from "./host-authority-provider";
import {
  getHostRuntimeStore,
  type HostAuthorityReference,
  type OwnedHostAuthorityBinding,
} from "./host-runtime";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColors = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The retained route owns its lease; destination identity never selects another origin. */
export function HostAuthorityRoute({
  reference,
  children,
  pending = <ThemedLoadingSpinner uniProps={spinnerColors} />,
}: {
  reference: HostAuthorityReference;
  children: ReactNode;
  pending?: ReactNode;
}) {
  const registry = getHostRuntimeStore();
  const { originServerId, serverId } = reference;
  useSyncExternalStore(
    (changed) => registry.subscribe(originServerId, changed),
    () => registry.getSnapshot(originServerId),
    () => registry.getSnapshot(originServerId),
  );
  const serverInfo = registry.getServerInfo(originServerId);
  const features = serverInfo?.features;
  // COMPAT(preFleetDirectRoutes): added in v0.12, remove after 2027-04-20.
  // Old direct hosts retain their existing shell/session owner. Owned SDK scopes still reject unsupported capability.
  const legacy =
    originServerId === serverId && serverInfo !== null && features?.hostSessionScopes !== true;
  const [lease, setLease] = useState<OwnedHostAuthorityBinding | null>(null);
  useEffect(() => {
    if (legacy) return;
    const owned = registry.acquireBinding({ originServerId, serverId });
    setLease(owned);
    return () => {
      void owned.release();
    };
  }, [legacy, originServerId, registry, serverId]);
  if (legacy) return children;
  if (
    !lease ||
    lease.binding.reference.originServerId !== originServerId ||
    lease.binding.reference.serverId !== serverId
  )
    return pending;
  return <HostAuthorityProvider binding={lease.binding}>{children}</HostAuthorityProvider>;
}
