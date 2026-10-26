import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runInspectCommand } from "./inspect.js";
import { runLsCommand } from "./ls.js";
import { runChangesCommand } from "./changes.js";
import { runNotificationsCommand } from "./notifications.js";
import {
  runAckCommand,
  runApproveChangeSetCommand,
  runApproveCommand,
  runCancelCommand,
  runPauseCommand,
  runPlanCommand,
  runRejectPlanCommand,
  runRequestChangesCommand,
  runResumeCommand,
  runRetryCommand,
} from "./transition.js";

export function createGoalCommand(): Command {
  const goal = new Command("goal").description("Manage goals");

  addJsonAndDaemonHostOptions(
    goal
      .command("create")
      .description("Create a goal")
      .argument("<title>", "Goal title")
      .option("--objective <text>", "What the goal should achieve")
      .option(
        "--criterion <text>",
        "Acceptance criterion (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      )
      .option("--cwd <path>", "Repository to plan and work in; makes the Manager run this goal")
      .option(
        "--lead <provider[/model]>",
        "Provider for the Lead agent, optionally with a model (required with --cwd)",
      )
      .option(
        "--provider <provider[/model]>",
        "Default provider for tasks, optionally with a model (required with --cwd)",
      )
      .option("--max-parallel <n>", "Tasks to run at once (1-8, default 2)")
      .option("--max-attempts <n>", "Attempts per task before it fails for good (1-5, default 2)")
      .option("--auto-approve", "Run the Lead's plan without waiting for approval")
      .option("--no-notify-lead", "Do not message the Lead about failures or completion")
      .option(
        "--review-provider <provider[/model]>",
        "Provider, optionally with a model, for the reviewer and verifier (default: the Lead's)",
      )
      .option(
        "--verify-provider <provider[/model]>",
        "Provider, optionally with a model, for the verifier (default: the review provider)",
      )
      .option("--lead-thinking <id>", "Thinking option for the Lead (default: the model's)")
      .option(
        "--worker-thinking <id>",
        "Thinking option for tasks on --provider; a task's own thinking wins (default: the model's)",
      )
      .option("--review-thinking <id>", "Thinking option for the reviewer (default: the model's)")
      .option("--verify-thinking <id>", "Thinking option for the verifier (default: the model's)")
      .option(
        "--branch-prefix <prefix>",
        "Integration branch is <prefix>/<goalId> (default paseo-goal)",
      )
      .option(
        "--test-command <cmd>",
        "Shell command run after each merge; a failure sends the change back",
      )
      .option("--require-approval", "Hold every reviewed change until you approve it")
      .option("--max-rework <n>", "Rework rounds allowed per change (0-5, default 2)")
      .option("--max-tasks <n>", "Tasks allowed in a plan (default 25)")
      .option("--max-runs <n>", "Agent runs allowed over the goal's lifetime (default 60)")
      .option("--run-timeout <minutes>", "Time allowed for any one agent turn (default 60)")
      .option("--goal-timeout <minutes>", "Time allowed for the whole goal (default 1440)")
      .option("--retry-backoff <seconds>", "Pause before a failed task is retried (default 5)")
      .option("--max-tokens <n>", "Fail the goal once providers report this many tokens")
      .option("--max-cost <usd>", "Fail the goal once providers report this much cost in USD")
      .option(
        "--deadline <iso-time>",
        "Time the goal must be finished by, e.g. 2026-11-01T18:00:00Z",
      )
      .option(
        "--on-permission <policy>",
        "When an agent asks for a permission: fail the run, or wait for you to answer in Paseo",
      )
      .option(
        "--allow-provider <provider>",
        "Restrict the goal to this provider (repeatable)",
        (value: string, previous: string[] = []) => [...previous, value],
      ),
  ).action(withOutput(runCreateCommand));

  addJsonAndDaemonHostOptions(goal.command("ls").description("List goals")).action(
    withOutput(runLsCommand),
  );

  addJsonAndDaemonHostOptions(
    goal
      .command("inspect")
      .description("Show a goal's tasks (full goal and event history with --json)")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runInspectCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("plan")
      .description("Propose a task plan from a JSON file (array of tasks)")
      .argument("<id>", "Goal ID")
      .requiredOption("--file <path>", "JSON file containing the task array"),
  ).action(withOutput(runPlanCommand));

  addJsonAndDaemonHostOptions(
    goal.command("approve").description("Approve the proposed plan").argument("<id>", "Goal ID"),
  ).action(withOutput(runApproveCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("reject-plan")
      .description("Send the proposed plan back to a fresh Lead to plan again")
      .argument("<id>", "Goal ID")
      .option("--message <text>", "What the new plan should change"),
  ).action(withOutput(runRejectPlanCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("retry")
      .description(
        "Retry failed or cancelled tasks with fresh attempts; reopens a failed goal (retries all of them)",
      )
      .argument("<id>", "Goal ID")
      .option("--task <taskId>", "Retry only this task (a live goal only)"),
  ).action(withOutput(runRetryCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("pause")
      .description("Start no new worker runs; runs already going finish")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runPauseCommand));

  addJsonAndDaemonHostOptions(
    goal.command("resume").description("Resume a paused goal").argument("<id>", "Goal ID"),
  ).action(withOutput(runResumeCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("changes")
      .description("List a goal's change sets and where each stands")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runChangesCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("notifications")
      .description(
        "List the messages sent to a goal's Lead and originating chat, and their outcome",
      )
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runNotificationsCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("approve-changeset")
      .description("Approve a reviewed change set that is held for human approval")
      .argument("<id>", "Goal ID")
      .argument("<changeset>", "Change set ID"),
  ).action(withOutput(runApproveChangeSetCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("request-changes")
      .description("Send a change set held for approval back to its author")
      .argument("<id>", "Goal ID")
      .argument("<changeset>", "Change set ID")
      .requiredOption("--message <text>", "What must change"),
  ).action(withOutput(runRequestChangesCommand));

  addJsonAndDaemonHostOptions(
    goal
      .command("ack")
      .description(
        "Dismiss an ended goal so it stops asking for attention; a failed goal can still be retried",
      )
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runAckCommand));

  addJsonAndDaemonHostOptions(
    goal.command("cancel").description("Cancel a goal").argument("<id>", "Goal ID"),
  ).action(withOutput(runCancelCommand));

  return goal;
}
