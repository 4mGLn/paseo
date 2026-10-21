import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { View } from "react-native";
import { Users } from "lucide-react-native";
import type { AgentTeamSummary } from "@getpaseo/protocol/messages";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useComposerControlLayout } from "@/composer/agent-controls/layout-context";

const NO_TEAM_ID = "";

export interface AgentTeamControlValue {
  teams: AgentTeamSummary[];
  selectedTeam: string | null;
  onSelectTeam: (team: string | null) => void;
  disabled?: boolean;
}

/** The new-chat team picker. Callers render it only when the host defines teams. */
export function AgentTeamControl({
  teams,
  selectedTeam,
  onSelectTeam,
  disabled = false,
  surface = "toolbar",
  onClose,
}: AgentTeamControlValue & { surface?: "toolbar" | "sheet"; onClose?: () => void }) {
  const { t } = useTranslation();
  const { presentation } = useComposerControlLayout();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const options = useMemo<ComboboxOption[]>(
    () => [
      { id: NO_TEAM_ID, label: t("agentControls.team.none") },
      ...teams.map((team) => ({
        id: team.name,
        label: team.name,
        description: team.roles.map((role) => role.name).join(", "),
      })),
    ],
    [t, teams],
  );
  const valueLabel = selectedTeam ?? t("agentControls.team.none");

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) onClose?.();
    },
    [onClose],
  );
  const handlePress = useCallback(() => setOpen((current) => !current), []);
  const handleSelect = useCallback(
    (id: string) => {
      onSelectTeam(id === NO_TEAM_ID ? null : id);
      handleOpenChange(false);
    },
    [handleOpenChange, onSelectTeam],
  );

  return (
    <>
      <AgentControlTrigger
        ref={anchorRef}
        icon={Users}
        surface={surface}
        label={t("agentControls.team.title")}
        value={valueLabel}
        showToolbarLabel={selectedTeam !== null && presentation.showModeLabel}
        showCaret={surface === "toolbar" && presentation.showCarets}
        open={open}
        disabled={disabled}
        onPress={handlePress}
        accessibilityLabel={t("agentControls.team.selectWithValue", { value: valueLabel })}
        testID="team-control"
      />
      <Combobox
        options={options}
        value={selectedTeam ?? NO_TEAM_ID}
        onSelect={handleSelect}
        open={open}
        onOpenChange={handleOpenChange}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={260}
        title={t("agentControls.team.title")}
      />
    </>
  );
}
