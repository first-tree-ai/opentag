import { type RefObject, useRef } from "react";
import * as m from "../../../paraglide/messages.js";
import { Button } from "../../../ui/design-system.js";

const feedbackRoles = { error: "alert", success: "status" } as const;

export function SoulFooter({
  busy,
  dirty,
  editing,
  empty,
  editRef,
  feedback,
  onDiscard,
  onEdit,
}: {
  busy: boolean;
  dirty: boolean;
  editing: boolean;
  empty: boolean;
  editRef: RefObject<HTMLButtonElement | null>;
  feedback: { kind: "error" | "success"; text: string } | undefined;
  onDiscard: () => void;
  onEdit: () => void;
}) {
  const text = feedback?.text ?? draftNotice(editing, dirty, empty);
  const reservedText = useRef<string>("");
  if (text) reservedText.current = text;
  if (empty && !editing && !text && !reservedText.current) return null;
  return (
    <div
      className="flex min-h-[57px] flex-wrap items-center justify-between gap-3 border-t border-kumo-line pt-3 md:min-h-[53px]"
      data-ui="soul-actions"
    >
      <span
        className={`min-w-0 flex-1 basis-48 text-xs leading-relaxed ${feedback?.kind === "error" ? "text-kumo-danger" : "text-kumo-subtle"}`}
        // Retain the same text geometry after feedback expires, without leaving a visible or spoken notice.
        style={{ visibility: text ? "visible" : "hidden" }}
        aria-hidden={!text || undefined}
        role={feedback ? feedbackRoles[feedback.kind] : undefined}
      >
        {text ?? reservedText.current}
      </span>
      {editing ? (
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button disabled={busy} type="button" variant="ghost" onClick={onDiscard}>
            {m.common_cancel()}
          </Button>
          <Button disabled={busy || !dirty} type="submit">
            {busy ? m.agent_settings_saving_action() : m.agent_settings_save_changes_action()}
          </Button>
        </div>
      ) : !empty ? (
        <Button disabled={busy} ref={editRef} type="button" variant="secondary" onClick={onEdit}>
          {m.agent_settings_soul_edit_action()}
        </Button>
      ) : null}
    </div>
  );
}

function draftNotice(editing: boolean, dirty: boolean, empty: boolean) {
  if (!editing || !dirty) return undefined;
  return empty ? m.agent_settings_soul_clear_notice() : m.agent_settings_soul_next_turn_notice();
}
