import type { ChangedFile } from "@getpaseo/protocol/goal/types";
import { runGitCommand } from "../../utils/run-git-command.js";
import { spawnProcess } from "../../utils/spawn.js";

export interface CapturedChange {
  branch: string;
  baseCommit: string;
  headCommit: string;
  files: ChangedFile[];
}

export type MergeOutcome = { ok: true; headCommit: string } | { ok: false; conflicts: string[] };

export interface CommandOutcome {
  exitCode: number | null;
  timedOut: boolean;
  /** The last part of combined stdout and stderr. */
  output: string;
}

/** What the change-set pipeline needs from git and the shell. */
export interface GitPort {
  /**
   * Commit anything uncommitted, then describe the work against the integration
   * commit. Null when there is none. Commits, not branch names, are used because
   * Paseo may rename a worktree's branch after creation.
   */
  capture(input: {
    cwd: string;
    integrationCommit: string;
    message: string;
  }): Promise<CapturedChange | null>;
  /** True when the worktree has no uncommitted or untracked changes. */
  isClean(cwd: string): Promise<boolean>;
  head(cwd: string): Promise<string>;
  currentBranch(cwd: string): Promise<string>;
  /** Merge a commit into the branch checked out at cwd. A conflict is aborted and reported. */
  merge(input: { cwd: string; commit: string; message: string }): Promise<MergeOutcome>;
  /** Discard a half-finished merge and move the checked-out branch back to a commit. */
  resetHard(input: { cwd: string; commit: string }): Promise<void>;
  /** `key` groups commands (by goal) so they can be stopped together. */
  runCommand(input: {
    cwd: string;
    command: string;
    timeoutMs: number;
    key?: string;
  }): Promise<CommandOutcome>;
  /** Kill running commands for a key, or all of them. Their results report a signal exit. */
  killCommands(key?: string): void;
}

const OUTPUT_TAIL_CHARS = 4000;

// Commits the Manager makes itself carry an explicit author instead of relying on
// whatever identity the machine has configured.
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Paseo Goal Manager",
  "-c",
  "user.email=goal-manager@paseo.local",
  "-c",
  "commit.gpgsign=false",
];

async function git(cwd: string, args: string[], accept?: number[]) {
  return runGitCommand(args, { cwd, ...(accept ? { acceptExitCodes: accept } : {}) });
}

async function rev(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", ref])).stdout.trim();
}

function parseNameStatus(stdout: string): ChangedFile[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [status = "?", ...rest] = line.split("\t");
      return { status, path: rest.join("\t") };
    });
}

/** End a command's whole process group; fall back to the process itself. */
function killGroup(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

const OUTPUT_DRAIN_MS = 100;

export function createGitPort(): GitPort {
  const running_ = new Map<string, Set<() => void>>();
  return {
    async capture({ cwd, integrationCommit, message }) {
      const dirty = (await git(cwd, ["status", "--porcelain"])).stdout.trim().length > 0;
      if (dirty) {
        await git(cwd, ["add", "-A"]);
        await git(cwd, [...COMMIT_IDENTITY, "commit", "-m", message]);
      }
      const headCommit = await rev(cwd, "HEAD");
      const baseCommit = (await git(cwd, ["merge-base", "HEAD", integrationCommit])).stdout.trim();
      if (headCommit === baseCommit) return null;
      const diff = await git(cwd, ["diff", "--name-status", `${baseCommit}..${headCommit}`]);
      const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      return { branch, baseCommit, headCommit, files: parseNameStatus(diff.stdout) };
    },

    head: (cwd) => rev(cwd, "HEAD"),

    async isClean(cwd) {
      return (await git(cwd, ["status", "--porcelain"])).stdout.trim().length === 0;
    },

    async currentBranch(cwd) {
      return (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    },

    async merge({ cwd, commit, message }) {
      const dirty = (await git(cwd, ["status", "--porcelain"])).stdout.trim();
      if (dirty.length > 0) {
        throw new Error(`Integration worktree has uncommitted changes:\n${dirty}`);
      }
      const result = await git(
        cwd,
        [...COMMIT_IDENTITY, "merge", "--no-ff", "-m", message, commit],
        [0, 1],
      );
      if (result.exitCode === 0) return { ok: true, headCommit: await rev(cwd, "HEAD") };
      const unmerged = await git(cwd, ["diff", "--name-only", "--diff-filter=U"]);
      const conflicts = unmerged.stdout.split("\n").filter((line) => line.trim().length > 0);
      if (conflicts.length === 0) {
        // Exit 1 without conflicts is a real failure, not a conflict.
        await git(cwd, ["merge", "--abort"], [0, 128]);
        throw new Error(`git merge failed: ${result.stderr.trim() || result.stdout.trim()}`);
      }
      await git(cwd, ["merge", "--abort"]);
      return { ok: false, conflicts };
    },

    async resetHard({ cwd, commit }) {
      await git(cwd, ["merge", "--abort"], [0, 128]);
      await git(cwd, ["reset", "--hard", commit]);
      await git(cwd, ["clean", "-fd"]);
    },

    runCommand({ cwd, command, timeoutMs, key = "" }) {
      return new Promise((resolve, reject) => {
        const child = spawnProcess("sh", ["-c", command], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        let timedOut = false;
        let settled = false;
        const collect = (chunk: Buffer | string) => {
          output = (output + chunk.toString()).slice(-OUTPUT_TAIL_CHARS * 2);
        };
        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        const stop = () => killGroup(child);
        const running = running_.get(key) ?? new Set<() => void>();
        running.add(stop);
        running_.set(key, running);
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        const release = () => {
          clearTimeout(timer);
          running.delete(stop);
        };
        child.on("error", (error) => {
          release();
          reject(error);
        });
        // Judge the command by when its own process ends. Waiting for its output
        // pipes to close would also wait for any background child that inherited them.
        child.on("exit", (exitCode) => {
          if (settled) return;
          settled = true;
          release();
          // Whatever the command left running goes with it.
          stop();
          setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            resolve({ exitCode, timedOut, output: output.slice(-OUTPUT_TAIL_CHARS) });
          }, OUTPUT_DRAIN_MS);
        });
      });
    },

    killCommands(key) {
      for (const [k, stops] of running_) {
        if (key !== undefined && k !== key) continue;
        for (const stop of stops) stop();
      }
    },
  };
}
