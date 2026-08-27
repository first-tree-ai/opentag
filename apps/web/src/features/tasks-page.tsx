import type { TaskDetail, TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { type ChangeEventHandler, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, browserApi } from "../api.js";
import feishuIconUrl from "../assets/feishu.svg";
import { Icon, StatusIndicator, type StatusTone } from "../ui/design-system.js";
import "./tasks-page.css";

type TaskFilter = "all" | TaskStatus;
type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };

const statusPresentation: Record<TaskStatus, { readonly label: string; readonly tone: StatusTone }> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
  ended: { label: "Ended", tone: "neutral" },
  idle: { label: "Idle", tone: "neutral" },
};

export function TasksPage() {
  const [state, setState] = useState<LoadState<{ tasks: TaskSummary[]; nextCursor: string | null }>>({
    kind: "loading",
  });
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState("all");
  const [status, setStatus] = useState<TaskFilter>("all");

  useEffect(() => {
    let active = true;
    browserApi.tasks().then(
      (value) =>
        active && setState({ kind: "ready", value: { tasks: [...value.tasks], nextCursor: value.nextCursor } }),
      (error: unknown) => active && setState({ kind: "error", error: asError(error) }),
    );
    return () => {
      active = false;
    };
  }, []);

  const agents = useMemo(() => {
    if (state.kind !== "ready") return [];
    return [...new Map(state.value.tasks.map((task) => [task.agent.id, task.agent])).values()].sort((left, right) =>
      left.displayName.localeCompare(right.displayName),
    );
  }, [state]);
  const tasks = useMemo(() => {
    if (state.kind !== "ready") return [];
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return state.value.tasks.filter((task) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [
          task.title,
          task.id,
          task.agent.displayName,
          task.agent.name,
          task.source.provider,
          task.source.channelId,
          task.source.threadKey,
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      return (
        matchesQuery && (agentId === "all" || task.agent.id === agentId) && (status === "all" || task.status === status)
      );
    });
  }, [agentId, query, state, status]);

  async function loadMore(): Promise<void> {
    if (state.kind !== "ready" || !state.value.nextCursor) return;
    try {
      const next = await browserApi.tasks({ cursor: state.value.nextCursor });
      setState({ kind: "ready", value: { tasks: [...state.value.tasks, ...next.tasks], nextCursor: next.nextCursor } });
    } catch (error) {
      setState({ kind: "error", error: asError(error) });
    }
  }

  return (
    <section className="tasks-page" aria-labelledby="tasks-page-title">
      <header className="tasks-page-header">
        <div>
          <h1 id="tasks-page-title">Tasks</h1>
          <p>Inspect stored bot Sessions, inbound messages, and runtime Turn results.</p>
        </div>
        <span className="tasks-debug-note">Read-only debug view</span>
      </header>

      <form className="task-toolbar" aria-label="Filter Tasks" onSubmit={(event) => event.preventDefault()}>
        <label className="task-search">
          <span className="visually-hidden">Search Tasks</span>
          <input
            value={query}
            type="search"
            placeholder="Search Tasks"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <TaskSelect label="Filter by Agent" value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          <option value="all">All Agents</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.displayName}
            </option>
          ))}
        </TaskSelect>
        <TaskSelect
          label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskFilter)}
        >
          <option value="all">All statuses</option>
          {Object.entries(statusPresentation).map(([value, presentation]) => (
            <option key={value} value={value}>
              {presentation.label}
            </option>
          ))}
        </TaskSelect>
      </form>

      {state.kind === "loading" ? (
        <TaskNotice heading="Loading Tasks" detail="Reading stored Sessions and Turns." />
      ) : null}
      {state.kind === "error" ? <TaskNotice heading="Tasks unavailable" detail={state.error.message} /> : null}
      {state.kind === "ready" && tasks.length > 0 ? (
        <>
          <table className="task-table" aria-label="Tasks">
            <thead>
              <tr className="task-table-grid task-table-header">
                <th scope="col">Task</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </tbody>
          </table>
          {state.value.nextCursor ? (
            <button className="task-load-more" type="button" onClick={() => void loadMore()}>
              Load more
            </button>
          ) : null}
        </>
      ) : null}
      {state.kind === "ready" && tasks.length === 0 ? (
        <TaskNotice heading="No Tasks found" detail="Try a different search or filter." />
      ) : null}
    </section>
  );
}

