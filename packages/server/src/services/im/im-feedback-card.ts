import {
  bodySentence,
  CARD_STATUS,
  type CardCopy,
  failureCardCopy,
  OFFLINE_CARD,
  PARKED_CARD,
} from "./im-feedback-card-copy.js";
import type { FeedbackLanguage } from "./im-feedback-copy.js";
import type { FeedbackAction, FeedbackRuntime, FeedbackTarget } from "./im-feedback-store.js";

export type CardTone = "failure" | "success" | "offline" | "pending";

/** Waiting notices share the failure color: a card is red when something did not happen as asked. */
const FEISHU_TEMPLATE = { failure: "red", success: "green", offline: "red", pending: "grey" } as const;
/**
 * Slack only paints the attachment bar from a hex color when the attachment holds blocks; the
 * `danger` and `good` keywords render as a grey bar there.
 */
const SLACK_COLOR = { failure: "#E01E5A", success: "#2EB67D", offline: "#E01E5A", pending: "#9E9EA6" } as const;

export interface FeedbackCard {
  /**
   * A waiting notice shares its target with the failure card that may follow, so it carries a different
   * identity: failure readback must never bind the notice.
   */
  kind: "failure" | "notice";
  tone: CardTone;
  title: string;
  /** Plain text: cards carry no links (Gandy 11-10). */
  body?: string;
  /** Plain text above the body: which group and message a card sent to the sender's direct message is about. */
  origin?: string;
}

export function feedbackDetailsUrl(target: Pick<FeedbackTarget, "id">, publicUrl: string): string {
  return new URL(`/im-feedback/${encodeURIComponent(target.id)}`, publicUrl).href;
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

function fromCopy(copy: CardCopy, tone: CardTone, language: FeedbackLanguage): FeedbackCard {
  return {
    kind: "failure",
    tone,
    title: copy.title[language],
    ...(copy.body ? { body: copy.body[language] } : {}),
  };
}

export function feedbackCard(
  target: FeedbackTarget,
  action: FeedbackAction | undefined,
  language: FeedbackLanguage,
  runtime?: FeedbackRuntime,
): FeedbackCard {
  const status = cardStatus(target, action);
  // A status card is only its state: who acted and when stay on the details page.
  if (status) return { kind: "failure", tone: status.tone, title: CARD_STATUS[status.key][language] };
  return fromCopy(
    failureCardCopy(target.errorCode, {
      workspaceBlocked: target.state === "workspace_blocked",
      batchRetryBlocked: target.batchRetryBlocked,
      ...(target.batchSize ? { batchSize: target.batchSize } : {}),
      provider: target.provider,
      ...(runtime ? { runtime } : {}),
      ...(target.retryAt ? { retryAt: target.retryAt } : {}),
    }),
    "failure",
    language,
  );
}

/** Both waiting notices are red, like a failure: the offline Computer, or a message parked behind an unconfirmed one. */
export function waitingCard(language: FeedbackLanguage, reason: "offline" | "parked" = "offline"): FeedbackCard {
  return { ...fromCopy(reason === "parked" ? PARKED_CARD : OFFLINE_CARD, "offline", language), kind: "notice" };
}

/**
 * Whether provider content holds this target's failure identity: its exact details URL, which a failure card
 * carries as a zero-width link and a plain-text message as its details link. Waiting notices carry no URL.
 */
export function holdsFailureIdentity(content: string, feedbackId: string): boolean {
  const id = feedbackId.replace(/[^0-9a-f-]/giu, "");
  return new RegExp(`/im-feedback/${id}(?![0-9A-Za-z?/_-])`, "u").test(content);
}

/** The hidden Slack block ID a card is read back by. */
export function slackCardIdentity(kind: FeedbackCard["kind"], feedbackId: string): string {
  return `${kind === "notice" ? "opentag_notice" : "opentag_feedback"}:${feedbackId}`;
}

/** Plain words for notifications and Slack's attachment fallback. */
export function cardFallback(card: FeedbackCard): string {
  return card.body ? `${card.title}: ${card.body}` : card.title;
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
  const body = card.body ? bodySentence(slackEscape(card.body), language) : undefined;
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
          ...(card.origin
            ? [{ type: "section" as const, text: { type: "plain_text" as const, text: card.origin, emoji: false } }]
            : []),
          ...(body ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: body } }] : []),
        ],
      },
    ],
    unfurl_links: false,
    unfurl_media: false,
  };
}

/**
 * Feishu's message read API returns a card's links but not its button values, so a failure card carries a
 * zero-width link to its details page as its readback identity. It is not visible and opens nothing anyone
 * can click. A waiting notice is never read back and carries none.
 */
export function feishuCardContent(card: FeedbackCard, detailsUrl: string, language: FeedbackLanguage): string {
  const identity = card.kind === "failure" ? `[\u200b](${detailsUrl})` : "";
  const markdown = `${card.body ? bodySentence(card.body, language) : ""}${identity}`;
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: card.title }, template: FEISHU_TEMPLATE[card.tone] },
    elements: [
      ...(card.origin ? [{ tag: "div", text: { tag: "plain_text", content: card.origin } }] : []),
      { tag: "div", text: { tag: "lark_md", content: markdown } },
    ],
  });
}
