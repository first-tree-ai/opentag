import { type ChangeEventHandler, type ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  findTaskPreview,
  type TaskActivity,
  type TaskPreview,
  type TaskResult,
  type TaskSourceKind,
  type TaskStatus,
  taskPreviews,
} from "../mock/task-data.js";
import { Icon, StatusIndicator, type StatusTone } from "../ui/design-system.js";
import "./tasks-page.css";

type TaskFilter = "all" | TaskStatus;
type SourceFilter = "all" | TaskSourceKind;
type AgentFilter = "all" | TaskPreview["agent"];

type ConversationTurn = {
  readonly actions: readonly TaskActivity[];
  readonly assistantUpdate?: string;
  readonly duration: string;
  readonly id: string;
  readonly request: string;
  readonly requestTime: string;
  readonly result: TaskResult;
  readonly resultObservedAt?: string;
};

const statusPresentation: Record<TaskStatus, { readonly label: string; readonly tone: StatusTone }> = {
  needs_attention: { label: "Needs attention", tone: "warning" },
  processing: { label: "In progress", tone: "info" },
  recently_completed: { label: "Recently completed", tone: "success" },
  unable_to_confirm: { label: "Unable to confirm", tone: "neutral" },
};

const sourcePresentation: Record<TaskSourceKind, { readonly abbreviation: string; readonly label: string }> = {
  email: { abbreviation: "@", label: "Email" },
  feishu: { abbreviation: "FS", label: "Feishu" },
  github: { abbreviation: "GH", label: "GitHub" },
  jira: { abbreviation: "J", label: "Jira" },
};

const toolPresentation: Readonly<Record<string, string>> = {
  FS: "Feishu",
  GD: "Google Drive",
};

export function TasksPage() {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [source, setSource] = useState<SourceFilter>("all");
  const [status, setStatus] = useState<TaskFilter>("all");
  const tasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return taskPreviews.filter((task) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [task.title, task.agent, task.source.context, task.source.detail, sourcePresentation[task.source.kind].label]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      return (
        matchesQuery &&
        (agent === "all" || task.agent === agent) &&
        (source === "all" || task.source.kind === source) &&
        (status === "all" || task.status === status)
      );
    });
  }, [agent, query, source, status]);

  return (
    <section className="tasks-page" aria-labelledby="tasks-page-title">
      <header className="tasks-page-header">
        <div>
          <h1 id="tasks-page-title">Tasks</h1>
          <p>Track work Agents handle across connected sources.</p>
        </div>
        <span className="tasks-demo-note">Demo data</span>
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
        <TaskSelect
          label="Filter by Agent"
          value={agent}
          onChange={(event) => setAgent(event.target.value as AgentFilter)}
        >
          <option value="all">All Agents</option>
          <option value="Atlas">Atlas</option>
          <option value="Scout">Scout</option>
        </TaskSelect>
        <TaskSelect
          label="Filter by source"
          value={source}
          onChange={(event) => setSource(event.target.value as SourceFilter)}
        >
          <option value="all">All sources</option>
          <option value="feishu">Feishu</option>
          <option value="email">Email</option>
          <option value="github">GitHub</option>
          <option value="jira">Jira</option>
        </TaskSelect>
        <TaskSelect
          label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskFilter)}
        >
          <option value="all">All statuses</option>
          <option value="processing">In progress</option>
          <option value="recently_completed">Recently completed</option>
          <option value="needs_attention">Needs attention</option>
          <option value="unable_to_confirm">Unable to confirm</option>
        </TaskSelect>
      </form>

      {tasks.length > 0 ? (
        <table className="task-table" aria-label="Demo Tasks">
          <thead>
            <tr className="task-table-grid task-table-header">
              <th scope="col">Work</th>
              <th scope="col">Source</th>
              <th scope="col">Activity</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} />
            ))}
          </tbody>
        </table>
      ) : (
        <section className="task-empty-state" aria-live="polite">
          <h2>No Tasks found</h2>
          <p>Try a different search or filter.</p>
        </section>
      )}
    </section>
  );
}

