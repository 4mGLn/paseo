# Goal orchestration: reconnaissance and decisions

Source-backed map for adding Goals, a Manager, and a Lead Agent to this fork. Base commit `068f272a0` (`getpaseo/paseo`, Apache-2.0). Paths below are relative to `packages/server/src/server` (`S/`) unless they start with `packages/`. Line numbers are at the base commit and will drift.

All items were verified against source at the base commit.

## Fork constraints

- `LICENSE` is Apache-2.0 with a third-party carve-out. Modification and redistribution are allowed.
- `CONTRIBUTING.md` closes PRs by default, asks for under about 3,000 lines of production code, and routes specialized workflows to plugins. This work will not go upstream as one change. Treat it as a long-lived fork and keep the diff isolated to ease rebasing.
- `docs/product.md` prefers a lean core and plugins for specialized workflows. The decision between core and plugin is open (see below).

## What already exists

| Need                                        | Existing piece                                                                                                          | Location                                                                                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Create an agent on any provider             | `AgentManager.createAgent`                                                                                              | `S/agent/agent-manager.ts:1271`                                                                            |
| Pick a provider per task                    | `AgentSessionConfig.provider`, `buildProviderRegistry`                                                                  | `S/agent/agent-sdk-types.ts` (~:590), `S/agent/provider-registry.ts:907`                                   |
| Drive an agent without a client             | `runAgent`, `waitForAgentEvent`, `waitForAgentClose`                                                                    | `agent-manager.ts:2416`, `:3392`, `:1211`                                                                  |
| Observe turn end and permission requests    | `AgentManager.subscribe`, `AgentStreamEvent` (`turn_completed`, `turn_failed`, `turn_canceled`, `permission_requested`) | `agent-manager.ts:969`; `agent-sdk-types.ts:408-442`                                                       |
| Parent/child agents                         | `paseo.parent-agent-id` label (`PARENT_AGENT_ID_LABEL`)                                                                 | `agent-manager.ts:17`                                                                                      |
| Lead Agent tools                            | MCP catalog: `create_agent`, `send_agent_prompt`, `get_agent_status`, `cancel_agent`, `respond_to_permission`           | `S/agent/tools/paseo-tools.ts:1544`, `:1975`, `:2079`, `:2198`                                             |
| Answer permission requests                  | `respondToAgentPermission`                                                                                              | `S/agent/permission-response.ts`                                                                           |
| Isolated worktree workspace                 | `createPaseoWorktreeWithPriority`, `createWorkspaceForWorktree`                                                         | `S/paseo-worktree-service.ts:73`; `S/session/workspace-provisioning/workspace-provisioning-service.ts:272` |
| Worktree primitives and base-ref resolution | `createWorktree`, `resolveBaseBranchForWorktree`, `deletePaseoWorktree`                                                 | `S/utils/worktree.ts:1220`, `:1686`, `:1079`                                                               |
| Safe workspace removal                      | `workspace-archive-service` (only for `isPaseoOwnedWorktree`)                                                           | `S/workspace-archive-service.ts:357`, `:403`                                                               |
| Commit, diff, merge                         | `commitChanges`, `getCheckoutDiff`, `mergeToBase`, `mergeFromBase`                                                      | `S/utils/checkout-git.ts:3603`, `:3487`, `:3747`, `:3819`                                                  |
| Durable service template                    | `ScheduleService`, `ScheduleStore`, `recoverInterruptedRuns`                                                            | `S/schedule/service.ts:268`, `:604`; `S/schedule/store.ts:103`                                             |
| Atomic JSON writes                          | `writeJsonFileAtomic`, `FileBackedRegistry.mutateCache`                                                                 | `S/atomic-file.ts:23`; `S/workspace-registry.ts:180`, `:320`                                               |
| Idempotent external step                    | `MessageReceipts` (fingerprint, pending/completed)                                                                      | `S/message-receipts/index.ts:21`                                                                           |
| Authorization                               | Operation permission table, enforced per message                                                                        | `S/authorization/operation-permissions.ts`; `S/authorization/index.ts:33`                                  |

## What does not exist

