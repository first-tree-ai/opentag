import {
  effectsCopy,
  FEEDBACK_LABELS,
  type FeedbackLanguage,
  failureCopy,
  offlineNoticeCopy,
} from "./im-feedback-copy.js";
import type { FeedbackAction, FeedbackTarget } from "./im-feedback-store.js";

function actionResult(language: FeedbackLanguage, action?: FeedbackAction): string | undefined {
  if (!action) return;
  if (["confirmed", "submitting", "checking"].includes(action.state)) return FEEDBACK_LABELS.checking[language];
  if (action.state === "failed") return FEEDBACK_LABELS.actionFailed[language];
  if (action.state === "stale") return FEEDBACK_LABELS.actionStale[language];
  if (action.state !== "succeeded") return;
  if (action.resultCode === "released_unverified") return FEEDBACK_LABELS.releasedUnverified[language];
  if (action.kind === "save_release") return FEEDBACK_LABELS.saved[language];
  if (action.kind === "discard") return FEEDBACK_LABELS.discarded[language];
  return FEEDBACK_LABELS.retryQueued[language];
}

export function feedbackContent(target: FeedbackTarget, action?: FeedbackAction, language: FeedbackLanguage = "en") {
  const resolved = action?.state === "succeeded" || target.state === "completed";
  const checking = action && ["confirmed", "submitting", "checking"].includes(action.state);
  const result =
    actionResult(language, action) ??
    (target.state === "completed" ? FEEDBACK_LABELS.taskCompleted[language] : undefined);
  const attribution = action ? ` · ${action.actorDisplayName.slice(0, 255)} · ${action.updatedAt.toISOString()}` : "";
  const failure = failureCopy(target.errorCode, language, {
    workspaceBlocked: target.state === "workspace_blocked",
    batchRetryBlocked: target.batchRetryBlocked,
  });
  const title = result ? `${resolved ? "✅" : checking ? "⏳" : "⚠️"} ${result}${attribution}` : failure.cause;
  return {
    title,
    impact: effectsCopy(target.effects, language),
    availability: failure.next,
    result: !!result,
    checking: !!checking,
  };
}

/** The link stays in the text so readback can match the exact details URL on both providers. */
export function textLink(provider: FeedbackTarget["provider"], url: string, label: string): string {
  return provider === "slack" ? `<${url}|${label}>` : `[${label}](${url})`;
}

export function renderOfflineNotice(
  target: Pick<FeedbackTarget, "provider" | "agentId">,
  publicUrl: string,
  language: FeedbackLanguage,
): string {
  const { before, label, after } = offlineNoticeCopy(language);
  const url = new URL(`/agents/${encodeURIComponent(target.agentId)}`, publicUrl).href;
  return `${before} ${textLink(target.provider, url, label)}\n${after}`;
}

export function renderFeedbackText(
  target: FeedbackTarget,
  publicUrl: string,
  action?: FeedbackAction,
  language: FeedbackLanguage = "en",
): string {
  const content = feedbackContent(target, action, language);
  const detailsUrl = new URL(`/im-feedback/${encodeURIComponent(target.id)}`, publicUrl).href;
  const link = textLink(target.provider, detailsUrl, FEEDBACK_LABELS.details[language]);
  return content.result
    ? `${content.title} ${link}`
    : [content.title, content.impact, `${content.availability} ${link}`].join("\n\n");
}
