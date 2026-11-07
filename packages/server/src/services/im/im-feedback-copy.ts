import type { ImContentV1, TurnFailureReason } from "@opentag/shared";

export type FeedbackLanguage = "zh" | "en";
type Localized = Record<FeedbackLanguage, string>;

/** Text the sender wrote: a Chinese Bot name in a mention must not switch an English request to Chinese. */
export function feedbackLanguage(content: ImContentV1): FeedbackLanguage {
  const written = content.blocks
    .flatMap((block) => {
      if (block.type === "text" || block.type === "quote" || block.type === "code") return [block.text];
      return block.type === "link" ? [block.label] : [];
    })
    .join(" ");
  return textLanguage(written || content.fallbackText);
}

/** Chinese when the text contains Chinese, otherwise English. */
export function textLanguage(text: string): FeedbackLanguage {
  return /\p{Script=Han}/u.test(text) ? "zh" : "en";
}

const NEXT = {
  later: { zh: "稍后再发一次。", en: "Send it again later." },
  owner: { zh: "请 Agent 所有者处理后再发一次。", en: "Ask the Agent owner to fix this, then send it again." },
  smaller: { zh: "可以拆小一点再发。", en: "Try splitting it into smaller pieces and sending it again." },
  environment: {
    zh: "再发一次；还不行请联系 Agent 所有者。",
    en: "Send it again. If it still fails, contact the Agent owner.",
  },
  check: {
    zh: "先看看结果，再决定要不要重发。",
    en: "Check the results before deciding whether to send it again.",
  },
  resend: { zh: "如果还需要，请再发一次。", en: "If you still need this, send it again." },
  workspace: {
    zh: "这个 Session 的工作已暂停，新消息会继续排队。保存或放弃文件不会撤销已经发生的外部操作。",
    en: "Work in this Session is paused; new input for this Session remains queued. Saving or discarding files will not undo external operations.",
  },
  batch: {
    zh: "这批消息不能在这里重试。先打开原任务，逐条看过后再开始新工作。",
    en: "This frozen batch cannot be retried here. Open the original Task and review every input before starting new work.",
  },
} satisfies Record<string, Localized>;

const UNAVAILABLE = {
  zh: "模型服务暂时不可用，任务没有完成。",
  en: "The model service is temporarily unavailable, so the task didn't finish.",
};
const ENVIRONMENT = {
  zh: "执行环境出了问题，任务没有完成。",
  en: "The execution environment had a problem, so the task didn't finish.",
};

/** One line per reason so a new TurnFailureReason cannot ship without a sentence and a next step. */
const FAILURES = {
  provider_rate_limited: { cause: UNAVAILABLE, next: NEXT.later },
  provider_unavailable: { cause: UNAVAILABLE, next: NEXT.later },
  provider_connection_failed: { cause: UNAVAILABLE, next: NEXT.later },
  provider_authentication_failed: {
    cause: { zh: "模型认证失败，任务没有完成。", en: "Model authentication failed, so the task didn't finish." },
    next: NEXT.owner,
  },
  provider_access_denied: {
    cause: { zh: "模型访问权限被拒绝，任务没有完成。", en: "Model access was denied, so the task didn't finish." },
    next: NEXT.owner,
  },
  provider_quota_exceeded: {
    cause: { zh: "模型额度用完了，任务没有完成。", en: "The model quota has run out, so the task didn't finish." },
    next: NEXT.owner,
  },
  credential_unavailable: {
    cause: {
      zh: "执行凭据不可用，任务没有完成。",
      en: "Execution credentials are unavailable, so the task didn't finish.",
    },
    next: NEXT.owner,
  },
  provider_context_limit: {
    cause: { zh: "这个任务超过了上下文上限，没有完成。", en: "This task hit the context limit, so it didn't finish." },
    next: NEXT.smaller,
  },
  provider_execution_limit: {
    cause: { zh: "这个任务超过了执行上限，没有完成。", en: "This task hit its execution limit, so it didn't finish." },
    next: NEXT.smaller,
  },
  turn_timeout: {
    cause: { zh: "这个任务超过了时间上限，没有完成。", en: "This task hit its time limit, so it didn't finish." },
    next: NEXT.smaller,
  },
  output_too_large: {
    cause: { zh: "这个任务的结果太大，没有完成。", en: "This task's result was too large, so it didn't finish." },
    next: NEXT.smaller,
  },
  provider_process_exited: { cause: ENVIRONMENT, next: NEXT.environment },
  provider_start_failed: { cause: ENVIRONMENT, next: NEXT.environment },
  sandbox_unavailable: { cause: ENVIRONMENT, next: NEXT.environment },
  client_shutdown: { cause: ENVIRONMENT, next: NEXT.environment },
  provider_request_rejected: { cause: ENVIRONMENT, next: NEXT.environment },
  configuration_conflict: { cause: ENVIRONMENT, next: NEXT.environment },
  session_resume_failed: { cause: ENVIRONMENT, next: NEXT.environment },
  provider_protocol_error: { cause: ENVIRONMENT, next: NEXT.environment },
  provider_failed: { cause: ENVIRONMENT, next: NEXT.environment },
  provider_empty_result: { cause: ENVIRONMENT, next: NEXT.environment },
  provider_teardown_failed: { cause: ENVIRONMENT, next: NEXT.environment },
  turn_state_unknown: {
    cause: { zh: "无法确认任务是否完成。", en: "We can't confirm whether the task finished." },
    next: NEXT.check,
  },
  workspace_failed: {
    cause: {
      zh: "工作区改动没能保存，任务没有完成。",
      en: "Workspace changes couldn't be saved, so the task didn't finish.",
    },
    next: NEXT.workspace,
  },
} satisfies Record<TurnFailureReason, { cause: Localized; next: Localized }>;

