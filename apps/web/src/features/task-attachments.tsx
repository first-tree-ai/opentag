import type { TaskAttachment } from "@opentag/shared/browser";
import * as m from "../paraglide/messages.js";

export function TaskAttachments({ attachments }: { attachments: readonly TaskAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <ul className="grid gap-2 text-sm" aria-label={m.tasks_attachments()} data-ui="task-attachments">
      {attachments.map((attachment, index) => (
        <li className="grid gap-0.5 break-words" key={attachment.ordinal ?? index}>
          <span>{[attachmentType(attachment.kind), attachment.filename].filter(Boolean).join(" · ")}</span>
          {attachment.availability && attachment.availability !== "available" ? (
            <span className="text-xs text-kumo-subtle">{attachmentAvailability(attachment.availability)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function attachmentType(kind: TaskAttachment["kind"]): string {
  switch (kind) {
    case "image":
      return m.tasks_reply_type_image();
    case "audio":
      return m.tasks_reply_type_audio();
    case "video":
      return m.tasks_reply_type_video();
    default:
      return m.tasks_reply_type_file();
  }
}

function attachmentAvailability(availability: Exclude<TaskAttachment["availability"], "available" | undefined>) {
  switch (availability) {
    case "too_large":
      return m.tasks_attachment_too_large();
    case "unsupported":
      return m.tasks_attachment_unsupported();
    default:
      return m.tasks_attachment_unavailable();
  }
}
