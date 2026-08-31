import type { TaskDetail, TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import feishuIconUrl from "../assets/feishu.svg";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import {
  Banner,
  Button,
  ClipboardText,
  Collapsible,
  Empty,
  Icon,
  Input,
  LayerCard,
  Select,
  SkeletonLine,
  StatusIndicator,
  type StatusTone,
  Table,
  Text,
} from "../ui/design-system.js";

type TaskFilter = "all" | TaskStatus;
type LoadState<T> = { kind: "loading" } | { kind: "error"; error: Error } | { kind: "ready"; value: T };
type TaskCollection = { tasks: TaskSummary[]; nextCursor: string | null };

const statusPresentation: Record<TaskStatus, { readonly label: string; readonly tone: StatusTone }> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  completed: { label: "Completed", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  expired: { label: "Expired", tone: "warning" },
  ended: { label: "Ended", tone: "neutral" },
  idle: { label: "Idle", tone: "neutral" },
};

const statusItems = Object.fromEntries([
  ["all", "All statuses"],
  ...Object.entries(statusPresentation).map(([value, presentation]) => [value, presentation.label]),
]);

export function TasksPage() {
  const [state, setState] = useState<LoadState<TaskCollection>>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState("all");
  const [status, setStatus] = useState<TaskFilter>("all");
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  const initialLoadGeneration = useRef(0);

  const loadTasks = useCallback(async (): Promise<void> => {
    const generation = initialLoadGeneration.current + 1;
    initialLoadGeneration.current = generation;
    setState({ kind: "loading" });
    setLoadMoreError(null);
    try {
      const value = await browserApi.tasks();
      if (initialLoadGeneration.current !== generation) return;
      setState({ kind: "ready", value: { tasks: [...value.tasks], nextCursor: value.nextCursor } });
    } catch (error) {
      if (initialLoadGeneration.current !== generation) return;
      setState({ kind: "error", error: asError(error) });
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    return () => {
      // Invalidate an in-flight request when this page unmounts.
      initialLoadGeneration.current += 1;
    };
  }, [loadTasks]);

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
  const agentItems = useMemo(
    () => Object.fromEntries([["all", "All Agents"], ...agents.map((agent) => [agent.id, agent.displayName])]),
    [agents],
  );
  const hasActiveFilters = query.trim().length > 0 || agentId !== "all" || status !== "all";

  function clearFilters(): void {
    setQuery("");
    setAgentId("all");
    setStatus("all");
  }

  async function loadMore(): Promise<void> {
    if (state.kind !== "ready" || !state.value.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await browserApi.tasks({ cursor: state.value.nextCursor });
      setState((current) =>
        current.kind === "ready"
          ? { kind: "ready", value: { tasks: [...current.value.tasks, ...next.tasks], nextCursor: next.nextCursor } }
          : current,
      );
    } catch (error) {
      // Keep the rows already on screen. A failed append should be recoverable without making the
      // viewer lose the page that was loaded successfully.
      setLoadMoreError(asError(error));
    } finally {
      setLoadingMore(false);
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
        className="grid gap-3 @min-[36rem]/workspace:grid-cols-[minmax(14rem,1fr)_12rem_12rem_auto] @min-[36rem]/workspace:items-end"
        aria-label="Filter Tasks"
        data-ui="task-toolbar"
        onSubmit={(event) => event.preventDefault()}
      >
        <Input
          aria-label="Search Tasks"
          className="w-full"
          placeholder="Search loaded Tasks"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          aria-label="Filter by Agent"
          className="w-full"
          items={agentItems}
          size="sm"
          value={agentId}
          onValueChange={(value) => setAgentId(value ?? "all")}
        />
        <Select
          aria-label="Filter by status"
          className="w-full"
          items={statusItems}
          size="sm"
          value={status}
          onValueChange={(value) => setStatus((value ?? "all") as TaskFilter)}
        />
        {hasActiveFilters ? (
          <Button className="w-full @min-[36rem]/workspace:w-auto" type="button" variant="ghost" onClick={clearFilters}>
            Clear filters
          </Button>
        ) : null}
      </form>

      {state.kind === "loading" ? <TaskLoading heading="Loading Tasks" /> : null}
      {state.kind === "error" ? (
        <Banner
          action={
            <Button type="button" variant="secondary" onClick={() => void loadTasks()}>
              Try again
            </Button>
          }
          description={state.error.message}
          role="alert"
          title="Tasks unavailable"
          variant="error"
        />
      ) : null}
      {state.kind === "ready" && tasks.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-kumo-subtle">
            <span aria-live="polite">
              Showing {tasks.length} of {state.value.tasks.length} loaded{" "}
              {state.value.tasks.length === 1 ? "Task" : "Tasks"}
            </span>
            {state.value.nextCursor ? <span>More Tasks are available.</span> : null}
          </div>
          <LayerCard className="overflow-hidden p-0 shadow-none ring-0 @min-[36rem]/workspace:shadow-xs @min-[36rem]/workspace:ring @min-[36rem]/workspace:ring-kumo-line">
            <Table className="block @min-[36rem]/workspace:table" aria-label="Tasks" data-ui="task-table">
              <Table.Header className="hidden @min-[36rem]/workspace:table-header-group">
                <Table.Row>
                  <Table.Head>Task</Table.Head>
                  <Table.Head>Status</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body className="grid gap-3 @min-[36rem]/workspace:table-row-group">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} />
                ))}
              </Table.Body>
            </Table>
          </LayerCard>
          {state.value.nextCursor ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={loadingMore}
                loading={loadingMore}
                type="button"
                variant="secondary"
                onClick={() => void loadMore()}
              >
                {loadingMore ? "Loading more Tasks…" : loadMoreError ? "Try again" : "Load more"}
              </Button>
              {loadMoreError ? (
                <Banner description={loadMoreError.message} role="alert" size="sm" variant="error" />
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {state.kind === "ready" && tasks.length === 0 ? (
        <Empty
          contents={
            hasActiveFilters ? (
              <Button type="button" variant="secondary" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : null
          }
          description={hasActiveFilters ? "Try a different search or filter." : "Stored Sessions will appear here."}
          icon={<Icon name="message" />}
          title="No Tasks found"
        />
      ) : null}
    </section>
  );
}

export function TaskDetailPage({ taskId }: { taskId?: string }) {
  const [state, setState] = useState<LoadState<TaskDetail>>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);
  const taskLoadGeneration = useRef(0);

  useEffect(() => {
    const generation = taskLoadGeneration.current + 1;
    taskLoadGeneration.current = generation;
    setState({ kind: "loading" });
    setLoadingMore(false);
    setLoadMoreError(null);
    if (!taskId) {
      setState({ kind: "error", error: new Error("Task not found") });
      return () => {
        if (taskLoadGeneration.current === generation) taskLoadGeneration.current += 1;
      };
    }
    browserApi.task(taskId).then(
      (value) => taskLoadGeneration.current === generation && setState({ kind: "ready", value }),
      (error: unknown) =>
        taskLoadGeneration.current === generation && setState({ kind: "error", error: asError(error) }),
    );
    return () => {
      if (taskLoadGeneration.current === generation) taskLoadGeneration.current += 1;
    };
  }, [taskId]);

  async function loadMoreTurns(): Promise<void> {
    if (!taskId || state.kind !== "ready" || !state.value.nextCursor || loadingMore) return;
    const generation = taskLoadGeneration.current;
    const cursor = state.value.nextCursor;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const next = await browserApi.task(taskId, cursor);
      if (taskLoadGeneration.current !== generation) return;
      setState((current) =>
        current.kind === "ready" && current.value.task.id === taskId
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
      if (taskLoadGeneration.current !== generation) return;
      setLoadMoreError(asError(error));
    } finally {
      if (taskLoadGeneration.current === generation) setLoadingMore(false);
    }
  }

  if (state.kind === "loading") return <TaskLoading heading="Loading Task" />;
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
        <Link className="inline-flex items-center gap-1" to="/tasks">
          <Icon name="arrow-left" />
          Tasks
        </Link>
        <span className="text-sm text-kumo-subtle" data-ui="tasks-debug-note">
          Read-only debug view
        </span>
      </nav>

      <header className="grid gap-3" data-ui="task-conversation-header">
        <div className="break-words">
          <Text as="h1" size="lg" variant="heading">
            {task.title}
          </Text>
        </div>
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

      <Banner
        data-ui="task-capture-boundary"
        description="Provider outbound messages and detailed tool traces are not captured. Agent output below is the stored runtime final output."
        size="sm"
        variant="secondary"
      />

      <section className="grid gap-4" aria-label="Task conversation" data-ui="task-thread">
        {turns.length > 0 ? (
          turns.map((turn) => <TaskTurnView key={turn.deliveryId} task={task} turn={turn} />)
        ) : (
          <Empty
            description="This Session has no stored IM deliveries."
            icon={<Icon name="message" />}
            size="sm"
            title="No Turns recorded"
          />
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
        <Banner
          data-ui="task-runtime-error"
          description={loadMoreError.message}
          role="alert"
          size="sm"
          variant="error"
        />
      ) : null}

      <Collapsible.Root data-ui="task-debug-facts">
        <Collapsible.DefaultTrigger>Technical details</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel keepMounted>
          <LayerCard className="grid gap-4 p-4">
            <Text as="p" variant="secondary">
              Stable identifiers for support and runtime diagnostics.
            </Text>
            <section className="grid gap-3 @min-[36rem]/workspace:grid-cols-2" aria-label="Task debug identifiers">
              <DebugValue label="Session" value={task.id} />
              <DebugValue label="Channel" value={task.source.channelId} />
              {task.source.threadKey ? <DebugValue label="Thread" value={task.source.threadKey} /> : null}
              <DebugValue label="Agent" value={task.agent.id} />
            </section>
          </LayerCard>
        </Collapsible.DefaultPanel>
      </Collapsible.Root>

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
          <span className="grid min-w-0 gap-0.5">
            <strong className="break-words">
              {turn.message.authorDisplayName ?? humanizeEnum(turn.message.authorKind)}
            </strong>
            <small className="text-kumo-subtle">
              {attentionLabel(turn.attention)} · {formatTimestamp(turn.message.occurredAt)}
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
          <span className="grid min-w-0 gap-0.5">
            <strong>{task.agent.displayName}</strong>
            <small className="text-kumo-subtle">
              {absorbedBy
                ? "Steered into active Turn"
                : report
                  ? `${humanizeEnum(report.outcome)} · ${formatTimestamp(report.reportedAt)}`
                  : deliveryStateLabel(turn.delivery.state)}
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
              : `Delivery ${deliveryStateLabel(turn.delivery.state).toLocaleLowerCase()}.`}
          </p>
        )}
        <Collapsible.Root data-ui="task-agent-process">
          <Collapsible.DefaultTrigger>
            <span>Runtime details</span>
          </Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel keepMounted>
            <LayerCard className="grid gap-4 p-4" data-ui="task-agent-events">
              <p className="text-sm text-kumo-subtle" data-ui="task-process-metadata">
                {[
                  `${turn.delivery.attemptCount} ${turn.delivery.attemptCount === 1 ? "attempt" : "attempts"}`,
                  report ? `Outcome: ${humanizeEnum(report.outcome)}` : null,
                  report ? `Effects: ${humanizeEnum(report.executionEffects)}` : null,
                  tokenTotal === null ? null : `${tokenTotal.toLocaleString()} tokens`,
                  report ? `${report.traceSummary.lastSequence} trace events` : null,
                  report?.traceSummary.droppedEvents ? `${report.traceSummary.droppedEvents} dropped` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              <section className="grid gap-3 @min-[36rem]/workspace:grid-cols-2" aria-label="Runtime identifiers">
                <DebugValue label="Delivery" value={turn.deliveryId} />
                <DebugValue label="Message" value={turn.message.externalMessageId} />
                {absorbedBy ? <DebugValue label="Absorbed by delivery" value={absorbedBy.deliveryId} /> : null}
                {absorbedBy ? <DebugValue label="Target Turn" value={absorbedBy.turnId} /> : null}
                {report ? <DebugValue label="Turn" value={report.turnId} /> : null}
              </section>
              {report?.errorReason || turn.delivery.lastErrorCode || turn.delivery.reason ? (
                <Banner
                  data-ui="task-runtime-error"
                  description={report?.errorReason ?? turn.delivery.lastErrorCode ?? turn.delivery.reason}
                  size="sm"
                  variant="error"
                />
              ) : null}
            </LayerCard>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      </article>
    </section>
  );
}

function TaskRow({ task }: { task: TaskSummary }) {
  const status = statusPresentation[task.status];
  return (
    <Table.Row
      className="grid gap-3 rounded-lg p-4 ring ring-kumo-line @min-[36rem]/workspace:table-row @min-[36rem]/workspace:rounded-none @min-[36rem]/workspace:p-0 @min-[36rem]/workspace:ring-0"
      data-ui="task-table-row"
    >
      <Table.Cell
        className="block !p-0 @min-[36rem]/workspace:table-cell @min-[36rem]/workspace:!p-3"
        data-label="Task"
      >
        <Link className="font-medium" params={{ taskId: task.id }} title={task.title} to="/tasks/$taskId">
          {task.title}
        </Link>
        <span
          className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle"
          data-ui="task-list-metadata"
        >
          <span>{task.agent.displayName}</span>
          <span aria-hidden="true">·</span>
          <ProviderIcon provider={task.source.provider} compact />
          <span>{task.source.provider}</span>
          <span aria-hidden="true">·</span>
          <span>{task.sessionKind}</span>
          <span aria-hidden="true">·</span>
          <span>{shortId(task.source.threadKey ?? task.source.channelId)}</span>
        </span>
      </Table.Cell>
      <Table.Cell
        className="block !p-0 @min-[36rem]/workspace:table-cell @min-[36rem]/workspace:!p-3"
        data-label="Status"
      >
        <StatusIndicator
          className="flex-wrap"
          aria-label={`${status.label}, updated ${formatRelativeTime(task.lastActivityAt)}`}
          detail={formatRelativeTime(task.lastActivityAt)}
          label={status.label}
          tone={status.tone}
        />
      </Table.Cell>
    </Table.Row>
  );
}

function SourceIdentity({ task }: { task: TaskSummary }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-2" data-ui="task-source-identity">
      <ProviderIcon provider={task.source.provider} />
      <span className="grid min-w-0 gap-0.5">
        <strong className="break-words">{task.agent.displayName}</strong>
        <small className="break-words text-kumo-subtle">
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
      <span className="grid size-7 place-items-center rounded-full bg-kumo-tint" aria-hidden="true">
        S
      </span>
    );
  return <img alt="" aria-hidden="true" className={compact ? "size-5" : "size-7"} src={feishuIconUrl} />;
}

