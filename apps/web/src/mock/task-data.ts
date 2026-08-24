export type TaskSourceKind = "email" | "feishu" | "github" | "jira";

export type TaskStatus = "needs_attention" | "processing" | "recently_completed" | "unable_to_confirm";

export type TaskActivity = {
  readonly detail?: string;
  readonly label: string;
  readonly quote?: string;
  readonly time: string;
  readonly tone?: "default" | "warning";
  readonly tool?: string;
};

export type TaskResult = {
  readonly items?: readonly { readonly label: string; readonly value: string }[];
  readonly summary: string;
  readonly title: string;
};

export type TaskFollowUp = {
  readonly activity: readonly TaskActivity[];
  readonly assistantUpdate?: string;
  readonly duration: string;
  readonly request: string;
  readonly requestTime: string;
  readonly resultObservedAt?: string;
  readonly result: TaskResult;
};

export type TaskPreview = {
  readonly activity: readonly TaskActivity[];
  readonly agent: "Atlas" | "Scout";
  readonly assistantUpdate?: string;
  readonly duration: string;
  readonly execution: readonly { readonly label: string; readonly value: string }[];
  readonly followUps?: readonly TaskFollowUp[];
  readonly id: string;
  readonly initiatedBy: string;
  readonly relativeUpdatedAt: string;
  readonly result: TaskResult;
  readonly resultObservedAt?: string;
  readonly source: {
    readonly context: string;
    readonly detail: string;
    readonly kind: TaskSourceKind;
    readonly locationLabel: "Channel" | "Issue" | "Mailbox" | "Repository";
  };
  readonly startedAt: string;
  readonly status: TaskStatus;
  readonly title: string;
  readonly tokens: string | null;
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
    },
    status: "recently_completed",
    relativeUpdatedAt: "12 min ago",
    initiatedBy: "Mia Zhang",
    startedAt: "Aug 24, 11:04 AM",
    duration: "8m 12s",
    tokens: "14.2K",
    assistantUpdate:
      "I’ll compare the launch checklist with the latest plan and call out anything that still needs a decision.",
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
    activity: [
      {
        time: "11:04 AM",
        label: "Request received",
        detail: "From Mia Zhang in Product Launch",
        quote:
          "Please review the Q3 launch plan and call out anything that is still unowned or missing a confirmed date.",
      },
      {
        time: "11:05 AM",
        label: "Read Q3 launch checklist",
        detail: "Feishu · Product Launch",
        tool: "FS",
      },
      {
        time: "11:07 AM",
        label: "Opened the launch brief",
        detail: "Google Drive · Q3 launch plan",
        tool: "GD",
      },
    ],
    followUps: [
      {
        requestTime: "11:18 AM",
        request: "Please turn the three unresolved items into follow-ups and tag the likely owners.",
        duration: "2m 41s",
        assistantUpdate:
          "I’ll draft the follow-ups in Feishu without assigning anyone who has not confirmed ownership.",
        activity: [
          {
            time: "11:19 AM",
            label: "Drafted 3 follow-up messages",
            detail: "Feishu · Product Launch",
            tool: "FS",
          },
        ],
        result: {
          title: "Follow-ups drafted",
          summary:
            "Three follow-up messages were drafted with suggested owners. Ownership remains unassigned until each person confirms.",
          items: [
            { label: "Partner announcement", value: "Suggested owner: Jordan Lee" },
            { label: "Migration email", value: "Suggested owner: Priya Nair" },
            { label: "Security sign-off", value: "Date confirmation requested" },
          ],
        },
        resultObservedAt: "11:21 AM",
      },
    ],
    execution: [
      { label: "Session", value: "Q3 launch readiness" },
      { label: "Turns", value: "5" },
      { label: "Provider", value: "OpenAI" },
      { label: "Retries", value: "0" },
      { label: "Record quality", value: "Local result captured" },
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
    },
    status: "processing",
    relativeUpdatedAt: "2 min ago",
    initiatedBy: "Noah Liu",
    startedAt: "Aug 24, 10:42 AM",
    duration: "In progress",
    tokens: "6.4K",
    resultObservedAt: "10:47 AM",
    result: {
      title: "Customer feedback analysis in progress",
      summary: "Three visit summaries are loaded. Scout is grouping recurring issues by account and owner.",
      items: [
        { label: "Most frequent", value: "Slow permission setup" },
        { label: "Follow-up", value: "Clarify audit log retention" },
      ],
    },
    activity: [
      {
        time: "10:42 AM",
        label: "Request received",
        detail: "From Noah Liu in Customer Feedback",
        quote: "Please group yesterday's customer visit notes by account, issue, and the team that should follow up.",
      },
      { time: "10:43 AM", label: "Scout started" },
      { time: "10:46 AM", label: "Read three visit summaries" },
      { time: "10:47 AM", label: "Grouping recurring issues" },
    ],
    execution: [
      { label: "Session", value: "Enterprise visit notes" },
      { label: "Turns", value: "3" },
      { label: "Provider", value: "Anthropic" },
      { label: "Retries", value: "0" },
      { label: "Record quality", value: "In progress" },
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
    },
    status: "needs_attention",
    relativeUpdatedAt: "25 min ago",
    initiatedBy: "Olivia Sun",
    startedAt: "Aug 24, 10:18 AM",
    duration: "11m 03s",
    tokens: "18.6K",
    resultObservedAt: "10:29 AM",
    result: {
      title: "Two source documents are missing",
      summary: "The review is paused because the access checklist and security orientation steps are not available.",
      items: [
        { label: "Missing input", value: "Access provisioning checklist" },
        { label: "Missing input", value: "Security orientation guide" },
      ],
    },
    activity: [
      {
        time: "10:18 AM",
        label: "Request received",
        detail: "From Olivia Sun in Engineering Collaboration",
        quote:
          "Compare the onboarding document with what new engineers actually do, then call out missing steps and owners.",
      },
      { time: "10:19 AM", label: "Atlas started" },
      { time: "10:24 AM", label: "Reviewed the onboarding document" },
      { time: "10:29 AM", label: "Requested two missing inputs" },
    ],
    execution: [
      { label: "Session", value: "Onboarding process review" },
      { label: "Turns", value: "4" },
      { label: "Provider", value: "OpenAI" },
      { label: "Retries", value: "1" },
      { label: "Record quality", value: "Local result captured" },
    ],
  },
  {
    id: "security-questionnaire",
    title:
      "Complete the attached enterprise security questionnaire and flag every answer that still needs legal review.",
    agent: "Scout",
    source: {
      kind: "email",
      context: "security@northstar.example",
      detail: "Enterprise security questionnaire",
      locationLabel: "Mailbox",
    },
    status: "recently_completed",
    relativeUpdatedAt: "32 min ago",
    initiatedBy: "Priya Nair",
    startedAt: "Aug 24, 9:56 AM",
    duration: "14m 21s",
    tokens: "22.1K",
    resultObservedAt: "10:10 AM",
    result: {
      title: "Questionnaire draft completed",
      summary: "Thirty-four answers were drafted and four policy questions were flagged for legal review.",
      items: [
        { label: "Legal review", value: "Data residency commitments" },
        { label: "Legal review", value: "Subprocessor notification period" },
      ],
    },
    activity: [
      {
        time: "9:56 AM",
        label: "Email received",
        detail: "From Priya Nair",
        quote: "Please complete the attached security questionnaire and flag anything that requires a legal decision.",
      },
      { time: "9:58 AM", label: "Scout started" },
      { time: "10:05 AM", label: "Drafted thirty-four answers" },
      { time: "10:10 AM", label: "Flagged four policy questions" },
      { time: "10:10 AM", label: "Completed" },
    ],
    execution: [
      { label: "Session", value: "Enterprise security questionnaire" },
      { label: "Turns", value: "6" },
      { label: "Provider", value: "Anthropic" },
      { label: "Retries", value: "0" },
      { label: "Record quality", value: "Local result captured" },
    ],
  },
  {
    id: "github-oauth-regression",
    title:
      "Investigate why the OAuth callback intermittently drops the session cookie in staging and propose a safe fix.",
    agent: "Atlas",
    source: {
      kind: "github",
      context: "opentag/web #123",
      detail: "OAuth callback regression",
      locationLabel: "Repository",
    },
    status: "needs_attention",
    relativeUpdatedAt: "46 min ago",
    initiatedBy: "Ethan Brooks",
    startedAt: "Aug 24, 9:31 AM",
    duration: "17m 44s",
    tokens: "27.3K",
    resultObservedAt: "9:49 AM",
    result: {
      title: "Likely proxy header mismatch",
      summary:
        "The staging proxy appears to drop the secure cookie on one callback path. Production behavior remains unconfirmed.",
      items: [
        { label: "Needs confirmation", value: "Production proxy header policy" },
        { label: "Proposed fix", value: "Normalize forwarded protocol handling" },
      ],
    },
    activity: [
      {
        time: "9:31 AM",
        label: "Issue assigned",
        detail: "From opentag/web #123",
        quote: "Please isolate the intermittent staging cookie loss and propose the smallest safe fix.",
      },
      { time: "9:33 AM", label: "Atlas started" },
      { time: "9:39 AM", label: "Compared callback request headers" },
      { time: "9:49 AM", label: "Requested production proxy confirmation" },
    ],
    execution: [
      { label: "Session", value: "OAuth callback regression" },
      { label: "Turns", value: "7" },
      { label: "Provider", value: "OpenAI" },
      { label: "Retries", value: "1" },
      { label: "Record quality", value: "Local result captured" },
    ],
  },
  {
    id: "jira-onboarding-coverage",
    title: "Review onboarding event coverage before the next experiment and identify any missing analytics events.",
    agent: "Scout",
    source: {
      kind: "jira",
      context: "PROJ-342",
      detail: "Onboarding event coverage",
      locationLabel: "Issue",
    },
    status: "unable_to_confirm",
    relativeUpdatedAt: "3 hr ago",
    initiatedBy: "Avery Morgan",
    startedAt: "Aug 24, 8:12 AM",
    duration: "Unavailable",
    tokens: null,
    result: {
      title: "Unable to confirm the latest execution",
      summary: "The Task record is incomplete because the final provider response was not received.",
      items: [{ label: "Last confirmed", value: "Event inventory loaded" }],
    },
    activity: [
      {
        time: "8:12 AM",
        label: "Issue assigned",
        detail: "From PROJ-342",
        quote: "Review onboarding event coverage before the experiment and identify any missing analytics events.",
      },
      { time: "8:13 AM", label: "Scout started" },
      { time: "8:17 AM", label: "Loaded the event inventory" },
      { time: "Unknown", label: "Final provider response not received" },
    ],
    execution: [
      { label: "Session", value: "Onboarding event coverage" },
      { label: "Turns", value: "Unavailable" },
      { label: "Provider", value: "Anthropic" },
      { label: "Retries", value: "Unavailable" },
      { label: "Record quality", value: "Incomplete" },
    ],
  },
];

export function findTaskPreview(taskId: string | undefined): TaskPreview | undefined {
  return taskPreviews.find((task) => task.id === taskId);
}
