# Goals

A Goal is one objective that Paseo plans, carries out with several coding agents, reviews, tests and merges on its own branch. You start it once and read the result from the history. Goals are a fork addition; `docs/goal-orchestration-phase0.md` holds the reconnaissance and decisions behind the design.

## Roles

| Role     | What it is                                                                                                                                         |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manager  | Daemon code, no model. Schedules tasks, records events, retries, enforces limits and recovers after a restart. `packages/server/src/server/goal/`. |
| Lead     | An agent that reads the repository and proposes the plan. It is also the conversation: the Manager messages it about failures and completion.      |
| Workers  | Agents that carry out tasks, each in its own worktree, on the task's provider or the goal's default.                                               |
| Reviewer | A fresh agent that reads one change and returns approve or request changes. It never wrote the change.                                             |
| Verifier | A fresh agent that checks each acceptance criterion against the merged result and gives evidence.                                                  |

Agents reason and edit. The Manager decides what runs, in what order, and what counts as done. The reducer (`goal-reducer.ts`) rejects any event that breaks the rules below, so a Manager bug cannot write an illegal state to the log.

## Start one

```bash
paseo goal create "Add rate limiting" \
  --objective "Limit the public API to 100 requests a minute per key" \
  --criterion "Requests over the limit get HTTP 429" \
  --criterion "Existing API tests still pass" \
  --cwd ~/code/api --lead claude --provider codex \
  --review-provider opencode --test-command "npm test" --auto-approve

paseo goal ls
paseo goal inspect <id>           # tasks and their status
paseo goal changes <id>           # change sets and where each stands
paseo goal notifications <id>     # messages to the Lead and the chat, and their outcome
paseo goal inspect <id> --json    # full goal and event history
paseo goal reject-plan <id> --message "Split the migration out"
paseo goal pause <id>             # start no new worker runs
paseo goal resume <id>
paseo goal retry <id>             # retry failed tasks; reopens a failed goal
paseo goal cancel <id>
paseo goal ack <id>               # dismiss an ended goal
```

`paseo goal ls` shows each goal's progress, elapsed time, reported usage and what it is waiting on. `paseo goal inspect` shows the same per task.

Without `--cwd` the goal is manual: it records plans and state and nothing runs. With `--cwd` the Manager takes over. `--cwd` must be a git repository.

## Lifecycle

1. **Plan.** The Lead replies with a JSON task graph: ids, titles, descriptions, kinds (`implement`, `review`, `read`), dependencies and optional providers. The Manager checks it (no cycles, known providers, within the task limit, no ids ending in `-rw<n>`) and sends an unusable plan back, up to two times.
2. **Approve.** The goal waits for `paseo goal approve <id>`, or approves itself with `--auto-approve`. `paseo goal reject-plan <id> --message ...` sends the plan back instead: the Lead and its worktree are retired, and a new Lead plans with your feedback and the rejected plan in its prompt. A plan can be rejected 5 times.
3. **Execute.** Ready tasks start, at most `maxParallel` per goal and 4 across the daemon. Each task gets its own worktree. A task runs on its own provider or the goal's default. Its prompt includes the reports of the tasks it depends on. A failed task is retried after a backoff, up to `maxAttempts` failed attempts. A run interrupted by a restart does not count as a failed attempt.
4. **Capture.** When an implement task succeeds, its work is committed if needed and recorded as a change set with explicit base and head commits and the changed files. A task that changed nothing is recorded as such.
5. **Review.** A reviewer reads `git diff base..head` in the author's worktree. Changes it asks for, merge conflicts and test failures each become a rework task that continues in the author's worktree, up to `maxReworkRounds`.
6. **Integrate.** Approved change sets merge one at a time into the goal's integration branch in its own worktree. The branch is `<branchPrefix>/<goalId>`, `paseo-goal/<goalId>` by default, and Paseo's branch auto-namer is told to leave it alone. Its worktree path is in `paseo goal changes <id> --json`. `testCommand`, if set, runs after each merge; a failure resets the branch.
7. **Verify.** When everything is integrated, the verifier checks each acceptance criterion and records its evidence. Only then does the goal complete.