function DebugValue({ label, value }: { label: string; value: string }) {
  return (
    <span className="grid min-w-0 gap-1" data-ui="task-debug-value">
      <strong className="text-sm">{label}</strong>
      <ClipboardText
        labels={{ copyAction: `Copy ${label}` }}
        size="sm"
        text={value}
        tooltip={{ copiedText: "Copied!", side: "top", text: `Copy ${label}` }}
      />
    </span>
  );
}

function TaskLoading({ heading }: { heading: string }) {
  return (
    <LayerCard className="grid gap-4 p-4" aria-live="polite" data-ui="task-loading" role="status">
      <div className="sr-only">
        <Text as="h2" variant="heading">
          {heading}
        </Text>
      </div>
      <SkeletonLine className="h-5 w-2/5" />
      <SkeletonLine className="h-4 w-full" />
      <SkeletonLine className="h-4 w-4/5" />
    </LayerCard>
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

function attentionLabel(value: TaskTurn["attention"]): string {
  if (value === "direct") return "Direct message";
  if (value === "ambient") return "Ambient message";
  return humanizeEnum(value);
}

function deliveryStateLabel(value: TaskTurn["delivery"]["state"]): string {
  return value === "accepted" ? "In progress" : humanizeEnum(value);
}

function humanizeEnum(value: string): string {
  const normalized = value.replaceAll(/[_-]+/gu, " ");
  return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("The request failed");
}
