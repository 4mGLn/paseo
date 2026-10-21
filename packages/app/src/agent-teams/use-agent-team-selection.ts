import { useCallback, useMemo } from "react";
import type { AgentTeamSummary } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { rememberSelectedTeam, resolveSelectedTeam } from "./team-selection";

export interface AgentTeamSelection {
  teams: AgentTeamSummary[];
  selectedTeam: string | null;
  onSelectTeam: (team: string | null) => void;
}

const EMPTY_TEAMS: AgentTeamSummary[] = [];

/**
 * Teams defined on the host and the remembered choice for it. Returns no teams
 * when the host predates `features.agentTeams`, so the selector stays hidden.
 */
export function useAgentTeamSelection(serverId: string | null): AgentTeamSelection {
  const normalizedServerId = serverId ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const supported = useHostFeature(serverId, "agentTeams");
  const { preferences, updatePreferences } = useFormPreferences();
  const query = useFetchQuery<AgentTeamSummary[], Error>({
    queryKey: ["host", normalizedServerId, "agent-teams"],
    queryFn: async () => {
      if (!client) return EMPTY_TEAMS;
      return (await client.listAgentTeams()).teams;
    },
    enabled: supported && client !== null,
    retry: false,
    dataShape: "value",
    staleTimeMs: 60_000,
  });
  const teams = supported ? (query.data ?? EMPTY_TEAMS) : EMPTY_TEAMS;
  const teamNames = useMemo(() => teams.map((team) => team.name), [teams]);
  const selectedTeam = resolveSelectedTeam({ preferences, serverId, teamNames });
  const onSelectTeam = useCallback(
    (team: string | null) => {
      if (!serverId) return;
      void updatePreferences((current) =>
        rememberSelectedTeam({ preferences: current, serverId, team }),
      ).catch((error) => {
        console.warn("[AgentTeamSelection] persist team preference failed", error);
      });
    },
    [serverId, updatePreferences],
  );
  return useMemo(
    () => ({ teams, selectedTeam, onSelectTeam }),
    [teams, selectedTeam, onSelectTeam],
  );
}
