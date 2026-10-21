import { randomUUID } from "node:crypto";
import { type StructuredError, StructuredErrorSchema } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../../db/client.js";
import { slackWebhookReceipts } from "../../../db/schema/index.js";
import type { PolicyErrorCategory, PolicyPhase, PolicyRetryability } from "../../im/external-call-policy.js";
import { InboundReceiptWorkStore } from "../../im/inbound-receipt-work-store.js";
import {
  INBOUND_WORK_LEASE_MS,
  type InboundWork,
  InboundWorkSchema,
  inboundWorkRetryDelay,
} from "../../im/inbound-work.js";

export class SlackWebhookReceiptError extends Error {
  declare readonly code: string;
  declare readonly category: PolicyErrorCategory;
  declare readonly retryability: PolicyRetryability;
  declare readonly phase: PolicyPhase;
  declare readonly requestId: string;
  readonly structuredError: StructuredError;

  constructor(code: string, requestId: string = randomUUID()) {
    super(code);
    this.name = "SlackWebhookReceiptError";
    this.code = code;
    this.category = "validation";
    this.retryability = "not_retryable";
    this.phase = "request";
    this.requestId = requestId;
    this.structuredError = StructuredErrorSchema.parse({
      code: this.code,
      category: "validation",
      retryability: "never",
      phase: "request",
      requestId: this.requestId,
      message: this.message,
    });
  }

  toStructuredError(): StructuredError {
    return this.structuredError;
  }
}

type SlackWebhookReceiptMetricCore = { type: "receipt" | "duplicate"; installationId: string; eventId: string };
type SlackWebhookReceiptMetricDetails = { status?: "processing" | "processed" | "failed"; errorCode?: string };
export type SlackWebhookReceiptMetric = SlackWebhookReceiptMetricCore & SlackWebhookReceiptMetricDetails;

type SlackWebhookReceiptClaimCore = { accepted: boolean; duplicate: boolean };
type SlackWebhookReceiptClaimDetails = {
  receiptId?: string;
  attempt?: number;
  receivedAt?: Date;
  status?: "processing" | "processed" | "failed";
};
export type SlackWebhookReceiptClaim = SlackWebhookReceiptClaimCore & SlackWebhookReceiptClaimDetails;

type SlackWebhookReceiptInput = {
  installationId: string;
  credentialGeneration: number;
  eventId: string;
  work?: InboundWork;
};

export class SlackWebhookReceiptStore {
  readonly recovery: InboundReceiptWorkStore;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onMetric: (metric: SlackWebhookReceiptMetric) => void;

  constructor(
    database: DatabaseClient,
    options: { now?: () => Date; onMetric?: (metric: SlackWebhookReceiptMetric) => void } = {},
  ) {
    this.recovery = new InboundReceiptWorkStore(database, "slack", options.now ?? (() => new Date()));
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
    const work = input.work === undefined ? undefined : InboundWorkSchema.parse(input.work);
    if (work && work.provider !== "slack") throw new Error("IM_INBOUND_WORK_PROVIDER_MISMATCH");
    return this.#database.transaction(async (transaction) => {
      const receivedAt = this.#now();
      const leaseExpiresAt = work ? new Date(receivedAt.getTime() + INBOUND_WORK_LEASE_MS) : null;
      const [created] = await transaction
        .insert(slackWebhookReceipts)
        .values({
          installationId: input.installationId,
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
          target: [
            slackWebhookReceipts.installationId,
            slackWebhookReceipts.credentialGeneration,
            slackWebhookReceipts.eventId,
          ],
        })
        .returning({
          id: slackWebhookReceipts.id,
          status: slackWebhookReceipts.status,
          attempt: slackWebhookReceipts.attemptCount,
          receivedAt: slackWebhookReceipts.receivedAt,
        });
      if (created) {
        this.#onMetric({
          type: "receipt",
          installationId: input.installationId,
          eventId: input.eventId,
          status: "processing",
        });
        return {
          accepted: true,
          duplicate: false,
          receiptId: created.id,
          status: created.status,
          ...(work ? { attempt: created.attempt, receivedAt: created.receivedAt } : {}),
        };
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

  async markProcessed(receiptId: string, attempt?: number): Promise<void> {
    const [updated] = await this.#database
      .update(slackWebhookReceipts)
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
          eq(slackWebhookReceipts.id, receiptId),
          attempt === undefined
            ? and(isNull(slackWebhookReceipts.workPayload), eq(slackWebhookReceipts.attemptCount, 1))
            : and(eq(slackWebhookReceipts.attemptCount, attempt), eq(slackWebhookReceipts.status, "processing")),
        ),
      )
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

  async markFailed(receiptId: string, errorCode: string, attempt?: number, retry = true): Promise<void> {
    const safeCode = errorCode.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 120) || "SLACK_EVENT_PROCESSING_FAILED";
    const [updated] = await this.#database
      .update(slackWebhookReceipts)
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
          eq(slackWebhookReceipts.id, receiptId),
          attempt === undefined
            ? and(isNull(slackWebhookReceipts.workPayload), eq(slackWebhookReceipts.attemptCount, 1))
            : and(eq(slackWebhookReceipts.attemptCount, attempt), eq(slackWebhookReceipts.status, "processing")),
        ),
      )
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
