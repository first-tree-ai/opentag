import {
  TASK_CANCELLED_DELIVERY_REASON,
  type TaskSummary,
  type TaskTurn,
  type TurnFailureReason,
} from "@opentag/shared/browser";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime, formatRelativeTime, initials } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { Button, Icon, StatusIndicator, Text } from "../ui/design-system.js";
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
import { taskStatusGroup, taskStatusGroupLabel, taskStatusGroupTone } from "./task-status.js";
import { buildTaskTimeline, type CapturedTaskReply, type TaskReport, type TaskTimelineEntry } from "./task-timeline.js";

export function TaskActivity({
  task,
  turns,
  internalSessions,
  replies,
  pagination,
  repliesStatus,
}: {
  task: TaskSummary;
  turns: TaskTurn[];
  internalSessions?: TaskInternalSessionItem[];
  replies?: CapturedTaskReply[];
  pagination: ReactNode;
  repliesStatus?: ReactNode;
}) {
  /*
   * Supplying the replies feed — even empty while it loads, errors, or finds nothing — makes its
   * state authoritative. Legacy-only callers omit `replies` and keep the old per-report notices.
   */
  const capturedFeedSupplied = replies !== undefined;
  const entries = buildTaskTimeline(turns, task.source.provider, replies ?? []);
  const hasInternalSessions = (internalSessions?.length ?? 0) > 0;
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
      className="relative grid w-full max-w-3xl gap-5"
      aria-labelledby="task-activity-title"
      data-ui="task-thread"
      onScroll={(event) => updateScrollState(event.currentTarget)}
    >
      <Text as="h2" id="task-activity-title" variant="heading" DANGEROUS_className="sr-only">
        {m.tasks_activity()}
      </Text>
      {hasInternalSessions && internalSessions ? <TaskInternalSessionsList sessions={internalSessions} /> : null}
      <TaskActivityTimeline key={task.id} entryIds={entries.map((entry) => entry.id)}>
        {pagination}
        {entries.length > 0 ? (
          <div className="grid">
            {entries.map((entry) => (
              <div key={entry.id} className="py-4 first:pt-0 last:pb-0">
                <TaskEntry capturedFeedSupplied={capturedFeedSupplied} task={task} entry={entry} />
              </div>
            ))}
          </div>
        ) : !hasInternalSessions ? (
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
            <span>Jump to latest</span>
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function TaskInternalSessionsList({ sessions }: { sessions: TaskInternalSessionItem[] }) {
  return (
    <div className="grid gap-2 rounded-lg border border-kumo-line bg-kumo-base p-4" data-ui="task-internal-sessions">
      <ul className="grid divide-y divide-kumo-line">
        {sessions.map((session) => {
          const status = session.status ? taskStatusGroup(session.status) : session.endedAt ? "completed" : "running";
          const activityAt = session.endedAt ?? session.createdAt;
          const preview = session.title?.trim() || session.runtimeModel || session.id;
          return (
            <li
              key={session.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0 text-sm"
              data-ui="task-internal-session-row"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 truncate font-medium text-kumo-default">{preview}</span>
                {preview !== session.id ? (
                  <span className="truncate text-xs text-kumo-subtle">{session.id}</span>
                ) : null}
              </div>
              <div className="flex items-center gap-3">
                <StatusIndicator label={taskStatusGroupLabel(status)} tone={taskStatusGroupTone(status)} />
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
    </div>
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
              hasReplies={entry.hasReplies}
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

function TaskAgentMeta({ entry }: { entry: TaskTimelineEntry }) {
  if (entry.kind === "reply") return <TaskOutgoingReplyMeta reply={entry.reply} />;
  if (entry.kind === "report") return <TaskReportMeta report={entry.report} />;
  if (entry.kind === "status") {
    return <small className="text-xs text-kumo-subtle">{deliveryStateLabel(entry.turn.delivery)}</small>;
  }
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
      <span
        className="grid size-8 place-items-center rounded-md bg-kumo-tint text-xs font-medium ring-1 ring-inset ring-kumo-line/60"
        aria-hidden="true"
      >
        {initials(author)}
      </span>
      <div className="grid min-w-0 gap-2">
        <header className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author">
          <strong className="min-w-0 wrap-anywhere text-sm font-medium">{author}</strong>
          <small className="text-xs text-kumo-subtle">
            {attentionLabel(turn.attention)} · {formatDateTime(turn.message.occurredAt)}
          </small>
        </header>
        <div className="grid min-w-0 gap-3 rounded-xl bg-kumo-recessed p-4 ring-1 ring-inset ring-kumo-line/60 shadow-2xs">
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
  return (
    <small className="text-xs text-kumo-subtle">
      {m.tasks_report_summary({ outcome: humanizeEnum(report.outcome), time: formatDateTime(report.reportedAt) })}
    </small>
  );
}

function TaskReportBody({
  report,
  hasReplies,
  provider,
  capturedFeedSupplied,
}: {
  report: TaskReport;
  hasReplies: boolean;
  provider: TaskSummary["source"]["provider"];
  capturedFeedSupplied: boolean;
}) {
  return (
    <>
      {hasReplies ? <TaskReportMeta report={report} /> : null}
      {provider === "feishu" ? <TaskReplyNotice capturedFeedSupplied={capturedFeedSupplied} report={report} /> : null}
      {report.finalText ? <TaskExecutionSummary text={report.finalText} /> : null}
      {report.outgoingReplies?.runtimeSummaryTruncated ? (
        <p className="text-sm text-kumo-subtle">{m.tasks_summary_truncated()}</p>
      ) : null}
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
function TaskReplyNotice({ report, capturedFeedSupplied }: { report: TaskReport; capturedFeedSupplied: boolean }) {
  const snapshot = report.outgoingReplies;
  if (!snapshot || snapshot.status === "unavailable")
    return capturedFeedSupplied ? null : (
      <p className="text-sm text-kumo-subtle" data-ui="task-reply-unavailable">
        {m.tasks_reply_data_unavailable()}
      </p>
    );
  if (snapshot.status === "incomplete" || (snapshot.omittedCount ?? 0) > 0)
    return (
      <p className="text-sm text-kumo-subtle" data-ui="task-reply-incomplete">
        {m.tasks_reply_incomplete()}
      </p>
    );
  return null;
}

function TaskExecutionSummary({ text }: { text: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: This groups summary content, not form controls.
    <div
      className="grid gap-2 rounded-xl bg-kumo-base/80 p-3.5 ring-1 ring-inset ring-kumo-line/50"
      data-ui="task-execution-summary"
      role="group"
      aria-label={m.tasks_execution_summary()}
    >
      <TaskMessageBody format="markdown" text={text} />
    </div>
  );
}

function TaskUnreportedBody({ delivery }: { delivery: TaskTurn["delivery"] }) {
  const running = delivery.isRunning === true;
  if (delivery.state === "terminal_rejected" && delivery.reason === "restore_required") {
    return <p className="text-sm text-kumo-danger">{m.tasks_failure_progress_restore_failed()}</p>;
  }
  return (
    <p className="text-sm text-kumo-subtle" data-state={running ? "progress" : "attention"}>
      {running
        ? m.tasks_work_in_progress()
        : delivery.state === "accepted"
          ? m.tasks_execution_report_unavailable()
          : m.tasks_message_state({ state: deliveryStateLabel(delivery).toLocaleLowerCase() })}
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

function attentionLabel(value: TaskTurn["attention"]): string {
  if (value === "direct") return m.tasks_direct_message();
  if (value === "ambient") return m.tasks_ambient_message();
  return humanizeEnum(value);
}

function deliveryStateLabel(delivery: TaskTurn["delivery"]): string {
  if (delivery.isRunning === true) return m.tasks_in_progress();
  // A withdrawn delivery is stored as expired; the reader asked for it and is told so.
  if (delivery.state === "expired" && delivery.reason === TASK_CANCELLED_DELIVERY_REASON) {
    return m.tasks_status_cancelled();
  }
  return humanizeEnum(delivery.state);
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
