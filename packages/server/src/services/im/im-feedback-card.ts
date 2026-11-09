import {
  bodyWithLink,
  CARD_BUTTONS,
  CARD_LINK_LABELS,
  CARD_STATUS,
  type CardCopy,
  type CardLink,
  failureCardCopy,
  OFFLINE_CARD,
  PARKED_CARD,
} from "./im-feedback-card-copy.js";
import type { FeedbackLanguage } from "./im-feedback-copy.js";
import type { FeedbackAction, FeedbackTarget } from "./im-feedback-store.js";

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
  /**
   * A waiting notice shares its target with the failure card that may follow, so it carries a different
   * identity: failure readback must never bind the notice.
   */
  kind: "failure" | "notice";
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
    kind: "failure",
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
  // A status card is only its state: who acted and when stay on the details page.
  if (status) return { kind: "failure", tone: status.tone, title: CARD_STATUS[status.key][language], buttons: [] };
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

/** Both waiting notices are orange: the offline Computer, or a message parked behind an unconfirmed one. */
export function waitingCard(
  target: Pick<FeedbackTarget, "id">,
  publicUrl: string,
  language: FeedbackLanguage,
  reason: "offline" | "parked" = "offline",
): FeedbackCard {
  return {
    ...fromCopy(reason === "parked" ? PARKED_CARD : OFFLINE_CARD, "offline", language, (link) =>
      feedbackLinkUrl(target, publicUrl, link),
    ),
    kind: "notice",
  };
}

/** Links a failure message can carry. A waiting notice links only to `restore` or `agent`. */
const FAILURE_LINKS = new Set<string>(["settings", "task"]);

/**
 * Whether provider content holds this target's failure identity: its details URL, or one of the links only
 * a failure card carries. A waiting notice for the same target never matches.
 */
export function holdsFailureIdentity(content: string, feedbackId: string): boolean {
  const pattern = new RegExp(`/im-feedback/${feedbackId.replace(/[^0-9a-f-]/giu, "")}(\\?open=([a-z]+))?`, "gu");
  for (const match of content.matchAll(pattern)) if (!match[2] || FAILURE_LINKS.has(match[2])) return true;
  return false;
}

/** The hidden Slack block ID a card is read back by. */
export function slackCardIdentity(kind: FeedbackCard["kind"], feedbackId: string): string {
  return `${kind === "notice" ? "opentag_notice" : "opentag_feedback"}:${feedbackId}`;
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
            block_id: slackCardIdentity(card.kind, feedbackId),
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