An implement task that depends on another starts only after that task's change set is integrated, and branches from the integrated commit, so it builds on the merged code.

The result is the integration branch and its worktree. Nothing is merged into your branch or pushed. Review it and merge it yourself.

## What is guaranteed

- **No unreviewed merge.** A change set can reach `integrating` only from `approved`, and `approved` only from a reviewer's verdict or your approval. The transition table in the reducer enforces it. Before each merge the pipeline also checks that the integration branch is where it left it, and resets it if something else moved it. Agents share the repository's git data, so a misbehaving agent could still try to write there; the checks catch that, they cannot stop it.
- **No early completion.** The reducer refuses `goal.completed` while a change set is neither integrated nor superseded, an implement task's work was never captured, or a criterion is unverified. A managed goal needs at least one criterion.
- **Your checkout is never touched.** Every agent, including the Lead, works in its own worktree. The integration branch is separate from your branches. Every worktree waits for its `paseo.json` setup to finish (up to 5 minutes) before an agent or a merge uses it. Worktrees start from the commit that was checked out in `cwd` when the goal was created, recorded as `baseCommit`, so a goal started on a feature branch builds on it.
- **Restarts lose nothing.** State is an append-only event log. After a restart, interrupted runs are closed out as interrupted and run again, and an interrupted run does not use up an attempt. A daemon that keeps crashing is bounded by `maxRuns`. A test restarts the daemon after each event of a full scenario and requires the goal to finish.
- **Every notification has a recorded outcome.** A message to the Lead (a task failed for good, the goal completed) or to the originating chat (how the goal ended) is recorded before it is sent, with its text, and each attempt is recorded as delivered or failed. A failed attempt is retried after 5 seconds, then 30, 120 and 300, five attempts in all; after the fifth failure the notification stays `failed` with its last error. Delivered means the agent layer accepted the prompt, not that anyone read it. Notifications and an acknowledgement are the only events accepted after a goal has ended.
- **Duplicates do nothing.** An event id is recorded once. Resending a request with the same `eventId` returns the existing result. The CLI does not send an `eventId`.

## Control a running goal

- **Pause.** `paseo goal pause` stops new worker runs from starting. Runs already going finish and are recorded; their reviews, merges and rework scheduling continue. Nothing new starts, and the goal is neither verified nor failed for being stuck until you resume. Planning and plan approval still happen. Time, run and budget limits keep counting. The pause is an event, so it holds across restarts: interrupted runs are closed out and wait as pending tasks.
- **Retry.** `paseo goal retry <id> [--task <taskId>]` returns failed or cancelled tasks to pending. Their earlier failed runs stop counting against `maxAttempts`, so each gets a full set of attempts again; the run limit, time limit and budgets do not reset. On a live goal you can name one task. A failed goal is reopened to executing and every failed and cancelled task is retried, because one left behind would fail the goal again at once. A failed goal is not reopened when a change set was rejected (the goal can no longer complete), the run limit, deadline or a budget is used up, or nothing failed (planning or verification failures). Retry also waits until the failed goal's stopping agents have ended. After reopening, change sets are picked up where the failure left them, as after a restart, and the chat that started the goal is told about its next ending as well.
- **Cancel** is final.
- **Acknowledge.** `paseo goal ack <id>` (`goal.acknowledge`) dismisses an ended goal so it stops asking for attention. It records a `goal.acknowledged` event and sets `acknowledgedAt`, so the mark survives a restart. It changes nothing else: the status stays, and a failed goal can still be retried. A retry that reopens the goal clears the mark, so its next ending needs attention again. A live goal cannot be acknowledged; acknowledging twice returns the goal unchanged.

Gate each on its own `server_info.features` flag: `goalControls` for pause, resume, retry and plan rejection, `goalAcknowledge` for acknowledge, `goalBudgets` before sending `limits.maxTotalTokens`, `limits.maxCostUsd` or `limits.deadlineAt` (an older daemon drops them silently), and `goalUpdates` for pushes.

