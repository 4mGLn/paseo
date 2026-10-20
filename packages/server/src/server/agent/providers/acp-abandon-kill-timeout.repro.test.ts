import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { ACPAgentSession } from "./acp-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

const source = `
import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
const { AgentSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import(process.env.ACP_SDK_URL);
appendFileSync(process.env.PROBE_PIDS, String(process.pid) + '\\n');
new AgentSideConnection(() => ({
  async initialize() { return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true } }; },
  async newSession() { return { sessionId: 'held-session' }; },
  async loadSession() { return {}; },
  async authenticate() {},
  prompt() { return new Promise(() => {}); },
  async cancel() {},
}), ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`;

test("a failed abandoned-runtime kill must block a second provider process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "acp-abandon-timeout-"));
  const script = path.join(dir, "agent.mjs");
  const pidFile = path.join(dir, "pids");
  await writeFile(script, source);
  let allowTermination = false;
  const session = new ACPAgentSession(
    { provider: "abandon-probe", cwd: dir },
    {
      provider: "abandon-probe",
      logger: createTestLogger(),
      defaultCommand: [process.execPath, script],
      defaultModes: [],
      capabilities: {
        supportsStreaming: true,
        supportsSessionPersistence: true,
        supportsDynamicModes: true,
        supportsMcpServers: true,
        supportsReasoningStream: true,
        supportsToolInvocations: true,
      },
      launchEnv: {
        ACP_SDK_URL: pathToFileURL(
          createRequire(import.meta.url).resolve("@agentclientprotocol/sdk"),
        ).href,
        PROBE_PIDS: pidFile,
      },
      // Inject the documented termination result; the ACP subprocess itself is real.
      terminateProcess: (child, options) =>
        allowTermination ? terminateWithTreeKill(child, options) : Promise.resolve("kill-timeout"),
    },
  );
  try {
    await session.initializeNewSession();
    await session.startTurn("first");
    await expect(session.abandonForegroundTurn()).rejects.toThrow("provider process did not exit");
    const firstPid = Number((await readFile(pidFile, "utf8")).trim());
    expect(() => process.kill(firstPid, 0)).not.toThrow();
    const next = await session.startTurn("second").then(
      () => "started",
      () => "refused",
    );
    const pids = (await readFile(pidFile, "utf8")).trim().split("\n").map(Number);
    for (const pid of pids) expect(() => process.kill(pid, 0)).not.toThrow();
    console.log({ next, liveProviderProcesses: pids.length });
    expect(next).toBe("refused");
    expect(pids).toHaveLength(1);
  } finally {
    allowTermination = true;
    await session.close();
    const pids = await readFile(pidFile, "utf8").catch(() => "");
    for (const pid of pids.trim().split("\n").filter(Boolean).map(Number)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await rm(dir, { recursive: true, force: true });
  }
});
