import { randomUUID } from "node:crypto";
import type { RuntimeCredentialProvider } from "@opentag/shared";
import { RuntimeProxyError } from "./provider-proxy-support.js";
import { type RuntimeWriteJournal, RuntimeWriteJournalUnavailableError } from "./write-journal.js";

export type WriteReceiptState = "succeeded" | "rejected" | "unknown";

/** Durable write receipt: a controlled bounded code plus the classification state. */
export interface WriteReceipt {
  /** Controlled bounded journal result code; never provider free text. */
  readonly code: string;
  readonly state: WriteReceiptState;
}

/** Mutable per-write context so error cleanup can never overwrite an already attempted outcome. */
export interface WriteReceiptContext {
  completionAttempted: boolean;
  readonly intentHash: string;
  readonly operationId: string;
}

const SLACK_ERROR_CODE = /^[a-z0-9_]{1,64}$/;
const SUCCESS_UNCONFIRMED_CODE = "provider_outcome_unconfirmed";
const TRANSPORT_UNKNOWN_CODE = "proxy_error";

export interface BeginWriteReceiptInput {
  executionId: string;
  now: () => Date;
  operation: string;
  policyRevision: string;
  provider: RuntimeCredentialProvider;
  requestHash: string;
  resource: string;
  sessionId: string;
}

/**
 * Starts one durable write intent before any upstream byte. A conflict with an unresolved
 * same-resource write (or an unavailable journal) fails before the provider is touched.
 */
export async function beginWriteReceipt(
  journal: RuntimeWriteJournal,
  input: BeginWriteReceiptInput,
): Promise<WriteReceiptContext> {
  const operationId = randomUUID();
  try {
    const receipt = await journal.beginWrite({
      sessionId: input.sessionId,
      operationId,
      executionId: input.executionId,
      provider: input.provider,
      resource: input.resource,
      operation: input.operation,
      requestHash: input.requestHash,
      policyRevision: input.policyRevision,
      createdAt: input.now().toISOString(),
    });
    return { completionAttempted: false, intentHash: receipt.intentHash, operationId };
  } catch (error) {
    if (error instanceof RuntimeWriteJournalUnavailableError) {
      throw new RuntimeProxyError("write_journal_unavailable");
    }
    throw error;
  }
}

/**
 * Completes the receipt exactly once per write context. A failed durable completion surfaces
 * `write_outcome_unknown` and is never retried, so cleanup cannot overwrite a stored outcome.
 */
export async function completeWriteReceipt(
  journal: RuntimeWriteJournal,
  sessionId: string,
  context: WriteReceiptContext,
  receipt: WriteReceipt,
  now: () => Date,
): Promise<void> {
  if (context.completionAttempted) return;
  context.completionAttempted = true;
  try {
    await journal.completeWrite(sessionId, {
      operationId: context.operationId,
      intentHash: context.intentHash,
      state: receipt.state,
      resultCode: receipt.code,
      completedAt: now().toISOString(),
    });
  } catch {
    throw new RuntimeProxyError("write_outcome_unknown");
  }
}

/** Best-effort cleanup receipt for a write with no durable outcome yet; never throws twice. */
export async function completeWriteReceiptUnknown(
  journal: RuntimeWriteJournal,
  sessionId: string,
  context: WriteReceiptContext,
  now: () => Date,
): Promise<void> {
  await completeWriteReceipt(
    journal,
    sessionId,
    context,
    { state: "unknown", code: TRANSPORT_UNKNOWN_CODE },
    now,
  ).catch(() => undefined);
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return payload as Record<string, unknown>;
}

function hasProviderSuccessShape(provider: RuntimeCredentialProvider, payload: unknown): boolean {
  const record = payloadRecord(payload);
  if (!record) return false;
  if (provider === "slack") return record.ok === true;
  if (provider === "feishu") return record.code === 0;
  return false;
}

function providerRejectionCode(provider: RuntimeCredentialProvider, payload: unknown): string | undefined {
  const record = payloadRecord(payload);
  if (!record) return undefined;
  if (provider === "slack") {
    if (record.ok !== false) return undefined;
    return typeof record.error === "string" && SLACK_ERROR_CODE.test(record.error) ? record.error : "provider_rejected";
  }
  if (provider === "feishu") {
    if (typeof record.code === "number" && Number.isSafeInteger(record.code) && record.code !== 0) {
      return `feishu_${record.code}`;
    }
  }
  return undefined;
}

function isDefiniteRejectionStatus(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

/** 5xx/408 outcomes are ambiguous even when the body looks like a provider error. */
function isAmbiguousStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

/**
 * Write receipt classification for a parsed JSON response. Success requires HTTP 2xx AND the
 * provider's explicit success shape (`ok === true` / `code === 0`); explicit provider errors and
 * definite 4xx (except 408) are rejections; 5xx, 408, and 2xx without success evidence stay
 * unknown, so they can never appear as a successful write or be automatically replayed.
 */
export function classifyWriteReceipt(input: {
  payload: unknown;
  provider: RuntimeCredentialProvider;
  status: number;
}): WriteReceipt {
  const { payload, provider, status } = input;
  if (status >= 200 && status < 300 && hasProviderSuccessShape(provider, payload)) {
    return { state: "succeeded", code: `http_${status}` };
  }
  if (!isAmbiguousStatus(status)) {
    const rejection = providerRejectionCode(provider, payload);
    if (rejection) return { state: "rejected", code: rejection };
    if (isDefiniteRejectionStatus(status)) return { state: "rejected", code: `http_${status}` };
  }
  if (status >= 200 && status < 300) return { state: "unknown", code: SUCCESS_UNCONFIRMED_CODE };
  return { state: "unknown", code: `http_${status}` };
}

/** Status-only receipt for responses whose body must remain an unread stream (upload bytes). */
export function classifyStatusWriteReceipt(status: number): WriteReceipt {
  if (status >= 200 && status < 300) return { state: "succeeded", code: `http_${status}` };
  if (isDefiniteRejectionStatus(status)) return { state: "rejected", code: `http_${status}` };
  return { state: "unknown", code: `http_${status}` };
}
