import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createGitPort } from "./git-ops.js";

const port = createGitPort();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("git ops against real repositories", () => {
  let root: string;
  let repo: string;
  let integration: string;
  let work: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "paseo-git-ops-"));
    repo = join(root, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "pipe" });
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    await writeFile(join(repo, "shared.txt"), "base\n");
    git(repo, "add", "-A");
    git(repo, "-c", "commit.gpgsign=false", "commit", "-m", "initial");
    integration = join(root, "integration");
    work = join(root, "work");
    git(repo, "worktree", "add", "-b", "goal/integration", integration);
    git(repo, "worktree", "add", "-b", "task/work", work);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("capture commits uncommitted work and reports explicit commits and files", async () => {
    await writeFile(join(work, "feature.txt"), "new\n");
    await writeFile(join(work, "shared.txt"), "changed\n");

    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task a",
    });

    expect(captured).not.toBeNull();
    expect(captured?.branch).toBe("task/work");
    expect(captured?.baseCommit).toBe(git(repo, "rev-parse", "main"));
    expect(captured?.headCommit).toBe(git(work, "rev-parse", "HEAD"));
    expect(captured?.files.map((f) => [f.status, f.path]).sort()).toEqual([
      ["A", "feature.txt"],
      ["M", "shared.txt"],
    ]);
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(git(work, "log", "-1", "--format=%an")).toBe("Paseo Goal Manager");
  });

  test("capture keeps the agent's own commits and returns null when nothing changed", async () => {
    expect(
      await port.capture({ cwd: work, integrationCommit: "goal/integration", message: "x" }),
    ).toBeNull();

    await writeFile(join(work, "a.txt"), "a\n");
    git(work, "add", "-A");
    git(work, "-c", "commit.gpgsign=false", "commit", "-m", "agent commit");
    const agentHead = git(work, "rev-parse", "HEAD");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "x",
    });
    expect(captured?.headCommit).toBe(agentHead);
  });

  test("merge brings a change into the integration branch with a merge commit", async () => {
    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task a",
    });

    const result = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "Integrate task a",
    });

    expect(result.ok).toBe(true);
    expect(await readFile(join(integration, "feature.txt"), "utf8")).toBe("new\n");
    expect(git(integration, "log", "-1", "--format=%s")).toBe("Integrate task a");
    expect(git(integration, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
  });

  test("a conflicting merge is aborted, reported, and leaves the branch untouched", async () => {
    // Integration changes shared.txt one way...
    await writeFile(join(integration, "shared.txt"), "integration side\n");
    git(integration, "add", "-A");
    git(integration, "-c", "commit.gpgsign=false", "commit", "-m", "integration edit");
    const before = git(integration, "rev-parse", "HEAD");
    // ...and the task changed it another way.
    await writeFile(join(work, "shared.txt"), "task side\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task",
    });

    const result = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "Integrate",
    });

    expect(result).toEqual({ ok: false, conflicts: ["shared.txt"] });
    expect(git(integration, "rev-parse", "HEAD")).toBe(before);
    expect(git(integration, "status", "--porcelain")).toBe("");
    expect(await readFile(join(integration, "shared.txt"), "utf8")).toBe("integration side\n");
  });

  test("merge refuses to run on a dirty integration worktree", async () => {
    await writeFile(join(integration, "stray.txt"), "oops\n");
    await expect(
      port.merge({ cwd: integration, commit: git(repo, "rev-parse", "main"), message: "m" }),
    ).rejects.toThrow(/uncommitted/);
  });

  test("resetHard returns the branch to an earlier commit and removes new files", async () => {
    const start = git(integration, "rev-parse", "HEAD");
    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: "goal/integration",
      message: "task",
    });
    await port.merge({ cwd: integration, commit: captured?.headCommit ?? "", message: "m" });
    await writeFile(join(integration, "untracked.txt"), "x\n");

    await port.resetHard({ cwd: integration, commit: start });

    expect(git(integration, "rev-parse", "HEAD")).toBe(start);
    expect(git(integration, "status", "--porcelain")).toBe("");
  });

  test("runCommand reports exit code and output, and kills a command that overruns", async () => {
    const ok = await port.runCommand({ cwd: repo, command: "echo hello", timeoutMs: 5000 });
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false });
    expect(ok.output).toContain("hello");

    const failed = await port.runCommand({
      cwd: repo,
      command: "echo broke >&2; exit 3",
      timeoutMs: 5000,
    });
    expect(failed).toMatchObject({ exitCode: 3, timedOut: false });
    expect(failed.output).toContain("broke");

    const started = Date.now();
    const slow = await port.runCommand({ cwd: repo, command: "sleep 30", timeoutMs: 200 });
    expect(slow.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("capture and merge keep working when Paseo renames the integration branch", async () => {
    const integrationHead = git(integration, "rev-parse", "HEAD");
    // Paseo's branch auto-namer renames a worktree's branch after creation.
    git(integration, "branch", "-m", "goal/integration", "renamed-by-namer");

    await writeFile(join(work, "feature.txt"), "new\n");
    const captured = await port.capture({
      cwd: work,
      integrationCommit: integrationHead,
      message: "task",
    });
    expect(captured?.baseCommit).toBe(integrationHead);

    const merged = await port.merge({
      cwd: integration,
      commit: captured?.headCommit ?? "",
      message: "m",
    });
    expect(merged.ok).toBe(true);
    expect(await port.currentBranch(integration)).toBe("renamed-by-namer");
  });

  test("isClean sees untracked and modified files", async () => {
    expect(await port.isClean(work)).toBe(true);
    await writeFile(join(work, "stray.txt"), "x\n");
    expect(await port.isClean(work)).toBe(false);
  });
});
