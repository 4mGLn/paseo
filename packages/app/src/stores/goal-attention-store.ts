import { create } from "zustand";

interface GoalAttentionStoreState {
  /** Goals blocked on your approval, per host, from the last poll. */
  blockedByServer: Record<string, number>;
  setBlocked: (serverId: string, count: number) => void;
  clear: (serverId: string) => void;
}

/** Written by `GoalAttentionWatcher`, read by the sidebar's Goals badge. */
export const useGoalAttentionStore = create<GoalAttentionStoreState>()((set) => ({
  blockedByServer: {},
  setBlocked: (serverId, count) => {
    set((state) =>
      state.blockedByServer[serverId] === count
        ? state
        : { blockedByServer: { ...state.blockedByServer, [serverId]: count } },
    );
  },
  clear: (serverId) => {
    set((state) => {
      if (!(serverId in state.blockedByServer)) {
        return state;
      }
      const { [serverId]: _removed, ...rest } = state.blockedByServer;
      return { blockedByServer: rest };
    });
  },
}));

export function selectTotalBlockedGoals(state: GoalAttentionStoreState): number {
  return Object.values(state.blockedByServer).reduce((sum, count) => sum + count, 0);
}
