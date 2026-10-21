import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("reported #4748: a terminal process survives stopping its daemon", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "terminal-process-survival-"));
  const daemon = await createTestPaseoDaemon({ agentClients: {} });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: "terminal-process-survival",
    reconnect: { enabled: false },
  });
  let pid: number | undefined;
  try {
    await client.connect();
    const opened = await client.openProject(cwd);
    expect(opened.workspace, opened.error ?? undefined).toBeTruthy();
    const marker = path.join(cwd, "pid");
    const created = await client.createTerminal(cwd, "Process survival", undefined, {
      workspaceId: opened.workspace!.id,
      command: process.execPath,
      args: [
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
    });
    expect(created.terminal, created.error ?? undefined).toBeTruthy();
    await expect
      .poll(async () => {
        pid = Number(await readFile(marker, "utf8").catch(() => "0"));
        return pid > 0;
      })
      .toBe(true);
    expect(isAlive(pid!)).toBe(true);

    await client.close();
    await daemon.close();
    // Wait until the worker has applied shutdown before checking the contract.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(isAlive(pid!), "the original terminal process must still be alive").toBe(true);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
    if (pid && isAlive(pid)) process.kill(pid, "SIGTERM");
    await rm(cwd, { recursive: true, force: true });
  }
});
