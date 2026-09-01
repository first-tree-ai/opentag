import type { TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import { ApiError, browserApi } from "../api.js";
import { PageHeader } from "../components/kumo/page-header/page-header.js";
import { compareText, foldCase, formatDateTime, formatRelativeTime, initials } from "../i18n/format.js";
import { messagingProviderLabel } from "../im/provider-label.js";
import * as m from "../paraglide/messages.js";
import { queryKeys } from "../query/keys.js";
import {
  Button,
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

export function TasksPage({ agentId }: { agentId?: string } = {}) {
  const [query, setQuery] = useState("");
  const [selectedAgentId, setSelectedAgentId] = useState("all");
  const [status, setStatus] = useState<TaskFilter>("all");
  /*
   * Pages accumulate in the cache, so a failed append leaves the rows already on screen alone and
   * stays retryable — the behavior the hand-rolled append kept its own error state for.
   */
  const tasksQuery = useInfiniteQuery({
    queryKey: agentId ? queryKeys.tasks.byAgent(agentId) : queryKeys.tasks.list(),
    queryFn: ({ pageParam }) => browserApi.tasks({ agentId, cursor: pageParam }),
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
          <div className="min-w-56 flex-1">
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
          <section
            aria-label={m.tasks_table_region()}
            className="min-w-0 overflow-x-auto rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand focus-visible:ring-inset"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to focus the horizontal scroll region.
            tabIndex={0}
          >
            <Table className="min-w-[36rem]" aria-label={m.tasks_title()} data-ui="task-table">
              <thead>
                <tr className="border-b border-kumo-line text-left text-sm text-kumo-subtle">
                  <th scope="col">{m.tasks_task_label()}</th>
                  <th scope="col">{m.tasks_status_label()}</th>
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
        <TaskNotice heading={m.tasks_no_tasks_found()} detail={m.tasks_no_tasks_found_detail()} />
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
          {m.tasks_no_tasks_yet()}
        </p>
      ) : null}
      {!unavailable && tasks.length > 0 ? (
        <>
          <div className="overflow-x-auto">
            <Table className="w-full" aria-label={m.tasks_agent_tasks()} data-ui="task-table">
              <thead>
                <tr className="border-b border-kumo-line text-left text-sm text-kumo-subtle">
                  <th scope="col">{m.tasks_task_label()}</th>
                  <th scope="col">{m.tasks_status_label()}</th>
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

export function TaskDetailPage({ agentId, taskId }: { agentId?: string; taskId?: string }) {
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

  if (terminalTaskError) return <TaskUnavailable agentId={agentId} error={terminalTaskError} />;
  if (taskId !== undefined && taskQuery.isPending) {
    return <TaskNotice loading heading={m.tasks_loading_task()} detail={m.tasks_loading_task_detail()} />;
  }
  if (!first) {
    // No Task id at all is the same answer as one the Server does not have.
    const error = taskId === undefined ? new ApiError(404, m.tasks_not_found()) : asError(taskQuery.error);
    return <TaskUnavailable agentId={agentId} error={error} />;
  }

  const { task } = first;
  const status = statusPresentation[task.status];
  return (
    <article className="grid gap-6" data-ui="task-conversation-page">
      <nav className="flex items-center gap-3" aria-label={m.tasks_breadcrumb()}>
        <Link {...agentTasksLink(agentId ?? task.agent.id)}>
          <Icon name="arrow-left" />
          {m.tasks_title()}
        </Link>
      </nav>

      <header className="grid gap-3" data-ui="task-conversation-header">
        <div className="flex flex-wrap items-center gap-2 break-words">
          <Text as="h1" size="lg" variant="heading">
            {task.title}
          </Text>
          <TaskTitleEditor showTitle={false} task={task} />
        </div>
        <section className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" aria-label={m.tasks_details()}>
          <span className="inline-flex items-center gap-2">
            <span
              className="grid size-7 place-items-center rounded-full bg-kumo-brand text-xs font-medium text-kumo-inverse"
              aria-hidden="true"
            >
              {task.agent.displayName.charAt(0)}
            </span>
            <strong>{task.agent.displayName}</strong>
          </span>
          <span className="inline-flex items-center gap-1.5 text-kumo-subtle">
            <ProviderIcon className="size-5" provider={task.source.provider} />
            {messagingProviderLabel(task.source.provider)}
          </span>
          <span className="text-kumo-subtle">{m.tasks_started({ time: formatDateTime(task.createdAt) })}</span>
          <span className="text-kumo-subtle">{m.tasks_updated({ time: formatRelativeTime(task.lastActivityAt) })}</span>
          <StatusIndicator
            aria-label={m.tasks_status_updated({
              status: taskStatusLabel(task.status),
              time: formatRelativeTime(task.lastActivityAt),
            })}
            label={taskStatusLabel(task.status)}
            tone={status.tone}
          />
        </section>
      </header>

      <section className="grid gap-5" aria-labelledby="task-activity-title" data-ui="task-thread">
        <Text as="h2" id="task-activity-title" variant="heading">
          {m.tasks_activity()}
        </Text>
        {turns.length > 0 ? (
          turns.map((turn) => <TaskTurnView key={turn.deliveryId} task={task} turn={turn} />)
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

function TaskUnavailable({ agentId, error }: { agentId?: string; error: Error }) {
  const notFound = error instanceof ApiError && error.status === 404;
  return (
    <section className="grid gap-3" data-ui="task-not-found">
      <Text as="h1" size="lg" variant="heading">
        {notFound ? m.tasks_not_found() : m.tasks_unavailable()}
      </Text>
      <Text as="p" variant="secondary">
        {notFound ? m.tasks_not_found_detail() : error.message}
      </Text>
      {agentId ? (
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
      className="grid gap-4"
      aria-label={m.tasks_message_sent_at({ time: formatDateTime(turn.message.occurredAt) })}
      data-ui="task-exchange"
    >
      <article className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3" data-ui="task-message-request">
        <span className="grid size-8 place-items-center rounded-md bg-kumo-tint text-xs font-medium" aria-hidden="true">
          {initials(turn.message.authorDisplayName ?? turn.message.authorKind)}
        </span>
        <div className="grid min-w-0 gap-2">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-ui="task-message-author">
            <strong className="break-words">
              {turn.message.authorDisplayName ?? humanizeEnum(turn.message.authorKind)}
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

function TaskRow({ showAgent = true, task }: { showAgent?: boolean; task: TaskSummary }) {
  const status = statusPresentation[task.status];
  return (
    <tr className="border-b border-kumo-line align-top" data-ui="task-table-row">
      <td className="p-3" data-label={m.tasks_task_label()}>
        <TaskTitleEditor task={task} link={{ ...agentTaskDetailLink(task.agent.id, task.id) }} />
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
      <td className="p-3" data-label={m.tasks_status_label()}>
        <StatusIndicator
          aria-label={m.tasks_status_updated({
            status: taskStatusLabel(task.status),
            time: formatRelativeTime(task.lastActivityAt),
          })}
          detail={formatRelativeTime(task.lastActivityAt)}
          label={taskStatusLabel(task.status)}
          tone={status.tone}
        />
      </td>
    </tr>
  );
}

function TaskTitleEditor({
  link,
  showTitle = true,
  task,
}: {
  link?: ReturnType<typeof agentTaskDetailLink>;
  showTitle?: boolean;
  task: TaskSummary;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(task.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = () => {
    setDraft(task.title);
    setError(null);
    setEditing(true);
  };

  const cancel = () => {
    if (saving) return;
    setDraft(task.title);
    setError(null);
    setEditing(false);
  };

  const save = async (title: string | null) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await browserApi.updateTaskTitle(task.id, { title });
      await queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all() });
      setEditing(false);
    } catch {
      setError(m.tasks_title_save_failed());
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <span className="inline-flex max-w-full items-center gap-1">
        {showTitle && link ? (
          <Link {...link} title={task.title}>
            {task.title}
          </Link>
        ) : showTitle ? (
          <span>{task.title}</span>
        ) : null}
        <Button
          aria-label={m.tasks_edit_title()}
          disabled={saving}
          size="compact"
          type="button"
          variant="ghost"
          onClick={begin}
        >
          {m.tasks_edit_title()}
        </Button>
      </span>
    );
  }

  return (
    <form
      className="grid max-w-xl gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save(draft.trim() || null);
      }}
    >
      <KumoInputControl
        aria-label={m.tasks_edit_title()}
        autoFocus
        disabled={saving}
        maxLength={120}
        placeholder={m.tasks_title_placeholder()}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <span className="flex flex-wrap gap-2">
        <Button disabled={saving} loading={saving} size="compact" type="submit" variant="primary">
          {m.tasks_save_title()}
        </Button>
        <Button disabled={saving} size="compact" type="button" variant="ghost" onClick={cancel}>
          {m.tasks_cancel_title()}
        </Button>
        <Button
          disabled={saving}
          size="compact"
          type="button"
          variant="secondary-destructive"
          onClick={() => void save(null)}
        >
          {m.tasks_clear_title()}
        </Button>
      </span>
      {error ? (
        <span className="text-sm text-kumo-danger" role="alert">
          {error}
        </span>
      ) : null}
    </form>
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

function shortId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(m.tasks_request_failed());
}
