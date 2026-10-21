import { useEffect, useState } from "react";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { openGoalForm, type GoalFormModel, type GoalFormPrefill } from "./goal-form-model";

/** One model per mount (docs/forms.md): later prop changes never rebuild it. */
export function useGoalFormModel(prefill: GoalFormPrefill | undefined): GoalFormModel {
  const [model] = useState(() => openGoalForm({ prefill }));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  return model;
}

/** Pipes the host's registered providers into the model once the goal runs with agents. */
export function useGoalFormProviderOptions(input: {
  model: GoalFormModel;
  serverId: string;
  enabled: boolean;
}) {
  const { model, serverId, enabled } = input;
  const snapshot = useProvidersSnapshot(serverId, { enabled });

  useEffect(() => {
    if (!enabled || !snapshot.entries) {
      return;
    }
    model.applyProviderOptions(
      buildSelectableProviderSelectorProviders(snapshot.entries).map(({ id, label }) => ({
        id,
        label,
      })),
    );
  }, [enabled, model, snapshot.entries]);

  return snapshot;
}
