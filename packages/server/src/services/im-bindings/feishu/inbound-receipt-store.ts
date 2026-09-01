import { randomUUID } from "node:crypto";
import { type StructuredError, StructuredErrorSchema } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { feishuInboundReceipts } from "../../../db/schema/index.js";

export class FeishuInboundReceiptError extends Error {
  declare readonly code: string;
  readonly structuredError: StructuredError;

  constructor(code: string, requestId: string = randomUUID()) {
    super(code);
    this.name = "FeishuInboundReceiptError";
    this.code = code;
    this.structuredError = StructuredErrorSchema.parse({
      code,
      category: "validation",
      retryability: "never",
      phase: "request",
      requestId,
      message: code,
    });
  }

  toStructuredError(): StructuredError {
    return this.structuredError;
  }
}

type FeishuInboundReceiptMetricCore = { type: "receipt" | "duplicate"; bindingId: string; eventId: string };
type FeishuInboundReceiptMetricDetails = { status?: "processing" | "processed" | "failed"; errorCode?: string };
export type FeishuInboundReceiptMetric = FeishuInboundReceiptMetricCore & FeishuInboundReceiptMetricDetails;

type FeishuInboundReceiptClaimCore = { accepted: boolean; duplicate: boolean };
type FeishuInboundReceiptClaimDetails = {
  receiptId?: string;
  status?: "processing" | "processed" | "failed";
};
export type FeishuInboundReceiptClaim = FeishuInboundReceiptClaimCore & FeishuInboundReceiptClaimDetails;

export type FeishuInboundReceiptInput = {
  bindingId: string;
  credentialGeneration: number;
  eventId: string;
};

export class FeishuInboundReceiptStore {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onMetric: (metric: FeishuInboundReceiptMetric) => void;

  constructor(
    database: DatabaseClient,
    options: { now?: () => Date; onMetric?: (metric: FeishuInboundReceiptMetric) => void } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onMetric = options.onMetric ?? (() => undefined);
  }

  async claim(input: FeishuInboundReceiptInput): Promise<FeishuInboundReceiptClaim> {
    if (!isValidEventId(input.eventId)) throw new FeishuInboundReceiptError("FEISHU_RECEIPT_EVENT_ID_INVALID");
    if (!Number.isSafeInteger(input.credentialGeneration) || input.credentialGeneration < 1) {
      throw new FeishuInboundReceiptError("FEISHU_RECEIPT_GENERATION_INVALID");
    }
    return this.#database.transaction(async (transaction) => {
      const [created] = await transaction
        .insert(feishuInboundReceipts)
        .values({
          imBindingId: input.bindingId,
          credentialGeneration: input.credentialGeneration,
          eventId: input.eventId,
          status: "processing",
          receivedAt: this.#now(),
          attemptCount: 1,
        })
        .onConflictDoNothing({
          target: [feishuInboundReceipts.imBindingId, feishuInboundReceipts.eventId],
        })
        .returning({ id: feishuInboundReceipts.id, status: feishuInboundReceipts.status });
      if (created) {
        this.#onMetric({ type: "receipt", bindingId: input.bindingId, eventId: input.eventId, status: "processing" });
        return { accepted: true, duplicate: false, receiptId: created.id, status: created.status };
      }

      const [existing] = await transaction
        .select({ id: feishuInboundReceipts.id, status: feishuInboundReceipts.status })
        .from(feishuInboundReceipts)
        .where(
          and(eq(feishuInboundReceipts.imBindingId, input.bindingId), eq(feishuInboundReceipts.eventId, input.eventId)),
        )
        .limit(1);
      this.#onMetric({
        type: "duplicate",
        bindingId: input.bindingId,
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
      .update(feishuInboundReceipts)
      .set({ status: "processed", processedAt: this.#now(), lastErrorCode: null, lastErrorAt: null })
      .where(eq(feishuInboundReceipts.id, receiptId))
      .returning({
        id: feishuInboundReceipts.id,
        bindingId: feishuInboundReceipts.imBindingId,
        eventId: feishuInboundReceipts.eventId,
      });
    if (updated)
      this.#onMetric({ type: "receipt", bindingId: updated.bindingId, eventId: updated.eventId, status: "processed" });
  }

  async markFailed(receiptId: string, errorCode: string): Promise<void> {
    const safeCode = sanitizeErrorCode(errorCode);
    const [updated] = await this.#database
      .update(feishuInboundReceipts)
      .set({ status: "failed", lastErrorCode: safeCode, lastErrorAt: this.#now() })
      .where(eq(feishuInboundReceipts.id, receiptId))
      .returning({
        id: feishuInboundReceipts.id,
        bindingId: feishuInboundReceipts.imBindingId,
        eventId: feishuInboundReceipts.eventId,
      });
    if (updated) {
      this.#onMetric({
        type: "receipt",
        bindingId: updated.bindingId,
        eventId: updated.eventId,
        status: "failed",
        errorCode: safeCode,
      });
    }
  }
}

function isValidEventId(eventId: string): boolean {
  return (
    eventId.length >= 1 &&
    eventId.length <= 512 &&
    [...eventId].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x21 && code <= 0x7e;
    })
  );
}

function sanitizeErrorCode(errorCode: string): string {
  return errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "FEISHU_EVENT_PROCESSING_FAILED";
}