export function TaskDetailPage() {
  const { taskId } = useParams();
  const [state, setState] = useState<LoadState<TaskDetail>>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    if (!taskId) {
      setState({ kind: "error", error: new Error("Task not found") });
      return () => undefined;
    }
    browserApi.task(taskId).then(
      (value) => active && setState({ kind: "ready", value }),
      (error: unknown) => active && setState({ kind: "error", error: asError(error) }),
    );
    return () => {
      active = false;
    };
  }, [taskId]);

  async function loadMoreTurns(): Promise<void> {
    if (!taskId || state.kind !== "ready" || !state.value.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await browserApi.task(taskId, state.value.nextCursor);
      setState((current) =>
        current.kind === "ready"
          ? {
              kind: "ready",
              value: {
                ...current.value,
                turns: [...current.value.turns, ...next.turns],
                nextCursor: next.nextCursor,
              },
            }
          : current,
      );
    } catch (error) {
      setLoadMoreError(asError(error));
    } finally {
      setLoadingMore(false);
    }
  }

  if (state.kind === "loading") return <TaskNotice heading="Loading Task" detail="Reading stored Turn details." />;
  if (state.kind === "error") {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <section className="task-not-found">
        <h1>{notFound ? "Task not found" : "Task unavailable"}</h1>
        <p>{notFound ? "This Task does not exist or is outside your Account." : state.error.message}</p>
        <Link to="/tasks">Back to Tasks</Link>
      </section>
    );
  }

  const { task, turns, internalSessions, collaborationMessages } = state.value;
  const status = statusPresentation[task.status];
  return (
    <article className="task-conversation-page">
      <nav className="task-breadcrumb" aria-label="Breadcrumb">
        <Link to="/tasks">
          <Icon name="arrow-left" />
          Tasks
        </Link>
        <span className="tasks-debug-note">Read-only debug view</span>
      </nav>

      <header className="task-conversation-header">
        <h1>{task.title}</h1>
        <section className="task-conversation-context" aria-label="Task source">
          <SourceIdentity task={task} />
          <StatusIndicator
            aria-label={`${status.label}, updated ${formatRelativeTime(task.lastActivityAt)}`}
            detail={`Updated ${formatRelativeTime(task.lastActivityAt)}`}
            label={status.label}
            tone={status.tone}
          />
        </section>
      </header>

      <section className="task-debug-facts" aria-label="Task debug identifiers">
        <DebugValue label="Session" value={task.id} />
        <DebugValue label="Channel" value={task.source.channelId} />
        {task.source.threadKey ? <DebugValue label="Thread" value={task.source.threadKey} /> : null}
        <DebugValue label="Agent" value={task.agent.id} />
      </section>

      <p className="task-capture-boundary">
        Provider outbound messages and detailed tool traces are not captured. Agent output below is the stored runtime
        final output.
      </p>

      <section className="task-thread" aria-label="Task conversation">
        {turns.length > 0 ? (
          turns.map((turn) => <TaskTurnView key={turn.deliveryId} task={task} turn={turn} />)
        ) : (
          <TaskNotice heading="No Turns recorded" detail="This Session has no stored IM deliveries." />
        )}
      </section>
      {state.value.nextCursor ? (
        <button className="task-load-more" type="button" disabled={loadingMore} onClick={() => void loadMoreTurns()}>
          {loadingMore ? "Loading more Turns…" : "Load more Turns"}
        </button>
      ) : null}
      {loadMoreError ? (
        <p className="task-runtime-error" role="alert">
          {loadMoreError.message}
        </p>
      ) : null}

      {internalSessions.length > 0 || collaborationMessages.length > 0 ? (
        <details className="task-related-sessions">
          <summary>
            Internal collaboration · {internalSessions.length} Sessions · {collaborationMessages.length} messages
          </summary>
          <section>
            {internalSessions.map((session) => (
              <p key={session.id}>
                <strong>{session.endedAt ? "Ended" : "Active"}</strong> · <code>{session.id}</code>
                {session.runtimeModel ? ` · ${session.runtimeModel}` : ""}
              </p>
            ))}
            {collaborationMessages.map((message) => (
              <article className="task-collaboration-message" key={message.id}>
                <p>{message.content}</p>
                <small>
                  {message.outcome} · {formatTimestamp(message.createdAt)} · {message.sourceSessionId} →{" "}
                  {message.targetSessionId}
                </small>
              </article>
            ))}
          </section>
        </details>
      ) : null}
    </article>
  );
}

