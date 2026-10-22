import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { PiRpcAgentClient } from "../agent/providers/pi/agent.js";

// Linux process census, restricted to the provider belonging to this test's agent.
function piProcesses(agentId: string): number[] {
  return readdirSync("/proc").flatMap((name) => {
    if (!/^\d+$/.test(name)) return [];
    try {
      const args = readFileSync(`/proc/${name}/cmdline`, "utf8");
      if (args.split("\0")[0] !== "pi") return [];
      const env = readFileSync(`/proc/${name}/environ`, "utf8").split("\0");
      if (!env.includes(`PASEO_AGENT_ID=${agentId}`)) return [];
      return [Number(name)];
    } catch {
      // Processes can exit during the census, and unrelated processes can be private.
      return [];
    }
  });
}

// No inference is needed: an idle, empty native session reproduces the leak.
test
  .runIf(process.platform === "linux" && process.env.PASEO_ARCHIVED_PI_QA === "1")
  .each(["timeline", "attention"] as const)(
  "reading archived Pi %s does not retain a provider process",
  async (operation) => {
    const cwd = mkdtempSync(path.join(tmpdir(), "paseo-pi-archive-"));
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { pi: new PiRpcAgentClient({ logger }) },
      pluginsEnabled: false,
      logger,
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${daemon.port}/ws`,
      appVersion: "0.12.0",
    });
    let agentId: string | undefined;
    try {
      await client.connect();
      await client.fetchAgents({ subscribe: {} });
      const agent = await client.createAgent({
        provider: "pi",
        cwd,
        title: "archived Pi process regression",
      });
      agentId = agent.id;
      await client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "idle");
      expect(piProcesses(agent.id)).toHaveLength(1);
      await client.archiveAgent(agent.id);
      await expect.poll(() => piProcesses(agent.id), { timeout: 10_000 }).toEqual([]);

      if (operation === "timeline") {
        await client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
      } else {
        await client.clearAgentAttention(agent.id);
      }

      const processes = piProcesses(agent.id);
      expect((await daemon.daemon.agentStorage.get(agent.id))?.archivedAt).toBeTruthy();
      process.stdout.write(`${operation}: after archive=0; after read=${processes.length}\n`);
      await expect.poll(() => piProcesses(agent.id), { timeout: 3_000 }).toEqual([]);
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
      if (agentId) {
        const closedAgentId = agentId;
        await expect.poll(() => piProcesses(closedAgentId), { timeout: 10_000 }).toEqual([]);
      }
    }
  },
  180_000,
);
