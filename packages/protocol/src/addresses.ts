import { z } from "zod";

export const AgentAddressSchema = z.object({
  serverId: z.string().min(1),
  agentId: z.string().min(1),
});

export const WorkspaceAddressSchema = z.object({
  serverId: z.string().min(1),
  workspaceId: z.string().min(1),
});

export type AgentAddress = z.infer<typeof AgentAddressSchema>;
export type WorkspaceAddress = z.infer<typeof WorkspaceAddressSchema>;
