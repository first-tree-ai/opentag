export type TaskStatus = "needs_attention" | "processing" | "recently_completed";

export type TaskToolStatus = "completed" | "in_progress" | "requires_attention";

export type TaskReasoningSummary = {
  readonly id: string;
  readonly kind: "reasoning_summary";
  readonly text: string;
};

export type TaskToolCall = {
  readonly action: string;
  readonly id: string;
  readonly kind: "tool_call";
  readonly status: TaskToolStatus;
  readonly target: string;
  readonly tool: "feishu" | "google_drive";
};

export type TaskAgentEvent = TaskReasoningSummary | TaskToolCall;

export type TaskResult = {
  readonly items?: readonly { readonly label: string; readonly value: string }[];
  readonly summary: string;
  readonly title: string;
};

export type TaskUsage = {
  readonly input: string | null;
  readonly output: string | null;
  readonly total: string | null;
};

export type TaskExchange = {
  readonly duration: string;
  readonly events: readonly TaskAgentEvent[];
  readonly id: string;
  readonly request: string;
  readonly requestTime: string;
  readonly result: TaskResult | null;
  readonly resultObservedAt?: string;
  readonly retries: number;
  readonly status: "completed" | "needs_attention" | "processing";
  readonly usage: TaskUsage;
};

export type TaskPreview = {
  readonly agent: "Atlas" | "Scout";
  readonly execution: readonly { readonly label: string; readonly value: string }[];
  readonly exchanges: readonly TaskExchange[];
  readonly id: string;
  readonly initiatedBy: string;
  readonly relativeUpdatedAt: string;
  readonly source: {
    readonly context: string;
    readonly detail: string;
    readonly kind: "feishu";
    readonly locationLabel: "Channel";
    readonly threadUrl: string;
  };
  readonly startedAt: string;
  readonly status: TaskStatus;
  readonly title: string;
};

