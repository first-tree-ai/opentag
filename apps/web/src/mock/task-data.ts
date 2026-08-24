export type TaskStatus = "needs_attention" | "processing" | "recently_completed";

export type TaskToolStatus = "completed" | "in_progress" | "requires_attention";

export type TaskReasoningSummary = {
  readonly id: string;
  readonly kind: "reasoning_summary";
  readonly text: string;
};

export type TaskToolCall = {
  readonly action: string;
  readonly detail: string;
  readonly groupId: string;
  readonly groupLabel: string;
  readonly id: string;
  readonly kind: "tool_call";
  readonly result: string;
  readonly status: TaskToolStatus;
  readonly target: string;
  readonly tool: "feishu" | "google_drive";
};

export type TaskAgentEvent = TaskReasoningSummary | TaskToolCall;

export type TaskFinalAnswerBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly items: readonly string[]; readonly kind: "unordered_list" };

export type TaskFinalAnswer = {
  readonly blocks: readonly TaskFinalAnswerBlock[];
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
  readonly finalAnswer: TaskFinalAnswer | null;
  readonly finalAnswerObservedAt?: string;
  readonly retries: number;
  readonly status: "completed" | "needs_attention" | "processing";
  readonly usage: TaskUsage;
};

export type TaskPreview = {
  readonly agent: "Atlas" | "Scout";
  readonly exchanges: readonly TaskExchange[];
  readonly id: string;
  readonly initiatedBy: string;
  readonly relativeUpdatedAt: string;
  readonly source: {
    readonly context: string;
    readonly detail: string;
    readonly kind: "feishu";
    readonly threadUrl: string;
  };
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
      threadUrl: "https://www.feishu.cn/",
    },
    status: "recently_completed",
    relativeUpdatedAt: "12 min ago",
    initiatedBy: "Mia Zhang",
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
            action: "Read the Product Launch thread",
            detail: "Feishu · Product Launch",
            groupId: "review-sources",
            groupLabel: "Read 2 sources",
            result: "18 messages read",
            target: "Product Launch",
            status: "completed",
          },
          {
            id: "review-tool-2",
            kind: "tool_call",
            tool: "google_drive",
            action: "Opened the Q3 launch brief",
            detail: "Google Drive · Q3 launch brief",
            groupId: "review-sources",
            groupLabel: "Read 2 sources",
            result: "8 checklist items found",
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
            action: "Searched recent launch messages",
            detail: "Feishu · Product Launch",
            groupId: "review-search",
            groupLabel: "Searched 12 Feishu messages",
            result: "12 recent messages matched",
            target: "Product Launch",
            status: "completed",
          },
        ],
        finalAnswerObservedAt: "11:12 AM",
        finalAnswer: {
          blocks: [
            {
              kind: "paragraph",
              text: "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
            },
            {
              kind: "unordered_list",
              items: [
                "Partner announcement copy — Needs owner",
                "Customer migration email — Needs owner",
                "Security review sign-off — Date unconfirmed",
              ],
            },
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
            action: "Drafted follow-up messages",
            detail: "Feishu · Product Launch",
            groupId: "draft-follow-ups",
            groupLabel: "Drafted 3 follow-up messages",
            result: "3 drafts prepared",
            target: "Product Launch",
            status: "completed",
          },
        ],
        finalAnswerObservedAt: "11:18 AM",
        finalAnswer: {
          blocks: [
            {
              kind: "paragraph",
              text: "Three follow-up messages were prepared with suggested owners. No ownership was recorded as confirmed.",
            },
            {
              kind: "unordered_list",
              items: [
                "Partner announcement — Suggested owner: Jordan Lee",
                "Migration email — Suggested owner: Priya Nair",
                "Security sign-off — Date confirmation requested",
              ],
            },
          ],
        },
      },
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
      threadUrl: "https://www.feishu.cn/",
    },
    status: "processing",
    relativeUpdatedAt: "2 min ago",
    initiatedBy: "Noah Liu",
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
            action: "Read the Customer Feedback thread",
            detail: "Feishu · Customer Feedback",
            groupId: "collect-feedback",
            groupLabel: "Read 2 Feishu sources",
            result: "3 visit summaries read",
            target: "Customer Feedback",
            status: "completed",
          },
          {
            id: "feedback-tool-2",
            kind: "tool_call",
            tool: "feishu",
            action: "Search recent customer messages",
            detail: "Feishu · Customer Feedback",
            groupId: "collect-feedback",
            groupLabel: "Read 2 Feishu sources",
            result: "Search in progress",
            target: "Customer Feedback",
            status: "in_progress",
          },
        ],
        finalAnswer: null,
      },
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
      threadUrl: "https://www.feishu.cn/",
    },
    status: "needs_attention",
    relativeUpdatedAt: "25 min ago",
    initiatedBy: "Olivia Sun",
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
            action: "Opened the engineering onboarding guide",
            detail: "Feishu · Engineering onboarding",
            groupId: "onboarding-sources",
            groupLabel: "Checked 2 onboarding sources",
            result: "Guide opened",
            target: "Engineering onboarding",
            status: "completed",
          },
          {
            id: "onboarding-tool-2",
            kind: "tool_call",
            tool: "google_drive",
            action: "Tried to open the access checklist",
            detail: "Google Drive · Access provisioning checklist",
            groupId: "onboarding-sources",
            groupLabel: "Checked 2 onboarding sources",
            result: "Access required",
            target: "Access provisioning checklist",
            status: "requires_attention",
          },
        ],
        finalAnswerObservedAt: "10:29 AM",
        finalAnswer: {
          blocks: [
            {
              kind: "paragraph",
              text: "The review is paused because the access checklist and security orientation steps are not available.",
            },
            {
              kind: "unordered_list",
              items: ["Access provisioning checklist — Missing input", "Security orientation guide — Missing input"],
            },
          ],
        },
      },
    ],
  },
];

export function findTaskPreview(taskId: string | undefined): TaskPreview | undefined {
  return taskPreviews.find((task) => task.id === taskId);
}