export function TaskDetailPage() {
  const { taskId } = useParams();
  const task = findTaskPreview(taskId);
  if (!task) {
    return (
      <section className="task-not-found">
        <h1>Task not found</h1>
        <p>This demo Task does not exist.</p>
        <Link to="/tasks">Back to Tasks</Link>
      </section>
    );
  }

  const status = statusPresentation[task.status];
  const source = sourcePresentation[task.source.kind];
  const request = task.activity.find((item) => item.quote);
  const progress = task.activity.filter((item) => !item.quote);
  const turns: readonly ConversationTurn[] = [
    {
      id: "initial",
      request: request?.quote ?? task.title,
      requestTime: request?.time ?? task.startedAt,
      assistantUpdate: task.assistantUpdate,
      duration: task.duration,
      actions: progress.filter((item) => item.tool),
      result: task.result,
      resultObservedAt: task.resultObservedAt,
    },
    ...(task.followUps ?? []).map((followUp, index) => ({
      id: `follow-up-${index + 1}`,
      request: followUp.request,
      requestTime: followUp.requestTime,
      assistantUpdate: followUp.assistantUpdate,
      duration: followUp.duration,
      actions: followUp.activity,
      result: followUp.result,
      resultObservedAt: followUp.resultObservedAt,
    })),
  ];
  const details = [
    ["Source", source.label],
    [task.source.locationLabel, task.source.context],
    ["Initiated by", task.initiatedBy],
    ["Agent", task.agent],
    ["Started", task.startedAt],
    ["Duration", task.duration],
    ["Tokens", task.tokens ?? "Unavailable"],
  ] as const;

  return (
    <article className="task-conversation-page">
      <nav className="task-breadcrumb" aria-label="Breadcrumb">
        <Link to="/tasks">
          <Icon name="arrow-left" />
          Tasks
        </Link>
        <span className="tasks-demo-note">Demo data</span>
      </nav>

      <header className="task-conversation-header">
        <h1>{task.title}</h1>
        <section className="task-conversation-context" aria-label="Task source">
          <SourceIdentity task={task} />
          <StatusIndicator
            aria-label={`${status.label}, updated ${task.relativeUpdatedAt}`}
            detail={task.relativeUpdatedAt}
            label={status.label}
            tone={status.tone}
          />
        </section>
      </header>

      <section className="task-thread" aria-label="Task conversation">
        {turns.map((turn) => (
          <TaskConversationTurn key={turn.id} task={task} turn={turn} />
        ))}
      </section>

      <details className="task-record-details">
        <summary>
          <span>Task details</span>
          <Icon name="chevron-right" />
        </summary>
        <div className="task-record-grid">
          <dl>
            {details.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <dl>
            {task.execution.map((item) => (
              <div key={item.label}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </details>
    </article>
  );
}

function TaskConversationTurn({ task, turn }: { task: TaskPreview; turn: ConversationTurn }) {
  const resultId = `${task.id}-${turn.id}-result`;
  const toolLabels = [
    ...new Set(turn.actions.flatMap((action) => (action.tool ? [toolPresentation[action.tool] ?? action.tool] : []))),
  ];
  const actionCount = `${turn.actions.length} ${turn.actions.length === 1 ? "action" : "actions"}`;
  const duration = turn.duration === "In progress" ? "In progress" : turn.duration;
  const workLabel = [actionCount, ...toolLabels, duration].join(" · ");
  const responseTime = turn.resultObservedAt ?? "Time unavailable";

  return (
    <section className="task-turn" aria-label={`Conversation turn at ${turn.requestTime}`}>
      <article className="task-message task-message--request">
        <header className="task-message-author">
          <span className="task-person-mark" aria-hidden="true">
            {task.initiatedBy.charAt(0)}
          </span>
          <span>
            <strong>{task.initiatedBy}</strong>
            <small>
              {task.source.context} · {turn.requestTime}
            </small>
          </span>
        </header>
        <div className="task-request-bubble">
          <p>{turn.request}</p>
        </div>
      </article>

      <article className="task-message task-message--agent">
        <header className="task-message-author">
          <span className="task-agent-mark" aria-hidden="true">
            {task.agent.charAt(0)}
          </span>
          <span>
            <strong>{task.agent}</strong>
            <small>{responseTime}</small>
          </span>
        </header>

        {task.status === "processing" && turn.assistantUpdate ? (
          <p className="task-agent-update">{turn.assistantUpdate}</p>
        ) : null}

        <section className="task-agent-response" aria-labelledby={resultId}>
          <h2 id={resultId}>{turn.result.title}</h2>
          <p>{turn.result.summary}</p>
          {turn.result.items ? (
            <ul>
              {turn.result.items.map((item) => (
                <li key={`${item.label}-${item.value}`}>
                  <span>{item.value}</span>
                  <small>— {item.label}</small>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        {turn.actions.length > 0 ? (
          <details className="task-work-summary" open={task.status === "processing"}>
            <summary>
              <span>{workLabel}</span>
              <Icon name="chevron-right" />
            </summary>
            <ol>
              {turn.actions.map((item) => (
                <li key={`${item.time}-${item.label}`}>
                  <span className="task-action-mark" aria-hidden="true">
                    {item.tool}
                  </span>
                  <span className="task-action-copy">
                    <strong>{item.label}</strong>
                    {item.detail ? <small>{item.detail}</small> : null}
                  </span>
                  <time>{item.time}</time>
                </li>
              ))}
            </ol>
          </details>
        ) : null}

        {turn.resultObservedAt ? (
          <p className="task-result-observation">
            <span>Agent result recorded locally · Outbound delivery unconfirmed</span>
            <time>{turn.resultObservedAt}</time>
          </p>
        ) : null}
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

function TaskRow({ task }: { task: TaskPreview }) {
  const status = statusPresentation[task.status];
  return (
    <tr className="task-table-grid task-table-row">
      <td className="task-work-cell" data-label="Work">
        <Link to={`/tasks/${task.id}`}>{task.title}</Link>
        <small>{task.agent}</small>
      </td>
      <td data-label="Source">
        <SourceIdentity task={task} />
      </td>
      <td data-label="Activity">
        <StatusIndicator
          aria-label={`${status.label}, updated ${task.relativeUpdatedAt}`}
          detail={task.relativeUpdatedAt}
          label={status.label}
          tone={status.tone}
        />
      </td>
    </tr>
  );
}

function SourceIdentity({ task }: { task: TaskPreview }) {
  const source = sourcePresentation[task.source.kind];
  return (
    <span className="task-source-identity">
      <span className={`task-source-mark task-source-mark--${task.source.kind}`} aria-hidden="true">
        {source.abbreviation}
      </span>
      <span>
        <strong>{task.source.context}</strong>
        <small>
          {source.label} · {task.source.detail}
        </small>
      </span>
    </span>
  );
}
