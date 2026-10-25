import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_GIT_PROCESS_POLICY } from "../../utils/git-process-scheduler.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import {
  createPersistedProjectRecord,
  createPersistedWorkspaceRecord,
} from "../workspace-registry.js";

// Diagnostic for #7760's Linux report. These are small independent checkouts,
// rather than the reporter's large linked worktrees. No agent turns are needed.
test("checkout status answers before its client timeout during a 200-workspace observation burst", async () => {
  // The regular Vitest config raises this cap to avoid fake-timer deadlocks.
  // This reproduction needs the actual production admission policy.
  const previousRate = process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND;
  process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND = String(
    DEFAULT_GIT_PROCESS_POLICY.maxProcessesPerSecond,
  );
  const root = mkdtempSync(join(tmpdir(), "paseo-checkout-burst-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "a.txt"), "base\n");
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Paseo Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "init",
  ]);
  const cwds = Array.from({ length: 200 }, (_, i) => {
    const cwd = join(root, `repo-${i}`);
    git(root, ["clone", "--local", "--quiet", repo, cwd]);
    git(cwd, ["remote", "remove", "origin"]);
    return cwd;
  });
  const registry = join(root, ".paseo", "projects");
  mkdirSync(registry, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(registry, "projects.json"),
    JSON.stringify(
      cwds.map((cwd, i) =>
        createPersistedProjectRecord({
          projectId: `prj_test_${i}`,
          rootPath: cwd,
          kind: "git",
          displayName: `repo-${i}`,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    ),
  );
  writeFileSync(
    join(registry, "workspaces.json"),
    JSON.stringify(
      cwds.map((cwd, i) =>
        createPersistedWorkspaceRecord({
          workspaceId: `wks_test_${i}`,
          projectId: `prj_test_${i}`,
          cwd,
          kind: "local_checkout",
          displayName: `repo-${i}`,
          createdAt: now,
          updatedAt: now,
        }),
      ),
    ),
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: {},
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientType: "browser",
  });
  try {
    await client.connect();
    await client.observeEvents(["checkout_status_update"]).ready;
    const status = await client.getCheckoutStatus(cwds[199]!);
    expect(status.isGit).toBe(true);
    expect(status.error).toBeNull();
  } finally {
    await client.close();
    await daemon.close();
    rmSync(root, { recursive: true, force: true });
    if (previousRate === undefined) delete process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND;
    else process.env.PASEO_GIT_MAX_PROCESSES_PER_SECOND = previousRate;
  }
}, 120_000);