function TaskTurnView({ task, turn }: { task: TaskSummary; turn: TaskTurn }) {
  const report = turn.report;
  const usage = report?.usage;
  const tokenTotal = usage
    ? (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)
    : null;
  return (
    <section className="task-exchange" aria-label={`Message sent at ${formatTimestamp(turn.message.occurredAt)}`}>
      <article className="task-message task-message--request">
        <header className="task-message-author">
          <span className="task-person-mark" aria-hidden="true">
            {getInitials(turn.message.authorDisplayName ?? turn.message.authorKind)}
          </span>
          <span>
            <strong>{turn.message.authorDisplayName ?? turn.message.authorKind}</strong>
            <small>
              {turn.attention} · {formatTimestamp(turn.message.occurredAt)}
            </small>
          </span>
        </header>
        <div className="task-request-bubble">
          <p>{turn.message.fallbackText || "No text content"}</p>
        </div>
      </article>

      <article className="task-message task-message--agent">
        <header className="task-message-author task-message-author--agent">
          <span className="task-agent-mark" aria-hidden="true">
            {task.agent.displayName.charAt(0)}
          </span>
          <span>
            <strong>{task.agent.displayName}</strong>
            <small>{report ? `${report.outcome} · ${formatTimestamp(report.reportedAt)}` : turn.delivery.state}</small>
          </span>
        </header>
        {report?.finalText ? (
          <section className="task-agent-response" aria-label="Stored runtime final output">
            <p className="task-answer-paragraph">{report.finalText}</p>
          </section>
        ) : (
          <p className={turn.delivery.state === "accepted" ? "task-progress-summary" : "task-attention-summary"}>
            {turn.delivery.state === "accepted"
              ? "The Turn is running or its report has not arrived."
              : `Delivery ${turn.delivery.state}.`}
          </p>
        )}
        <details className="task-agent-process">
          <summary>
            <span>Runtime details</span>
            <Icon name="chevron-right" />
          </summary>
          <section className="task-agent-events">
            <DebugValue label="Delivery" value={turn.deliveryId} />
            <DebugValue label="Message" value={turn.message.externalMessageId} />
            {report ? <DebugValue label="Turn" value={report.turnId} /> : null}
            <p className="task-process-metadata">
              {[
                `${turn.delivery.attemptCount} ${turn.delivery.attemptCount === 1 ? "attempt" : "attempts"}`,
                report ? `Outcome ${report.outcome}` : null,
                report ? `Effects ${report.executionEffects}` : null,
                tokenTotal === null ? null : `${tokenTotal.toLocaleString()} tokens`,
                report ? `${report.traceSummary.lastSequence} trace events` : null,
                report?.traceSummary.droppedEvents ? `${report.traceSummary.droppedEvents} dropped` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
            {report?.errorReason || turn.delivery.lastErrorCode || turn.delivery.reason ? (
              <p className="task-runtime-error">
                {report?.errorReason ?? turn.delivery.lastErrorCode ?? turn.delivery.reason}
              </p>
            ) : null}
          </section>
        </details>
      </article>
    </section>
  );
}

function TaskSelect({
  children,
  label,
  onChange,
  value,
}: {
  children: ReactNode;
  label: string;
  onChange: ChangeEventHandler<HTMLSelectElement>;
  value: string;
}) {
  return (
    <label>
      <span className="visually-hidden">{label}</span>
      <select aria-label={label} value={value} onChange={onChange}>
        {children}
      </select>
    </label>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  const status = statusPresentation[task.status];
  return (
    <tr className="task-table-grid task-table-row">
      <td className="task-work-cell" data-label="Task">
        <Link to={`/tasks/${task.id}`}>{task.title}</Link>
        <span className="task-list-metadata">
          <span>{task.agent.displayName}</span>
          <span aria-hidden="true">·</span>
          <ProviderIcon provider={task.source.provider} compact />
          <span>{task.source.provider}</span>
          <span aria-hidden="true">·</span>
          <span>{task.sessionKind}</span>
          <span aria-hidden="true">·</span>
          <span>{shortId(task.source.threadKey ?? task.source.channelId)}</span>
        </span>
      </td>
      <td className="task-status-cell" data-label="Status">
        <StatusIndicator
          aria-label={`${status.label}, updated ${formatRelativeTime(task.lastActivityAt)}`}
          detail={formatRelativeTime(task.lastActivityAt)}
          label={status.label}
          tone={status.tone}
        />
      </td>
    </tr>
  );
}

function SourceIdentity({ task }: { task: TaskSummary }) {
  return (
    <span className="task-source-identity">
      <ProviderIcon provider={task.source.provider} />
      <span>
        <strong>{task.agent.displayName}</strong>
        <small>
          {task.source.provider} · {task.sessionKind} · {shortId(task.source.threadKey ?? task.source.channelId)}
        </small>
      </span>
    </span>
  );
}

function ProviderIcon({
  provider,
  compact = false,
}: {
  provider: TaskSummary["source"]["provider"];
  compact?: boolean;
}) {
  if (provider !== "feishu")
    return (
      <span className="task-provider-mark" aria-hidden="true">
        S
      </span>
    );
  return (
    <img
      alt=""
      aria-hidden="true"
      className={compact ? "task-feishu-icon task-feishu-icon--compact" : "task-feishu-icon"}
      src={feishuIconUrl}
    />
  );
}

function DebugValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="task-debug-value">
      <strong>{label}</strong>
      <code>{value}</code>
      <button type="button" onClick={() => void navigator.clipboard?.writeText(value)} aria-label={`Copy ${label}`}>
        Copy
      </button>
    </span>
  );
}

function TaskNotice({ heading, detail }: { heading: string; detail: string }) {
  return (
    <section className="task-empty-state" aria-live="polite">
      <h2>{heading}</h2>
      <p>{detail}</p>
    </section>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const deltaSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const absolute = Math.abs(deltaSeconds);
  if (absolute < 60) return formatter.format(deltaSeconds, "second");
  const deltaMinutes = Math.round(deltaSeconds / 60);
  if (Math.abs(deltaMinutes) < 60) return formatter.format(deltaMinutes, "minute");
  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 24) return formatter.format(deltaHours, "hour");
  return formatter.format(Math.round(deltaHours / 24), "day");
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function getInitials(name: string): string {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("The request failed");
}
