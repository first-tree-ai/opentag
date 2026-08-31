import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { slackWebhookReceipts } from "../../../db/schema/index.js";
import type { PolicyErrorCategory, PolicyPhase, PolicyRetryability } from "../../im/external-call-policy.js";

export class SlackWebhookReceiptError extends Error {
  declare readonly code: string;
  declare readonly category: PolicyErrorCategory;
  declare readonly retryability: PolicyRetryability;
  declare readonly phase: PolicyPhase;
  declare readonly requestId: string;

  constructor(code: string, requestId = randomUUID()) {
    super(code);
    this.name = "SlackWebhookReceiptError";
    this.code = code;
    this.category = "validation";
    this.retryability = "not_retryable";
    this.phase = "request";
    this.requestId = requestId;
  }
}

type SlackWebhookReceiptMetricCore = { type: "receipt" | "duplicate"; installationId: string; eventId: string };
type SlackWebhookReceiptMetricDetails = { status?: "processing" | "processed" | "failed"; errorCode?: string };
export type SlackWebhookReceiptMetric = SlackWebhookReceiptMetricCore & SlackWebhookReceiptMetricDetails;

type SlackWebhookReceiptClaimCore = { accepted: boolean; duplicate: boolean };
type SlackWebhookReceiptClaimDetails = { receiptId?: string; status?: "processing" | "processed" | "failed" };
export type SlackWebhookReceiptClaim = SlackWebhookReceiptClaimCore & SlackWebhookReceiptClaimDetails;

type SlackWebhookReceiptInput = { installationId: string; credentialGeneration: number; eventId: string };

export class SlackWebhookReceiptStore {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onMetric: (metric: SlackWebhookReceiptMetric) => void;

  constructor(
    database: DatabaseClient,
    options: { now?: () => Date; onMetric?: (metric: SlackWebhookReceiptMetric) => void } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onMetric = options.onMetric ?? (() => undefined);
  }

  async claim(input: SlackWebhookReceiptInput): Promise<SlackWebhookReceiptClaim> {
    if (
      input.eventId.length < 1 ||
      input.eventId.length > 255 ||
      [...input.eventId].some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x21 || code > 0x7e;
      })
    ) {
      throw new SlackWebhookReceiptError("SLACK_RECEIPT_EVENT_ID_INVALID");
    }
    return this.#database.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(slackWebhookReceipts)
        .values({
          installationId: input.installationId,
          credentialGeneration: input.credentialGeneration,
          eventId: input.eventId,
          status: "processing",
          receivedAt: this.#now(),
          attemptCount: 1,
        })
        .onConflictDoNothing({
          target: [
            slackWebhookReceipts.installationId,
            slackWebhookReceipts.credentialGeneration,
            slackWebhookReceipts.eventId,
          ],
        })
        .returning({ id: slackWebhookReceipts.id, status: slackWebhookReceipts.status });
      if (created) {
        this.#onMetric({
          type: "receipt",
          installationId: input.installationId,
          eventId: input.eventId,
          status: "processing",
        });
        return { accepted: true, duplicate: false, receiptId: created.id, status: created.status };
      }
      const [existing] = await transaction
        .select({ id: slackWebhookReceipts.id, status: slackWebhookReceipts.status })
        .from(slackWebhookReceipts)
        .where(
          and(
            eq(slackWebhookReceipts.installationId, input.installationId),
            eq(slackWebhookReceipts.credentialGeneration, input.credentialGeneration),
            eq(slackWebhookReceipts.eventId, input.eventId),
          ),
        )
        .limit(1);
      this.#onMetric({
        type: "duplicate",
        installationId: input.installationId,
        eventId: input.eventId,
        ...(existing?.status ? { status: existing.status } : {}),
      });
      return {
        accepted: false,
        duplicate: true,
        ...(existing?.id ? { receiptId: existing.id } : {}),
        ...(existing?.status ? { status: existing.status } : {}),
      };
    });
  }

  async markProcessed(receiptId: string): Promise<void> {
    const [updated] = await this.#database
      .update(slackWebhookReceipts)
      .set({ status: "processed", processedAt: this.#now(), lastErrorCode: null, lastErrorAt: null })
      .where(eq(slackWebhookReceipts.id, receiptId))
      .returning({
        id: slackWebhookReceipts.id,
        installationId: slackWebhookReceipts.installationId,
        eventId: slackWebhookReceipts.eventId,
      });
    if (updated) {
      this.#onMetric({
        type: "receipt",
        installationId: updated.installationId,
        eventId: updated.eventId,
        status: "processed",
      });
    }
  }

  async markFailed(receiptId: string, errorCode: string): Promise<void> {
    const safeCode = errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "SLACK_EVENT_PROCESSING_FAILED";
    const [updated] = await this.#database
      .update(slackWebhookReceipts)
      .set({ status: "failed", lastErrorCode: safeCode, lastErrorAt: this.#now() })
      .where(eq(slackWebhookReceipts.id, receiptId))
      .returning({
        id: slackWebhookReceipts.id,
        installationId: slackWebhookReceipts.installationId,
        eventId: slackWebhookReceipts.eventId,
      });
    if (updated) {
      this.#onMetric({
        type: "receipt",
        installationId: updated.installationId,
        eventId: updated.eventId,
        status: "failed",
        errorCode: safeCode,
      });
    }
  }
}