`describeGoalWaitingOn` in `packages/protocol/src/goal/waiting-on.ts` names what a live goal is waiting on (plan approval, a held change set, running tasks, review, merge, retry, verification, or a pause); the CLI and the app both use it. It returns an English `label` for the CLI and a translation `key` (`goals.waitingOn.*`) with `params` (`count`, `ids`, `title`, `tasks`) for the app. Use `count` for plural forms.

## Watching goals

`goal.list` returns every goal with its `usage` and a `progress` count (`tasksTotal`, `tasksDone`, `tasksFailed`, `tasksRunning`), enough for a list row without `goal.inspect`. `summarizeGoalProgress` in `packages/protocol/src/goal/progress.ts` computes the same counts for a daemon that predates `progress`.

To be told about changes, subscribe to the `goal.update` session event (`session.events.set_subscription.request` with `events: ["goal.update"]`, or `observeGoalUpdates()` in the client). Each `goal.update` carries one goal in the shape `goal.list` returns. The first change to a goal is sent at once; changes in the next 250 ms are folded into one push of the latest state. Only connections that subscribed get it, and only with the `automation.manage` permission. Keep polling `goal.list` as well, at a slower rate: a push missed across a reconnect is not replayed.

The reducer records when each stage started and ended, from the events alone, so replay gives the same times and older logs gain them too. A change set carries `reviewStartedAt` and `reviewedAt` (left `in_review` with a verdict), `mergeStartedAt` (first entered `integrating`) and `mergedAt`. The goal carries `verifyStartedAt`, the moment every task succeeded and every change set settled, and `verifiedAt`, when the last criterion was verified. Each is absent until its stage is reached.

## Usage and budgets

The Manager records one `usage.recorded` event per agent turn: Lead, workers, reviewers and the verifier. It holds what the provider reported at the end of the turn, or nothing. The goal carries the sum as `usage` (`inputTokens`, `cachedInputTokens`, `outputTokens`, `totalTokens` = input + output, `costUsd`, `reportedTurns`, `totalTurns`), and each worker run carries its own.

Providers report differently, so treat the numbers as a floor:

- Some report nothing, or report after the turn has ended (pi and omp poll session stats in the background). Those turns count in `totalTurns` and not in `reportedTurns`. Show "reported for N of M turns" next to any total.
- Some report the agent's session total rather than the turn's. A Lead or reviewer that needs a correction turn can then be counted twice. Workers run one turn per agent and are not affected.
- `costUsd` is only what the provider computed. Most report tokens without cost.

`limits.maxTotalTokens` and `limits.maxCostUsd` fail the goal once the reported totals reach them, and a goal over budget is not reopened. They cannot stop a turn already running, and they never count what was not reported.

## Configuration

Set on `paseo goal create`. Defaults apply when a flag is omitted. Ranges and defaults live in `packages/protocol/src/goal/config-bounds.ts`, which the schema, the daemon, the CLI and the app share.

