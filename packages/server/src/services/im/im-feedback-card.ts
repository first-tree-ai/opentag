import {
  bodyWithLink,
  CARD_BUTTONS,
  CARD_LINK_LABELS,
  CARD_STATUS,
  type CardCopy,
  type CardLink,
  failureCardCopy,
  OFFLINE_CARD,
} from "./im-feedback-card-copy.js";
import type { FeedbackLanguage } from "./im-feedback-copy.js";
import type { FeedbackAction, FeedbackTarget } from "./im-feedback-store.js";
import { plainText } from "./im-feedback-text.js";

export type CardTone = "failure" | "success" | "offline" | "pending";

const FEISHU_TEMPLATE = { failure: "red", success: "green", offline: "orange", pending: "grey" } as const;
/**
 * Slack only paints the attachment bar from a hex color when the attachment holds blocks; the
 * `danger` and `good` keywords render as a grey bar there.
 */
const SLACK_COLOR = { failure: "#E01E5A", success: "#2EB67D", offline: "#F2952F", pending: "#9E9EA6" } as const;

type ButtonKind = keyof typeof CARD_BUTTONS;
interface CardButton {
  kind: ButtonKind;
  label: string;
  style: "primary" | "danger";
  url: string;
}
export interface FeedbackCard {
  tone: CardTone;
  title: string;
  body?: { text: string; link?: { label: string; url: string } };
  buttons: CardButton[];
}

export function feedbackDetailsUrl(target: Pick<FeedbackTarget, "id">, publicUrl: string): string {
  return new URL(`/im-feedback/${encodeURIComponent(target.id)}`, publicUrl).href;
}

/**
 * Every web destination goes through the feedback page, which sends the Agent owner on and tells
 * anyone else who owns the Agent. The URL also carries the card's identity for Feishu readback.
 */
export function feedbackLinkUrl(target: Pick<FeedbackTarget, "id">, publicUrl: string, link: CardLink): string {
  const url = new URL(feedbackDetailsUrl(target, publicUrl));
  url.searchParams.set("open", link);
  return url.href;
}

type CardStatus = { tone: CardTone; key: keyof typeof CARD_STATUS };
const ACTION_STATUS: Partial<Record<FeedbackAction["state"], CardStatus>> = {
  confirmed: { tone: "pending", key: "checking" },
  submitting: { tone: "pending", key: "checking" },
  checking: { tone: "pending", key: "checking" },
  failed: { tone: "failure", key: "failed" },
  stale: { tone: "failure", key: "stale" },
};
const SUCCESS_STATUS: Record<FeedbackAction["kind"], CardStatus> = {
  save_release: { tone: "success", key: "saved" },
  discard: { tone: "success", key: "discarded" },
  retry_task: { tone: "success", key: "retryQueued" },
};

function cardStatus(target: FeedbackTarget, action?: FeedbackAction): CardStatus | undefined {
  if (action?.state === "succeeded")
    // An unverified release did not prove the save, so it is not reported as saved.
    return action.resultCode === "released_unverified" ? ACTION_STATUS.failed : SUCCESS_STATUS[action.kind];
  const status = action && ACTION_STATUS[action.state];
  if (status) return status;
  if (target.state === "completed") return { tone: "success", key: "completed" };
}

function fromCopy(
  copy: CardCopy,
  tone: CardTone,
  language: FeedbackLanguage,
  linkUrl: (link: CardLink) => string,
): FeedbackCard {
  return {
    tone,
    title: copy.title[language],
    ...(copy.body
      ? {
          body: {
            text: copy.body[language],
            ...(copy.link ? { link: { label: CARD_LINK_LABELS[copy.link][language], url: linkUrl(copy.link) } } : {}),
          },
        }
      : {}),
    buttons: [],
  };
}

