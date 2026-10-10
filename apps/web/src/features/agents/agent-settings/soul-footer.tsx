import type { RefObject } from "react";
import * as m from "../../../paraglide/messages.js";
import { SettingsSaveActions } from "./settings-layout.js";

export function SoulFooter({
  busy,
  dirty,
  empty,
  feedback,
  footerRef,
  onDiscard,
}: {
  busy: boolean;
  dirty: boolean;
  empty: boolean;
  feedback: { kind: "error" | "success"; text: string } | undefined;
  footerRef: RefObject<HTMLDivElement | null>;
  onDiscard: () => void;
}) {
  if (!dirty && !feedback) return null;
  return (
    <div className="grid gap-3" ref={footerRef}>
      {dirty ? (
        <>
          <SettingsSaveActions
            busy={busy}
            discardLabel={m.agent_settings_soul_discard_action()}
            saveLabel={m.agent_settings_soul_apply_action()}
            savingLabel={m.agent_settings_soul_applying_action()}
            statusLabel={null}
            onDiscard={onDiscard}
          />
          {empty ? <p className="text-sm text-kumo-subtle">{m.agent_settings_soul_clear_notice()}</p> : null}
          <p className="text-xs leading-relaxed text-kumo-subtle">{m.agent_settings_soul_next_turn_notice()}</p>
        </>
      ) : null}
      {feedback ? (
        <p
          className={feedback.kind === "error" ? "text-sm text-kumo-danger" : "text-sm text-kumo-subtle"}
          role={feedback.kind === "error" ? "alert" : "status"}
        >
          {feedback.text}
        </p>
      ) : null}
    </div>
  );
}
