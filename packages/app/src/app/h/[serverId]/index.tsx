import { useMemo } from "react";
import { HostAuthorityRoute } from "@/runtime/host-authority-route";
import {
  workspaceSelectionAuthority,
  type ActiveWorkspaceSelection,
} from "@/stores/last-workspace-selection";
import { Redirect, useLocalSearchParams } from "expo-router";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import {
  resolveHostIndexRoute,
  resolveWorkspaceSelectionStatus,
} from "@/navigation/host-runtime-bootstrap";
import { StartupSplashScreen } from "@/screens/startup-splash-screen";
import { useHasHydratedWorkspaces, useWorkspaceExists } from "@/stores/session-store-hooks";
import {
  useIsLastWorkspaceSelectionHydrated,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";

export default function HostIndexRoute() {
  const serverId = useHostRouteServerId();
  const remembered = useLastWorkspaceSelection();
  const { origin } = useLocalSearchParams<{ origin?: string }>();
  const selection = useMemo(
    () =>
      remembered?.serverId === serverId
        ? { ...remembered, ...(origin ? { authority: { originServerId: origin } } : {}) }
        : null,
    [remembered, serverId, origin],
  );
  if (!selection) return <HostIndexContent workspaceSelection={null} />;
  return (
    <HostAuthorityRoute reference={workspaceSelectionAuthority(selection)}>
      <HostIndexContent workspaceSelection={selection} />
    </HostAuthorityRoute>
  );
}

function HostIndexContent({
  workspaceSelection,
}: {
  workspaceSelection: ActiveWorkspaceSelection | null;
}) {
  const serverId = useHostRouteServerId();
  const isWorkspaceSelectionLoaded = useIsLastWorkspaceSelectionHydrated();
  const workspaceSelectionWorkspaceId = workspaceSelection?.workspaceId ?? null;
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(serverId);
  const workspaceSelectionExists = useWorkspaceExists(serverId, workspaceSelectionWorkspaceId);

  if (!serverId || !isWorkspaceSelectionLoaded) {
    return <StartupSplashScreen />;
  }

  return (
    <Redirect
      href={resolveHostIndexRoute({
        serverId,
        workspaceSelection,
        workspaceSelectionStatus: resolveWorkspaceSelectionStatus({
          hasHydratedWorkspaces,
          workspaceExists: workspaceSelectionExists,
        }),
      })}
    />
  );
}
