import type { TaskDetail, TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { type ChangeEventHandler, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import {
  Button,
  ClipboardText,
  Collapsible,
  Icon,
  KumoInputControl,
  KumoSelectControl,
  Loader,
  StatusIndicator,
  type StatusTone,
  Table,
  Text,
} from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";

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
    <section className="grid gap-6" aria-labelledby="tasks-page-title" data-ui="tasks-page">
      <PageHeader
        description="Inspect stored bot Sessions, inbound messages, and runtime Turn results."
        title="Tasks"
        titleId="tasks-page-title"
      >
        <Text as="span" data-ui="tasks-debug-note" variant="secondary">
          Read-only debug view
        </Text>
      </PageHeader>

      <form
        className="flex flex-wrap items-end gap-3"
        aria-label="Filter Tasks"
        data-ui="task-toolbar"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="min-w-56 flex-1">
          <span className="sr-only">Search Tasks</span>
          <KumoInputControl
            aria-label="Search Tasks"
            value={query}
            type="search"
            placeholder="Search Tasks"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
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
          <Table className="w-full" aria-label="Tasks" data-ui="task-table">
            <thead>
              <tr className="border-b border-kumo-line text-left text-sm text-kumo-subtle">
                <th scope="col">Task</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </tbody>
          </Table>
          {state.value.nextCursor ? (
            <Button type="button" variant="secondary" onClick={() => void loadMore()}>
              Load more
            </Button>
          ) : null}
        </>
      ) : null}
      {state.kind === "ready" && tasks.length === 0 ? (
        <TaskNotice heading="No Tasks found" detail="Try a different search or filter." />
      ) : null}
    </section>
  );
}

/**
 * The Agent home list. It reads the Agent's own Tasks from the server rather than filtering a
 * workspace-wide page, so paging past the first page cannot hide this Agent's older Tasks.
 */