export function feedbackCard(
  target: FeedbackTarget,
  publicUrl: string,
  action: FeedbackAction | undefined,
  language: FeedbackLanguage,
): FeedbackCard {
  const status = cardStatus(target, action);
  if (status) {
    // A display name is free text, and these cards are parsed for provider link and mention syntax.
    const actor = action ? `${plainText(action.actorDisplayName.slice(0, 255))} · ${utcMinute(action.updatedAt)}` : "";
    return {
      tone: status.tone,
      title: CARD_STATUS[status.key][language],
      ...(actor ? { body: { text: actor } } : {}),
      buttons: [],
    };
  }
  const workspaceBlocked = target.state === "workspace_blocked";
  const card = fromCopy(
    failureCardCopy(target.errorCode, { workspaceBlocked, batchRetryBlocked: target.batchRetryBlocked }),
    "failure",
    language,
    (link) => feedbackLinkUrl(target, publicUrl, link),
  );
  if (workspaceBlocked) {
    const operation = (kind: ButtonKind) => {
      const url = new URL(feedbackDetailsUrl(target, publicUrl));
      url.searchParams.set("operation", kind);
      return url.href;
    };
    card.buttons = [
      {
        kind: "save_release",
        label: CARD_BUTTONS.save_release[language],
        style: "primary",
        url: operation("save_release"),
      },
      { kind: "discard", label: CARD_BUTTONS.discard[language], style: "danger", url: operation("discard") },
    ];
  }
  return card;
}

export function offlineCard(
  target: Pick<FeedbackTarget, "id">,
  publicUrl: string,
  language: FeedbackLanguage,
): FeedbackCard {
  return fromCopy(OFFLINE_CARD, "offline", language, (link) => feedbackLinkUrl(target, publicUrl, link));
}

function utcMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** Plain words for notifications and Slack's attachment fallback. */
export function cardFallback(card: FeedbackCard): string {
  return card.body ? `${card.title}: ${card.body.text}` : card.title;
}

function slackEscape(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/**
 * The card is one colored attachment. A top-level `text` would show above the card as a second copy,
 * so the notification uses the attachment fallback instead. The hidden block ID is the card's
 * identity for readback.
 */
export function slackCardMessage(card: FeedbackCard, feedbackId: string, language: FeedbackLanguage) {
  const body = card.body
    ? bodyWithLink(
        slackEscape(card.body.text),
        card.body.link ? `<${card.body.link.url}|${slackEscape(card.body.link.label)}>` : undefined,
        language,
      )
    : undefined;
  return {
    attachments: [
      {
        color: SLACK_COLOR[card.tone],
        fallback: cardFallback(card),
        blocks: [
          {
            type: "header" as const,
            block_id: `opentag_feedback:${feedbackId}`,
            text: { type: "plain_text" as const, text: card.title, emoji: true },
          },
          ...(body ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: body } }] : []),
          ...(card.buttons.length
            ? [
                {
                  type: "actions" as const,
                  elements: card.buttons.map((b) => ({
                    type: "button" as const,
                    text: { type: "plain_text" as const, text: b.label },
                    style: b.style,
                    action_id: `opentag_feedback_${b.kind}`,
                    url: b.url,
                  })),
                },
              ]
            : []),
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * Feishu's message read API returns a card's links but not its button values, so a card whose body
 * has no feedback link carries a zero-width one to the details page as its readback identity.
 */
export function feishuCardContent(card: FeedbackCard, detailsUrl: string, language: FeedbackLanguage): string {
  const identity = `[​](${detailsUrl})`;
  const body = card.body
    ? bodyWithLink(
        card.body.text,
        card.body.link ? `[${card.body.link.label}](${card.body.link.url})` : undefined,
        language,
      )
    : undefined;
  const markdown = card.body?.link ? body : `${body ?? ""}${identity}`;
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: card.title }, template: FEISHU_TEMPLATE[card.tone] },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: markdown } },
      ...(card.buttons.length
        ? [
            {
              tag: "action",
              actions: card.buttons.map((b) => ({
                tag: "button",
                text: { tag: "plain_text", content: b.label },
                type: b.style,
                url: b.url,
              })),
            },
          ]
        : []),
    ],
  });
}
