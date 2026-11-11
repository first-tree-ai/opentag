import {
  TASK_CANCELLED_DELIVERY_REASON,
  type TaskSummary,
  type TaskTurn,
  type TurnFailureReason,
} from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime, formatRelativeTime } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { Button, Icon, StatusIndicator, Text, Tooltip } from "../ui/design-system.js";
import { AgentAvatar } from "./agents/agent-avatar.js";
import { TaskActivityTimeline } from "./task-activity-timeline.js";
import { TaskAttachments } from "./task-attachments.js";
import type { TaskInternalSessionItem } from "./task-detail-view.js";
import { TaskMessageBody } from "./task-message-body.js";
import {
  TaskCapturedReply,
  TaskCapturedReplyMeta,
  TaskOutgoingReply,
  TaskOutgoingReplyMeta,
} from "./task-outgoing-replies.js";
import { taskStatusLabel, taskStatusTone } from "./task-status.js";
import { buildTaskTimeline, type CapturedTaskReply, type TaskReport, type TaskTimelineEntry } from "./task-timeline.js";

export function TaskActivity({
  task,
  turns,
  emptyStateHidden = false,
  replies,
  pagination,
  repliesStatus,
}: {
  task: TaskSummary;
  turns: TaskTurn[];
  /** Leaves out the empty conversation's explanation, for a Task that has other work to show. */
  emptyStateHidden?: boolean;
  replies?: CapturedTaskReply[];
  pagination: ReactNode;
  repliesStatus?: ReactNode;
}) {
  /*
   * Supplying the replies feed — even empty while it loads, errors, or finds nothing — makes its
   * state authoritative. Legacy-only callers omit `replies` and keep the old per-report notices.
   */
  const capturedFeedSupplied = replies !== undefined;
  const entries = buildTaskTimeline(turns, task.source.provider, replies ?? []).filter((entry) =>
    taskEntryVisible(entry, task.source.provider, capturedFeedSupplied),
  );
  const sectionRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const autoScrolledTaskIdRef = useRef<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);

  const resolveScrollContainer = useCallback((candidate?: EventTarget | null): HTMLElement | null => {
    if (candidate instanceof HTMLElement && candidate.scrollHeight > 0) return candidate;
    const content = sectionRef.current?.closest<HTMLElement>('[data-ui="content"]');
    if (content && content.scrollHeight > 0) return content;
    if (document.scrollingElement instanceof HTMLElement && document.scrollingElement.scrollHeight > 0) {
      return document.scrollingElement;
    }
    return content ?? sectionRef.current ?? (document.scrollingElement as HTMLElement | null);
  }, []);

  const updateScrollState = useCallback(
    (candidate?: EventTarget | null) => {
      const target = resolveScrollContainer(candidate);
      if (!target) return;
      const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
      setShowJumpToLatest(distanceFromBottom > 48);
    },
    [resolveScrollContainer],
  );

  useEffect(() => {
    if (entries.length === 0 || autoScrolledTaskIdRef.current === task.id) return;
    autoScrolledTaskIdRef.current = task.id;
    const target = resolveScrollContainer();
    if (target) {
      target.scrollTo?.({ top: target.scrollHeight, behavior: "instant" as ScrollBehavior });
      if (target.scrollHeight > 0) {
        target.scrollTop = target.scrollHeight;
      }
    }
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [entries.length, resolveScrollContainer, task.id]);

  useEffect(() => {
    const content = sectionRef.current?.closest<HTMLElement>('[data-ui="content"]');
    const onScroll = (event: Event) => updateScrollState(event.currentTarget ?? event.target);
    content?.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      content?.removeEventListener("scroll", onScroll);
      window.removeEventListener("scroll", onScroll);
    };
  }, [updateScrollState]);

  const scrollToLatest = () => {
    const target = resolveScrollContainer();
    if (target) {
      target.scrollTo?.({ top: target.scrollHeight, behavior: "smooth" });
      target.scrollTop = target.scrollHeight;
    }
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
    setShowJumpToLatest(false);
  };

  return (
    <section
      ref={sectionRef}
      className="relative grid w-full grid-cols-1 gap-5"
      aria-labelledby="task-activity-title"
      data-ui="task-thread"
      onScroll={(event) => updateScrollState(event.currentTarget)}
    >
      <Text as="h2" id="task-activity-title" variant="heading" DANGEROUS_className="sr-only">
        {m.tasks_activity()}
      </Text>
      <TaskActivityTimeline key={task.id} entryIds={entries.map((entry) => entry.id)}>
        {pagination}
        {entries.length > 0 ? (
          <div className="grid grid-cols-1">
            {entries.map((entry) => (
              <div key={entry.id} className="py-4 first:pt-0 last:pb-0">
                <TaskEntry capturedFeedSupplied={capturedFeedSupplied} task={task} entry={entry} />
              </div>
            ))}
          </div>
        ) : !emptyStateHidden ? (
          <div className="grid gap-2">
            <Text as="h3" variant="heading">
              {m.tasks_no_activity()}
            </Text>
            <Text as="p" variant="secondary">
              {m.tasks_no_activity_detail()}
            </Text>
          </div>
        ) : null}
        {repliesStatus}
        <div ref={bottomRef} aria-hidden="true" />
      </TaskActivityTimeline>
      {showJumpToLatest && entries.length > 0 ? (
        <div className="sticky bottom-4 flex justify-center pointer-events-none">
          <Button
            type="button"
            size="compact"
            variant="secondary"
            className="pointer-events-auto rounded-full shadow-md"
            data-ui="task-activity-jump-latest"
            onClick={scrollToLatest}
          >
            <Icon name="chevron-down" />
            <span>{m.tasks_jump_to_latest()}</span>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The internal Sessions the Task's Session created, earliest first and ended ones included: what
 * each was asked to do (its title, or its id when it has none), whether it is still active, and
 * when it last did something. The id says nothing to most readers, so it waits in the title's tooltip
 * for whoever is diagnosing the run.
 */
export function TaskInternalSessionsList({
  sessions,
  footer,
}: {
  sessions: TaskInternalSessionItem[];
  /** Paging and error notices. They stay when no Session could be read. */
  footer?: ReactNode;
}) {
  if (sessions.length === 0) return <>{footer}</>;
  return (
    <section
      aria-labelledby="task-internal-sessions-title"
      className="grid grid-cols-1 gap-3"
      data-ui="task-internal-sessions"
    >
      <Text as="h2" headingSize="body" id="task-internal-sessions-title" variant="heading">
        {m.tasks_internal_sessions_heading()}
      </Text>
      <ul className="grid grid-cols-1 divide-y divide-kumo-line border-y border-kumo-line">
        {sessions.map((session) => {
          const activityAt = session.lastActivityAt ?? session.endedAt ?? session.createdAt;
          const preview = session.title?.trim() || session.runtimeModel || session.id;
          return (
            <li
              key={session.id}
              className="flex items-center justify-between gap-3 py-3 text-sm @min-[56rem]/content:flex-col @min-[56rem]/content:items-start @min-[56rem]/content:gap-1.5"
              data-ui="task-internal-session-row"
            >
              <TaskInternalSessionTitle id={session.id} preview={preview} />
              <div className="flex shrink-0 items-center gap-3">
                <InternalSessionStatus session={session} />
                <time
                  className="whitespace-nowrap text-xs text-kumo-subtle"
                  dateTime={activityAt}
                  title={formatDateTime(activityAt)}
                >
                  {formatRelativeTime(activityAt)}
                </time>
              </div>
            </li>
          );
        })}
      </ul>
      {footer}
    </section>
  );
}

/**
 * Two lines where a row's width would leave a single line only a few words: on narrow containers
 * and in the two-column layout's side column. One line on a full-width row.
 */
const internalSessionTitleClassName =
  "min-w-0 flex-1 line-clamp-2 wrap-anywhere text-kumo-default @min-[40rem]/content:line-clamp-1 @min-[56rem]/content:line-clamp-2 @min-[56rem]/content:flex-none @min-[56rem]/content:self-stretch";

/**
 * Hover and keyboard focus open the tooltip with the full title and the id. A tooltip is not exposed
 * to assistive technology on its own, so the id is also part of the title's text for screen readers.
 * A row named by its id has nothing more to show, so it is plain text rather than a focus stop.
 */
function TaskInternalSessionTitle({ id, preview }: { id: string; preview: string }) {
  if (preview === id) return <span className={internalSessionTitleClassName}>{preview}</span>;
  const idLabel = m.tasks_internal_session_id({ id });
  return (
    <Tooltip
      content={
        <span className="grid max-w-md gap-1 wrap-anywhere">
          <span>{preview}</span>
          <span>{idLabel}</span>
        </span>
      }
      render={
        // `relative` keeps the absolutely placed screen-reader text inside the clipped title; at its static position past the title's end it would widen the content region.
        <span
          className={`${internalSessionTitleClassName} relative rounded-sm focus-visible:outline-2 focus-visible:outline-kumo-focus`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The tooltip holds the id and full title, and keyboard users must be able to open it.
          tabIndex={0}
        />
      }
    >
      {preview}
      <span className="sr-only"> {idLabel}</span>
    </Tooltip>
  );
}

/**
 * An internal Session is active until it ends. A development example may still carry a Task status,
 * which reads as it does elsewhere.
 */
function InternalSessionStatus({ session }: { session: TaskInternalSessionItem }) {
  if (session.status) {
    return <StatusIndicator label={taskStatusLabel(session.status)} tone={taskStatusTone(session.status)} />;
  }
  return session.endedAt ? (
    <StatusIndicator label={m.tasks_internal_session_ended()} tone="neutral" />
  ) : (
    <StatusIndicator label={m.tasks_internal_session_active()} tone="info" />
  );
}

function TaskEntry({
  task,
  entry,
  capturedFeedSupplied,
}: {
  task: TaskSummary;
  entry: TaskTimelineEntry;
  capturedFeedSupplied: boolean;
}) {
  if (entry.kind === "captured") return <TaskCapturedReplyEntry task={task} entry={entry} />;
  const turn = entry.turn;
  if (entry.kind === "request") return <TaskRequest turn={turn} id={entry.id} />;
  const compact = entry.kind === "report" && entry.hasReplies;
  return (
    <article
      className={compact ? "grid gap-2 pl-11" : "grid grid-cols-[2rem_minmax(0,1fr)] gap-3"}
      data-ui="task-message-agent"
      data-task-entry-id={entry.id}
    >
      {!compact ? (
        <AgentAvatar
          displayName={task.agent.displayName}
          avatarPath={task.agent.avatarPath}
          className="size-8 text-xs font-medium text-kumo-strong"
        />
      ) : null}
      <div className="grid min-w-0 gap-2">
        {!compact ? (
          <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author-agent">
            <strong className="min-w-0 wrap-anywhere text-sm font-medium">{task.agent.displayName}</strong>
            <TaskAgentMeta entry={entry} />
          </header>
        ) : null}
        {/* biome-ignore lint/a11y/useSemanticElements: This groups message content, not form controls. */}
        <div
          className={compact ? "grid min-w-0 gap-3 text-sm" : "grid min-w-0 gap-3"}
          role="group"
          aria-label={m.tasks_agent_response()}
          data-ui="task-agent-response"
        >
          {entry.kind === "reply" ? (
            <TaskOutgoingReply reply={entry.reply} />
          ) : entry.kind === "report" ? (
            <TaskReportBody
              capturedFeedSupplied={capturedFeedSupplied}
              provider={task.source.provider}
              report={entry.report}
            />
          ) : (
            <TaskUnreportedBody delivery={turn.delivery} />
          )}
        </div>
      </div>
    </article>
  );
}

/** A message header names its author and time only; the body already says how the work went. */
function TaskAgentMeta({ entry }: { entry: TaskTimelineEntry }) {
  if (entry.kind === "reply") return <TaskOutgoingReplyMeta reply={entry.reply} />;
  if (entry.kind === "report") return <TaskReportMeta report={entry.report} />;
  return null;
}

function TaskRequest({ turn, id }: { turn: TaskTurn; id: string }) {
  const author = turn.message.authorDisplayName ?? taskAuthorLabel(turn.message.authorKind);
  const attachments = turn.message.attachments ?? [];
  return (
    <article
      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3"
      aria-label={m.tasks_message_sent_at({ time: formatDateTime(turn.message.occurredAt) })}
      data-ui="task-message-request"
      data-task-entry-id={id}
    >
      <AgentAvatar displayName={author} className="size-8 text-xs font-medium text-kumo-strong" />
      <div className="grid min-w-0 grid-cols-1 gap-2">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author">
          <strong className="min-w-0 wrap-anywhere text-sm font-medium">{author}</strong>
          <small className="text-xs text-kumo-subtle">{formatDateTime(turn.message.occurredAt)}</small>
        </header>
        {/* The fill follows the message, so a one-line request does not read as a wide empty panel. */}
        <div
          className="grid w-fit min-w-0 max-w-full gap-3 rounded-xl bg-kumo-recessed p-4"
          data-ui="task-message-request-body"
        >
          {turn.message.fallbackText || attachments.length === 0 ? (
            <TaskMessageBody format="plain_text" text={turn.message.fallbackText} />
          ) : null}
          <TaskAttachments attachments={attachments} />
          {turn.message.truncated ? <p className="text-sm text-kumo-subtle">{m.tasks_message_truncated()}</p> : null}
        </div>
        {turn.absorbedBy ? (
          <small className="text-xs text-kumo-subtle" title={m.tasks_included_in_active_work()}>
            {m.tasks_added_to_active_work()}
          </small>
        ) : null}
      </div>
    </article>
  );
}

function TaskReportMeta({ report }: { report: TaskReport }) {
  return <small className="text-xs text-kumo-subtle">{formatDateTime(report.reportedAt)}</small>;
}

/**
 * A report entry carries only what the conversation itself cannot show: a failure, or a notice about
 * the reply history. The runtime's final text repeats the reply the Agent already sent, so it is
 * never shown, and a report with nothing else to say leaves no entry. A Turn still running gets no
 * entry either until it sends a real reply: the Task status already says it is running.
 */
function taskEntryVisible(
  entry: TaskTimelineEntry,
  provider: TaskSummary["source"]["provider"],
  capturedFeedSupplied: boolean,
): boolean {
  // A running Turn already reads as running in the Task status; an entry saying so repeats it.
  if (entry.kind === "status") return entry.turn.delivery.isRunning !== true;
  if (entry.kind !== "report") return true;
  return (
    Boolean(entry.report.errorReason) ||
    (provider === "feishu" && replyNotice(entry.report, capturedFeedSupplied) !== null)
  );
}

function TaskReportBody({
  report,
  provider,
  capturedFeedSupplied,
}: {
  report: TaskReport;
  provider: TaskSummary["source"]["provider"];
  capturedFeedSupplied: boolean;
}) {
  return (
    <>
      {provider === "feishu" ? <TaskReplyNotice capturedFeedSupplied={capturedFeedSupplied} report={report} /> : null}
      {report.errorReason ? <p className="text-sm text-kumo-danger">{turnFailureLabel(report.errorReason)}</p> : null}
    </>
  );
}

/**
 * The old report's own reply snapshot. Once the captured replies feed is supplied, this notice only
 * states what stays true about that snapshot — an incomplete history — and stays silent on the
 * missing or unavailable cases the feed itself now reports. Legacy-only callers keep those notices;
 * an empty snapshot needs no notice.
 */
function replyNotice(report: TaskReport, capturedFeedSupplied: boolean): "unavailable" | "incomplete" | null {
  const snapshot = report.outgoingReplies;
  if (!snapshot || snapshot.status === "unavailable") return capturedFeedSupplied ? null : "unavailable";
  if (snapshot.status === "incomplete" || (snapshot.omittedCount ?? 0) > 0) return "incomplete";
  return null;
}

function TaskReplyNotice({ report, capturedFeedSupplied }: { report: TaskReport; capturedFeedSupplied: boolean }) {
  const notice = replyNotice(report, capturedFeedSupplied);
  if (notice === "unavailable")
    return (
      <p className="text-sm text-kumo-subtle" data-ui="task-reply-unavailable">
        {m.tasks_reply_data_unavailable()}
      </p>
    );
  if (notice === "incomplete")
    return (
      <p className="text-sm text-kumo-subtle" data-ui="task-reply-incomplete">
        {m.tasks_reply_incomplete()}
      </p>
    );
  return null;
}

function TaskUnreportedBody({ delivery }: { delivery: TaskTurn["delivery"] }) {
  if (delivery.state === "terminal_rejected" && delivery.reason === "restore_required") {
    return <p className="text-sm text-kumo-danger">{m.tasks_failure_progress_restore_failed()}</p>;
  }
  // A rejected message is a failure the reader may need to act on, so it reads as one.
  if (delivery.state === "terminal_rejected") {
    return (
      <p className="text-sm text-kumo-danger" data-state="failed">
        {deliveryStateMessage(delivery)}
      </p>
    );
  }
  return (
    <p className="text-sm text-kumo-subtle" data-state="attention">
      {delivery.state === "accepted" ? m.tasks_execution_report_unavailable() : deliveryStateMessage(delivery)}
    </p>
  );
}

/**
 * One platform-confirmed sent reply from the Server's capture. It carries no Turn and never
 * will — the record stands on the provider's own confirmation.
 */
function TaskCapturedReplyEntry({
  task,
  entry,
}: {
  task: TaskSummary;
  entry: TaskTimelineEntry & { kind: "captured" };
}) {
  return (
    <article
      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3"
      data-ui="task-message-agent"
      data-task-entry-id={entry.id}
    >
      <AgentAvatar
        displayName={task.agent.displayName}
        avatarPath={task.agent.avatarPath}
        className="size-8 text-xs font-medium text-kumo-strong"
      />
      <div className="grid min-w-0 gap-2">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author-agent">
          <strong className="min-w-0 wrap-anywhere text-sm font-medium">{task.agent.displayName}</strong>
          <TaskCapturedReplyMeta reply={entry.reply} />
        </header>
        {/* biome-ignore lint/a11y/useSemanticElements: This groups message content, not form controls. */}
        <div
          className="grid min-w-0 gap-3"
          role="group"
          aria-label={m.tasks_agent_response()}
          data-ui="task-agent-response"
        >
          <TaskCapturedReply legacyReply={entry.legacyReply} reply={entry.reply} />
        </div>
      </div>
    </article>
  );
}

function taskAuthorLabel(value: TaskTurn["message"]["authorKind"]): string {
  if (value === "human") return m.tasks_author_user();
  if (value === "bot") return m.tasks_author_bot();
  return m.tasks_author_system();
}

/** Why an unreported message has no execution, in the reader's language. */
function deliveryStateMessage(delivery: TaskTurn["delivery"]): string {
  // A withdrawn delivery is stored as expired; the reader asked for it and is told so.
  if (delivery.state === "expired" && delivery.reason === TASK_CANCELLED_DELIVERY_REASON) {
    return m.tasks_message_cancelled();
  }
  if (delivery.state === "pending") return m.tasks_message_pending();
  if (delivery.state === "expired") return m.tasks_message_expired();
  if (delivery.state === "terminal_rejected") return m.tasks_message_rejected();
  return m.tasks_execution_report_unavailable();
}

/*
 * The reason is the runtime's vocabulary, one of `TurnFailureReason`, and a reader gets a name
 * for it. A reason this build does not know yet is still shown, humanized, rather than hidden.
 */
const turnFailureLabels: Record<TurnFailureReason, () => string> = {
  provider_authentication_failed: m.tasks_failure_provider_authentication_failed,
  provider_access_denied: m.tasks_failure_provider_access_denied,
  provider_quota_exceeded: m.tasks_failure_provider_quota_exceeded,
  provider_rate_limited: m.tasks_failure_provider_rate_limited,
  provider_unavailable: m.tasks_failure_provider_unavailable,
  provider_connection_failed: m.tasks_failure_provider_connection_failed,
  provider_context_limit: m.tasks_failure_provider_context_limit,
  provider_execution_limit: m.tasks_failure_provider_execution_limit,
  provider_request_rejected: m.tasks_failure_provider_request_rejected,
  provider_process_exited: m.tasks_failure_provider_process_exited,

  workspace_failed: m.tasks_failure_workspace_failed,
  configuration_conflict: m.tasks_failure_configuration_conflict,
  credential_unavailable: m.tasks_failure_credential_unavailable,
  im_connection_unavailable: m.tasks_failure_im_connection_unavailable,
  model_login_missing: m.tasks_failure_model_login_missing,
  tool_setup_failed: m.tasks_failure_tool_setup_failed,
  sandbox_unavailable: m.tasks_failure_sandbox_unavailable,
  provider_start_failed: m.tasks_failure_provider_start_failed,
  session_resume_failed: m.tasks_failure_session_resume_failed,
  provider_protocol_error: m.tasks_failure_provider_protocol_error,
  provider_failed: m.tasks_failure_provider_failed,
  provider_empty_result: m.tasks_failure_provider_empty_result,
  output_too_large: m.tasks_failure_output_too_large,
  provider_teardown_failed: m.tasks_failure_provider_teardown_failed,
  turn_state_unknown: m.tasks_failure_turn_state_unknown,
  turn_timeout: m.tasks_failure_turn_timeout,
  client_shutdown: m.tasks_failure_client_shutdown,
};

function turnFailureLabel(reason: string): string {
  const label = Object.hasOwn(turnFailureLabels, reason) ? turnFailureLabels[reason as TurnFailureReason] : undefined;
  return label ? label() : humanizeEnum(reason);
}

function humanizeEnum(value: string): string {
  const normalized = value.replaceAll(/[_-]+/gu, " ");
  return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
}