export function AgentTasksSection({ agentId }: { agentId: string }) {
  const [state, setState] = useState<LoadState<{ tasks: TaskSummary[]; nextCursor: string | null }>>({
    kind: "loading",
  });
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    let active = true;
    setState({ kind: "loading" });
    browserApi.tasks({ agentId }).then(
      (value) =>
        active && setState({ kind: "ready", value: { tasks: [...value.tasks], nextCursor: value.nextCursor } }),
      (error: unknown) => active && setState({ kind: "error", error: asError(error) }),
    );
    return () => {
      active = false;
    };
  }, [agentId]);

  async function loadMore(): Promise<void> {
    if (state.kind !== "ready" || !state.value.nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await browserApi.tasks({ agentId, cursor: state.value.nextCursor });
      setState({ kind: "ready", value: { tasks: [...state.value.tasks, ...next.tasks], nextCursor: next.nextCursor } });
    } catch (error) {
      setState({ kind: "error", error: asError(error) });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section
      className="grid gap-4 rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
      aria-labelledby="agent-tasks-heading"
      data-ui="agent-tasks"
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Text as="h2" id="agent-tasks-heading" variant="heading">
          Tasks
        </Text>
        <Link className="text-sm text-kumo-link" to="/tasks">
          All Tasks
        </Link>
      </div>
      {state.kind === "loading" ? (
        <p className="text-sm text-kumo-subtle" role="status">
          Loading Tasks…
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="text-sm text-kumo-subtle" role="status">
          Tasks are temporarily unavailable.
        </p>
      ) : null}
      {state.kind === "ready" && state.value.tasks.length === 0 ? (
        <p className="text-sm text-kumo-subtle" role="status">
          No Tasks yet. Work this Agent handles in Feishu or Slack appears here.
        </p>
      ) : null}
      {state.kind === "ready" && state.value.tasks.length > 0 ? (
        <>
          <Table className="w-full" aria-label="Agent Tasks" data-ui="task-table">
            <thead>
              <tr className="border-b border-kumo-line text-left text-sm text-kumo-subtle">
                <th scope="col">Task</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {state.value.tasks.map((task) => (
                <TaskRow key={task.id} showAgent={false} task={task} />
              ))}
            </tbody>
          </Table>
          {state.value.nextCursor ? (
            <Button disabled={loadingMore} type="button" variant="secondary" onClick={() => void loadMore()}>
              {loadingMore ? "Loading more Tasks…" : "Load more"}
            </Button>
          ) : null}
        </>
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
      <section className="grid gap-3" data-ui="task-not-found">
        <Text as="h1" size="lg" variant="heading">
          {notFound ? "Task not found" : "Task unavailable"}
        </Text>
        <Text as="p" variant="secondary">
          {notFound ? "This Task does not exist or is outside your Account." : state.error.message}
        </Text>
        <Link to="/tasks">Back to Tasks</Link>
      </section>
    );
  }

  const { task, turns, internalSessions, collaborationMessages } = state.value;
  const status = statusPresentation[task.status];
  return (
    <article className="grid gap-6" data-ui="task-conversation-page">
      <nav className="flex items-center gap-3" aria-label="Breadcrumb">
        <Link to="/tasks">
          <Icon name="arrow-left" />
          Tasks
        </Link>
        <span className="text-sm text-kumo-subtle" data-ui="tasks-debug-note">
          Read-only debug view
        </span>
      </nav>

      <header className="grid gap-3" data-ui="task-conversation-header">
        <Text as="h1" size="lg" title={task.title} truncate variant="heading">
          {task.title}
        </Text>
        <section
          className="flex flex-wrap items-center gap-3"
          aria-label="Task source"
          data-ui="task-conversation-context"
        >
          <SourceIdentity task={task} />
          <StatusIndicator
            aria-label={`${status.label}, updated ${formatRelativeTime(task.lastActivityAt)}`}
            detail={`Updated ${formatRelativeTime(task.lastActivityAt)}`}
            label={status.label}
            tone={status.tone}
          />
        </section>
      </header>

      <section className="grid gap-3 sm:grid-cols-2" aria-label="Task debug identifiers" data-ui="task-debug-facts">
        <DebugValue label="Session" value={task.id} />
        <DebugValue label="Channel" value={task.source.channelId} />
        {task.source.threadKey ? <DebugValue label="Thread" value={task.source.threadKey} /> : null}
        <DebugValue label="Agent" value={task.agent.id} />
      </section>

      <p className="text-sm text-kumo-subtle" data-ui="task-capture-boundary">
        Provider outbound messages and detailed tool traces are not captured. Agent output below is the stored runtime
        final output.
      </p>

      <section className="grid gap-4" aria-label="Task conversation" data-ui="task-thread">
        {turns.length > 0 ? (
          turns.map((turn) => <TaskTurnView key={turn.deliveryId} task={task} turn={turn} />)
        ) : (
          <TaskNotice heading="No Turns recorded" detail="This Session has no stored IM deliveries." />
        )}
      </section>
      {state.value.nextCursor ? (
        <Button
          loading={loadingMore}
          type="button"
          variant="secondary"
          disabled={loadingMore}
          onClick={() => void loadMoreTurns()}
        >
          Load more Turns
        </Button>
      ) : null}
      {loadMoreError ? (
        <p className="text-sm text-kumo-danger" data-ui="task-runtime-error" role="alert">
          {loadMoreError.message}
        </p>
      ) : null}

      {internalSessions.length > 0 || collaborationMessages.length > 0 ? (
        <Collapsible.Root data-ui="task-related-sessions">
          <Collapsible.DefaultTrigger>
            Internal collaboration · {internalSessions.length} Sessions · {collaborationMessages.length} messages
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel keepMounted>
            <section className="grid gap-3">
              {internalSessions.map((session) => (
                <p key={session.id}>
                  <strong>{session.endedAt ? "Ended" : "Active"}</strong> · <code>{session.id}</code>
                  {session.runtimeModel ? ` · ${session.runtimeModel}` : ""}
                </p>
              ))}
              {collaborationMessages.map((message) => (
                <article className="rounded-md bg-kumo-recessed p-3" key={message.id}>
                  <p>{message.content}</p>
                  <small>
                    {message.outcome} · {formatTimestamp(message.createdAt)} · {message.sourceSessionId} →{" "}
                    {message.targetSessionId}
                  </small>
                </article>
              ))}
            </section>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      ) : null}
    </article>
  );
}

function TaskTurnView({ task, turn }: { task: TaskSummary; turn: TaskTurn }) {
  const report = turn.report;
  const absorbedBy = turn.absorbedBy;
  const usage = report?.usage;
  const tokenTotal = usage
    ? (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0)
    : null;
  return (
    <section
      className="grid gap-3"
      aria-label={`Message sent at ${formatTimestamp(turn.message.occurredAt)}`}
      data-ui="task-exchange"
    >
      <article className="rounded-lg bg-kumo-recessed p-4" data-ui="task-message-request">
        <header className="flex items-center gap-2" data-ui="task-message-author">
          <span
            className="grid size-7 place-items-center rounded-full bg-kumo-tint text-xs font-medium"
            aria-hidden="true"
          >
            {getInitials(turn.message.authorDisplayName ?? turn.message.authorKind)}
          </span>
          <span>
            <strong>{turn.message.authorDisplayName ?? turn.message.authorKind}</strong>
            <small>
              {turn.attention} · {formatTimestamp(turn.message.occurredAt)}
            </small>
          </span>
        </header>
        <div className="mt-2 whitespace-pre-wrap">
          <p>{turn.message.fallbackText || "No text content"}</p>
        </div>
      </article>

      <article className="rounded-lg bg-kumo-base p-4 ring ring-kumo-line" data-ui="task-message-agent">
        <header className="flex items-center gap-2" data-ui="task-message-author-agent">
          <span
            className="grid size-7 place-items-center rounded-full bg-kumo-brand text-kumo-inverse"
            aria-hidden="true"
          >
            {task.agent.displayName.charAt(0)}
          </span>
          <span>
            <strong>{task.agent.displayName}</strong>
            <small>
              {absorbedBy
                ? "absorbed into running Turn"
                : report
                  ? `${report.outcome} · ${formatTimestamp(report.reportedAt)}`
                  : turn.delivery.state}
            </small>
          </span>
        </header>
        {absorbedBy ? (
          <p className="text-sm text-kumo-subtle" data-ui="task-progress-summary">
            This input was steered into the active Turn.
          </p>
        ) : report?.finalText ? (
          <section aria-label="Stored runtime final output" data-ui="task-agent-response">
            <p className="whitespace-pre-wrap">{report.finalText}</p>
          </section>
        ) : (
          <p
            className="text-sm text-kumo-subtle"
            data-state={turn.delivery.state === "accepted" ? "progress" : "attention"}
          >
            {turn.delivery.state === "accepted"
              ? "The Turn is running or its report has not arrived."
              : `Delivery ${turn.delivery.state}.`}
          </p>
        )}
        <Collapsible.Root data-ui="task-agent-process">
          <Collapsible.DefaultTrigger>
            <span>Runtime details</span>
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel keepMounted>
            <section className="grid gap-3" data-ui="task-agent-events">
              <DebugValue label="Delivery" value={turn.deliveryId} />
              <DebugValue label="Message" value={turn.message.externalMessageId} />
              {absorbedBy ? <DebugValue label="Absorbed by delivery" value={absorbedBy.deliveryId} /> : null}
              {absorbedBy ? <DebugValue label="Target Turn" value={absorbedBy.turnId} /> : null}
              {report ? <DebugValue label="Turn" value={report.turnId} /> : null}
              <p className="text-sm text-kumo-subtle" data-ui="task-process-metadata">
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
                <p className="text-sm text-kumo-danger" data-ui="task-runtime-error">
                  {report?.errorReason ?? turn.delivery.lastErrorCode ?? turn.delivery.reason}
                </p>
              ) : null}
            </section>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
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
    <div>
      <span className="sr-only">{label}</span>
      <KumoSelectControl aria-label={label} size="sm" value={value} onChange={onChange}>
        {children}
      </KumoSelectControl>
    </div>
  );
}

