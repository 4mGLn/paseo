import { z } from "zod";

/** Dispatch acknowledgment describes admission, never provider completion. */
export const AgentDispatchSchema = z.object({
  disposition: z.enum(["turn_started", "steered", "out_of_band", "suppressed"]),
  tracking: z.enum(["turn", "unavailable"]),
});
export type AgentDispatch = z.infer<typeof AgentDispatchSchema>;
export interface AgentSendResult {
  submissionId: string;
  // Older receipts/hosts did not record dispatch evidence.
  disposition: AgentDispatch["disposition"] | "unknown";
  tracking: AgentDispatch["tracking"];
}