const INPUT_FAILURES: Record<string, { cause: Localized; next: Localized }> = {
  input_expired: {
    cause: {
      zh: "消息等待太久已过期，任务没有完成。",
      en: "The message waited too long and expired, so the task didn't finish.",
    },
    next: NEXT.resend,
  },
  input_rejected: {
    cause: { zh: "消息没能送达，任务没有完成。", en: "The message couldn't be delivered, so the task didn't finish." },
    next: NEXT.environment,
  },
};

export function failureCopy(
  code: string | null,
  language: FeedbackLanguage,
  options: { batchRetryBlocked?: boolean; workspaceBlocked?: boolean } = {},
): { cause: string; next: string } {
  const failure =
    code && Object.hasOwn(FAILURES, code)
      ? FAILURES[code as TurnFailureReason]
      : code && Object.hasOwn(INPUT_FAILURES, code)
        ? (INPUT_FAILURES[code] as { cause: Localized; next: Localized })
        : { cause: ENVIRONMENT, next: NEXT.environment };
  const next = options.workspaceBlocked ? NEXT.workspace : options.batchRetryBlocked ? NEXT.batch : failure.next;
  return { cause: failure.cause[language], next: next[language] };
}

export function effectsCopy(effects: string | null, language: FeedbackLanguage): string {
  const copy =
    effects === "not_started"
      ? { zh: "任务没有开始，没有执行任何操作。", en: "The task didn't start, and no operations were run." }
      : {
          zh: "可能已经执行了部分操作，重发前请先检查结果。",
          en: "Some operations may already have run. Check the results before sending it again.",
        };
  return copy[language];
}

/** Tells people how to recover, not only to wait. Names no Computer or administrator: everyone in the group reads it. */
export function offlineNoticeCopy(language: FeedbackLanguage): { before: string; label: string; after: string } {
  return language === "zh"
    ? {
        before:
          "运行这个 Agent 的电脑离线了，暂时处理不了这条消息。\n请确认电脑已开机、已联网，再到 Agent 页面恢复连接。",
        label: "恢复连接",
        after: "如果这不是你管理的 Agent，请联系它的管理员。\n消息已保留，恢复后会自动处理；7 天内没恢复会过期。",
      }
    : {
        before:
          "The computer running this Agent is offline, so this message can't be handled yet.\nCheck that the computer is on and connected, then restore the connection on the Agent page.",
        label: "Restore connection",
        after:
          "If you don't manage this Agent, contact its administrator.\nYour message is saved and will be handled after it reconnects. It expires after 7 days.",
      };
}

export const FEEDBACK_LABELS = {
  details: { zh: "查看详情", en: "View details" },
  taskFailed: { zh: "任务失败", en: "Task failed" },
  taskStatus: { zh: "任务状态", en: "Task status" },
  retrySave: { zh: "重试保存", en: "Retry save" },
  discard: { zh: "放弃改动", en: "Discard unsaved changes" },
  taskCompleted: { zh: "任务已完成", en: "Task completed" },
  checking: { zh: "正在确认操作结果，请不要重复提交", en: "Checking the operation result; do not submit it again" },
  actionFailed: {
    zh: "操作失败，请先查看当前状态再重试",
    en: "The operation failed; review the current state before trying again",
  },
  actionStale: { zh: "环境已经变化，请查看当前状态", en: "The environment changed; review its current state" },
  releasedUnverified: {
    zh: "环境已释放，继续前请确认改动已保存",
    en: "Environment released; verify saved changes before continuing",
  },
  saved: {
    zh: "已保存并释放环境，下次分配时会恢复",
    en: "Saved and environment released; the next allocation restores it",
  },
  discarded: {
    zh: "未保存的改动已放弃，之前完整的存档仍保留",
    en: "Unsaved changes discarded; previous complete archive retained",
  },
  retryQueued: { zh: "已重新排队", en: "Retry queued" },
} satisfies Record<string, Localized>;
