import type { ListTasksResponse, TaskDetail, TaskSummary } from "@opentag/shared/browser";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { compareText, foldCase, formatDateTime, formatRelativeTime } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import { liveResourceQueryOptions } from "../query/live.js";
import {
  Button,
  buttonClassName,
  Icon,
  KumoInputControl,
  LayerCard,
  Loader,
  Select,
  StatusIndicator,
  Table,
  Text,
} from "../ui/design-system.js";
import { ProviderIcon } from "../ui/provider-icon.js";
import { agentTaskDetailLink, agentTasksLink } from "./agents/agent-routes.js";
import {
  liveRefreshErrors,
  ResourceRefreshNotice,
  ResourceRefreshStatus,
  usePersistedSettledError,
} from "./resource/resource-state.js";
import { useRememberedState } from "./shell/shell-memory.js";
import { TaskCancelControl } from "./task-cancel.js";
import { TaskActivity } from "./task-conversation.js";
import {
  TASK_STATUS_GROUPS,
  type TaskStatusGroup,
  taskStatusGroup,
  taskStatusGroupLabel,
  taskStatusGroupTone,
} from "./task-status.js";

type TaskFilter = "all" | TaskStatusGroup;

export function TasksPage({ agentId, showExamples = false }: { agentId?: string; showExamples?: boolean } = {}) {
  const filterKey = taskFilterKey(agentId);
  const [query, setQuery] = useRememberedState(`${filterKey}:query`, "");
  const [selectedAgentId, setSelectedAgentId] = useState("all");
  const [status, setStatus] = useRememberedState<TaskFilter>(`${filterKey}:status`, "all");
  /*
   * Pages accumulate in the cache, so a failed append leaves the rows already on screen alone and
   * stays retryable — the behavior the hand-rolled append kept its own error state for.
   */
  const listKey = taskListQueryKey(agentId, showExamples);
  const tasksQuery = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => readTasks({ agentId, cursor: pageParam, showExamples }),
    initialPageParam: undefined as string | undefined,
    // The API reports the end of the list as null; the cache reads undefined as "no page after this".
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...liveResourceQueryOptions,
  });
  const loaded = useMemo(() => tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [], [tasksQuery.data]);
  const taskError = asError(tasksQuery.error);
  const persistedError = usePersistedSettledError(listKey, {
    error: tasksQuery.error ? taskError : null,
    isError: tasksQuery.isError,
    isSuccess: tasksQuery.isSuccess,
  });
  /*
   * Which page failed does not change what a terminal status means. The Server resolves the Task
   * scope before it parses a cursor — an unusable cursor is a 400 — so a 401, 403, 404 or 410 on an
   * append says the same thing it says on the first read, and the rows already in hand are exactly
   * what must stop being shown.
   */
  const {
    terminalError: terminalTasksError,
    loadMoreError,
    refreshError,
  } = liveRefreshErrors({ ...tasksQuery, error: taskError }, persistedError);

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
        (status === "all" || taskStatusGroup(task.status) === status)
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
          className="flex flex-col gap-3 @min-[48rem]/content:flex-row @min-[48rem]/content:items-center"
          aria-label={m.tasks_filter_tasks()}
          data-ui="task-toolbar"
          onSubmit={(event) => event.preventDefault()}
        >
          <div className="min-w-56 flex-1 @min-[48rem]/content:max-w-md">
            <span className="sr-only">{m.tasks_search_tasks()}</span>
            <KumoInputControl
              aria-label={m.tasks_search_tasks()}
              className="w-full"
              size="sm"
              value={query}
              type="search"
              placeholder={m.tasks_search_tasks()}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <div className="flex w-full flex-col gap-3 @min-[36rem]/content:flex-row @min-[48rem]/content:ml-auto @min-[48rem]/content:w-auto">
            {!agentId ? (
              <TaskSelect
                label={m.tasks_filter_by_agent()}
                options={[
                  { label: m.tasks_all_agents(), value: "all" },
                  ...agents.map((agent) => ({ label: agent.displayName, value: agent.id })),
                ]}
                renderValue={(value) =>
                  value === "all"
                    ? m.tasks_all_agents()
                    : m.tasks_agent_filter_value({
                        agent: agents.find((agent) => agent.id === value)?.displayName ?? value,
                      })
                }
                value={selectedAgentId}
                onChange={setSelectedAgentId}
              />
            ) : null}
            <TaskSelect
              label={m.tasks_filter_by_status()}
              options={[
                { label: m.tasks_all_statuses(), value: "all" },
                ...TASK_STATUS_GROUPS.map((value) => ({ label: taskStatusGroupLabel(value), value })),
              ]}
              renderValue={(value) =>
                value === "all"
                  ? m.tasks_all_statuses()
                  : m.tasks_status_filter_value({ status: taskStatusGroupLabel(value as TaskStatusGroup) })
              }
              value={status}
              onChange={(value) => setStatus(value as TaskFilter)}
            />
          </div>
        </form>
      )}
      {showingDevelopmentExamples ? (
        <Text as="p" size="sm" variant="secondary">
          {m.tasks_development_examples()}
        </Text>
      ) : null}
      {refreshError ? <ResourceRefreshNotice error={refreshError} onRetry={() => void tasksQuery.refetch()} /> : null}

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
                disabled={tasksQuery.isFetching}
                loading={tasksQuery.isFetchingNextPage}
                type="button"
                variant="secondary"
                onClick={() => void tasksQuery.fetchNextPage({ cancelRefetch: false })}
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
 * an Account-wide page, so paging past the first page cannot hide this Agent's older Tasks.
 */
