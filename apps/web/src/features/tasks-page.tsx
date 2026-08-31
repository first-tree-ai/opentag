import type { TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { compareText, foldCase, formatDateTime, formatNumber, formatRelativeTime, initials } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import {
  Button,
  ClipboardText,
  Collapsible,
  Icon,
  KumoInputControl,
  KumoSelectControl,
  Loader,
  type SelectControlChangeEvent,
  StatusIndicator,
  type StatusTone,
  Table,
  Text,
} from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { isTerminalResourceError } from "./resource/resource-state.js";

type TaskFilter = "all" | TaskStatus;

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
  const [query, setQuery] = useState("");
  const [agentId, setAgentId] = useState("all");
  const [status, setStatus] = useState<TaskFilter>("all");
  /*
   * Pages accumulate in the cache, so a failed append leaves the rows already on screen alone and
   * stays retryable — the behavior the hand-rolled append kept its own error state for.
   */
  const tasksQuery = useInfiniteQuery({
    queryKey: queryKeys.tasks.list(),
    queryFn: ({ pageParam }) => browserApi.tasks({ cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    // The API reports the end of the list as null; the cache reads undefined as "no page after this".
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const loaded = useMemo(() => tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [], [tasksQuery.data]);
  const taskError = asError(tasksQuery.error);
  /*
   * Which page failed does not change what a terminal status means. The Server resolves the Task
   * scope before it parses a cursor — an unusable cursor is a 400 — so a 401, 403, 404 or 410 on an
   * append says the same thing it says on the first read, and the rows already in hand are exactly
   * what must stop being shown.
   */
  const terminalTasksError = tasksQuery.isError && isTerminalResourceError(taskError) ? taskError : null;
  const loadMoreError = tasksQuery.isFetchNextPageError && !terminalTasksError ? taskError : null;

  const agents = useMemo(
    () =>
      [...new Map(loaded.map((task) => [task.agent.id, task.agent])).values()].sort((left, right) =>
        compareText(left.displayName, right.displayName),
      ),
    [loaded],
  );
  const tasks = useMemo(() => {
    const normalizedQuery = foldCase(query.trim());
    return loaded.filter((task) => {
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
          .map((value) => foldCase(value ?? ""))
          .join(" ")
          .includes(normalizedQuery);
      return (
        matchesQuery && (agentId === "all" || task.agent.id === agentId) && (status === "all" || task.status === status)
      );
    });
  }, [agentId, loaded, query, status]);

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

      {/*
       * The toolbar is built out of the rows themselves — the Agent options are the Agents named by
       * the Tasks that were read. A terminal response withdraws those rows, so it has to withdraw
       * what was derived from them too, or the Account keeps reading Agent names off a list the
       * Server has just refused. The typed filters are React state and come back on recovery.
       */}
      {terminalTasksError ? null : (
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
      )}

      {!terminalTasksError && tasksQuery.isPending ? (
        <TaskNotice heading="Loading Tasks" detail="Reading stored Sessions and Turns." />
      ) : null}
      {terminalTasksError ? (
        <TaskNotice
          action={
            <Button type="button" variant="secondary" onClick={() => void tasksQuery.refetch()}>
              Try again
            </Button>
          }
          heading="Tasks unavailable"
          detail={terminalTasksError.message}
        />
      ) : null}
      {!terminalTasksError && tasksQuery.isError && !tasksQuery.data ? (
        <TaskNotice
          action={
            <Button type="button" variant="secondary" onClick={() => void tasksQuery.refetch()}>
              Try again
            </Button>
          }
          heading="Tasks unavailable"
          detail={asError(tasksQuery.error).message}
        />
      ) : null}
      {!terminalTasksError && tasksQuery.data && tasks.length > 0 ? (
        <>
          <section
            aria-label="Tasks table"
            className="min-w-0 overflow-x-auto rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus the horizontal scroll region.
            tabIndex={0}
          >
            <Table className="min-w-[36rem]" aria-label="Tasks" data-ui="task-table">
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
          </section>
          {tasksQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={tasksQuery.isFetchingNextPage}
                loading={tasksQuery.isFetchingNextPage}
                type="button"
                variant="secondary"
                onClick={() => void tasksQuery.fetchNextPage()}
              >
                {tasksQuery.isFetchingNextPage ? "Loading more Tasks…" : loadMoreError ? "Try again" : "Load more"}
              </Button>
              {loadMoreError ? (
                <span className="text-sm text-kumo-danger" role="alert">
                  {loadMoreError.message}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      {!terminalTasksError && tasksQuery.data && tasks.length === 0 ? (
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
  /*
   * Keyed by the Agent, so the route reusing this component for a different `:agentId` reads a
   * different entry rather than a load that has to be told apart from the one before it. An append
   * belongs to the entry that started it, and the pages it accumulated are still there on the way
   * back — which is what the generation counter here had to imitate by hand.
   */
  const tasksQuery = useInfiniteQuery({
    queryKey: queryKeys.tasks.byAgent(agentId),
    queryFn: ({ pageParam }) => browserApi.tasks({ agentId, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const tasks = useMemo(() => tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [], [tasksQuery.data]);
  const taskError = asError(tasksQuery.error);
  // The same rule the workspace list follows: a refusal withdraws the rows it refused, whichever
  // page asked for them. Only a transient append failure keeps them, reported beside its control.
  const terminalTasksError = tasksQuery.isError && isTerminalResourceError(taskError) ? taskError : null;
  const loadMoreError = tasksQuery.isFetchNextPageError && !terminalTasksError ? taskError : null;
  const unavailable = terminalTasksError !== null || (tasksQuery.isError && !tasksQuery.data);

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
      {!unavailable && tasksQuery.isPending ? (
        <p className="text-sm text-kumo-subtle" role="status">
          Loading Tasks…
        </p>
      ) : null}
      {unavailable ? (
        <p className="text-sm text-kumo-subtle" role="status">
          Tasks are temporarily unavailable.
        </p>
      ) : null}
      {!unavailable && tasksQuery.data && tasks.length === 0 ? (
        <p className="text-sm text-kumo-subtle" role="status">
          No Tasks yet. Message this Agent in your chat app to put it to work.
        </p>
      ) : null}
      {!unavailable && tasks.length > 0 ? (
        <>
          <div className="overflow-x-auto">
            <Table className="w-full" aria-label="Agent Tasks" data-ui="task-table">
              <thead>
                <tr className="border-b border-kumo-line text-left text-sm text-kumo-subtle">
                  <th scope="col">Task</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <TaskRow key={task.id} showAgent={false} task={task} />
                ))}
              </tbody>
            </Table>
          </div>
          {tasksQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={tasksQuery.isFetchingNextPage}
                type="button"
                variant="secondary"
                onClick={() => void tasksQuery.fetchNextPage()}
              >
                {tasksQuery.isFetchingNextPage ? "Loading more Tasks…" : loadMoreError ? "Try again" : "Load more"}
              </Button>
              {loadMoreError ? (
                <span className="text-sm text-kumo-subtle" role="status">
                  Could not load more Tasks.
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function TaskDetailPage({ taskId }: { taskId?: string }) {
  /*
   * The Task itself, its internal Sessions and its collaboration messages come from the first page
   * only, exactly as the hand-rolled append kept them; each further page contributes Turns.
   */
  const taskQuery = useInfiniteQuery({
    queryKey: queryKeys.tasks.detail(taskId ?? ""),
    queryFn: ({ pageParam }) => browserApi.task(taskId as string, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: taskId !== undefined,
  });
  const first = taskQuery.data?.pages[0];
  const turns = useMemo(() => taskQuery.data?.pages.flatMap((page) => page.turns) ?? [], [taskQuery.data]);
  const taskError = asError(taskQuery.error);
  // `TaskService.get` resolves the Task before it parses a cursor, so a terminal status on a Turn
  // append is about the Task, not the page boundary. It withdraws the conversation with it.
  const terminalTaskError = taskQuery.isError && isTerminalResourceError(taskError) ? taskError : null;
  const loadMoreError = taskQuery.isFetchNextPageError && !terminalTaskError ? taskError : null;

  if (terminalTaskError) return <TaskUnavailable error={terminalTaskError} />;
  if (taskId !== undefined && taskQuery.isPending) {
    return <TaskNotice heading="Loading Task" detail="Reading stored Turn details." />;
  }
  if (!first) {
    // No Task id at all is the same answer as one the Server does not have.
    const error = taskId === undefined ? new ApiError(404, "Task not found") : asError(taskQuery.error);
    return <TaskUnavailable error={error} />;
  }

  const { task, internalSessions, collaborationMessages } = first;
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

      <section
        className="grid gap-3 @min-[36rem]/workspace:grid-cols-2"
        aria-label="Task debug identifiers"
        data-ui="task-debug-facts"
      >
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
      {taskQuery.hasNextPage ? (
        <Button
          loading={taskQuery.isFetchingNextPage}
          type="button"
          variant="secondary"
          disabled={taskQuery.isFetchingNextPage}
          onClick={() => void taskQuery.fetchNextPage()}
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
                    {message.outcome} · {formatDateTime(message.createdAt)} · {message.sourceSessionId} →{" "}
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

function TaskUnavailable({ error }: { error: Error }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <section className="grid gap-3" data-ui="task-not-found">
      <Text as="h1" size="lg" variant="heading">
        {notFound ? "Task not found" : "Task unavailable"}
      </Text>
      <Text as="p" variant="secondary">
        {notFound ? "This Task does not exist or is outside your Account." : error.message}
      </Text>
      <Link to="/tasks">Back to Tasks</Link>
    </section>
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
      aria-label={`Message sent at ${formatDateTime(turn.message.occurredAt)}`}
      data-ui="task-exchange"
    >
      <article className="rounded-lg bg-kumo-recessed p-4" data-ui="task-message-request">
        <header className="flex items-center gap-2" data-ui="task-message-author">
          <span
            className="grid size-7 place-items-center rounded-full bg-kumo-tint text-xs font-medium"
            aria-hidden="true"
          >
            {initials(turn.message.authorDisplayName ?? turn.message.authorKind)}
          </span>
          <span>
            <strong>{turn.message.authorDisplayName ?? turn.message.authorKind}</strong>
            <small>
              {turn.attention} · {formatDateTime(turn.message.occurredAt)}
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
                  ? `${report.outcome} · ${formatDateTime(report.reportedAt)}`
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
                  tokenTotal === null ? null : String(m.format_tokens({ count: formatNumber(tokenTotal) })),
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
  onChange: (event: SelectControlChangeEvent) => void;
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
        <Link params={{ taskId: task.id }} title={task.title} to="/tasks/$taskId">
          {task.title}
        </Link>
        <span className="mt-1 block text-sm text-kumo-subtle" data-ui="task-list-metadata">
          {showAgent ? (
            <>
              <span>{task.agent.displayName}</span>
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          <TaskProviderIcon provider={task.source.provider} compact />
          <span>{messagingProviderLabel(task.source.provider)}</span>
          <span aria-hidden="true"> · </span>
          <span>{task.sessionKind}</span>
          <span aria-hidden="true"> · </span>
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
          {messagingProviderLabel(task.source.provider)} · {task.sessionKind} ·{" "}
          {shortId(task.source.threadKey ?? task.source.channelId)}
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
  return (
    <ProviderIcon className={compact ? "mr-1 inline-block size-5" : "mr-1 inline-block size-6"} provider={provider} />
  );
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

function TaskNotice({ action, heading, detail }: { action?: ReactNode; heading: string; detail: string }) {
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
      {action ? <div className="flex justify-center">{action}</div> : null}
    </section>
  );
}

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("The request failed");
}