- **No Goal, Task, Change Set, or Agent Run entity.** `pi-goal-x` is a Pi provider extension, not core.
- **No durable event log.** Timeline `seq` is in memory (`S/agent/agent-timeline-store.ts:45`). `MessageReceipts` is per-request idempotency, not an ordered log. `VersionedValue` in `S/directory-sync/internal/versioned-collection.ts` is for snapshot sync.
- **No conflict dry run, rebase, cherry-pick, or patch-apply helper.** Conflict detection matches stderr strings (`S/utils/checkout-git.ts` ~:3726, ~:3908). Phase 3 needs `git merge-tree` or a throwaway worktree.
- **No push events for list-style features.** Schedules poll every 5 seconds (`packages/app/src/hooks/use-schedules.ts:33`). A Goal progress view needs outbound events.
- **Agent wait.** `wait_for_agent` (added after the goal phases) lets a chat agent block on one of its own subagents; before it, callers polled `get_agent_status` or `get_agent_activity`.
- **`loop/*` is a stub.** Schemas and permission entries exist (`packages/protocol/src/loop/rpc-schemas.ts`, `S/authorization/operation-permissions.ts:117-121`), but there is no handler, client method, or UI. Decide whether to remove it before adding Goal RPCs with similar meaning.

## Extension points

1. **New RPC pair.** Use schedules as the file checklist, with the corrections below.
   - Schema: `packages/protocol/src/<domain>/rpc-schemas.ts`.
   - Wire into the inbound and outbound unions in `packages/protocol/src/messages.ts` (schedules: `:3398-3406`, `:7083-7091`).
   - Add a permission entry. The table is `satisfies`-checked, so a missing entry fails to compile.
   - Add a `S/session.ts` dispatch case (schedules: chain at `:2394`, switch at `:3125-3144`) and a handler class under `S/session/<domain>/`.
   - Add a `packages/client/src/daemon-client.ts` method and its entry in the response-type table (schedules: `:623-655`, `:6132-6181`).
   - Validators are generated into `packages/protocol/src/generated/validation/` by `generate-validation-aot.mjs` on `prebuild`, `pretypecheck`, and `pretest`.
2. **Capability gate.** Add a COMPAT-tagged boolean under `features` in `buildServerInfoStatusPayload` (`S/websocket-server.ts` ~:1790) and in the `server_info` schema (`packages/protocol/src/messages.ts:3567-3660`).
3. **Plugin hooks.** `server.on` observers (`agent.turn_ended`, `agent.permission_requested`, `workspace.created`, and others) and `server.before` transforms (`agent.create`, `workspace.create`). Source: `public-docs/plugins/reference.md:537-556`, `plugin-examples/lifecycle-logger`. The registry is typed in `packages/plugin/src/server/lifecycle.ts:48-75`: observers `agent.turn_started|turn_ended|permission_requested|permission_resolved|archived|created|closed` and `workspace.created|archived`; transforms `agent.create`, `agent.session_open`, `workspace.create`. Plugins run in a forked subprocess (`S/plugins/runtime.ts`, `plugin-process.ts`), so a plugin cannot share the daemon's in-process store or serialized queues. That confirms the core decision.
4. **CLI.** Register a command group in `packages/cli/src/cli.ts:144`, one file per subcommand under `packages/cli/src/commands/<group>/` (schedules: `index.ts:14`).
5. **App.** Add a route in `packages/app/src/app/`, a screen under `screens/`, and hooks over `useFetchQuery`. Read `docs/expo-router.md` first.

## Rules that constrain the design

- New RPCs use dotted names with `.request` and `.response` suffixes (`docs/rpc-namespacing.md`). Schedules do not, so do not copy their names.
- Wire schemas stay pure: no `.transform()`, `.catch()`, or `.preprocess()`. New fields are optional (`docs/protocol-compatibility.md`).
- The schedule RPCs have no `features` flag, which breaks the feature contract. A Goal feature must gate once on `server_info.features.*`.
- Persistence is file-based JSON with Zod schemas and no migrations (`docs/data-model.md`). A new durable entity follows the schedule recipe: schema in `packages/protocol`, one file per id written with `writeJsonFileAtomic`, mutations serialized per key, parse on read and skip invalid files with a logged error, recovery in the service `start()`.
- The workspace registry has one writer, `workspace-provisioning-service`. Do not write `workspaces.json` from Goal code.
- Permissions are daemon-wide with no per-workspace scope (`docs/permissions.md`). Phase 4 permission boundaries for Goals need either a new permission or enforcement inside the Manager.
- Do not run the full test suite. Run single files with `npx vitest run <file> --bail=1`.