export const taskPreviews: readonly TaskPreview[] = [
  {
    id: "q3-launch-readiness",
    title: "Review the Q3 launch plan, identify unresolved owners, and flag every item without a confirmed date.",
    agent: "Atlas",
    source: {
      kind: "feishu",
      context: "Product Launch",
      detail: "Q3 launch readiness",
      locationLabel: "Channel",
      threadUrl: "https://www.feishu.cn/",
    },
    status: "recently_completed",
    relativeUpdatedAt: "12 min ago",
    initiatedBy: "Mia Zhang",
    startedAt: "Aug 24, 11:04 AM",
    exchanges: [
      {
        id: "review-plan",
        request:
          "Please review the Q3 launch plan and call out anything that is still unowned or missing a confirmed date.",
        requestTime: "11:04 AM",
        duration: "8m 12s",
        status: "completed",
        retries: 0,
        usage: { input: "8.1K", output: "6.1K", total: "14.2K" },
        events: [
          {
            id: "review-reasoning-1",
            kind: "reasoning_summary",
            text: "I’ll compare the launch checklist with the latest plan and trace each unresolved item back to the thread.",
          },
          {
            id: "review-tool-1",
            kind: "tool_call",
            tool: "feishu",
            action: "Read thread",
            target: "Product Launch",
            status: "completed",
          },
          {
            id: "review-tool-2",
            kind: "tool_call",
            tool: "google_drive",
            action: "Open document",
            target: "Q3 launch brief",
            status: "completed",
          },
          {
            id: "review-reasoning-2",
            kind: "reasoning_summary",
            text: "The checklist and brief disagree on three items. I’m checking the recent thread before treating any owner or date as confirmed.",
          },
          {
            id: "review-tool-3",
            kind: "tool_call",
            tool: "feishu",
            action: "Search messages",
            target: "Product Launch",
            status: "completed",
          },
        ],
        resultObservedAt: "11:12 AM",
        result: {
          title: "Launch plan reviewed",
          summary: "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
          items: [
            { label: "Needs owner", value: "Partner announcement copy" },
            { label: "Needs owner", value: "Customer migration email" },
            { label: "Date unconfirmed", value: "Security review sign-off" },
          ],
        },
      },
      {
        id: "draft-follow-ups",
        request: "Please turn the three unresolved items into follow-ups and tag the likely owners.",
        requestTime: "11:15 AM",
        duration: "2m 41s",
        status: "completed",
        retries: 0,
        usage: { input: "3.2K", output: "1.6K", total: "4.8K" },
        events: [
          {
            id: "follow-up-reasoning-1",
            kind: "reasoning_summary",
            text: "I’ll draft the follow-ups from the confirmed context and keep suggested ownership distinct from assigned ownership.",
          },
          {
            id: "follow-up-tool-1",
            kind: "tool_call",
            tool: "feishu",
            action: "Draft messages",
            target: "Product Launch",
            status: "completed",
          },
        ],
        resultObservedAt: "11:18 AM",
        result: {
          title: "Follow-ups drafted",
          summary:
            "Three follow-up messages were prepared with suggested owners. No ownership was recorded as confirmed.",
          items: [
            { label: "Suggested: Jordan Lee", value: "Partner announcement" },
            { label: "Suggested: Priya Nair", value: "Migration email" },
            { label: "Date confirmation requested", value: "Security sign-off" },
          ],
        },
      },
    ],
    execution: [
      { label: "Provider", value: "OpenAI" },
      { label: "Session", value: "Q3 launch readiness" },
      { label: "Event record", value: "Reasoning summaries and tool calls captured" },
    ],
  },
  {
    id: "customer-visit-feedback",
    title: "Summarize the recurring issues from yesterday's three customer visits and group them by account and team.",
    agent: "Scout",
    source: {
      kind: "feishu",
      context: "Customer Feedback",
      detail: "Enterprise visit notes",
      locationLabel: "Channel",
      threadUrl: "https://www.feishu.cn/",
    },
    status: "processing",
    relativeUpdatedAt: "2 min ago",
    initiatedBy: "Noah Liu",
    startedAt: "Aug 24, 10:42 AM",
    exchanges: [
      {
        id: "group-feedback",
        request: "Please group yesterday's customer visit notes by account, issue, and the team that should follow up.",
        requestTime: "10:42 AM",
        duration: "In progress",
        status: "processing",
        retries: 0,
        usage: { input: "6.4K", output: null, total: null },
        events: [
          {
            id: "feedback-reasoning-1",
            kind: "reasoning_summary",
            text: "I’m collecting the three visit summaries first, then I’ll group repeated issues without merging account-specific context.",
          },
          {
            id: "feedback-tool-1",
            kind: "tool_call",
            tool: "feishu",
            action: "Read thread",
            target: "Customer Feedback",
            status: "completed",
          },
          {
            id: "feedback-tool-2",
            kind: "tool_call",
            tool: "feishu",
            action: "Search messages",
            target: "Customer Feedback",
            status: "in_progress",
          },
        ],
        result: null,
      },
    ],
    execution: [
      { label: "Provider", value: "Anthropic" },
      { label: "Session", value: "Enterprise visit notes" },
      { label: "Event record", value: "Live provider events" },
    ],
  },
  {
    id: "onboarding-document-review",
    title: "Compare the new employee onboarding document with the actual process, then list missing steps and owners.",
    agent: "Atlas",
    source: {
      kind: "feishu",
      context: "Engineering Collaboration",
      detail: "Onboarding process review",
      locationLabel: "Channel",
      threadUrl: "https://www.feishu.cn/",
    },
    status: "needs_attention",
    relativeUpdatedAt: "25 min ago",
    initiatedBy: "Olivia Sun",
    startedAt: "Aug 24, 10:18 AM",
    exchanges: [
      {
        id: "review-onboarding",
        request:
          "Compare the onboarding document with what new engineers actually do, then call out missing steps and owners.",
        requestTime: "10:18 AM",
        duration: "11m 03s",
        status: "needs_attention",
        retries: 1,
        usage: { input: "11.8K", output: "6.8K", total: "18.6K" },
        events: [
          {
            id: "onboarding-reasoning-1",
            kind: "reasoning_summary",
            text: "I’ll compare the documented path with the recent onboarding thread and identify gaps only where the source record is available.",
          },
          {
            id: "onboarding-tool-1",
            kind: "tool_call",
            tool: "feishu",
            action: "Open document",
            target: "Engineering onboarding",
            status: "completed",
          },
          {
            id: "onboarding-tool-2",
            kind: "tool_call",
            tool: "google_drive",
            action: "Open document",
            target: "Access provisioning checklist",
            status: "requires_attention",
          },
        ],
        resultObservedAt: "10:29 AM",
        result: {
          title: "Two source documents are missing",
          summary:
            "The review is paused because the access checklist and security orientation steps are not available.",
          items: [
            { label: "Missing input", value: "Access provisioning checklist" },
            { label: "Missing input", value: "Security orientation guide" },
          ],
        },
      },
    ],
    execution: [
      { label: "Provider", value: "OpenAI" },
      { label: "Session", value: "Onboarding process review" },
      { label: "Event record", value: "Provider events captured; source access incomplete" },
    ],
  },
];

export function findTaskPreview(taskId: string | undefined): TaskPreview | undefined {
  return taskPreviews.find((task) => task.id === taskId);
}