export function AgentTasksSection({ agentId }: { agentId: string }) {
  /*
   * Keyed by the Agent, so the route reusing this component for a different `:agentId` reads a
   * different entry rather than a load that has to be told apart from the one before it. An append
   * belongs to the entry that started it, and the pages it accumulated are still there on the way
   * back — which is what the generation counter here had to imitate by hand.
   */
  const listKey = queryKeys.tasks.byAgent(agentId);
  const tasksQuery = useInfiniteQuery({
    queryKey: listKey,
    queryFn: ({ pageParam }) => readTasks({ agentId, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    ...liveResourceQueryOptions,
  });
  const tasks = useMemo(() => tasksQuery.data?.pages.flatMap((page) => page.tasks) ?? [], [tasksQuery.data]);
  const taskError = asError(tasksQuery.error);
  const persistedError = usePersistedSettledError(listKey, {
    error: tasksQuery.error ? taskError : null,
    isError: tasksQuery.isError,
    isSuccess: tasksQuery.isSuccess,
  });
  // The same rule the Account list follows: a refusal withdraws the rows it refused, whichever
  // page asked for them. Only a transient append failure keeps them, reported beside its control.
  const {
    terminalError: terminalTasksError,
    loadMoreError,
    refreshError,
  } = liveRefreshErrors({ ...tasksQuery, error: taskError }, persistedError);
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
      {refreshError ? <ResourceRefreshStatus error={refreshError} onRetry={() => void tasksQuery.refetch()} /> : null}
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
                disabled={tasksQuery.isFetching}
                type="button"
                variant="secondary"
                onClick={() => void tasksQuery.fetchNextPage({ cancelRefetch: false })}
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
  const detailKey = taskDetailQueryKey(taskId, showExamples);
  const taskQuery = useInfiniteQuery({
    queryKey: detailKey,
    queryFn: ({ pageParam }) => readTaskDetail(taskId as string, agentId, pageParam, showExamples),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: taskId !== undefined,
    ...liveResourceQueryOptions,
  });
  const first = taskQuery.data?.pages[0];
  const turns = useMemo(() => {
    const loaded = taskQuery.data?.pages.flatMap((page) => page.turns) ?? [];
    // Reverse the complete collection, including each page's order and the API's timestamp ties.
    return loaded.reverse();
  }, [taskQuery.data]);
  const taskError = asError(taskQuery.error);
  const persistedError = usePersistedSettledError(detailKey, {
    error: taskQuery.error ? taskError : null,
    isError: taskQuery.isError,
    isSuccess: taskQuery.isSuccess,
  });
  // `TaskService.get` resolves the Task before it parses a cursor, so a terminal status on a Turn
  // append is about the Task, not the page boundary. It withdraws the conversation with it.
  const {
    terminalError: terminalTaskError,
    loadMoreError,
    refreshError,
  } = liveRefreshErrors({ ...taskQuery, error: taskError }, persistedError);

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
  const status = taskStatusGroup(task.status);
  const pagination = (
    <>
      {taskQuery.hasNextPage ? (
        <Button
          loading={taskQuery.isFetchingNextPage}
          type="button"
          variant="secondary"
          disabled={taskQuery.isFetching}
          onClick={() => void taskQuery.fetchNextPage({ cancelRefetch: false })}
        >
          {m.tasks_load_earlier_activity()}
        </Button>
      ) : null}
      {loadMoreError ? (
        <p className="text-sm text-kumo-danger" data-ui="task-activity-error" role="alert">
          {loadMoreError.message}
        </p>
      ) : null}
    </>
  );
  return (
    <article className="grid gap-6" data-ui="task-conversation-page">
      <nav className="-ml-2" aria-label={m.tasks_back_to_tasks()}>
        <TaskBackLink agentId={agentId ?? task.agent.id} showExamples={showExamples} />
      </nav>

      <header className="grid gap-4" data-ui="task-conversation-header">
        {/*
         * The title is a message excerpt of unpredictable length, so nothing shares its row. The
         * status is a fact about the Task and sits with the other facts, last, where it reads as
         * the outcome of what precedes it; equal columns keep it in one place whatever the title
         * or the Agent name measures.
         */}
        <div className="min-w-0 break-words">
          <Text as="h1" size="lg" variant="heading">
            {task.title}
          </Text>
        </div>
        <dl
          className="grid gap-x-8 gap-y-4 border-y border-kumo-line py-4 @min-[36rem]/content:grid-cols-3 @min-[60rem]/content:grid-cols-5"
          aria-label={m.tasks_details()}
        >
          <TaskDetailFact label={m.tasks_agent_label()}>
            <span className="flex min-w-0 items-center gap-2">
              <span
                className="grid size-7 shrink-0 place-items-center rounded-full bg-kumo-brand text-xs font-medium text-kumo-inverse"
                aria-hidden="true"
              >
                {task.agent.displayName.charAt(0)}
              </span>
              <strong className="min-w-0 break-words">{task.agent.displayName}</strong>
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
          <TaskDetailFact label={m.tasks_status_label()}>
            <StatusIndicator label={taskStatusGroupLabel(status)} tone={taskStatusGroupTone(status)} />
          </TaskDetailFact>
        </dl>
        <TaskCancelControl detailKey={detailKey} enabled={!showExamples} task={task} />
      </header>

      {refreshError ? <ResourceRefreshNotice error={refreshError} onRetry={() => void taskQuery.refetch()} /> : null}

      <TaskActivity task={task} turns={turns} pagination={pagination} />
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

function TaskSelect({
  label,
  options,
  renderValue,
  onChange,
  value,
}: {
  label: string;
  options: readonly { label: string; value: string }[];
  renderValue: (value: string) => ReactNode;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="w-full @min-[36rem]/content:w-44">
      <Select
        aria-label={label}
        className="w-full"
        renderValue={renderValue}
        size="sm"
        value={value}
        onValueChange={(nextValue) => {
          if (nextValue !== null) onChange(nextValue);
        }}
      >
        {options.map((option) => (
          <Select.Option key={option.value} value={option.value}>
            {option.label}
          </Select.Option>
        ))}
      </Select>
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
  const className = buttonClassName({ className: "w-fit", size: "compact", variant: "ghost" });
  if (showExamples) {
    return (
      <Link className={className} to="/tasks">
        <Icon name="arrow-left" />
        {m.tasks_title()}
      </Link>
    );
  }
  return (
    <Link className={className} {...agentTasksLink(agentId)}>
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
      className="min-w-0 overflow-hidden rounded-lg @min-[40rem]/content:overflow-x-auto @min-[40rem]/content:focus:outline-none @min-[40rem]/content:focus-visible:ring-2 @min-[40rem]/content:focus-visible:ring-kumo-brand @min-[40rem]/content:focus-visible:ring-inset"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The same region remains keyboard-scrollable in wider content areas.
      tabIndex={0}
    >
      <Table
        aria-label={compact ? m.tasks_agent_tasks() : m.tasks_title()}
        className={`block min-w-0 @min-[40rem]/content:table ${showAgent ? "@min-[40rem]/content:min-w-[65rem]" : "@min-[40rem]/content:min-w-[54rem]"}`}
        data-ui="task-table"
        layout="fixed"
      >
        <colgroup className="hidden @min-[40rem]/content:table-column-group">
          <col />
          {showAgent ? <col className="w-44" /> : null}
          <col className="w-60" />
          <col className="w-36" />
          <col className="w-40" />
        </colgroup>
        <Table.Header
          className="sr-only @min-[40rem]/content:not-sr-only @min-[40rem]/content:table-header-group"
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
        <Table.Body className="block @min-[40rem]/content:table-row-group">
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
  const status = taskStatusGroup(task.status);
  return (
    <Table.Row
      className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 border-b border-kumo-line last:border-b-0 @min-[40rem]/content:table-row @min-[40rem]/content:border-b-0"
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
        <span className={"inline-flex min-w-0 items-center gap-2 @min-[40rem]/content:whitespace-nowrap"}>
          <ProviderIcon className="size-5" provider={task.source.provider} />
          <span>{sourceLabel(task)}</span>
        </span>
      </Table.Cell>
      <Table.Cell className="col-start-2 row-start-1 justify-self-end" data-label={m.tasks_status_label()}>
        <StatusIndicator label={taskStatusGroupLabel(status)} tone={taskStatusGroupTone(status)} />
      </Table.Cell>
      <Table.Cell
        className="col-start-2 row-start-2 justify-self-end self-center"
        data-label={m.tasks_last_activity_label()}
      >
        <time
          className="whitespace-nowrap text-sm text-kumo-subtle"
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
    "line-clamp-2 max-w-[40rem] break-words font-medium text-kumo-default hover:text-kumo-link @min-[40rem]/content:line-clamp-1";
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
  return `${messagingProviderLabel(task.source.provider)} · ${context}`;
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

function taskFilterKey(agentId: string | undefined) {
  return `tasks:${agentId ?? "examples"}`;
}
