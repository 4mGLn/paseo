import { z } from "zod";
import { AgentAddressSchema } from "./addresses.js";

export const AgentRunCheckpointSchema = z.object({
  sequence: z.number().int().positive(),
  kind: z.enum([
    "interrupted",
    "submitted",
    "running",
    "permission",
    "resumed",
    "completed",
    "failed",
    "canceled",
  ]),
  at: z.string(),
  permissionRequestId: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
});
export type AgentRunCheckpoint = z.infer<typeof AgentRunCheckpointSchema>;
export const AgentRunRecordSchema = z.object({
  agent: AgentAddressSchema,
  submissionId: z.string(),
  turnId: z.string().nullable(),
  durability: z.enum(["persisted", "pending"]).optional(),
  status: z.enum([
    "interrupted",
    "submitted",
    "running",
    "permission",
    "completed",
    "failed",
    "canceled",
  ]),
  checkpoints: z.array(AgentRunCheckpointSchema),
});
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>;
export const AgentRunGetRequestSchema = z.object({
  type: z.literal("agent.runs.get.request"),
  requestId: z.string(),
  agentId: z.string(),
  submissionId: z.string(),
});
export const AgentRunGetResponseSchema = z.object({
  type: z.literal("agent.runs.get.response"),
  payload: z.object({ requestId: z.string(), run: AgentRunRecordSchema.nullable() }),
});
