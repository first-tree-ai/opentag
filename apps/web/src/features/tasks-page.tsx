import type { ListTasksResponse, TaskDetail, TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { compareText, foldCase, formatDateTime, formatRelativeTime, initials } from "../i18n/format.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import {
  Button,
  Icon,
  KumoInputControl,
  KumoSelectControl,
  LayerCard,
  Loader,
  type SelectControlChangeEvent,
  StatusIndicator,
  type StatusTone,
  Table,
  Text,
} from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { agentTaskDetailLink, agentTasksLink } from "./agents/agent-routes.js";
import { isTerminalResourceError } from "./resource/resource-state.js";
import { TaskMessageBody } from "./task-message-body.js";

type TaskFilter = "all" | TaskStatus;

const statusPresentation: Record<TaskStatus, { readonly tone: StatusTone }> = {
  queued: { tone: "info" },
  running: { tone: "info" },
  completed: { tone: "success" },
  failed: { tone: "danger" },
  expired: { tone: "warning" },
  ended: { tone: "neutral" },
  idle: { tone: "neutral" },
};

export function TasksPage({ agentId, showExamples = false }: { agentId?: string; showExamples?: boolean } = {}) {
  const [query, setQuery] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("all");
  const [status, setStatus] = useState<TaskFilter>("all");
  /*
   * Pages accumulate in the cache, so a failed append leaves the rows already on screen alone and
   * stays retryable — the behavior the hand-rolled append kept its own error state for.
   */
  const tasksQuery = useInfiniteQuery({
    queryKey: taskListQueryKey(agentId, showExamples),
    queryFn: ({ pageParam }) => readTasks({ agentId, cursor: pageParam, showExamples }),
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
        matchesQuery &&
        (agentId ? task.agent.id === agentId : selectedAgentId === "all" || task.agent.id === selectedAgentId) &&
        (status === "all" || task.status === status)
      );
    });
  }, [agentId, loaded, query, selectedAgentId, status]);
  const showingDevelopmentExamples = developmentExamplesLoaded(showExamples, tasksQuery.data);

  return (
    <section className="grid gap-6" aria-labelledby="tasks-page-title" data-ui="tasks-page">
      <PageHeader description={m.tasks_page_description()} title={m.tasks_title()} titleId="tasks-page-title" />

      {/*
       * The toolbar is built out of the rows themselves — the Agent options are the Agents named by
       * the Tasks that were read. A terminal response withdraws those rows, so it has to withdraw
       * what was derived from them too, or the Account keeps reading Agent names off a list the
       * Server has just refused. The typed filters are React state and come back on recovery.
       */}
      {terminalTasksError ? null : (
        <form
          className="flex flex-wrap items-end gap-3"
          aria-label={m.tasks_filter_tasks()}
          data-ui="task-toolbar"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="min-w-56 flex-1 @min-[48rem]/workspace:max-w-md">
            <span className="sr-only">{m.tasks_search_tasks()}</span>
            <KumoInputControl
              aria-label={m.tasks_search_tasks()}
              value={query}
              type="search"
              placeholder={m.tasks_search_tasks()}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {!agentId ? (
            <TaskSelect
              label={m.tasks_filter_by_agent()}
              value={selectedAgentId}
              onChange={(event) => setSelectedAgentId(event.target.value)}
            >
              <option value="all">{m.tasks_all_agents()}</option>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.displayName}
                </option>
              ))}
            </TaskSelect>
          ) : null}
          <TaskSelect
            label={m.tasks_filter_by_status()}
            value={status}
            onChange={(event) => setStatus(event.target.value as TaskFilter)}
          >
            <option value="all">{m.tasks_all_statuses()}</option>
            {Object.keys(statusPresentation).map((value) => (
              <option key={value} value={value}>
                {taskStatusLabel(value as TaskStatus)}
              </option>
            ))}
          </TaskSelect>
        </form>
      )}
      {showingDevelopmentExamples ? (
        <Text as="p" size="sm" variant="secondary">
          {m.tasks_development_examples()}
        </Text>
      ) : null}

      {!terminalTasksError && tasksQuery.isPending ? (
        <TaskNotice loading heading={m.tasks_loading_tasks()} detail={m.tasks_loading_tasks_detail()} />
      ) : null}
      {terminalTasksError ? (
        <TaskNotice
          action={
            <Button type="button" variant="secondary" onClick={() => void tasksQuery.refetch()}>
              {m.tasks_try_again()}
            </Button>
          }
          heading={m.tasks_tasks_unavailable()}
          detail={terminalTasksError.message}
        />
      ) : null}
      {!terminalTasksError && tasksQuery.isError && !tasksQuery.data ? (
        <TaskNotice
          action={
            <Button type="button" variant="secondary" onClick={() => void tasksQuery.refetch()}>
              {m.tasks_try_again()}
            </Button>
          }
          heading={m.tasks_tasks_unavailable()}
          detail={asError(tasksQuery.error).message}
        />
      ) : null}
      {!terminalTasksError && tasksQuery.data && tasks.length > 0 ? (
        <>
          <TaskTable showAgent={!agentId} showExamples={showExamples} tasks={tasks} />
          {tasksQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={tasksQuery.isFetchingNextPage}
                loading={tasksQuery.isFetchingNextPage}
                type="button"
                variant="secondary"
                onClick={() => void tasksQuery.fetchNextPage()}
              >
                {tasksQuery.isFetchingNextPage
                  ? m.tasks_loading_more()
                  : loadMoreError
                    ? m.tasks_try_again()
                    : m.tasks_load_more()}
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
        <TasksEmptyState hasLoadedTasks={loaded.length > 0} />
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
    queryFn: ({ pageParam }) => readTasks({ agentId, cursor: pageParam }),
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
          {m.tasks_title()}
        </Text>
        <Link className="text-sm text-kumo-link" {...agentTasksLink(agentId)}>
          All Tasks
        </Link>
      </div>
      {!unavailable && tasksQuery.isPending ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.tasks_loading_tasks_compact()}
        </p>
      ) : null}
      {unavailable ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.tasks_temporarily_unavailable()}
        </p>
      ) : null}
      {!unavailable && tasksQuery.data && tasks.length === 0 ? (
        <p className="text-sm text-kumo-subtle" role="status">
          {m.tasks_no_tasks_yet_detail()}
        </p>
      ) : null}
      {!unavailable && tasks.length > 0 ? (
        <>
          <TaskTable compact tasks={tasks} showAgent={false} />
          {tasksQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                disabled={tasksQuery.isFetchingNextPage}
                type="button"
                variant="secondary"
                onClick={() => void tasksQuery.fetchNextPage()}
              >
                {tasksQuery.isFetchingNextPage
                  ? m.tasks_loading_more()
                  : loadMoreError
                    ? m.tasks_try_again()
                    : m.tasks_load_more()}
              </Button>
              {loadMoreError ? (
                <span className="text-sm text-kumo-subtle" role="status">
                  {m.tasks_could_not_load_more()}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function TaskDetailPage({
  agentId,
  showExamples = false,
  taskId,
}: {
  agentId?: string;
  showExamples?: boolean;
  taskId?: string;
}) {
  /*
   * The Task itself, its internal Sessions and its collaboration messages come from the first page
   * only, exactly as the hand-rolled append kept them; each further page contributes Turns.
   */
  const taskQuery = useInfiniteQuery({
    queryKey: taskDetailQueryKey(taskId, showExamples),
    queryFn: ({ pageParam }) => readTaskDetail(taskId as string, agentId, pageParam, showExamples),
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

  if (terminalTaskError) {
    return <TaskUnavailable agentId={agentId} error={terminalTaskError} showExamples={showExamples} />;
  }
  if (taskId !== undefined && taskQuery.isPending) {
    return <TaskNotice loading heading={m.tasks_loading_task()} detail={m.tasks_loading_task_detail()} />;
  }
  if (!first) {
    // No Task id at all is the same answer as one the Server does not have.
    const error = taskId === undefined ? new ApiError(404, m.tasks_not_found()) : asError(taskQuery.error);
    return <TaskUnavailable agentId={agentId} error={error} showExamples={showExamples} />;
  }

  const { task } = first;
  const status = statusPresentation[task.status];
  return (
    <article className="grid gap-6" data-ui="task-conversation-page">
      <nav className="flex items-center gap-3" aria-label={m.tasks_breadcrumb()}>
        <TaskBackLink agentId={agentId ?? task.agent.id} showExamples={showExamples} />
      </nav>

      <header className="grid gap-4" data-ui="task-conversation-header">
        <div className="flex flex-wrap items-center justify-between gap-3 break-words">
          <Text as="h1" size="lg" variant="heading">
            {task.title}
          </Text>
          <StatusIndicator label={taskStatusLabel(task.status)} tone={status.tone} />
        </div>
        <dl
          className="grid gap-x-8 gap-y-4 border-y border-kumo-line py-4 @min-[36rem]/workspace:grid-cols-2 @min-[60rem]/workspace:grid-cols-4"
          aria-label={m.tasks_details()}
        >
          <TaskDetailFact label={m.tasks_agent_label()}>
            <span className="inline-flex items-center gap-2">
              <span
                className="grid size-7 place-items-center rounded-full bg-kumo-brand text-xs font-medium text-kumo-inverse"
                aria-hidden="true"
              >
                {task.agent.displayName.charAt(0)}
              </span>
              <strong>{task.agent.displayName}</strong>
            </span>
          </TaskDetailFact>
          <TaskDetailFact label={m.tasks_source_label()}>
            <span className="inline-flex items-center gap-1.5">
              <ProviderIcon className="size-5" provider={task.source.provider} />
              {sourceLabel(task)}
            </span>
          </TaskDetailFact>
          <TaskDetailFact label={m.tasks_started_label()}>
            <time dateTime={task.createdAt}>{formatDateTime(task.createdAt)}</time>
          </TaskDetailFact>
          <TaskDetailFact label={m.tasks_last_activity_label()}>
            <time dateTime={task.lastActivityAt} title={formatDateTime(task.lastActivityAt)}>
              {formatRelativeTime(task.lastActivityAt)}
            </time>
          </TaskDetailFact>
        </dl>
      </header>

      <section className="grid gap-5" aria-labelledby="task-activity-title" data-ui="task-thread">
        <Text as="h2" id="task-activity-title" variant="heading">
          {m.tasks_activity()}
        </Text>
        {turns.length > 0 ? (
          <div className="grid divide-y divide-kumo-line">
            {turns.map((turn) => (
              <TaskTurnView key={turn.deliveryId} task={task} turn={turn} />
            ))}
          </div>
        ) : (
          <TaskNotice heading={m.tasks_no_activity()} detail={m.tasks_no_activity_detail()} />
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
          {m.tasks_load_earlier_activity()}
        </Button>
      ) : null}
      {loadMoreError ? (
        <p className="text-sm text-kumo-danger" data-ui="task-activity-error" role="alert">
          {loadMoreError.message}
        </p>
      ) : null}
    </article>
  );
}

function TaskUnavailable({
  agentId,
  error,
  showExamples = false,
}: {
  agentId?: string;
  error: Error;
  showExamples?: boolean;
}) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <section className="grid gap-3" data-ui="task-not-found">
      <Text as="h1" size="lg" variant="heading">
        {notFound ? m.tasks_not_found() : m.tasks_unavailable()}
      </Text>
      <Text as="p" variant="secondary">
        {notFound ? m.tasks_not_found_detail() : error.message}
      </Text>
      {showExamples ? (
        <Link to="/tasks">{m.tasks_back_to_tasks()}</Link>
      ) : agentId ? (
        <Link {...agentTasksLink(agentId)}>{m.tasks_back_to_tasks()}</Link>
      ) : (
        <Link to="/agents">{m.tasks_back_to_agents()}</Link>
      )}
    </section>
  );
}

function TaskTurnView({ task, turn }: { task: TaskSummary; turn: TaskTurn }) {
  const report = turn.report;
  const absorbedBy = turn.absorbedBy;
  return (
    <section
      className="grid gap-4 py-6 first:pt-0 last:pb-0"
      aria-label={m.tasks_message_sent_at({ time: formatDateTime(turn.message.occurredAt) })}
      data-ui="task-exchange"
    >
      <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3" data-ui="task-message-request">
        <span className="grid size-8 place-items-center rounded-md bg-kumo-tint text-xs font-medium" aria-hidden="true">
          {initials(turn.message.authorDisplayName ?? taskAuthorLabel(turn.message.authorKind))}
        </span>
        <div className="grid min-w-0 gap-2">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author">
            <strong className="break-words">
              {turn.message.authorDisplayName ?? taskAuthorLabel(turn.message.authorKind)}
            </strong>
            <small className="text-kumo-subtle">
              {attentionLabel(turn.attention)} · {formatDateTime(turn.message.occurredAt)}
            </small>
          </header>
          <div className="max-w-[48rem] rounded-lg bg-kumo-recessed p-4">
            <TaskMessageBody format="plain_text" text={turn.message.fallbackText} />
          </div>
        </div>
      </article>

      <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3" data-ui="task-message-agent">
        <span
          className="grid size-8 place-items-center rounded-full bg-kumo-brand text-xs font-medium text-kumo-inverse"
          aria-hidden="true"
        >
          {task.agent.displayName.charAt(0)}
        </span>
        <div className="grid min-w-0 gap-2">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author-agent">
            <strong>{task.agent.displayName}</strong>
            <small className="text-kumo-subtle">
              {absorbedBy
                ? m.tasks_added_to_active_work()
                : report
                  ? m.tasks_report_summary({
                      outcome: humanizeEnum(report.outcome),
                      time: formatDateTime(report.reportedAt),
                    })
                  : deliveryStateLabel(turn.delivery.state)}
            </small>
          </header>
          <section
            className="max-w-[48rem] rounded-lg bg-kumo-base p-4 ring ring-kumo-line"
            aria-label={m.tasks_agent_response()}
            data-ui="task-agent-response"
          >
            {absorbedBy ? (
              <p className="text-sm text-kumo-subtle" data-ui="task-progress-summary">
                {m.tasks_included_in_active_work()}
              </p>
            ) : report?.finalText ? (
              <TaskMessageBody format="markdown" text={report.finalText} />
            ) : report?.errorReason ? (
              <p className="text-sm text-kumo-danger">{report.errorReason}</p>
            ) : (
              <p
                className="text-sm text-kumo-subtle"
                data-state={turn.delivery.state === "accepted" ? "progress" : "attention"}
              >
                {turn.delivery.state === "accepted"
                  ? m.tasks_work_in_progress()
                  : m.tasks_message_state({ state: deliveryStateLabel(turn.delivery.state).toLocaleLowerCase() })}
              </p>
            )}
          </section>
        </div>
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

function TasksEmptyState({ hasLoadedTasks }: { hasLoadedTasks: boolean }) {
  if (hasLoadedTasks) {
    return <TaskNotice heading={m.tasks_no_tasks_found()} detail={m.tasks_no_tasks_found_detail()} />;
  }
  return <TaskNotice heading={m.tasks_no_tasks_yet_heading()} detail={m.tasks_no_tasks_yet_detail()} />;
}

function TaskBackLink({ agentId, showExamples }: { agentId: string; showExamples: boolean }) {
  if (showExamples) {
    return (
      <Link to="/tasks">
        <Icon name="arrow-left" />
        {m.tasks_title()}
      </Link>
    );
  }
  return (
    <Link {...agentTasksLink(agentId)}>
      <Icon name="arrow-left" />
      {m.tasks_title()}
    </Link>
  );
}

function TaskTable({
  compact = false,
  showAgent = true,
  showExamples = false,
  tasks,
}: {
  compact?: boolean;
  showAgent?: boolean;
  showExamples?: boolean;
  tasks: TaskSummary[];
}) {
  const table = (
    <section
      aria-label={m.tasks_table_region()}
      className="min-w-0 overflow-hidden rounded-lg @min-[40rem]/workspace:overflow-x-auto @min-[40rem]/workspace:focus:outline-none @min-[40rem]/workspace:focus-visible:ring-2 @min-[40rem]/workspace:focus-visible:ring-kumo-brand @min-[40rem]/workspace:focus-visible:ring-inset"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The same region remains keyboard-scrollable on wider workspaces.
      tabIndex={0}
    >
      <Table
        aria-label={compact ? m.tasks_agent_tasks() : m.tasks_title()}
        className={`block min-w-0 @min-[40rem]/workspace:table ${showAgent ? "@min-[40rem]/workspace:min-w-[52rem]" : "@min-[40rem]/workspace:min-w-[42rem]"}`}
        data-ui="task-table"
        layout="fixed"
      >
        <colgroup className="hidden @min-[40rem]/workspace:table-column-group">
          <col />
          {showAgent ? <col className="w-44" /> : null}
          <col className="w-44" />
          <col className="w-32" />
          <col className="w-36" />
        </colgroup>
        <Table.Header
          className="hidden @min-[40rem]/workspace:table-header-group"
          variant={compact ? "compact" : undefined}
        >
          <Table.Row>
            <Table.Head>{m.tasks_task_label()}</Table.Head>
            {showAgent ? <Table.Head>{m.tasks_agent_label()}</Table.Head> : null}
            <Table.Head>{m.tasks_source_label()}</Table.Head>
            <Table.Head>{m.tasks_status_label()}</Table.Head>
            <Table.Head>{m.tasks_last_activity_label()}</Table.Head>
          </Table.Row>
        </Table.Header>
        <Table.Body className="block @min-[40rem]/workspace:table-row-group">
          {tasks.map((task) => (
            <TaskRow key={task.id} showAgent={showAgent} showExamples={showExamples} task={task} />
          ))}
        </Table.Body>
      </Table>
    </section>
  );
  if (compact) return table;
  return (
    <LayerCard className="p-0" data-ui="tasks-card">
      {table}
    </LayerCard>
  );
}

function TaskRow({
  showAgent = true,
  showExamples = false,
  task,
}: {
  showAgent?: boolean;
  showExamples?: boolean;
  task: TaskSummary;
}) {
  const status = statusPresentation[task.status];
  return (
    <Table.Row
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-kumo-line last:border-b-0 @min-[40rem]/workspace:table-row @min-[40rem]/workspace:border-b-0"
      data-ui="task-table-row"
    >
      <Table.Cell className="col-start-1 row-start-1 min-w-0" data-label={m.tasks_task_label()}>
        <TaskTitleLink showExamples={showExamples} task={task} />
      </Table.Cell>
      {showAgent ? (
        <Table.Cell className="col-span-2 row-start-3" data-label={m.tasks_agent_label()}>
          <span className="inline-flex min-w-0 items-center gap-2">
            <span
              className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-brand text-xs font-medium text-kumo-inverse"
              aria-hidden="true"
            >
              {task.agent.displayName.charAt(0)}
            </span>
            <span className="truncate">{task.agent.displayName}</span>
          </span>
        </Table.Cell>
      ) : null}
      <Table.Cell className="col-start-1 row-start-2 min-w-0" data-label={m.tasks_source_label()}>
        <span className="inline-flex items-center gap-2">
          <ProviderIcon className="size-5" provider={task.source.provider} />
          <span>{sourceLabel(task)}</span>
        </span>
      </Table.Cell>
      <Table.Cell className="col-start-2 row-start-1 justify-self-end" data-label={m.tasks_status_label()}>
        <StatusIndicator label={taskStatusLabel(task.status)} tone={status.tone} />
      </Table.Cell>
      <Table.Cell
        className="col-start-2 row-start-2 justify-self-end self-center"
        data-label={m.tasks_last_activity_label()}
      >
        <time
          className="text-sm text-kumo-subtle"
          dateTime={task.lastActivityAt}
          title={formatDateTime(task.lastActivityAt)}
        >
          {formatRelativeTime(task.lastActivityAt)}
        </time>
      </Table.Cell>
    </Table.Row>
  );
}

function TaskTitleLink({ showExamples, task }: { showExamples: boolean; task: TaskSummary }) {
  const className =
    "block break-words font-medium text-kumo-default hover:text-kumo-link @min-[40rem]/workspace:truncate";
  if (showExamples) {
    return (
      <Link
        className={className}
        params={{ taskId: task.id }}
        search={{ examples: true }}
        title={task.title}
        to="/tasks/$taskId"
      >
        {task.title}
      </Link>
    );
  }
  return (
    <Link className={className} {...agentTaskDetailLink(task.agent.id, task.id)} title={task.title}>
      {task.title}
    </Link>
  );
}

function TaskDetailFact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="grid min-w-0 gap-1">
      <Text as="dt" size="xs" variant="secondary">
        {label}
      </Text>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function TaskNotice({
  action,
  detail,
  heading,
  loading = false,
}: {
  action?: ReactNode;
  detail: string;
  heading: string;
  loading?: boolean;
}) {
  return (
    <section
      className="grid gap-2 rounded-lg bg-kumo-base p-8 text-center ring ring-kumo-line"
      aria-live="polite"
      data-ui="task-empty-state"
    >
      <div className="flex items-center justify-center gap-2">
        {loading ? <Loader aria-label={heading} size="sm" /> : null}
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

function sourceLabel(task: TaskSummary): string {
  const context =
    task.sessionKind === "thread"
      ? m.tasks_source_thread()
      : task.source.conversationKind === "dm"
        ? m.tasks_source_direct_message()
        : task.source.conversationKind === "group_dm"
          ? m.tasks_source_group_chat()
          : m.tasks_source_channel();
  return `${humanizeEnum(task.source.provider)} · ${context}`;
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

function deliveryStateLabel(value: TaskTurn["delivery"]["state"]): string {
  return value === "accepted" ? m.tasks_in_progress() : humanizeEnum(value);
}

function taskStatusLabel(value: TaskStatus): string {
  if (value === "queued") return m.tasks_status_queued();
  if (value === "running") return m.tasks_status_running();
  if (value === "completed") return m.tasks_status_completed();
  if (value === "failed") return m.tasks_status_failed();
  if (value === "expired") return m.tasks_status_expired();
  if (value === "ended") return m.tasks_status_ended();
  return m.tasks_status_idle();
}

function humanizeEnum(value: string): string {
  const normalized = value.replaceAll(/[_-]+/gu, " ");
  return `${normalized.charAt(0).toLocaleUpperCase()}${normalized.slice(1)}`;
}

function taskListQueryKey(agentId: string | undefined, showExamples: boolean) {
  if (showExamples) return [...queryKeys.tasks.list(), "development-examples"] as const;
  return agentId ? queryKeys.tasks.byAgent(agentId) : queryKeys.tasks.list();
}

function taskDetailQueryKey(taskId: string | undefined, showExamples: boolean) {
  const key = queryKeys.tasks.detail(taskId ?? "");
  return showExamples ? ([...key, "development-example"] as const) : key;
}

function developmentExamplesLoaded(showExamples: boolean, data: unknown): boolean {
  return showExamples && data !== undefined;
}

async function readTasks({
  agentId,
  cursor,
  showExamples = false,
}: {
  agentId?: string;
  cursor?: string;
  showExamples?: boolean;
}): Promise<ListTasksResponse> {
  if (showExamples) {
    const { createDevelopmentTasks } = await loadDevelopmentTaskData();
    return createDevelopmentTasks(agentId ?? "40000000-0000-4000-8000-000000000001");
  }
  return browserApi.tasks({ agentId, cursor });
}

async function readTaskDetail(
  taskId: string,
  agentId?: string,
  cursor?: string,
  showExamples = false,
): Promise<TaskDetail> {
  if (showExamples && !cursor) {
    const { createDevelopmentTaskDetail } = await loadDevelopmentTaskData();
    const detail = createDevelopmentTaskDetail(taskId, agentId ?? "40000000-0000-4000-8000-000000000001");
    if (detail) return detail;
  }
  return browserApi.task(taskId, cursor);
}

async function loadDevelopmentTaskData() {
  if (!import.meta.env.DEV) throw new Error("Development Task examples are unavailable in production");
  return import("../mock/dev-task-data.js");
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(m.tasks_request_failed());
}
