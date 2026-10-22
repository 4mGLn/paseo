import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { test, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

test("an interrupted child's finish notification reaches its parent after daemon restart", async () => {
  const root = await mkdtemp(path.resolve(".restart-3061-"));
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  let mcp: Client | undefined;
  const daemonLog = path.join(root, "daemon.log");
  const logger = pino({ level: "warn" }, pino.destination({ dest: daemonLog, sync: true }));
  const start = () =>
    createTestPaseoDaemon({
      paseoHomeRoot: root,
      staticDir: path.join(root, "static"),
      cleanup: false,
      logger,
      agentClients: { claude: new ClaudeAgentClient({ logger: pino({ level: "silent" }) }) },
    });
  async function until(check: () => boolean, timeout = 90_000) {
    const deadline = Date.now() + timeout;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for observation");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    daemon = await start();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    const parent = await client.createAgent({
      provider: "claude",
      model: "haiku",
      modeId: "bypassPermissions",
      cwd: root,
      title: "Restart notification parent",
    });
    mcp = new Client({ name: "restart-repro", version: "1" });
    await mcp.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${daemon.port}/mcp/agents?callerAgentId=${parent.id}`),
      ),
    );
    async function child(prompt: string) {
      const result = await mcp!.callTool({
        name: "create_agent",
        arguments: {
          relationship: { kind: "subagent" },
          workspace: { kind: "current" },
          provider: "claude/haiku",
          title: "Restart notification child",
          initialPrompt: prompt,
          settings: { modeId: "bypassPermissions" },
        },
      });
      if (result.isError) throw new Error(JSON.stringify(result));
      const data = result.structuredContent as { agentId: string };
      expect(data.agentId).toBeTypeOf("string");
      return data.agentId;
    }
    const normal = await child("Reply with exactly CONTROL_DONE. Do not use any tools.");
    const notifications = () =>
      daemon!.daemon.agentManager
        .getTimeline(parent.id)
        .filter((item) => item.type === "tool_call" && item.agentMessage);
    await until(() => notifications().some((item) => JSON.stringify(item).includes(normal)));
    await until(() => daemon!.daemon.agentManager.getAgent(parent.id)?.lifecycle === "idle");
    console.log("CONTROL: normal child completion delivered to parent");
    const interrupted = await child(
      "Use Bash to run exactly: sleep 180. Wait for it to finish, then reply DONE. Do not run it in the background.",
    );
    await until(() =>
      daemon!.daemon.agentManager
        .getTimeline(interrupted)
        .some(
          (item) =>
            JSON.stringify(item).includes("sleep 180") &&
            JSON.stringify(item).includes("tool_call"),
        ),
    );
    expect(daemon.daemon.agentManager.getAgent(interrupted)?.lifecycle).toBe("running");
    console.log("BEFORE STOP: child running; parent notification count", notifications().length);
    await mcp.close();
    mcp = undefined;
    await client.close();
    client = undefined;
    await daemon.close();
    const shutdownErrors = (await readFile(daemonLog, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.msg === "Failed to notify caller agent" ||
          entry.msg === "Child finish wait stopped",
      )
      .map((entry) => ({ message: entry.msg, error: entry.err?.message }));
    console.log("SHUTDOWN notification errors", shutdownErrors);
    daemon = await start();
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    const childAfter = await client.fetchAgent({ agentId: interrupted });
    await new Promise((resolve) => setTimeout(resolve, 4000));
    const parentHistory = await client.fetchAgentTimeline(parent.id);
    console.log("AFTER RESTART: child status", childAfter?.agent.status);
    const history = JSON.stringify(parentHistory);
    console.log("AFTER RESTART: control callback retained", history.includes(normal));
    console.log(
      "AFTER RESTART: interrupted child notification present",
      history.includes(interrupted),
    );
    expect(history.includes(normal)).toBe(true);
    expect(history.includes(interrupted)).toBe(true);
  } finally {
    await mcp?.close();
    await client?.close();
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
