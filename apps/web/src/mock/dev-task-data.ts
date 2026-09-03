import type { ListTasksResponse, TaskDetail, TaskStatus, TaskSummary, TaskTurn } from "@opentag/shared/browser";

const DEV_TASK_IDS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
  "10000000-0000-4000-8000-000000000004",
  "10000000-0000-4000-8000-000000000005",
] as const;

const EXAMPLES = [
  {
    title: "Review Q3 launch readiness and flag unowned work",
    status: "completed",
    provider: "feishu",
    conversationKind: "channel",
    sessionKind: "thread",
    ageMinutes: 12,
    authorDisplayName: "Mia Zhang",
    request: "Review the launch plan and identify anything without a confirmed owner or date.",
    finalText: "Eight launch items were checked. Two still need owners, and one has no confirmed date.",
  },
  {
    title: "整理昨天客户拜访的共性问题并按团队归类",
    status: "running",
    provider: "feishu",
    conversationKind: "group_dm",
    sessionKind: "channel",
    ageMinutes: 3,
    authorDisplayName: "Noah Liu",
    request: "请把昨天三次客户拜访中反复出现的问题整理出来，并标注应该跟进的团队。",
    finalText: null,
  },
  {
    title: "Compare the onboarding guide with the current process",
    status: "failed",
    provider: "slack",
    conversationKind: "channel",
    sessionKind: "thread",
    ageMinutes: 38,
    authorDisplayName: null,
    request: "Compare the onboarding guide with what new engineers actually do and list the gaps.",
    finalText: null,
  },
  {
    title: "Draft follow-ups for unresolved security reviews",
    status: "queued",
    provider: "feishu",
    conversationKind: "dm",
    sessionKind: "channel",
    ageMinutes: 74,
    authorDisplayName: "Olivia Sun",
    request: "Draft a concise follow-up for each security review that is still waiting for sign-off.",
    finalText: null,
  },
  {
    title: "Summarize this week's support escalations",
    status: "ended",
    provider: "slack",
    conversationKind: "channel",
    sessionKind: "channel",
    ageMinutes: 60 * 24 * 3,
    authorDisplayName: "Jordan Lee",
    request: "Summarize the support escalations from this week and group them by root cause.",
    finalText: null,
  },
] as const satisfies readonly {
  title: string;
  status: TaskStatus;
  provider: TaskSummary["source"]["provider"];
  conversationKind: TaskSummary["source"]["conversationKind"];
  sessionKind: TaskSummary["sessionKind"];
  ageMinutes: number;
  authorDisplayName: string | null;
  request: string;
  finalText: string | null;
}[];

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function summaryAt(index: number, agentId: string): TaskSummary {
  const example = EXAMPLES[index];
  const id = DEV_TASK_IDS[index];
  if (!example || !id) throw new Error("Development Task fixture index is out of range");
  const createdAt = isoMinutesAgo(example.ageMinutes + 35);
  const lastActivityAt = isoMinutesAgo(example.ageMinutes);
  return {
    id,
    agent: {
      id: agentId,
      name: "preview-agent",
      displayName: "OpenTag Agent",
      runtimeProvider: "codex",
    },
    source: {
      provider: example.provider,
      conversationKind: example.conversationKind,
      channelId: `preview-channel-${index + 1}`,
      threadKey: example.sessionKind === "thread" ? `preview-thread-${index + 1}` : null,
    },
    sessionKind: example.sessionKind,
    title: example.title,
    status: example.status,
    createdAt,
    endedAt: ["completed", "failed", "ended"].includes(example.status) ? lastActivityAt : null,
    lastActivityAt,
  };
}

export function createDevelopmentTasks(agentId: string): ListTasksResponse {
  return { tasks: EXAMPLES.map((_, index) => summaryAt(index, agentId)), nextCursor: null };
}

export function isDevelopmentTaskId(taskId: string): boolean {
  return DEV_TASK_IDS.includes(taskId as (typeof DEV_TASK_IDS)[number]);
}

function deliveryFor(status: TaskStatus, task: TaskSummary): TaskTurn["delivery"] {
  const state = status === "queued" ? "pending" : status === "ended" ? "expired" : "accepted";
  return {
    state,
    attemptCount: status === "failed" ? 2 : 1,
    acceptedAt: state === "accepted" ? task.createdAt : null,
    steeredAt: null,
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    reason: status === "ended" ? "The conversation ended before work started" : null,
    lastErrorCode: status === "failed" ? "SOURCE_ACCESS_REQUIRED" : null,
  };
}

function reportFor(index: number, task: TaskSummary, finalText: string | null): TaskTurn["report"] {
  if (task.status !== "completed" && task.status !== "failed") return null;
  const completed = task.status === "completed";
  return {
    turnId: `preview-turn-${index + 1}`,
    outcome: completed ? "completed" : "failed",
    executionEffects: completed ? "completed" : "may_have_occurred",
    finalText,
    errorReason: completed ? null : "The onboarding checklist requires additional access.",
    usage: { inputTokens: 8_240, cachedInputTokens: 1_120, outputTokens: 1_480 },
    traceSummary: { lastSequence: 18, droppedEvents: 0 },
    reportedAt: task.lastActivityAt,
  };
}

export function createDevelopmentTaskDetail(taskId: string, agentId: string): TaskDetail | undefined {
  const index = DEV_TASK_IDS.indexOf(taskId as (typeof DEV_TASK_IDS)[number]);
  if (index < 0) return undefined;
  const example = EXAMPLES[index];
  if (!example) return undefined;
  const task = summaryAt(index, agentId);
  return {
    task,
    turns: [
      {
        deliveryId: `20000000-0000-4000-8000-00000000000${index + 1}`,
        attention: "direct",
        delivery: deliveryFor(example.status, task),
        message: {
          id: `30000000-0000-4000-8000-00000000000${index + 1}`,
          externalMessageId: `preview-message-${index + 1}`,
          operation: "created",
          authorKind: "human",
          authorDisplayName: example.authorDisplayName,
          fallbackText: example.request,
          truncated: false,
          occurredAt: task.createdAt,
        },
        absorbedBy: null,
        report: reportFor(index, task, example.finalText),
      },
    ],
    internalSessions: [],
    collaborationMessages: [],
    nextCursor: null,
  };
}
