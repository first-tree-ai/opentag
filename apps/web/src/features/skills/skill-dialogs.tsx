import type { Skill } from "@opentag/shared/browser";
import { useState } from "react";
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
      title={m.skills_replace_title({ name: archiveName })}
    >
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} variant="ghost">
          {m.common_cancel()}
        </Button>
        <Button disabled={busy} onClick={onConfirm} variant="primary">
          {m.skills_replace_confirm()}
        </Button>
      </div>
    </Dialog>
  );
}

/** Confirms removing one Skill and its stored archive; the failure is shown inside the dialog. */
export function RemoveSkillDialog({ agentId, onClose, skill }: { agentId: string; onClose: () => void; skill: Skill }) {
  const remove = useRemoveSkill(agentId);
  const [error, setError] = useState<string | undefined>();

  const submit = async () => {
    setError(undefined);
    try {
      await remove.mutateAsync(skill.id);
      onClose();
    } catch (cause) {
      setError(skillErrorMessage(cause instanceof ApiError ? cause.code : undefined));
    }
  };

  return (
    <Dialog
      busy={remove.isPending}
      description={m.skills_delete_description()}
      onClose={onClose}
      role="alertdialog"
      title={m.skills_delete_title({ name: skill.name })}
    >
      <div className="grid gap-3">
        {error ? <Banner variant="error">{error}</Banner> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            {m.common_cancel()}
          </Button>
          <Button disabled={remove.isPending} onClick={submit} variant="danger">
            {m.skills_delete_confirm()}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
