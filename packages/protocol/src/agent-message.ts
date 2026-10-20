import { AgentAddressSchema } from "./addresses.js";
import { z } from "zod";

/** Semantic provenance, independent of provider envelopes and timeline presentation. */
export const AgentMessageSchema = z.object({
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
  sender: z.object({
    id: z.string().min(1),
    address: AgentAddressSchema.optional(),
    title: z.string().min(1).optional(),
  }),
  text: z.string(),
});

export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Declared message provenance; authenticated principal/source ownership is separate. */
export const AgentMessageSourceSchema = z.object({
  agent: AgentAddressSchema,
  title: z.string().min(1).optional(),
  event: z.enum(["message", "finished", "errored", "permission-required", "closed"]),
});
export type AgentMessageSource = z.infer<typeof AgentMessageSourceSchema>;
