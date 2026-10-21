# Agent teams

A team is a named set of roles, each mapped to a provider and model. Start a chat with a team and the chat agent is told its roster: which role does what, and the exact `create_agent` parameters for each. It then delegates by role with the `create_agent` and `wait_for_agent` tools it already has. There is no separate orchestration pipeline.

Use a team when you keep telling a chat "use Codex for the code and Claude for the review". Use [Goals](goals.md) when you need guaranteed review, verification, or merge steps.

## Configure

Teams live in the daemon config file under `daemon.teams`. There is no editor in the app. Edit `$PASEO_HOME/config.json` and restart the daemon; teams are read at startup and `paseo reload` does not apply them.

```json
{
  "daemon": {
    "agentProfiles": [
      {
        "id": "gemini-research",
        "name": "Gemini researcher",
        "provider": "gemini",
        "notes": "Research and documentation lookups."
      }
    ],
    "teams": {
      "full-stack": {
        "description": "Ship features end to end.",
        "roles": {
          "implementer": {
            "description": "Writes the code and the tests.",
            "provider": "codex",
            "model": "gpt-5.4",
            "modeId": "full-access",
            "isolation": "worktree"
          },
          "reviewer": {
            "description": "Reviews the implementer's diff for bugs.",
            "provider": "claude",
            "model": "opus"
          },
          "researcher": {
            "description": "Reads docs and the web before a design decision.",
            "profile": "Gemini researcher"
          }
        }
      }
    }
  }
}
```

A role names exactly one of:

- `profile` — an [agent profile](glossary.md) id or name. The role uses the profile's provider, model, mode, thinking option and features. `gemini` above is an ACP provider configured as in [custom-providers.md](custom-providers.md#example-google-gemini-cli).
- `provider` — a provider id, with optional `model`, `modeId` and `thinkingOptionId`.

`description` is required; it is what the chat agent reads to pick a role. `isolation: "worktree"` tells the chat to create a worktree workspace before starting that helper; `"local"` keeps the helper in the chat's workspace.

The config schema rejects a team without roles and a role with both or neither of `profile` and `provider`. A role that names a profile that does not exist does not fail the config load, because agent profiles are edited at runtime: the daemon logs a warning at startup, `agent.teams.list` leaves that team out and reports it in `error`, and creating a chat with that team fails.

## Use

- App: the **Team** selector next to the agent controls in a new chat. It shows only when the host advertises `server_info.features.agentTeams` and defines at least one team.
- CLI: `paseo agent teams` lists teams and roles; `paseo run --team <name> "<prompt>"` starts a team chat.
- Client: `DaemonClient.listAgentTeams()` and `createAgent({ team })`.

An unknown team fails creation and no agent is created.

## How the roster reaches the agent

The daemon resolves the team when the chat is created, appends the roster to the agent's creation-time system prompt (`AgentSessionConfig.systemPrompt`), and labels the agent `paseo.team=<name>`. The system prompt is persisted with the agent, so the roster survives resume and daemon restarts, and the user's first message is unchanged. The roster builder is `packages/server/src/server/agent/agent-team-roster.ts`.

The roster is frozen at creation. Editing the team later does not change chats that already exist.

## Limits

- The chat agent decides when and whether to delegate. A team adds instructions, not enforcement.
- There is no review, verification or merge guarantee. The chat is told it stays responsible for checking and integrating helper results. Use [Goals](goals.md) for enforced gates.
- Helpers a team chat creates do not inherit the team, its roster or its label.
- Providers that ignore `systemPrompt` (ACP providers and Copilot) never see the roster. Lead a team with a provider that supports it, such as Claude, Codex, OpenCode or Pi. ACP providers work as roles.
- A helper on a different provider than the chat needs an explicit `settings.modeId`; the roster tells the chat so. Set `modeId` on roles to avoid the extra lookup.
