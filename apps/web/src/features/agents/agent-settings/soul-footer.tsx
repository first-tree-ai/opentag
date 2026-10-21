import * as m from "../../../paraglide/messages.js";
import { SettingsSaveActions } from "./settings-layout.js";

export function SoulFooter({
  busy,
  dirty,
  empty,
  feedback,
  onDiscard,
}: {
  busy: boolean;
  dirty: boolean;
  empty: boolean;
  feedback: { kind: "error" | "success"; text: string } | undefined;
  onDiscard: () => void;
}) {
  if (!dirty && !feedback) return null;
  const text =
    feedback?.text ?? (empty ? m.agent_settings_soul_clear_notice() : m.agent_settings_soul_next_turn_notice());
  return (
    <SettingsSaveActions
      busy={busy}
      discardLabel={m.agent_settings_soul_discard_action()}
      saveLabel={m.agent_settings_soul_apply_action()}
      savingLabel={m.agent_settings_soul_applying_action()}
      showActions={dirty}
      statusLabel={
        <span
          className={
            feedback?.kind === "error"
              ? "text-xs leading-relaxed text-kumo-danger"
              : "text-xs leading-relaxed text-kumo-subtle"
          }
          role={feedback?.kind === "error" ? "alert" : feedback?.kind === "success" ? "status" : undefined}
        >
          {text}
        </span>
      }
      onDiscard={onDiscard}
    />
  );
}
