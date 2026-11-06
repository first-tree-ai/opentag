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

export function feedbackCardContent(
  target: FeedbackTarget,
  action?: FeedbackAction,
  language: FeedbackLanguage = "en",
) {
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

function cardActions(
  target: FeedbackTarget,
  result: boolean,
  operationUrl: (kind: string) => string,
  language: FeedbackLanguage,
) {
  if (result) return [];
  if (target.state === "workspace_blocked")
    return [
      {
        kind: "save_release",
        label: FEEDBACK_LABELS.retrySave[language],
        url: operationUrl("save_release"),
        style: "primary" as const,
      },
      {
        kind: "discard",
        label: FEEDBACK_LABELS.discard[language],
        url: operationUrl("discard"),
        style: "danger" as const,
      },
    ];
  return [];
}

type MessageSegment = { text: string; href?: string };

/**
 * A plain message for each provider, with the link as clickable words. Feishu `post` carries the link as
 * an `a` element, which does not depend on the provider recognizing link syntax in `text` content. Both
 * forms keep the URL in the stored message, which is what unknown-send readback matches.
 */
function renderMessage(lines: MessageSegment[][], language: FeedbackLanguage) {
  return {
    slack: lines.map((line) => line.map(({ text, href }) => (href ? `<${href}|${text}>` : text)).join(" ")).join("\n"),
    feishu: JSON.stringify({
      [language === "zh" ? "zh_cn" : "en_us"]: {
        content: lines.map((line) =>
          line.flatMap(({ text, href }, index) => [
            ...(index > 0 ? [{ tag: "text", text: " " }] : []),
            href ? { tag: "a", text, href } : { tag: "text", text },
          ]),
        ),
      },
    }),
  };
}

export function renderOfflineNotice(
  target: Pick<FeedbackTarget, "agentId">,
  publicUrl: string,
  language: FeedbackLanguage,
) {
  const { before, label, after } = offlineNoticeCopy(language);
  const href = new URL(`/agents/${encodeURIComponent(target.agentId)}`, publicUrl).href;
  const [reason = "", recovery = ""] = before.split("\n");
  return renderMessage(
    [[{ text: reason }], [{ text: recovery }, { text: label, href }], ...after.split("\n").map((text) => [{ text }])],
    language,
  );
}

export function renderFeedbackText(
  target: FeedbackTarget,
  publicUrl: string,
  action?: FeedbackAction,
  language: FeedbackLanguage = "en",
) {
  const content = feedbackCardContent(target, action, language);
  const href = new URL(`/im-feedback/${encodeURIComponent(target.id)}`, publicUrl).href;
  const link = { text: FEEDBACK_LABELS.details[language], href };
  return renderMessage(
    content.result
      ? [[{ text: content.title }, link]]
      : [[{ text: content.title }], [{ text: content.impact }], [{ text: content.availability }, link]],
    language,
  );
}

export function renderFeedbackCard(
  target: FeedbackTarget,
  publicUrl: string,
  action?: FeedbackAction,
  language: FeedbackLanguage = "en",
) {
  const content = feedbackCardContent(target, action, language);
  const detailsUrl = new URL(`/im-feedback/${encodeURIComponent(target.id)}`, publicUrl).href;
  const operationUrl = (kind: string) => {
    const u = new URL(detailsUrl);
    u.searchParams.set("operation", kind);
    return u.href;
  };
  const actions = cardActions(target, content.result, operationUrl, language);
  const details = FEEDBACK_LABELS.details[language];
  const text = content.result ? content.title : `${content.title}\n\n${content.impact}\n\n${content.availability}`;
  return {
    slack: {
      text,
      unfurl_links: false,
      unfurl_media: false,
      blocks: [
        {
          type: "section" as const,
          block_id: `opentag_feedback:${target.id}`,
          text: { type: "plain_text" as const, text: content.title },
        },
        ...(!content.result
          ? [
              { type: "section" as const, text: { type: "plain_text" as const, text: content.impact } },
              { type: "section" as const, text: { type: "plain_text" as const, text: content.availability } },
            ]
          : []),
        {
          type: "actions" as const,
          elements: [
            ...actions.map((a) => ({
              type: "button" as const,
              text: { type: "plain_text" as const, text: a.label },
              style: a.style,
              action_id: `opentag_feedback_${a.kind}`,
              url: a.url,
            })),
            {
              type: "button" as const,
              text: { type: "plain_text" as const, text: details },
              action_id: "opentag_feedback_details",
              url: detailsUrl,
            },
          ],
        },
      ],
    },
    feishu: JSON.stringify({
      config: { wide_screen_mode: true, update_multi: true },
      header: {
        title: {
          tag: "plain_text",
          content: (content.result ? FEEDBACK_LABELS.taskStatus : FEEDBACK_LABELS.taskFailed)[language],
        },
        template: action?.state === "succeeded" || target.state === "completed" ? "green" : "red",
      },
      elements: [
        { tag: "div", text: { tag: "plain_text", content: content.title } },
        ...(!content.result
          ? [
              { tag: "div", text: { tag: "plain_text", content: content.impact } },
              { tag: "div", text: { tag: "plain_text", content: content.availability } },
            ]
          : []),
        {
          tag: "action",
          actions: [
            ...actions.map((a) => ({
              tag: "button",
              text: { tag: "plain_text", content: a.label },
              type: a.style === "danger" ? "danger" : "primary",
              url: a.url,
            })),
            { tag: "button", text: { tag: "plain_text", content: details }, type: "default", url: detailsUrl },
          ],
        },
      ],
    }),
  };
}
