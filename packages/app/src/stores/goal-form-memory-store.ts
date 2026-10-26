import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { GoalFormMemory } from "@/goals/goal-form-memory";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const GoalSettingsSchema = z.strictObject({
  maxParallel: z.number(),
  maxAttempts: z.number(),
  maxReworkRounds: z.number(),
  maxTasks: z.number(),
  maxRuns: z.number(),
  runTimeoutMinutes: z.number(),
  goalTimeoutMinutes: z.number(),
  retryBackoffSeconds: z.number(),
  autoApprovePlan: z.boolean(),
  requireHumanApproval: z.boolean(),
  onPermissionRequest: z.enum(["fail", "wait"]),
  notifyLead: z.boolean(),
});

const GoalFormMemorySchema = z.strictObject({
  cwd: z.string(),
  leadProvider: z.string(),
  defaultProvider: z.string(),
  reviewProvider: z.string().nullable(),
  testCommand: z.string().nullable(),
  allowedProviders: z.array(z.string()),
  settings: GoalSettingsSchema,
}) satisfies z.ZodType<GoalFormMemory>;

const GoalFormMemoryPersistedSchema = z.strictObject({
  byServer: z.record(z.string(), GoalFormMemorySchema),
});

interface GoalFormMemoryStoreState {
  /** Your last managed goal on each host. */
  byServer: Record<string, GoalFormMemory>;
  remember: (serverId: string, memory: GoalFormMemory) => void;
}

/** Seeds the next goal on a host from the last one you created there. */
export const useGoalFormMemoryStore = create<GoalFormMemoryStoreState>()(
  persist(
    (set) => ({
      byServer: {},
      remember: (serverId, memory) => {
        set((state) => ({ byServer: { ...state.byServer, [serverId]: memory } }));
      },
    }),
    {
      name: "goal-form-memory",
      storage: createValidatedPersistStorage(AsyncStorage, GoalFormMemoryPersistedSchema),
      partialize: (state) => ({ byServer: state.byServer }),
      version: 1,
    },
  ),
);
