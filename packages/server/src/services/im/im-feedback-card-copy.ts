import type { TurnFailureReason } from "@opentag/shared";
import type { FeedbackLanguage } from "./im-feedback-copy.js";

type Localized = Record<FeedbackLanguage, string>;

export interface CardCopy {
  title: Localized;
  /** One short sentence on what to do; every card has one. Cards carry no links. */
  body: Localized;
}

const BODY = {
  later: { zh: "请稍后重试", en: "Try again later" },
  retry: { zh: "请重试", en: "Try again" },
} satisfies Record<string, Localized>;

const AGENT_ERROR_TITLE: Localized = { zh: "Agent 运行出错", en: "The Agent ran into an error" };
/** "Agent 运行出错" with what went wrong, when it is known without naming the tool or model. */
const agentError = (zh: string, en: string): CardCopy => ({ title: AGENT_ERROR_TITLE, body: { zh, en } });
const ENVIRONMENT: CardCopy = { title: AGENT_ERROR_TITLE, body: BODY.retry };
const SERVICE_UNAVAILABLE: CardCopy = {
  title: { zh: "模型服务暂时不可用", en: "Model service temporarily unavailable" },
  body: BODY.later,
};

/**
 * One entry per reason so a new TurnFailureReason cannot ship without a card. Copy follows the final card list
 * (Gandy 11-10); reasons whose automatic fix has not shipped use the interim copy, and cards that will name the
 * tool or model say "模型" until they can.
 */
const FAILURE_CARDS = {
  provider_rate_limited: { title: { zh: "模型请求太频繁", en: "Too many model requests" }, body: BODY.later },
  provider_unavailable: SERVICE_UNAVAILABLE,
  provider_connection_failed: SERVICE_UNAVAILABLE,
  provider_authentication_failed: {
    title: { zh: "模型未登录或登录已失效", en: "The model isn't signed in, or the sign-in expired" },
    body: { zh: "请在 Agent 所在电脑登录模型账号", en: "Sign in to the model on the Agent's computer" },
  },
  provider_access_denied: {
    title: { zh: "没有该模型的使用权限", en: "No permission to use this model" },
    body: { zh: "请在 OpenTag 更换模型", en: "Choose another model in OpenTag" },
  },
  provider_quota_exceeded: {
    title: { zh: "模型额度已用完", en: "Model quota used up" },
    body: { zh: "额度恢复后请重试", en: "Try again after the quota resets" },
  },
  provider_request_rejected: {
    title: { zh: "模型拒绝了这次请求", en: "The model rejected this request" },
    body: {
      zh: "请换个说法，或去掉图片和附件后重试",
      en: "Rephrase it, or remove images and attachments, and try again",
    },
  },
  credential_unavailable: {
    title: { zh: "执行凭据不可用", en: "Execution credentials unavailable" },
    body: { zh: "请在 OpenTag 更新凭据", en: "Update the credentials in OpenTag" },
  },
  // Interim until the conversation is compacted automatically.
  provider_context_limit: agentError("对话太长，请重试", "The conversation is too long. Try again"),
  // Interim until a cut-off reply continues automatically.
  provider_execution_limit: agentError("内容太长没写完，请重试", "The reply was too long to finish. Try again"),
  // Interim until an oversized reply is sent truncated.
  output_too_large: agentError("回复太长，请重试", "The reply is too long. Try again"),
  // The final title names the actual limit once it is 60 minutes.
  turn_timeout: {
    title: { zh: "任务超时", en: "Task timed out" },
    body: { zh: "回复“继续”，Agent 会接着做", en: 'Reply "continue" and the Agent will pick it up' },
  },
  sandbox_unavailable: agentError("云端运行环境断开，请重试", "The cloud environment disconnected. Try again"),
  provider_failed: agentError("模型调用失败，请重试", "The model call failed. Try again"),
  // These name the tool once cards can.
  provider_process_exited: ENVIRONMENT,
  provider_start_failed: ENVIRONMENT,
  provider_protocol_error: ENVIRONMENT,
  // Not produced as a failure today; kept so every reason has a card.
  client_shutdown: ENVIRONMENT,
  session_resume_failed: ENVIRONMENT,
  provider_empty_result: ENVIRONMENT,
  provider_teardown_failed: ENVIRONMENT,
  configuration_conflict: ENVIRONMENT,
  // Interim until a lost result is resumed automatically.
  turn_state_unknown: agentError(
    "处理可能中断，请先确认结果再决定是否重发",
    "Processing may have stopped. Check the result before sending it again",
  ),
  workspace_failed: {
    title: { zh: "工作区改动没能保存", en: "Workspace changes weren't saved" },
    body: { zh: "请在 OpenTag 重试保存或放弃改动", en: "Retry the save or discard the changes in OpenTag" },
  },
} satisfies Record<TurnFailureReason, CardCopy>;

const INPUT_FAILURE_CARDS: Record<string, CardCopy> = {
  input_expired: {
    title: { zh: "消息已过期", en: "Message expired" },
    body: {
      zh: "Agent 太久没能处理这条消息，如需要请重发",
      en: "The Agent couldn't handle this message for too long. Send it again if you still need it",
    },
  },
  input_rejected: { title: { zh: "消息没能送达", en: "Message not delivered" }, body: BODY.retry },
};

export function failureCardCopy(
  code: string | null,
  options: { batchRetryBlocked?: boolean; batchSize?: number; workspaceBlocked?: boolean } = {},
): CardCopy {
  const failure =
    code && Object.hasOwn(FAILURE_CARDS, code)
      ? FAILURE_CARDS[code as TurnFailureReason]
      : code && Object.hasOwn(INPUT_FAILURE_CARDS, code)
        ? (INPUT_FAILURE_CARDS[code] as CardCopy)
        : ENVIRONMENT;
  if (options.workspaceBlocked) return FAILURE_CARDS.workspace_failed;
  // A failed batch keeps its reason's card and says how many messages it held.
  if (options.batchRetryBlocked && options.batchSize && options.batchSize > 1)
    return {
      title: failure.title,
      body: {
        zh: `${failure.body.zh}（共 ${options.batchSize} 条消息）`,
        en: `${failure.body.en} (${options.batchSize} messages)`,
      },
    };
  return failure;
}

export const OFFLINE_CARD: CardCopy = {
  title: { zh: "Agent 所在电脑离线", en: "The Agent's computer is offline" },
  body: { zh: "电脑恢复后会自动处理", en: "Messages will be handled after the computer reconnects" },
};

/** A message waiting behind an earlier one whose dispatch the Computer never confirmed. */
export const PARKED_CARD: CardCopy = {
  title: { zh: "排队中", en: "Queued" },
  body: { zh: "前一条完成后处理", en: "Handled after the earlier message finishes" },
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

/** The body sentence in the reader's language: English ends with a period, Chinese copy does not. */
export function bodySentence(body: string, language: FeedbackLanguage): string {
  return language === "zh" ? body : `${body}.`;
}
