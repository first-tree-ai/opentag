import { type ChangeEventHandler, type ReactNode, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  findTaskPreview,
  type TaskExchange,
  type TaskPreview,
  type TaskStatus,
  type TaskToolCall,
  type TaskToolStatus,
  taskPreviews,
} from "../mock/task-data.js";
import { Icon, StatusIndicator, type StatusTone } from "../ui/design-system.js";
import "./tasks-page.css";

type TaskFilter = "all" | TaskStatus;
type AgentFilter = "all" | TaskPreview["agent"];

const statusPresentation: Record<TaskStatus, { readonly label: string; readonly tone: StatusTone }> = {
  needs_attention: { label: "Needs attention", tone: "warning" },
  processing: { label: "In progress", tone: "info" },
  recently_completed: { label: "Recently completed", tone: "success" },
};

const toolPresentation: Record<TaskToolCall["tool"], { readonly abbreviation: string; readonly label: string }> = {
  feishu: { abbreviation: "FS", label: "Feishu" },
  google_drive: { abbreviation: "GD", label: "Google Drive" },
};

const toolStatusPresentation: Record<TaskToolStatus, { readonly label: string; readonly tone: StatusTone }> = {
  completed: { label: "Completed", tone: "success" },
  in_progress: { label: "In progress", tone: "info" },
  requires_attention: { label: "Needs attention", tone: "warning" },
};

export function TasksPage() {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<AgentFilter>("all");
  const [status, setStatus] = useState<TaskFilter>("all");
  const tasks = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return taskPreviews.filter((task) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        [task.title, task.agent, task.source.context, task.source.detail, "Feishu"]
          .join(" ")
          .toLocaleLowerCase()
          .includes(normalizedQuery);
      return matchesQuery && (agent === "all" || task.agent === agent) && (status === "all" || task.status === status);
    });
  }, [agent, query, status]);

  return (
    <section className="tasks-page" aria-labelledby="tasks-page-title">
      <header className="tasks-page-header">
        <div>
          <h1 id="tasks-page-title">Tasks</h1>
          <p>Track work Agents handle in Feishu threads.</p>
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
          label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as TaskFilter)}
        >
          <option value="all">All statuses</option>
          <option value="processing">In progress</option>
          <option value="recently_completed">Recently completed</option>
          <option value="needs_attention">Needs attention</option>
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

  return (
    <article className="task-conversation-page">
      <nav className="task-breadcrumb" aria-label="Breadcrumb">
        <Link to="/tasks">
          <Icon name="arrow-left" />
          Tasks
        </Link>
        <span className="task-breadcrumb-actions">
          <span className="tasks-demo-note">Demo data</span>
          <a className="task-thread-link" href={task.source.threadUrl} target="_blank" rel="noreferrer">
            Open in Feishu
          </a>
        </span>
      </nav>

      <header className="task-conversation-header">
        <h1>{task.title}</h1>
        <section className="task-conversation-context" aria-label="Task source">
          <SourceIdentity task={task} />
          <StatusIndicator
            aria-label={`${status.label}, updated ${task.relativeUpdatedAt}`}
            detail={`Updated ${task.relativeUpdatedAt}`}
            label={status.label}
            tone={status.tone}
          />
        </section>
      </header>

      <section className="task-thread" aria-label="Task conversation">
        {task.exchanges.map((exchange) => (
          <TaskConversationExchange key={exchange.id} task={task} exchange={exchange} />
        ))}
      </section>
    </article>
  );
}

