import { randomUUID } from "node:crypto";
import { type StructuredError, StructuredErrorSchema } from "@opentag/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../../db/client.js";
import { feishuInboundReceipts, imBindings } from "../../../db/schema/index.js";
import { InboundReceiptWorkStore } from "../../im/inbound-receipt-work-store.js";
import {
  INBOUND_WORK_LEASE_MS,
  type InboundWork,
  InboundWorkSchema,
  inboundWorkRetryDelay,
} from "../../im/inbound-work.js";

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
  attempt?: number;
  receivedAt?: Date;
  status?: "processing" | "processed" | "failed";
};
export type FeishuInboundReceiptClaim = FeishuInboundReceiptClaimCore & FeishuInboundReceiptClaimDetails;

export type FeishuInboundReceiptInput = {
  bindingId: string;
  credentialGeneration: number;
  eventId: string;
  work?: InboundWork;
  fence?: { holderInstanceId: string; fencingEpoch: number };
};

export class FeishuInboundReceiptStore {
  readonly recovery: InboundReceiptWorkStore;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onMetric: (metric: FeishuInboundReceiptMetric) => void;

  constructor(
    database: DatabaseClient,
    options: { now?: () => Date; onMetric?: (metric: FeishuInboundReceiptMetric) => void } = {},
  ) {
    this.recovery = new InboundReceiptWorkStore(database, "feishu", options.now ?? (() => new Date()));
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onMetric = options.onMetric ?? (() => undefined);
  }

  async claim(input: FeishuInboundReceiptInput): Promise<FeishuInboundReceiptClaim> {
    if (!isValidEventId(input.eventId)) throw new FeishuInboundReceiptError("FEISHU_RECEIPT_EVENT_ID_INVALID");
    if (!Number.isSafeInteger(input.credentialGeneration) || input.credentialGeneration < 1) {
      throw new FeishuInboundReceiptError("FEISHU_RECEIPT_GENERATION_INVALID");
    }
    const work = input.work === undefined ? undefined : InboundWorkSchema.parse(input.work);
    if (work && work.provider !== "feishu") throw new Error("IM_INBOUND_WORK_PROVIDER_MISMATCH");
    return this.#database.transaction(async (transaction) => {
      const receivedAt = this.#now();
      await this.#assertWorkFence(transaction, input, work, receivedAt);
      const leaseExpiresAt = work ? new Date(receivedAt.getTime() + INBOUND_WORK_LEASE_MS) : null;
      const [created] = await transaction
        .insert(feishuInboundReceipts)
        .values({
          imBindingId: input.bindingId,
          credentialGeneration: input.credentialGeneration,
          eventId: input.eventId,
          status: "processing",
          receivedAt,
          workPayload: work ?? null,
          leaseExpiresAt,
          nextAttemptAt: leaseExpiresAt,
          attemptCount: 1,
        })
        .onConflictDoNothing({
          target: [feishuInboundReceipts.imBindingId, feishuInboundReceipts.eventId],
        })
        .returning({
          id: feishuInboundReceipts.id,
          status: feishuInboundReceipts.status,
          attempt: feishuInboundReceipts.attemptCount,
          receivedAt: feishuInboundReceipts.receivedAt,
        });
      if (created) {
        this.#onMetric({ type: "receipt", bindingId: input.bindingId, eventId: input.eventId, status: "processing" });
        return {
          accepted: true,
          duplicate: false,
          receiptId: created.id,
          status: created.status,
          ...(work ? { attempt: created.attempt, receivedAt: created.receivedAt } : {}),
        };
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

  async #assertWorkFence(
    transaction: DatabaseTransaction,
    input: FeishuInboundReceiptInput,
    work: InboundWork | undefined,
    receivedAt: Date,
  ): Promise<void> {
    if (work?.provider === "feishu") {
      const fence = input.fence;
      if (!fence) throw new FeishuInboundReceiptError("FEISHU_INBOUND_FENCE_STALE");
      const [binding] = await transaction
        .select({ id: imBindings.id })
        .from(imBindings)
        .where(
          and(
            eq(imBindings.id, input.bindingId),
            eq(imBindings.provider, "feishu"),
            eq(imBindings.status, "active"),
            eq(imBindings.credentialGeneration, input.credentialGeneration),
            eq(imBindings.externalAppId, work.event.externalAppId),
            eq(imBindings.connectionOwnerInstanceId, fence.holderInstanceId),
            eq(imBindings.connectionFencingEpoch, fence.fencingEpoch),
            gt(imBindings.connectionLeaseExpiresAt, receivedAt),
          ),
        )
        .limit(1);
      if (!binding) throw new FeishuInboundReceiptError("FEISHU_INBOUND_FENCE_STALE");
    }
  }

  async markProcessed(receiptId: string, attempt?: number): Promise<void> {
    const [updated] = await this.#database
      .update(feishuInboundReceipts)
      .set({
        status: "processed",
        processedAt: this.#now(),
        lastErrorCode: null,
        lastErrorAt: null,
        workPayload: null,
        leaseExpiresAt: null,
        nextAttemptAt: null,
      })
      .where(
        and(
          eq(feishuInboundReceipts.id, receiptId),
          attempt === undefined
            ? and(isNull(feishuInboundReceipts.workPayload), eq(feishuInboundReceipts.attemptCount, 1))
            : and(eq(feishuInboundReceipts.attemptCount, attempt), eq(feishuInboundReceipts.status, "processing")),
        ),
      )
      .returning({
        id: feishuInboundReceipts.id,
        bindingId: feishuInboundReceipts.imBindingId,
        eventId: feishuInboundReceipts.eventId,
      });
    if (updated)
      this.#onMetric({ type: "receipt", bindingId: updated.bindingId, eventId: updated.eventId, status: "processed" });
  }

  async markFailed(receiptId: string, errorCode: string, attempt?: number, retry = true): Promise<void> {
    const safeCode = sanitizeErrorCode(errorCode);
    const [updated] = await this.#database
      .update(feishuInboundReceipts)
      .set({
        status: "failed",
        lastErrorCode: safeCode,
        lastErrorAt: this.#now(),
        leaseExpiresAt: null,
        nextAttemptAt:
          attempt === undefined || !retry ? null : new Date(this.#now().getTime() + inboundWorkRetryDelay(attempt)),
        ...(retry ? {} : { workPayload: null }),
      })
      .where(
        and(
          eq(feishuInboundReceipts.id, receiptId),
          attempt === undefined
            ? and(isNull(feishuInboundReceipts.workPayload), eq(feishuInboundReceipts.attemptCount, 1))
            : and(eq(feishuInboundReceipts.attemptCount, attempt), eq(feishuInboundReceipts.status, "processing")),
        ),
      )
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
