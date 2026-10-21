import { describe, expect, test } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/agent-profile";

import { PersistedConfigSchema } from "../persisted-config.js";
import {
  AgentTeamNotFoundError,
  AgentTeamProfileNotFoundError,
  listResolvedAgentTeams,
  resolveAgentTeam,
  type AgentTeamsConfig,
} from "./agent-teams.js";

const researchProfile: AgentProfile = {
  id: "profile-research",
  name: "Gemini researcher",
  provider: "gemini-acp",
  model: "research-model",
  featureValues: { web: true },
};

const fullStack: AgentTeamsConfig = {
  "full-stack": {
    description: "Ship features end to end.",
    roles: {
      implementer: {
        description: "Writes the code.",
        provider: "codex",
        model: "impl-model",
        modeId: "full-access",
        isolation: "worktree",
      },
      reviewer: { description: "Reviews the diff.", provider: "claude", model: "review-model" },
      researcher: { description: "Reads docs and the web.", profile: "Gemini researcher" },
    },
  },
};

function parseTeams(teams: unknown) {
  return PersistedConfigSchema.safeParse({ daemon: { teams } });
}

describe("daemon.teams config", () => {
  test("accepts roles that name a provider or a profile", () => {
    const parsed = parseTeams(fullStack);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.daemon?.teams).toEqual(fullStack);
  });

  test("rejects a team without roles", () => {
    const parsed = parseTeams({ empty: { roles: {} } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      "A team needs at least one role",
    );
  });

  test("rejects a role that names both a profile and a provider, or neither", () => {
    for (const role of [
      { description: "x", profile: "p", provider: "codex" },
      { description: "x" },
    ]) {
      const parsed = parseTeams({ t: { roles: { r: role } } });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
        "A role names exactly one of profile or provider",
      );
    }
  });

  test("rejects model overrides on a profile role", () => {
    const parsed = parseTeams({
      t: { roles: { r: { description: "x", profile: "p", model: "m" } } },
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects unknown role keys", () => {
    const parsed = parseTeams({
      t: { roles: { r: { description: "x", provider: "codex", foo: 1 } } },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("resolveAgentTeam", () => {
  test("resolves profile roles to the profile's provider, model and features", () => {
    const team = resolveAgentTeam({
      teams: fullStack,
      agentProfiles: [researchProfile],
      name: "full-stack",
    });
    expect(team).toEqual({
      name: "full-stack",
      description: "Ship features end to end.",
      roles: [
        {
          name: "implementer",
          description: "Writes the code.",
          provider: "codex",
          model: "impl-model",
          modeId: "full-access",
          isolation: "worktree",
        },
        {
          name: "reviewer",
          description: "Reviews the diff.",
          provider: "claude",
          model: "review-model",
        },
        {
          name: "researcher",
          description: "Reads docs and the web.",
          provider: "gemini-acp",
          model: "research-model",
          featureValues: { web: true },
          profile: "Gemini researcher",
        },
      ],
    });
  });

  test("finds a profile by id as well as by name", () => {
    const team = resolveAgentTeam({
      teams: { t: { roles: { r: { description: "x", profile: "profile-research" } } } },
      agentProfiles: [researchProfile],
      name: "t",
    });
    expect(team.roles[0]?.provider).toBe("gemini-acp");
  });

  test("throws for an unknown team", () => {
    expect(() =>
      resolveAgentTeam({ teams: fullStack, agentProfiles: [researchProfile], name: "nope" }),
    ).toThrow(AgentTeamNotFoundError);
  });

  test("throws for a role whose profile is missing", () => {
    expect(() =>
      resolveAgentTeam({ teams: fullStack, agentProfiles: [], name: "full-stack" }),
    ).toThrow(
      new AgentTeamProfileNotFoundError("full-stack", "researcher", "Gemini researcher").message,
    );
  });
});

describe("listResolvedAgentTeams", () => {
  test("leaves out teams with a missing profile and reports why", () => {
    const listed = listResolvedAgentTeams({
      teams: {
        ...fullStack,
        solo: { roles: { worker: { description: "Does it.", provider: "claude" } } },
      },
      agentProfiles: [],
    });
    expect(listed.teams.map((team) => team.name)).toEqual(["solo"]);
    expect(listed.error).toBe(
      'Team "full-stack" role "researcher" references unknown agent profile "Gemini researcher"',
    );
  });

  test("returns no teams and no error when none are configured", () => {
    expect(listResolvedAgentTeams({ teams: undefined, agentProfiles: undefined })).toEqual({
      teams: [],
      error: null,
    });
  });
});
