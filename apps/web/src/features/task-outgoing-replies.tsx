import type { TaskTurn } from "@opentag/shared/browser";
import { formatDateTime } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { Collapsible } from "../ui/design-system.js";
import { TaskMessageBody } from "./task-message-body.js";

type OutgoingSnapshot = NonNullable<NonNullable<TaskTurn["report"]>["outgoingReplies"]>;
type OutgoingReply = OutgoingSnapshot["replies"][number];

export function TaskOutgoingReplies({ snapshot }: { snapshot: OutgoingSnapshot }) {
  return (
    <div className="grid gap-3" data-ui="task-sent-replies">
      {snapshot.replies.map((reply) => (
        <OutgoingReplyView key={reply.messageId} reply={reply} />
      ))}
      {snapshot.status === "incomplete" || (snapshot.omittedCount ?? 0) > 0 ? (
        <p className="text-sm text-kumo-subtle" data-ui="task-reply-incomplete">
          {m.tasks_reply_incomplete()}
        </p>
      ) : null}
    </div>
  );
}

function OutgoingReplyView({ reply }: { reply: OutgoingReply }) {
  const content = reply.content;
  const typeLabel = replyTypeLabel(content.msgType);
  const meta = [typeLabel, replyTime(reply.createTime)].filter(Boolean).join(" · ");
  return (
    <article className="grid gap-2" data-ui="task-sent-reply" data-msg-type={content.msgType}>
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong className="text-sm">{m.tasks_sent_reply()}</strong>
        {meta ? <small className="text-kumo-subtle">{meta}</small> : null}
      </header>
      <OutgoingReplyBody reply={reply} />
      {content.unavailable === "content_truncated" ? (
        <p className="text-sm text-kumo-subtle" data-ui="task-reply-content-truncated">
          {m.tasks_reply_content_truncated()}
        </p>
      ) : null}
    </article>
  );
}

function OutgoingReplyBody({ reply }: { reply: OutgoingReply }) {
  const content = reply.content;
  if (
    content.unavailable === "content_read_failed" &&
    !content.text &&
    !content.post &&
    !content.raw &&
    !content.filename
  ) {
    return (
      <p className="text-sm text-kumo-subtle" data-ui="task-reply-content-unavailable">
        {m.tasks_reply_content_unavailable()}
      </p>
    );
  }
  if (content.msgType === "text" && content.text !== undefined) {
    return <TaskMessageBody format="plain_text" text={content.text} />;
  }
  if (content.msgType === "post") {
    return (
      <div className="grid min-w-0 gap-2">
        {content.text ? <TaskMessageBody format="plain_text" text={content.text} /> : null}
        <RawPayload payload={content.post ?? content.raw} />
      </div>
    );
  }
  if (content.msgType === "interactive") {
    return (
      <div className="grid gap-2">
        <p className="text-sm text-kumo-subtle">{replyTypeLabel("interactive")}</p>
        <RawPayload payload={content.raw ?? content.post} />
      </div>
    );
  }
  const mediaLabel = mediaDescription(content);
  if (mediaLabel) {
    return <p className="break-words text-sm">{mediaLabel}</p>;
  }
  if (content.text) return <TaskMessageBody format="plain_text" text={content.text} />;
  if (content.raw) return <RawPayload payload={content.raw} />;
  return (
    <p className="text-sm text-kumo-subtle" data-ui="task-reply-content-unavailable">
      {m.tasks_reply_content_unavailable()}
    </p>
  );
}

function RawPayload({ payload }: { payload: unknown }) {
  const text = typeof payload === "string" ? payload : payload === undefined ? "" : JSON.stringify(payload, null, 2);
  if (!text) {
    return (
      <p className="text-sm text-kumo-subtle" data-ui="task-reply-content-unavailable">
        {m.tasks_reply_content_unavailable()}
      </p>
    );
  }
  return (
    <Collapsible.Root className="min-w-0 text-sm">
      <Collapsible.DefaultTrigger>{m.tasks_reply_native_content()}</Collapsible.DefaultTrigger>
      <Collapsible.Panel>
        <pre
          className="mt-2 max-w-full overflow-x-auto rounded-md bg-kumo-recessed p-3 leading-5"
          data-content-format="raw"
        >
          {text}
        </pre>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function mediaDescription(content: OutgoingReply["content"]): string | undefined {
  const type = replyTypeLabel(content.msgType);
  const parts = [type];
  if (content.filename) parts.push(content.filename);
  if (content.fileKey) parts.push(content.fileKey);
  if (content.imageKey) parts.push(content.imageKey);
  if (parts.length === 1 && !content.filename && !content.fileKey && !content.imageKey) return undefined;
  return parts.join(" · ");
}

function replyTypeLabel(msgType: OutgoingReply["content"]["msgType"]): string {
  switch (msgType) {
    case "text":
      return m.tasks_reply_type_text();
    case "share_chat":
      return m.tasks_reply_type_shared_chat();
    case "share_user":
      return m.tasks_reply_type_shared_user();
    case "image":
      return m.tasks_reply_type_image();
    case "file":
      return m.tasks_reply_type_file();
    case "audio":
      return m.tasks_reply_type_audio();
    case "video":
      return m.tasks_reply_type_video();
    case "media":
      return m.tasks_reply_type_media();
    case "interactive":
      return m.tasks_reply_type_card();
    case "sticker":
      return m.tasks_reply_type_sticker();
    case "post":
      return m.tasks_reply_type_post();
    default:
      return m.tasks_reply_type_unknown();
  }
}

function replyTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  return Number.isFinite(date.getTime()) ? formatDateTime(date) : undefined;
}