| Field                        | Flag                 | Default    | Meaning                                                                                                                                 |
| ---------------------------- | -------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cwd`                        | `--cwd`              | none       | Git repository the goal works on. The Manager runs the goal only when it is set; without it the goal is manual                          |
| `leadProvider`               | `--lead`             | required   | Provider for the Lead                                                                                                                   |
| `defaultProvider`            | `--provider`         | required   | Provider for tasks that name none                                                                                                       |
| `reviewProvider`             | `--review-provider`  | the Lead's | Provider for reviewers, and for the verifier unless `verifyProvider` is set                                                             |
| `verifyProvider`             | `--verify-provider`  | reviewer's | Provider for the verifier                                                                                                               |
| `branchPrefix`               | `--branch-prefix`    | paseo-goal | Integration branch is `<branchPrefix>/<goalId>`. Segments of letters, digits, `.`, `_`, `-` joined by `/`, at most 100 characters       |
| `maxParallel`                | `--max-parallel`     | 2          | Tasks at once, 1 to 8                                                                                                                   |
| `maxAttempts`                | `--max-attempts`     | 2          | Tries per task, 1 to 5                                                                                                                  |
| `maxReworkRounds`            | `--max-rework`       | 2          | Rework rounds per change, 0 to 5                                                                                                        |
| `autoApprovePlan`            | `--auto-approve`     | off        | Run the plan without waiting for you                                                                                                    |
| `requireHumanApproval`       | `--require-approval` | off        | Hold every reviewed change until you approve it                                                                                         |
| `testCommand`                | `--test-command`     | none       | Shell command run in the integration worktree after each merge                                                                          |
| `notifyLead`                 | `--no-notify-lead`   | on         | Message the Lead about failures and completion                                                                                          |
| `onPermissionRequest`        | `--on-permission`    | `fail`     | `fail` ends the run; `wait` leaves the request pending in Paseo for you                                                                 |
| `allowedProviders`           | `--allow-provider`   | any        | Restrict the goal to these providers                                                                                                    |
| `limits.maxTasks`            | `--max-tasks`        | 25         | Tasks in a plan                                                                                                                         |
| `limits.maxRuns`             | `--max-runs`         | 60         | Worker runs over the goal's life. Retries, rework and runs interrupted by a restart all count; Lead, reviewer and verifier turns do not |
| `limits.runTimeoutMinutes`   | `--run-timeout`      | 60         | Time for any one agent turn. The agent is then cancelled; if it has not stopped 30 seconds later, the turn is abandoned and fails       |
| `limits.goalTimeoutMinutes`  | `--goal-timeout`     | 1440       | Time from creation until the goal must be finished                                                                                      |
| `limits.retryBackoffSeconds` | `--retry-backoff`    | 5          | Pause before a retry, times the attempt number                                                                                          |
| `limits.deadlineAt`          | `--deadline`         | none       | ISO time the goal must be finished by. Must be in the future at creation; the earlier of this and `goalTimeoutMinutes` applies          |
| `limits.maxTotalTokens`      | `--max-tokens`       | none       | Reported input plus output tokens over the goal's life, 1000 to 10 billion. See [Usage and budgets](#usage-and-budgets)                 |
| `limits.maxCostUsd`          | `--max-cost`         | none       | Reported cost in USD over the goal's life, 0.01 to 100000                                                                               |

Every provider field, and a task's `provider` in a plan, takes `<provider>/<model>`, so each role (Lead, workers, reviewer, verifier) can run its own provider and model (`--lead codex/<model>`) as well as a bare provider id. The daemon splits at the first `/`; a bare id starts the provider's default model. `allowedProviders` lists bare provider ids and is matched against the part before the `/`.

Creation fails at once if a provider is not registered, is outside the allow-list, or `cwd` is not a git repository.

When a limit is reached the goal fails, its agents are cancelled, and the reason is recorded. `paseo goal approve-changeset` and `paseo goal request-changes --message ...` act on changes held by `--require-approval`.

## Security model

Goals run with the `automation.manage` permission, the same as schedules. Anyone who holds it can start agents that run commands on the machine. The boundaries below limit what a goal does by accident, not what a malicious holder of the permission can do.

- **Agents run unattended.** They act without asking, in worktrees, with the provider's unattended mode. The default `fail` policy ends a run that asks for a permission. `wait` leaves the request in Paseo for you to answer, and the run timeout ends one nobody answers (the turn is abandoned even if the provider ignores the cancel).
- **Read-only roles are checked, not trusted.** The Lead plans in a worktree of its own, kept while the goal runs and archived if it is cancelled or fails. A reviewer that changes the change it reviews has the changes undone and its verdict discarded. A verifier that leaves the integration branch changed or dirty has its verdict discarded and the branch reset.
- **`testCommand` is a shell command you chose.** It runs with your privileges in the integration worktree and has a fixed 10 minute limit. It is judged by its own exit, so a background process it leaves behind does not fail it, and it is killed when the goal ends or the daemon shuts down. Agent-written code runs inside it, so use a command and repository you trust.
- **Agent text is data.** Findings, test output, task reports and errors that reach another agent's prompt are quoted between delimiters that change on every prompt. That lowers the risk of prompt injection and does not remove it. An agent that reads attacker-controlled files can still be steered.
- **Plans cannot widen the goal.** A plan that names a provider outside the registered set or the allow-list is sent back. Task ids ending in `-rw<n>` are reserved. A managed goal's plan can only come from its Lead; `goal.propose_plan` is refused for it.
- **Verdicts are judgments.** A reviewer or verifier records evidence, and it can be wrong. For anything that must not depend on an agent's word, put it in `testCommand`.

Not protected: network access, files outside the worktrees that the provider's unattended mode can reach, and credentials in your environment. Treat a goal like a script you let a contractor write and run.

## Operations

- **State.** One file per goal, `$PASEO_HOME/goals/<goalId>.jsonl`, one event per line, fsynced on append, and the directory is fsynced when a new log is created. A torn last line from a crash is truncated on load. Do not edit these files.
- **Unreadable logs.** A log that fails to replay, or comes from a newer version, makes that goal unavailable and is logged at start. Other goals and the daemon are unaffected. The file is left as it is.
- **Compatibility.** There is no migration step. Event changes are additive, and tests replay logs written by each earlier phase. An implement task that succeeded before work capture existed cannot be recovered; its goal fails rather than completing unreviewed.
- **Worktrees.** The worktree of a failed run is archived when it fails, not after its retry backoff. Worktrees of abandoned runs, and of read and review tasks, are archived too. Worktrees of successful implement tasks, the integration worktree and the Lead's worktree are kept so you can inspect them. The Lead's worktree is archived if the goal is cancelled or fails. Archive the rest from Paseo when you are done.
- **Restarts.** A graceful shutdown stops the Manager before agents close, so runs are not recorded as failures. The next start marks them interrupted and runs them again with a new run id. It also sends every notification still pending at once, for ended goals too, within the five attempts; a delivered one is never sent again. Goals from before notifications were recorded have none and are not messaged again.
- **Cancel.** `paseo goal cancel` stops the Lead, workers, reviewers and verifier, the test command and any retry backoff, and archives the worktrees of every run still in flight. Uncommitted work in those worktrees is lost.
- **Concurrency.** At most 4 worker runs across all goals, and `maxParallel` per goal. The Lead, reviews, merges and verification are not counted. A task waiting out a retry backoff holds no slot.
- **Logs.** The Manager logs under the `goal-manager` and `change-set-pipeline` modules in `daemon.log`.

## Supported workflows

- Feature or fix work on a git repository that decomposes into tasks, with a test command that can judge a merge.
- Mixed providers: a planner on one, implementers on others, an independent reviewer on a third.
- Unattended runs bounded by time and run limits, and runs gated by your approval of the plan, each change, or both.

Not supported: goals without a git repository, merging into your branch or opening a pull request, re-planning around a failed criterion (the goal fails), and multi-repository goals.

### In the app

- **List.** Goals waiting on you come first: a plan or a change set held for approval, or a failure. Filters narrow to Needs you, Running or Done. With no goals, the screen offers templates that fill the create form.
- **Needs you.** The app has no push channel for goals. `GoalAttentionWatcher` polls `goal.list` every 15 seconds on each host that runs goals; the Goals screen polls every 5. The sidebar badge counts plans and change sets held for approval, not failures. A goal that starts waiting shows a toast; the first poll after launch stays quiet.
- **Detail.** The stepper, the banner and the progress panel all derive from the goal state in `packages/app/src/goals/`, with the phase taken from `describeGoalWaitingOn`. Held change sets get Approve and Request changes. Each task opens the agent of its latest run. Pause, Resume, Send back (plan rejection) and Retry appear only with `goalControls`.
- **Progress is an estimate.** The percent weights each implement task as half done when its run succeeds, three quarters when its change is approved, done when merged; planning and verification bracket the tasks. Time left needs two finished tasks and spreads the fastest and slowest over `maxParallel` (at most 4); review, merge and verification time is not sampled, so read it as a floor. Tokens and cost show "Not reported" until a provider reports.
- **Create form.** The objective is the only text you must write when the goal is manual; the title defaults to its first line. Careful, Balanced and Turbo fill every advanced setting; Balanced is the daemon's defaults. Steppers walk the ranges in `GOAL_CONFIG_BOUNDS`, so a value the daemon refuses cannot be entered. The form remembers your last managed goal per host (working directory, providers, settings) and offers its settings as Mine; the test command comes back only for the same directory. Budget caps are sent only to hosts with `goalControls`, since an older daemon would drop them silently. Optional fields equal to the daemon's default are left out of the config. The form does not set per-task providers, `verifyProvider`, `branchPrefix` or `limits.deadlineAt`.

### From a chat

In an agent chat, `/goal <objective>` or **Start goal from this chat** in the tab's menu opens the create form with the goal run by agents, the chat's working directory, and the chat's provider for the Lead and tasks. Without text after `/goal`, the objective is the chat's last message. The goal gets its own Lead; the chat stays as it is and receives the outcome, because the form sets `originAgentId` to the chat.

## Known limits

- Setup scripts run in every goal worktree. Anything setup leaves uncommitted in the integration worktree is reset before the first merge; setup output in a task's worktree is committed with its work and goes through review.
- The reviewer check sees `HEAD` and uncommitted files in the author's worktree, not ignored files or other refs. Reviewers legitimately run tests that create ignored files, and every agent shares the repository's refs, so a ref snapshot would flag other agents' own commits; neither check is done.
- A reviewer or verifier interrupted by a restart is not cancelled before its replacement starts. If a provider keeps agent processes alive across a daemon restart, two could briefly work on one worktree.
- Verification runs once, after all changes are integrated.
- A crash after a merge commit but before it is recorded leaves that commit on the integration branch; recovery resets the branch and merges again.
- If `cwd` is a subdirectory of the repository, git commands run in that subdirectory of each worktree.
- Quoting agent text in prompts does not stop prompt injection.
- A notification is sent at least once, not exactly once. If the daemon stops after the agent layer accepted it but before that was recorded, the next start sends it again. A crash after a goal ends but before its notifications are recorded loses them.

## Where the tests are

| File                                 | What it proves                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal/goal-reducer.test.ts`          | State machine, change set transition table, completion guards                                                                                           |
| `goal/goal-manager.test.ts`          | Planning, scheduling, retries, cancellation, recovery of runs, notification delivery and its retries across restarts                                    |
| `goal/change-set-pipeline.test.ts`   | Capture, review, rework, integration, verification, crash windows                                                                                       |
| `goal/limits-and-policy.test.ts`     | Time and run limits, backoff, permission policy, provider boundaries, read-only roles                                                                   |
| `goal/recovery-matrix.test.ts`       | A restart after every event of a full run finishes the goal                                                                                             |
| `goal/log-compat.test.ts`            | Logs from earlier phases replay; unknown logs are set aside                                                                                             |
| `goal/goal-controls.test.ts`         | Reject plan, pause and resume, retry and reopen, usage totals and budgets, across restarts                                                              |
| `goal/goal-update-publisher.test.ts` | `goal.update` pushes: sent at once, bursts folded per goal, stopped cleanly                                                                             |
| `goal/review-fixes.test.ts`          | Regressions from independent review: restarts, stuck turns, base commit, external cancel, backoff slots, test-command runner, integration head, quoting |
| `goal/goal-ports.test.ts`            | The permission wait loop and turn-end detection                                                                                                         |
| `goal/git-ops.test.ts`               | Capture, merge, conflict abort and reset on real repositories                                                                                           |
| `goal.e2e.test.ts`                   | A real daemon on real worktrees: full runs, conflicts, failing tests, restarts, renames                                                                 |

## Changing goals

- Add fields and event types; never change or remove the meaning of an existing one. Old logs must still replay, and the compat test must cover the change.
- Put every rule the Manager relies on in the reducer. The Manager can then be wrong without corrupting a goal.
- Use commits, not branch names, for anything stored. Paseo can rename a worktree's branch.
- Keep new RPCs under the `goal.*` namespace and gated on `server_info.features.goals`, or on the flag added with them.
- A new event type breaks an older client's strict event union. `goal-session.ts` leaves such types out of `goal.inspect` for clients without the matching capability (`goal_control_events` covers `goal.paused`, `goal.resumed`, `goal.retried` and `usage.recorded`; `goal_acknowledge_events` covers `goal.acknowledged`); add yours there.
- A new push message must reach only clients that asked for it. Deliver it as a session event subscription, as `goal.update` is, and return false for it in `legacyWantsEvent` in `session.ts`.
