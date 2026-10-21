import { Command } from "commander";
import { withOutput } from "../../output/index.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";
import { runCreateCommand } from "./create.js";
import { runInspectCommand } from "./inspect.js";
import { runLsCommand } from "./ls.js";
import { runChangesCommand } from "./changes.js";
import {
  runApproveChangeSetCommand,
  runApproveCommand,
  runCancelCommand,
  runPlanCommand,
  runRequestChangesCommand,
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
      .option("--lead <provider>", "Provider for the Lead agent (required with --cwd)")
      .option("--provider <provider>", "Default provider for tasks (required with --cwd)")
      .option("--max-parallel <n>", "Tasks to run at once (1-8, default 2)")
      .option("--max-attempts <n>", "Attempts per task before it fails for good (1-5, default 2)")
      .option("--auto-approve", "Run the Lead's plan without waiting for approval")
      .option("--no-notify-lead", "Do not message the Lead about failures or completion")
      .option(
        "--review-provider <provider>",
        "Provider for the reviewer and verifier (default: the Lead's)",
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
      .command("changes")
      .description("List a goal's change sets and where each stands")
      .argument("<id>", "Goal ID"),
  ).action(withOutput(runChangesCommand));

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
    goal.command("cancel").description("Cancel a goal").argument("<id>", "Goal ID"),
  ).action(withOutput(runCancelCommand));

  return goal;
}
