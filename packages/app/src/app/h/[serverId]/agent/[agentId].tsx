import { HostAuthorityRoute } from "@/runtime/host-authority-route";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useFetchQuery } from "@/data/query";
import { resolveAgentRoute, type AgentRouteLookup } from "@/navigation/agent-route-resolution";
import { AgentRouteResolutionView } from "@/navigation/agent-route-resolution-view";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeStore, useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import {
  buildHostRootRoute,
  buildSettingsHostRoute,
  withHostRouteAuthority,
} from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export default function HostAgentReadyRoute() {
  const { serverId, origin } = useLocalSearchParams<{ serverId?: string; origin?: string }>();
  const reference = useMemo(
    () => ({ originServerId: origin ?? serverId ?? "", serverId: serverId ?? "" }),
    [origin, serverId],
  );
  if (!serverId) return null;
  return (
    <HostRouteBootstrapBoundary>
      <HostAuthorityRoute reference={reference}>
        <HostAgentReadyRouteContent />
      </HostAuthorityRoute>
    </HostRouteBootstrapBoundary>
  );
}

function HostAgentReadyRouteContent() {
  const router = useRouter();
  const runtime = useHostRuntimeStore();
  const params = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
  }>();
  const handledNavigationRef = useRef<string | null>(null);
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : "";
  const hosts = useHosts();
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const client = runtimeSnapshot?.client ?? null;
  const connectionStatus = runtimeSnapshot?.connectionStatus ?? "connecting";
  const hostName = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const agentWorkspaceId = useSessionStore((state) => {
    if (!serverId || !agentId) {
      return null;
    }
    return state.sessions[serverId]?.agents?.get(agentId)?.workspaceId ?? null;
  });
  useEffect(() => {
    if (!serverId || !agentId || agentWorkspaceId) return;
    void runtime.prepareAgentRoute(serverId, agentId).catch(() => undefined);
  }, [agentId, agentWorkspaceId, serverId, runtime]);
  const shouldLookupAgent = Boolean(
    serverId && agentId && client && connectionStatus === "online" && !agentWorkspaceId,
  );
  const lookupQuery = useFetchQuery({
    queryKey: ["agentRouteResolution", serverId, agentId, runtimeSnapshot?.clientGeneration ?? 0],
    queryFn: async () => {
      if (!client) {
        throw new Error("Target host client is unavailable");
      }
      const result = await client.fetchAgent({ agentId });
      return result?.agent?.workspaceId ?? null;
    },
    enabled: shouldLookupAgent,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });
  const lookup = useMemo<AgentRouteLookup>(() => {
    if (!shouldLookupAgent) {
      return { kind: "idle" };
    }
    if (lookupQuery.isFetching) {
      return { kind: "fetching" };
    }
    if (lookupQuery.isError) {
      return { kind: "failed", error: toErrorMessage(lookupQuery.error) };
    }
    if (lookupQuery.isSuccess) {
      return { kind: "found", workspaceId: lookupQuery.data };
    }
    return { kind: "fetching" };
  }, [
    lookupQuery.data,
    lookupQuery.error,
    lookupQuery.isError,
    lookupQuery.isFetching,
    lookupQuery.isSuccess,
    shouldLookupAgent,
  ]);
  const resolution = resolveAgentRoute({
    serverId,
    agentId,
    cachedWorkspaceId: agentWorkspaceId,
    connectionStatus,
    lookup,
  });

  useEffect(() => {
    let navigationKey: string | null = null;
    if (resolution.kind === "invalid") {
      navigationKey = "invalid";
    } else if (resolution.kind === "resolved") {
      navigationKey = `workspace:${resolution.workspaceId}`;
    } else if (resolution.kind === "notFound") {
      navigationKey = "not-found";
    }
    if (!navigationKey || handledNavigationRef.current === navigationKey) {
      return;
    }
    handledNavigationRef.current = navigationKey;

    if (resolution.kind === "resolved") {
      navigateToAgent({
        serverId,
        agentId,
        workspaceId: resolution.workspaceId,
        authority: runtime.authorityFor(serverId),
      });
      return;
    }
    router.replace(
      resolution.kind === "invalid"
        ? ("/" as Href)
        : (withHostRouteAuthority(
            buildHostRootRoute(serverId),
            runtime.authorityFor(serverId),
          ) as Href),
    );
  }, [agentId, resolution, router, serverId, runtime]);

  const handleRetry = useCallback(() => {
    if (resolution.kind === "lookupError") {
      void lookupQuery.refetch();
      return;
    }
    if (serverId) {
      void runtime.runProbeCycleNow(serverId);
    }
  }, [lookupQuery, resolution.kind, serverId, runtime]);
  const handleManageHost = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostRoute(runtime.authorityFor(serverId).originServerId));
    }
  }, [router, serverId, runtime]);
  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(
      serverId
        ? (withHostRouteAuthority(
            buildHostRootRoute(serverId),
            runtime.authorityFor(serverId),
          ) as Href)
        : ("/" as Href),
    );
  }, [router, serverId, runtime]);

  if (
    resolution.kind === "waitingForHost" ||
    resolution.kind === "fetchingAgent" ||
    resolution.kind === "lookupError"
  ) {
    // Agent URLs intentionally omit workspaceId. Keep this route mounted while the target host
    // reconnects, then resolve the workspace from the authoritative agent record.
    return (
      <AgentRouteResolutionView
        resolution={resolution}
        hostName={hostName}
        lastHostError={runtimeSnapshot?.lastError ?? null}
        onRetry={handleRetry}
        onManageHost={handleManageHost}
        onBack={handleBack}
      />
    );
  }

  return null;
}