## Regression risks

- **Registry corruption.** `FileBackedRegistry.load` (`S/workspace-registry.ts:296-305`) treats a non-ENOENT parse error as loaded-and-empty. The next mutation then rewrites the file with only the new records. Goal code that creates workspaces inherits this.
- **Worktree create is two steps.** `git worktree add` (`S/utils/worktree.ts:1240`) runs before the registry upsert. A crash between them leaves an unregistered worktree. `workspace-recovery-service.ts` restores archived workspaces (`git worktree prune` at :163, then recreate) and does not scan for unregistered worktrees, so nothing reclaims the leftover. The Manager must write a task-intent event before creating a worktree and reconcile on recovery.
- **Schedule claim ordering.** `S/schedule/service.ts:738` claims a run before the worktree exists (`:979-980`). A crash in between loses the workspace link. The Manager must record intent before creating, then reconcile.
- **Racy collision suffix.** `createWorktree` picks `-N` suffixes with `existsSync` (`S/utils/worktree.ts:1229-1234`). Concurrent creates can collide, so bounded parallelism must serialize worktree creation or pass unique names.
- **`MessageReceipts` never recovers.** A `pending` receipt blocks retries with `agent_request_outcome_unknown`. Do not use it for Manager dispatch without a recovery rule.
- **No fsync.** `writeFileAtomic` (`S/atomic-file.ts:5`) is rename-only. Power loss can lose the last write. Decide whether the event log needs fsync.
- **Same-id overwrite.** `createAgentInternal` calls `deleteAgentState` for the resolved id before launch (`agent-manager.ts:1291`). Always pass fresh agent ids from the Manager.
- **Stored `running` agents after a crash.** Resume does not read `lastStatus`: `resumeAgentFromPersistenceInternal` (`agent-manager.ts:1374`) builds a fresh runtime and lifecycle. But the stored value is what the projection serves for non-resident agents (`S/agent/agent-projections.ts:240`), and only archiving normalizes `running` to `idle` (`S/agent/agent-archive.ts:27`). After a hard crash an agent can show `running` until it is loaded. The Manager must never trust stored agent status. On recovery it reads its own event log, treats every `running` task as interrupted, and re-dispatches with a new agent id.
- **Lifecycle split.** `archivedAt`, closed runtime, and workspace archive are separate states (`docs/agent-lifecycle.md`). Cancelling a Goal must handle all three.
- **Schedules depend on `waitForAgentEvent`.** Changing its semantics changes scheduled runs.
- **Docs drift.** `docs/architecture.md` says `AgentManager.create()`. The method is `createAgent`.
- **Generated validators.** A stale `ws-outbound.aot.ts` fails at runtime. Each message validator must stay under 1 MB.

## Decisions

1. **Core, not plugin.** The Manager is a daemon-lifetime service with its own store, modeled on `ScheduleService`. It lives in `S/goal/` with its own protocol domain (`packages/protocol/src/goal/`) to keep rebases cheap.
2. **`loop/*` stays as is.** Goal RPCs use a separate `goal.*` namespace.
3. **Per-Goal JSONL event log.** Append-only, one file per Goal, monotonic `seq`, unique event ids, fsync on append. Goal state is a replay of the log.
4. **The Lead proposes, the Manager dispatches.** The Lead outputs a structured plan. The Manager validates it, waits for approval, and dispatches tasks. The Lead does not call dispatch tools directly.

## Status

Phases 1 to 4 are built. How goals work, their guarantees, configuration, limits, security model and operations are in [goals.md](goals.md); this file keeps the reconnaissance and the decisions that shaped them.
