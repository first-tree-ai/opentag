import type { Skill } from "@opentag/shared/browser";
import { type RefObject, useEffect, useRef } from "react";
import { ApiError } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog } from "../../ui/design-system.js";
import { skillErrorMessage } from "./skills-page-model.js";
import { useRemoveSkill } from "./skills-queries.js";

/**
 * Confirms replacing a name-identical Skill.
 *
 * Presentational on purpose: the page owns the pending archive and the upload mutation, so the
 * confirm button only re-submits that same object with `replace: true`. Cancelling drops it, which is
 * what keeps a name conflict from silently overwriting an existing Skill.
 */
export function ReplaceSkillDialog({
  archiveName,
  busy,
  onCancel,
  onConfirm,
}: {
  archiveName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      busy={busy}
      description={m.skills_replace_description()}
      onClose={onCancel}
      role="alertdialog"
      title={m.skills_replace_title({ name: archiveName })}
    >
      <div className="flex justify-end gap-2">
        <Button disabled={busy} onClick={onCancel} variant="ghost">
          {m.common_cancel()}
        </Button>
        <Button
          aria-label={busy ? m.skills_replace_in_progress() : m.skills_replace_confirm()}
          aria-busy={busy}
          loading={busy}
          onClick={onConfirm}
          variant="danger"
        >
          {busy ? m.skills_replace_in_progress() : m.skills_replace_confirm()}
        </Button>
      </div>
    </Dialog>
  );
}

/** Confirms removing one Skill and its stored archive; the failure is shown inside the dialog. */
export function RemoveSkillDialog({
  onClose,
  returnFocusRef,
  skill,
}: {
  onClose: (removed: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  skill: Skill | undefined;
}) {
  // The delete carries the Skill's own Agent id, so the dialog can only ever delete the record it
  // was opened for.
  const remove = useRemoveSkill();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { reset } = remove;
  useEffect(() => {
    if (!skill) reset();
  }, [skill, reset]);
  const error = remove.error;
  const message = error ? skillErrorMessage(error instanceof ApiError ? error.code : undefined) : undefined;

  const submit = async () => {
    if (!skill || remove.isPending) return;
    try {
      await remove.mutateAsync({ agentId: skill.agentId, skillId: skill.id });
      onClose(true);
    } catch {
      // The mutation error remains visible in this dialog so the user can retry.
    }
  };

  return (
    <Dialog
      busy={remove.isPending}
      initialFocusRef={cancelRef}
      open={skill !== undefined}
      returnFocusRef={returnFocusRef}
      description={m.skills_delete_description()}
      onClose={() => onClose(false)}
      role="alertdialog"
      title={skill ? m.skills_delete_title({ name: skill.name }) : m.skills_delete_action()}
    >
      <div className="grid gap-3">
        {message ? <Banner variant="error">{message}</Banner> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={remove.isPending} onClick={() => onClose(false)} ref={cancelRef} variant="ghost">
            {m.common_cancel()}
          </Button>
          <Button
            aria-label={remove.isPending ? m.skills_delete_in_progress() : m.skills_delete_confirm()}
            aria-busy={remove.isPending}
            loading={remove.isPending}
            onClick={submit}
            variant="danger"
          >
            {remove.isPending ? m.skills_delete_in_progress() : m.skills_delete_confirm()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
