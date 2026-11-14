import type { TurnQuotaWaitRequest, TurnQuotaWaitResult } from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imFeedbackTargets, imMessages } from "../../db/schema/index.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import { quotaWaitNoticeText } from "./im-feedback-card-copy.js";
import { feedbackLanguage } from "./im-feedback-copy.js";
import type { ConversationTextTarget, ImFeedbackMessenger } from "./im-feedback-messenger.js";
import { ownsLiveDelivery } from "./im-feedback-store.js";

/** A wait lasts at most a week and a few minutes; a notice is not edited after that. */
const NOTICE_TTL_MS = 8 * 24 * 60 * 60_000;
/** Bounds the memory of sent notices; the oldest are forgotten first. */
const MAX_NOTICES = 10_000;

interface SentNotice {
  messageId?: string;
  text?: string;
  sequence: number;
  expiresAt: number;
}

interface NoticeConversation {
  conversation: ConversationTextTarget;
  language: "zh" | "en";
}

export interface ImQuotaWaitNoticesOptions {
  database: DatabaseClient;
  messenger: Pick<ImFeedbackMessenger, "postConversationText" | "updateConversationText">;
  now?: () => Date;
  /** Test seams; both read the database by default. */
  owns?: (frame: TurnQuotaWaitRequest, context: RuntimeBusinessContext) => Promise<boolean>;
  conversation?: (deliveryId: string) => Promise<NoticeConversation | undefined>;
}

/**
 * The notice of an IM Turn waiting for a used-up model quota (`turn:quota-wait`). The Client sends only the reset
 * time; the Server writes one plain message into the conversation and edits it when the time moves. Which message it
 * sent is kept in memory only: after a Server restart a moved reset sends a new message instead of editing.
 */
export class ImQuotaWaitNotices {
  readonly #owns: NonNullable<ImQuotaWaitNoticesOptions["owns"]>;
  readonly #conversation: NonNullable<ImQuotaWaitNoticesOptions["conversation"]>;
  readonly #messenger: ImQuotaWaitNoticesOptions["messenger"];
  readonly #now: () => Date;
  readonly #sent = new Map<string, SentNotice>();

  constructor(options: ImQuotaWaitNoticesOptions) {
    const { database } = options;
    this.#owns = options.owns ?? ((frame, context) => ownsLiveDelivery(database, frame, context));
    this.#conversation = options.conversation ?? ((deliveryId) => noticeConversation(database, deliveryId));
    this.#messenger = options.messenger;
    this.#now = options.now ?? (() => new Date());
  }

  async handle(frame: TurnQuotaWaitRequest, context: RuntimeBusinessContext): Promise<TurnQuotaWaitResult> {
    const result = (status: TurnQuotaWaitResult["status"]): TurnQuotaWaitResult => ({
      type: "turn:quota-wait:result",
      requestId: frame.requestId,
      turnId: frame.turnId,
      sequence: frame.sequence,
      status,
    });
    if (!(await this.#owns(frame, context))) return result("stale_generation");
    const now = this.#now();
    this.#prune(now.getTime());
    const sent = this.#sent.get(frame.deliveryId);
    // Frames of one delivery arrive in order; an older one repeated after a newer one changes nothing.
    if (sent && frame.sequence <= sent.sequence) return result("recorded");
    if (frame.ended || frame.resetAt === undefined) {
      this.#sent.delete(frame.deliveryId);
      return result("recorded");
    }
    const target = await this.#conversation(frame.deliveryId);
    const text = target && quotaWaitNoticeText(frame.resetAt, target.language, now);
    const next: SentNotice = { ...sent, sequence: frame.sequence, expiresAt: now.getTime() + NOTICE_TTL_MS };
    this.#sent.set(frame.deliveryId, next);
    if (!target || !text || text === sent?.text) return result("recorded");
    try {
      if (sent?.messageId) {
        await this.#messenger.updateConversationText(target.conversation, sent.messageId, text);
      } else {
        next.messageId = await this.#messenger.postConversationText(target.conversation, text, frame.requestId);
      }
      next.text = text;
      return result("recorded");
    } catch {
      return result("failed");
    }
  }

  #prune(now: number): void {
    for (const [deliveryId, sent] of this.#sent) {
      if (sent.expiresAt <= now || this.#sent.size > MAX_NOTICES) this.#sent.delete(deliveryId);
    }
  }
}

/** Where the Turn's input was written, and the language it was written in. */
async function noticeConversation(
  database: DatabaseClient,
  deliveryId: string,
): Promise<NoticeConversation | undefined> {
  const [row] = await database
    .select({ target: imFeedbackTargets, content: imMessages.content })
    .from(imFeedbackTargets)
    .innerJoin(imMessages, eq(imMessages.id, imFeedbackTargets.messageId))
    .where(eq(imFeedbackTargets.deliveryId, deliveryId))
    .limit(1);
  if (!row) return undefined;
  const { target } = row;
  return {
    language: feedbackLanguage(row.content),
    conversation: {
      provider: target.provider,
      bindingId: target.bindingId,
      bindingGeneration: target.bindingGeneration,
      installationId: target.installationId,
      channelId: target.channelId,
      threadKey: target.threadKey,
      // Into the input's thread when it was in one, as the failure message does; Feishu threads by replying.
      ...(target.threadKey ? { replyToExternalId: target.inputExternalId } : {}),
    },
  };
}
