import type { HostRuntime, PaseoApi } from "@getpaseo/client";
import { z } from "zod";
import type { PaseoToolResult } from "./types.js";

/** Resolves one ordinary API scope and preserves operation evidence through cleanup and MCP serialization. */
export async function executeHostTool(
  resolveRuntime: () => Promise<HostRuntime>,
  requestedServerId: string | undefined,
  execute: (
    api: PaseoApi,
    identity: { serverId: string; originServerId: string },
  ) => Promise<PaseoToolResult>,
): Promise<PaseoToolResult> {
  let serverId = requestedServerId;
  try {
    const runtime = await resolveRuntime();
    const originServerId = (await runtime.directory()).self.serverId;
    serverId ??= originServerId;
    const api = await runtime.client(serverId);
    let result: PaseoToolResult;
    let payload: Record<string, unknown>;
    try {
      result = await execute(api, { serverId, originServerId });
      payload = z.record(z.string(), z.unknown()).parse(result.structuredContent);
    } catch (error) {
      // The action owns its outcome. Failed cleanup cannot replace evidence that
      // a submitted operation has an unknown outcome.
      await api.dispose().catch(() => {});
      throw error;
    }
    let cleanupError: ReturnType<typeof describeError> | undefined;
    try {
      await api.dispose();
    } catch (error) {
      cleanupError = describeError(error);
    }
    return {
      ...result,
      structuredContent: {
        ...payload,
        serverId,
        ...(cleanupError ? { scopeCleanupError: cleanupError } : {}),
      },
    };
  } catch (error) {
    return {
      content: [],
      isError: true,
      structuredContent: { ...(serverId ? { serverId } : {}), ...describeError(error) },
    };
  }
}
function describeError(error: unknown): {
  error: string;
  code?: string;
  outcome?: "unknown";
  cause?: string;
} {
  const details = error instanceof Error ? error : new Error(String(error));
  return {
    error: details.message,
    ...("code" in details && typeof details.code === "string" ? { code: details.code } : {}),
    ...("outcome" in details && details.outcome === "unknown"
      ? { outcome: "unknown" as const }
      : {}),
    ...("cause" in details && typeof details.cause === "string" ? { cause: details.cause } : {}),
  };
}
