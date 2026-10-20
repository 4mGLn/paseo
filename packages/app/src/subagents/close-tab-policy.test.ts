import { managedAgentFields } from "@/subagents/test-fixtures";
import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  it("archives root agents when their tab closes", () => {
    expect(resolveCloseAgentTabPolicy({ managedRelationship: null })).toEqual({
      kind: "archive-on-close",
    });
  });

  it("keeps subagent tab close layout-only", () => {
    expect(
      resolveCloseAgentTabPolicy(
        managedAgentFields({ serverId: "server-1", agentId: "parent-agent" }),
      ),
    ).toEqual({
      kind: "layout-only",
    });
  });

  it("preserves the existing archive fallback when the agent is missing", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "archive-on-close" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "archive-on-close" });
  });
});
