import type { SkillOnConflict } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { type ChangeEvent, type DragEvent, type RefObject, useRef, useState } from "react";
import { ApiError, browserApi } from "../../api.js";
import * as m from "../../paraglide/messages.js";
import { Banner, Button, Dialog } from "../../ui/design-system.js";
import { skillFileRejection, skillUploadErrorMessage } from "./skill-format.js";
import { invalidateSkills } from "./skill-queries.js";

type UploadPhase = { kind: "idle" } | { kind: "uploading"; file: File } | { kind: "conflict"; file: File };

export interface SkillUpload {
  readonly busy: boolean;
  readonly conflict: File | null;
  readonly dragging: boolean;
  readonly error: string | undefined;
  readonly notice: string | undefined;
  readonly uploading: File | null;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly inputProps: {
    readonly accept: string;
    readonly hidden: true;
    readonly onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  };
  readonly dropZoneProps: {
    readonly "data-dragging": true | undefined;
    readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  openPicker(): void;
  confirmReplace(): void;
  dismissConflict(): void;
  dismissNotice(): void;
}

/**
 * One upload at a time, from the picker or a drop. The browser refuses what it can see for itself
 * — extension and size — before a request is made; the Server's `409` for a name it already holds
 * turns into a confirmation, and the same file is sent again with `onConflict=replace` only after
 * the reader agrees. Success re-reads every skill view, because a replacement changes the
 * assignments that list it too.
 */
export function useSkillUpload(): SkillUpload {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<UploadPhase>({ kind: "idle" });
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const busy = phase.kind === "uploading";

  async function upload(file: File, onConflict: SkillOnConflict) {
    setPhase({ kind: "uploading", file });
    setError(undefined);
    setNotice(undefined);
    try {
      const skill = await browserApi.uploadSkill(file, { onConflict });
      setNotice(
        onConflict === "replace"
          ? m.skills_upload_replaced({ name: skill.name })
          : m.skills_upload_success({ name: skill.name }),
      );
      setPhase({ kind: "idle" });
      await invalidateSkills(queryClient);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409 && onConflict === "fail") {
        setPhase({ kind: "conflict", file });
        return;
      }
      setPhase({ kind: "idle" });
      setError(skillUploadErrorMessage(cause));
    }
  }

  function accept(file: File | undefined) {
    if (!file || busy) return;
    const rejection = skillFileRejection(file);
    if (rejection) {
      setNotice(undefined);
      setError(rejection);
      return;
    }
    void upload(file, "fail");
  }

  return {
    busy,
    conflict: phase.kind === "conflict" ? phase.file : null,
    dragging,
    error,
    notice,
    uploading: phase.kind === "uploading" ? phase.file : null,
    inputRef,
    inputProps: {
      accept: ".zip,application/zip",
      hidden: true,
      onChange: (event) => {
        accept(event.target.files?.[0]);
        // Choosing the same file again must fire `change` again, so the control forgets this one.
        event.target.value = "";
      },
    },
    dropZoneProps: {
      "data-dragging": dragging || undefined,
      onDragOver: (event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = busy ? "none" : "copy";
        setDragging(true);
      },
      onDragLeave: (event) => {
        // Moving between children of the zone fires leave/over pairs; only leaving the zone counts.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDragging(false);
      },
      onDrop: (event) => {
        event.preventDefault();
        setDragging(false);
        accept(event.dataTransfer.files[0]);
      },
    },
    openPicker: () => inputRef.current?.click(),
    confirmReplace: () => {
      if (phase.kind === "conflict") void upload(phase.file, "replace");
    },
    dismissConflict: () => setPhase({ kind: "idle" }),
    dismissNotice: () => {
      setNotice(undefined);
      setError(undefined);
    },
  };
}

function carriesFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/** The outcome of the last upload, beside the control that started it. */
export function SkillUploadFeedback({ upload }: { upload: SkillUpload }) {
  if (upload.uploading) {
    return (
      <p className="text-sm text-kumo-subtle" data-ui="skills-upload-progress" role="status">
        {m.skills_uploading({ name: upload.uploading.name })}
      </p>
    );
  }
  if (upload.error) {
    return <Banner data-ui="skills-upload-error" description={upload.error} role="alert" variant="error" />;
  }
  if (upload.notice) {
    return <Banner data-ui="skills-upload-notice" description={upload.notice} role="status" variant="secondary" />;
  }
  return null;
}

export function SkillUploadConflictDialog({
  returnFocusRef,
  upload,
}: {
  returnFocusRef?: RefObject<HTMLElement | null>;
  upload: SkillUpload;
}) {
  if (!upload.conflict) return null;
  return (
    <Dialog
      description={m.skills_upload_conflict_description({ file: upload.conflict.name })}
      returnFocusRef={returnFocusRef}
      role="alertdialog"
      title={m.skills_upload_conflict_title()}
      onClose={upload.dismissConflict}
    >
      <div className="flex flex-wrap justify-end gap-3">
        <Button type="button" variant="ghost" onClick={upload.dismissConflict}>
          {m.common_cancel()}
        </Button>
        <Button type="button" variant="primary" onClick={upload.confirmReplace}>
          {m.skills_upload_conflict_replace()}
        </Button>
      </div>
    </Dialog>
  );
}
