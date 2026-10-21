import type { FormPreferences } from "@/create-agent-preferences/preferences";

/**
 * The remembered team for a host, or null when none is remembered or the host
 * no longer defines it. Teams are per host, so the preference is keyed by server.
 */
export function resolveSelectedTeam(input: {
  preferences: FormPreferences;
  serverId: string | null;
  teamNames: readonly string[];
}): string | null {
  if (!input.serverId) return null;
  const remembered = input.preferences.teamByServer?.[input.serverId];
  return remembered && input.teamNames.includes(remembered) ? remembered : null;
}

/** Remembers `team` for the host; null forgets it ("None"). */
export function rememberSelectedTeam(input: {
  preferences: FormPreferences;
  serverId: string;
  team: string | null;
}): FormPreferences {
  const { [input.serverId]: _previous, ...others } = input.preferences.teamByServer ?? {};
  const teamByServer = input.team ? { ...others, [input.serverId]: input.team } : others;
  const next: FormPreferences = { ...input.preferences, teamByServer };
  if (Object.keys(teamByServer).length === 0) delete next.teamByServer;
  return next;
}