function TaskConversationExchange({ task, exchange }: { task: TaskPreview; exchange: TaskExchange }) {
  const processId = `${task.id}-${exchange.id}-process`;

  return (
    <section className="task-exchange" aria-label={`Message sent at ${exchange.requestTime}`}>
      <article className="task-message task-message--request">
        <header className="task-message-author">
          <span className="task-person-mark" aria-hidden="true">
            {getInitials(task.initiatedBy)}
          </span>
          <span>
            <strong>{task.initiatedBy}</strong>
            <small>
              {task.source.context} · {exchange.requestTime}
            </small>
          </span>
        </header>
        <div className="task-request-bubble">
          <p>{exchange.request}</p>
        </div>
      </article>

      <article className="task-message task-message--agent">
        <header className="task-message-author task-message-author--agent">
          <span className="task-agent-mark" aria-hidden="true">
            {task.agent.charAt(0)}
          </span>
          <span>
            <strong>{task.agent}</strong>
            <small>
              {exchange.finalAnswerObservedAt ??
                (exchange.status === "processing" ? "In progress" : "Time unavailable")}
            </small>
          </span>
        </header>

        <TaskAgentProcess exchange={exchange} id={processId} />

        {exchange.finalAnswer ? (
          <section className="task-agent-response" aria-label="Agent final answer">
            {exchange.finalAnswer.blocks.map((block) => {
              if (block.kind === "paragraph") {
                return (
                  <p className="task-answer-paragraph" key={block.text}>
                    {block.text}
                  </p>
                );
              }
              return (
                <ul key={block.items.join("\n")}>
                  {block.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              );
            })}
            {exchange.finalAnswerObservedAt ? (
              <p className="task-result-observation">
                Recorded locally at {exchange.finalAnswerObservedAt} · Open Feishu for the authoritative thread
              </p>
            ) : null}
          </section>
        ) : null}
      </article>
    </section>
  );
}

function TaskAgentProcess({ exchange, id }: { exchange: TaskExchange; id: string }) {
  const toolCalls = exchange.events.filter((event): event is TaskToolCall => event.kind === "tool_call");
  const usage = [
    exchange.usage.input ? `${exchange.usage.input} input` : null,
    exchange.usage.output ? `${exchange.usage.output} output` : null,
    exchange.usage.total ? `${exchange.usage.total} total` : null,
  ].filter(Boolean);
  const processSummary = exchange.status === "processing" ? "Working" : `Worked for ${exchange.duration}`;
  const processMetadata = [
    `${toolCalls.length} ${toolCalls.length === 1 ? "tool call" : "tool calls"}`,
    `${exchange.retries} ${exchange.retries === 1 ? "retry" : "retries"}`,
    ...usage,
  ];

  return (
    <details className="task-agent-process" open={exchange.status !== "completed"}>
      <summary id={id}>
        <span>{processSummary}</span>
        <Icon name="chevron-right" />
      </summary>
      <section className="task-agent-events" aria-labelledby={id}>
        {exchange.events.map((event) => {
          if (event.kind === "reasoning_summary") {
            return (
              <p className="task-reasoning-summary" key={event.id}>
                {event.text}
              </p>
            );
          }
          return <TaskToolCallRow call={event} key={event.id} />;
        })}
      </section>
      <p className="task-process-metadata">{processMetadata.join(" · ")}</p>
    </details>
  );
}

function TaskToolCallRow({ call }: { call: TaskToolCall }) {
  const tool = toolPresentation[call.tool];
  const status = toolStatusPresentation[call.status];
  return (
    <article className="task-tool-call">
      <span className="task-action-mark" aria-hidden="true">
        {tool.abbreviation}
      </span>
      <span className="task-tool-action">
        <strong>{call.action}</strong>
        <small>{tool.label}</small>
      </span>
      <span className="task-tool-target">{call.target}</span>
      <StatusIndicator label={status.label} tone={status.tone} />
    </article>
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
  return (
    <span className="task-source-identity">
      <span className="task-source-mark task-source-mark--feishu" aria-hidden="true">
        FS
      </span>
      <span>
        <strong>{task.source.context}</strong>
        <small>Feishu · {task.source.detail}</small>
      </span>
    </span>
  );
}

function getInitials(name: string): string {
  return name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part.charAt(0))
    .join("");
}