function TaskRow({ showAgent = true, task }: { showAgent?: boolean; task: TaskSummary }) {
  const status = statusPresentation[task.status];
  return (
    <tr className="border-b border-kumo-line align-top" data-ui="task-table-row">
      <td className="p-3" data-label="Task">
        <Link title={task.title} to={`/tasks/${task.id}`}>
          {task.title}
        </Link>
        <span className="mt-1 block text-sm text-kumo-subtle" data-ui="task-list-metadata">
          {showAgent ? (
            <>
              <span>{task.agent.displayName}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <TaskProviderIcon provider={task.source.provider} compact />
          <span>{task.source.provider}</span>
          <span aria-hidden="true">·</span>
          <span>{task.sessionKind}</span>
          <span aria-hidden="true">·</span>
          <span>{shortId(task.source.threadKey ?? task.source.channelId)}</span>
        </span>
      </td>
      <td className="p-3" data-label="Status">
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
    <span className="inline-flex items-center gap-2" data-ui="task-source-identity">
      <TaskProviderIcon provider={task.source.provider} />
      <span>
        <strong>{task.agent.displayName}</strong>
        <small>
          {task.source.provider} · {task.sessionKind} · {shortId(task.source.threadKey ?? task.source.channelId)}
        </small>
      </span>
    </span>
  );
}

function TaskProviderIcon({
  provider,
  compact = false,
}: {
  provider: TaskSummary["source"]["provider"];
  compact?: boolean;
}) {
  return <ProviderIcon className={compact ? "size-5" : "size-7"} provider={provider} />;
}

function DebugValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="grid gap-1 rounded-md bg-kumo-recessed p-3" data-ui="task-debug-value">
      <strong>{label}</strong>
      <ClipboardText
        labels={{ copyAction: `Copy ${label}` }}
        size="sm"
        text={value}
        tooltip={{ copiedText: "Copied!", side: "top", text: `Copy ${label}` }}
      />
    </span>
  );
}

function TaskNotice({ heading, detail }: { heading: string; detail: string }) {
  return (
    <section
      className="grid gap-2 rounded-lg bg-kumo-base p-8 text-center ring ring-kumo-line"
      aria-live="polite"
      data-ui="task-empty-state"
    >
      <div className="flex items-center justify-center gap-2">
        {heading.startsWith("Loading") ? <Loader aria-label={heading} size="sm" /> : null}
        <Text as="h2" variant="heading">
          {heading}
        </Text>
      </div>
      <Text as="p" variant="secondary">
        {detail}
      </Text>
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
