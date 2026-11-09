import type { TurnFailureReason } from "@opentag/shared";
import type { FeedbackLanguage } from "./im-feedback-copy.js";

type Localized = Record<FeedbackLanguage, string>;

/** A web destination opened from a text link at the end of the body sentence. */
export type CardLink = "settings" | "task" | "restore" | "agent";

export interface CardCopy {
  title: Localized;
  /** One short sentence on what to do. Absent when the title already says it. */
  body?: Localized;
  link?: CardLink;
}

export const CARD_LINK_LABELS = {
  settings: { zh: "去设置", en: "Open settings" },
  task: { zh: "打开任务", en: "Open task" },
  restore: { zh: "恢复连接", en: "Restore connection" },
  agent: { zh: "查看 Agent", en: "View Agent" },
} satisfies Record<CardLink, Localized>;

const BODY = {
  later: { zh: "请稍后重试", en: "Try again later" },
  retry: { zh: "请重试", en: "Try again" },
  smaller: { zh: "请拆小后重试", en: "Split it into smaller tasks and try again" },
  modelSettings: { zh: "需要更新模型设置", en: "Model settings need an update" },
} satisfies Record<string, Localized>;

const ENVIRONMENT: CardCopy = { title: { zh: "执行环境出错", en: "Execution environment error" }, body: BODY.retry };
const ENVIRONMENT_CONFIG: CardCopy = {
  title: ENVIRONMENT.title,
  body: { zh: "需要检查 Agent 配置", en: "The Agent configuration needs a check" },
  link: "settings",
};
const SMALLER = (zh: string, en: string): CardCopy => ({ title: { zh, en }, body: BODY.smaller });

/** One entry per reason so a new TurnFailureReason cannot ship without a card. */
const FAILURE_CARDS = {
  provider_rate_limited: { title: { zh: "模型请求太频繁", en: "Too many model requests" }, body: BODY.later },
  provider_unavailable: {
    title: { zh: "模型服务暂时不可用", en: "Model service temporarily unavailable" },
    body: BODY.later,
  },
  provider_connection_failed: {
    title: { zh: "模型服务暂时不可用", en: "Model service temporarily unavailable" },
    body: BODY.later,
  },
  provider_authentication_failed: {
    title: { zh: "模型认证失败", en: "Model authentication failed" },
    body: BODY.modelSettings,
    link: "settings",
  },
  provider_access_denied: {
    title: { zh: "没有模型访问权限", en: "No access to the model" },
    body: BODY.modelSettings,
    link: "settings",
  },
  provider_quota_exceeded: {
    title: { zh: "模型额度已用完", en: "Model quota used up" },
    body: { zh: "恢复时间未知", en: "Recovery time unknown" },
  },
  credential_unavailable: {
    title: { zh: "执行凭据不可用", en: "Execution credentials unavailable" },
    body: { zh: "需要更新凭据", en: "Credentials need an update" },
    link: "settings",
  },
  provider_context_limit: SMALLER("任务超出上下文上限", "Task exceeds the context limit"),
  provider_execution_limit: SMALLER("任务超出执行上限", "Task exceeds the execution limit"),
  turn_timeout: SMALLER("任务超时", "Task timed out"),
  output_too_large: SMALLER("结果太大", "Result too large"),
  provider_process_exited: ENVIRONMENT,
  provider_start_failed: ENVIRONMENT,
  sandbox_unavailable: ENVIRONMENT,
  client_shutdown: ENVIRONMENT,
  session_resume_failed: ENVIRONMENT,
  provider_protocol_error: ENVIRONMENT,
  provider_failed: ENVIRONMENT,
  provider_empty_result: ENVIRONMENT,
  provider_teardown_failed: ENVIRONMENT,
  provider_request_rejected: ENVIRONMENT_CONFIG,
  configuration_conflict: ENVIRONMENT_CONFIG,
  turn_state_unknown: {
    title: { zh: "无法确认任务是否完成", en: "Can't confirm whether the task finished" },
    body: { zh: "请先查看结果", en: "Check the results first" },
  },
  workspace_failed: { title: { zh: "工作区改动没能保存", en: "Workspace changes weren't saved" } },
} satisfies Record<TurnFailureReason, CardCopy>;

const INPUT_FAILURE_CARDS: Record<string, CardCopy> = {
  input_expired: {
    title: { zh: "消息已过期", en: "Message expired" },
    body: { zh: "如需要请重发", en: "Send it again if you still need it" },
  },
  input_rejected: { title: { zh: "消息没能送达", en: "Message not delivered" }, body: BODY.retry },
};

export function failureCardCopy(
  code: string | null,
  options: { batchRetryBlocked?: boolean; workspaceBlocked?: boolean } = {},
): CardCopy {
  const failure =
    code && Object.hasOwn(FAILURE_CARDS, code)
      ? FAILURE_CARDS[code as TurnFailureReason]
      : code && Object.hasOwn(INPUT_FAILURE_CARDS, code)
        ? (INPUT_FAILURE_CARDS[code] as CardCopy)
        : ENVIRONMENT;
  if (options.workspaceBlocked) return FAILURE_CARDS.workspace_failed;
  if (options.batchRetryBlocked)
    return {
      title: failure.title,
      body: { zh: "请打开原任务查看", en: "Open the original task to review it" },
      link: "task",
    };
  return failure;
}

export const OFFLINE_CARD: CardCopy = {
  title: { zh: "Agent 所在电脑离线", en: "The Agent's computer is offline" },
  body: { zh: "恢复后会自动处理", en: "Messages will be handled after it reconnects" },
  link: "restore",
};

/** A message waiting behind an earlier one whose dispatch the Computer never confirmed. */
export const PARKED_CARD: CardCopy = {
  title: { zh: "排队中", en: "Queued" },
  body: { zh: "前一条完成后处理", en: "Handled after the earlier message finishes" },
  link: "agent",
};

/** What a card turns into once its button was used or the task later finished. */
export const CARD_STATUS = {
  completed: { zh: "已完成", en: "Done" },
  checking: { zh: "处理中，请勿重复点击", en: "In progress; don't click again" },
  failed: { zh: "操作失败", en: "The operation failed" },
  stale: { zh: "环境已变化，请刷新", en: "The environment changed; refresh" },
  saved: { zh: "已保存", en: "Saved" },
  discarded: { zh: "已放弃改动", en: "Changes discarded" },
  retryQueued: { zh: "已重新排队", en: "Queued again" },
} satisfies Record<string, Localized>;

export const CARD_BUTTONS = {
  save_release: { zh: "重试保存", en: "Retry save" },
  discard: { zh: "放弃改动", en: "Discard changes" },
} satisfies Record<string, Localized>;

/** Joins the body sentence and its trailing link in the reader's language. */
export function bodyWithLink(body: string, link: string | undefined, language: FeedbackLanguage): string {
  if (!link) return language === "zh" ? body : `${body}.`;
  return language === "zh" ? `${body}，${link}` : `${body}. ${link}`;
}
