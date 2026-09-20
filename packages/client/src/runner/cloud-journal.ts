import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type RuntimeImOutboxContext,
  RuntimeImOutboxContextSchema,
  type SessionMessageDeliveryRequest,
  SessionMessageDeliveryRequestSchema,
  type TurnReportRequest,
  TurnReportRequestSchema,
} from "@opentag/shared";
import { z } from "zod";

/**
 * Trusted-parent durable journal for Cloud deliveries and Session collaboration messages. Lives in
 * the Runner's own state directory — never inside the Session workspace, the Sandbox mounts, or any
 * user-readable location. Every mutation is write-temp + fsync + rename + directory fsync BEFORE
 * the corresponding channel acknowledgement, so a Runner crash never loses the boundary between
 * "received, not started", "started, outcome unknown", and "reported, awaiting ack".
 *
 * One file per entry, keyed by `deliveryId` for IM deliveries and by `messageId` for Session
 * messages. Both kinds share the phase machine (no backward transitions, no blind replays):
 *   received  — input durably journaled; receipt (re)sent on reconnect; execution NEVER started
 *   started   — Server verification arrived and execution began; a crash from here reports the
 *               terminal outcome "unknown" and NEVER re-executes
 *   reported  — immutable Terminal result journaled; a delivery report or Session settlement is
 *               re-sent until the Server's exact durable ack retires the entry
 *
 * A `received` entry may settle directly into a terminal `reported` not-started failure (missing
 * model grant, expired deadline, explicit cancel before start); it may never transition to
 * `started` afterwards, and a `received` entry can never report `completed`.
 */

export const CLOUD_JOURNAL_VERSION = 2;
export const CLOUD_JOURNAL_PHASES = ["received", "started", "reported"] as const;
/** Hard cap per entry: the dispatch/session frame budget plus scope/hash overhead. Oversize fails loudly. */
export const CLOUD_JOURNAL_ENTRY_MAX_BYTES = 320 * 1024;
/** Hard cap on entries scanned per operation; bounds reconnect reconciliation work. */
export const CLOUD_JOURNAL_MAX_ENTRIES = 1024;

/** Exact allocation identity that owns a journaled entry. */
export const CloudJournalScopeSchema = z
  .object({
    sandboxId: z.string().min(1).max(256),
    sessionId: z.string().min(1).max(256),
    environmentGeneration: z.number().int().nonnegative(),
    resourceName: z.string().min(1).max(1024),
    resourceUid: z.string().min(1).max(128),
  })
  .strict();
export type CloudJournalScope = z.infer<typeof CloudJournalScopeSchema>;

export const CloudJournalSettlementOutcomeSchema = z.enum(["completed", "failed", "cancelled", "unknown"]);
export type CloudJournalSettlementOutcome = z.infer<typeof CloudJournalSettlementOutcomeSchema>;

/** Terminal Session settlement; immutable once journaled and replayed until the Server acks it. */
const CloudJournalSettlementSchema = z.object({ outcome: CloudJournalSettlementOutcomeSchema }).strict();

const CloudJournalDeliveryEntrySchema = z
  .object({
    version: z.literal(CLOUD_JOURNAL_VERSION),
    /** Missing on E7 v2 files, which predate Session entries. */
    kind: z.literal("delivery").default("delivery"),
    delivery: DirectImMessageDeliveryRequestSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: CloudJournalScopeSchema,
    deliveryId: z.string().min(1).max(256),
    requestId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    phase: z.enum(CLOUD_JOURNAL_PHASES),
    report: TurnReportRequestSchema.optional(),
  })
  .strict();

const CloudJournalSessionEntrySchema = z
  .object({
    version: z.literal(CLOUD_JOURNAL_VERSION),
    kind: z.literal("session-message"),
    message: SessionMessageDeliveryRequestSchema,
    sessionKind: z.enum(["internal", "visible"]),
    outboxContext: RuntimeImOutboxContextSchema.optional(),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    scope: CloudJournalScopeSchema,
    messageId: z.string().uuid(),
    requestId: z.string().min(1).max(256),
    turnId: z.string().min(1).max(256),
    phase: z.enum(CLOUD_JOURNAL_PHASES),
    settlement: CloudJournalSettlementSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sessionKind === "visible" && value.outboxContext === undefined) {
      context.addIssue({
        code: "custom",
        path: ["outboxContext"],
        message: "A visible Session entry requires its outbox context",
      });
    }
    if (value.sessionKind === "internal" && value.outboxContext !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["outboxContext"],
        message: "An internal Session entry forbids IM outbox context",
      });
    }
    if (value.phase === "reported" && value.settlement === undefined) {
      context.addIssue({
        code: "custom",
        path: ["settlement"],
        message: "A reported Session entry requires a settlement",
      });
    }
    if (value.phase !== "reported" && value.settlement !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["settlement"],
        message: "Only a reported Session entry may carry a settlement",
      });
    }
  });

export type CloudJournalPhase = (typeof CLOUD_JOURNAL_PHASES)[number];

export interface CloudJournalDeliveryEntry {
  readonly kind: "delivery";
  /** The exact dispatched delivery payload; needed to rebuild reports after a crash. */
  readonly delivery: DirectImMessageDeliveryRequest;
  /** sha256 over the canonical dispatch payload; detects same-id/different-input replays. */
  readonly inputHash: string;
  /** The exact allocation that owned this delivery when it was received. */
  readonly scope: CloudJournalScope;
  readonly deliveryId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly phase: CloudJournalPhase;
  readonly report?: TurnReportRequest;
}

export interface CloudJournalSessionEntry {
  readonly kind: "session-message";
  /** The exact Session message the Server dispatched and this Runner journaled. */
  readonly message: SessionMessageDeliveryRequest;
  /** The target Session's actual role, carried from the dispatched run frame. */
  readonly sessionKind: "internal" | "visible";
  /** Nonsecret outbox context, present exactly for a visible target. */
  readonly outboxContext?: RuntimeImOutboxContext;
  /** sha256 over the canonical run-frame payload; detects same-id/different-input replays. */
  readonly inputHash: string;
  readonly scope: CloudJournalScope;
  readonly messageId: string;
  readonly requestId: string;
  readonly turnId: string;
  readonly phase: CloudJournalPhase;
  /** Present exactly in phase `reported`; never rewritten with a different outcome. */
  readonly settlement?: { readonly outcome: CloudJournalSettlementOutcome };
}

export type CloudJournalEntry = CloudJournalDeliveryEntry | CloudJournalSessionEntry;

export interface CloudJournalDurableAck {
  readonly turnId: string;
  readonly resultHash: string;
  readonly status: "recorded" | "already_recorded";
}

export interface CloudJournalSettlementAck {
  readonly turnId: string;
  readonly status: "recorded" | "already_recorded";
}

const ENTRY_NAME = /^[a-zA-Z0-9-]{1,256}\.json$/;

export class CloudJournalError extends Error {
  constructor(
    readonly code:
      | "conflict"
      | "unknown_entry"
      | "invalid_transition"
      | "store_failed"
      | "scope_mismatch"
      | "scope_unbound"
      | "ack_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "CloudJournalError";
  }
}

/** Canonical (key-sorted) JSON so the same logical payload always hashes identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

/** Stable identity of one IM dispatch payload. */
export function computeCloudDeliveryInputHash(delivery: DirectImMessageDeliveryRequest): string {
  return createHash("sha256").update(canonicalJson(delivery)).digest("hex");
}

/** Stable identity of one Session run-frame payload (message plus its target envelope). */
export function computeCloudSessionInputHash(input: {
  message: SessionMessageDeliveryRequest;
  sessionKind: "internal" | "visible";
  outboxContext?: RuntimeImOutboxContext;
}): string {
  // The request id is the per-attempt correlation identity, not input: a retry of the same
  // logical message under a fresh request id must still match the journaled entry's input.
  const { requestId: _requestId, ...message } = input.message;
  return createHash("sha256")
    .update(
      canonicalJson({
        message,
        sessionKind: input.sessionKind,
        outboxContext: input.outboxContext ?? null,
      }),
    )
    .digest("hex");
}

/** The durable file key of one entry: the delivery id or the Session message id. */
export function cloudJournalEntryKey(entry: CloudJournalEntry): string {
  return entry.kind === "delivery" ? entry.deliveryId : entry.messageId;
}

/** Fail visibly when a durable entry belongs to another allocation. */
export function assertCloudJournalScope(entry: CloudJournalEntry, scope: CloudJournalScope): void {
  const same = CloudJournalScopeSchema.safeParse(entry.scope);
  if (!same.success) {
    throw new CloudJournalError(
      "store_failed",
      `Journal entry ${cloudJournalEntryKey(entry)} has an unreadable allocation scope`,
    );
  }
  const fields = ["sandboxId", "sessionId", "environmentGeneration", "resourceName", "resourceUid"] as const;
  for (const field of fields) {
    if (entry.scope[field] !== scope[field]) {
      throw new CloudJournalError(
        "scope_mismatch",
        `Journal entry ${cloudJournalEntryKey(entry)} belongs to allocation ${entry.scope.sandboxId}/${entry.scope.environmentGeneration} (${entry.scope.resourceUid}), not the current one`,
      );
    }
  }
}

/** One bounded Session-message record request; the message id is the durable entry key. */
export interface CloudJournalSessionRecordInput {
  readonly message: SessionMessageDeliveryRequest;
  readonly sessionKind: "internal" | "visible";
  readonly outboxContext?: RuntimeImOutboxContext;
  readonly scope: CloudJournalScope;
  readonly requestId: string;
  readonly turnId: string;
}

/** The internal/visible outbox contract is enforced before anything is written. */
function assertSessionEnvelope(
  sessionKind: "internal" | "visible",
  outboxContext: RuntimeImOutboxContext | undefined,
): void {
  if (sessionKind === "visible" && outboxContext === undefined) {
    throw new CloudJournalError("conflict", "A visible Session message requires its outbox context");
  }
  if (sessionKind === "internal" && outboxContext !== undefined) {
    throw new CloudJournalError("conflict", "An internal Session message forbids IM outbox context");
  }
}

export class CloudJournal {
  readonly #directory: string;
  /** Serializes every mutation so concurrent frames cannot interleave read-modify-write. */
  #mutations: Promise<unknown> = Promise.resolve();

  private constructor(directory: string) {
    this.#directory = directory;
  }

  get directory(): string {
    return this.#directory;
  }

  /** Open (and create) the journal directory with owner-only permissions. */
  static async open(directory: string): Promise<CloudJournal> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new CloudJournal(directory);
  }

  /** Every entry, for reconnect reconciliation. Corrupt files fail loudly, never silently skipped. */
  async list(): Promise<CloudJournalEntry[]> {
    const entryNames = await this.#entryNames();
    if (entryNames.length > CLOUD_JOURNAL_MAX_ENTRIES) {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal holds more than ${CLOUD_JOURNAL_MAX_ENTRIES} entries`,
      );
    }
    const entries: CloudJournalEntry[] = [];
    for (const name of entryNames) {
      entries.push(await this.#readFile(name));
    }
    return entries;
  }

  /**
   * E7 rebind cleanup: remove every entry that belongs to exactly the seal-complete assignment.
   * Any entry from another allocation fails closed instead of being silently discarded, so a
   * broken rebind can never erase durable work that was not proven settled.
   */
  async resetScope(scope: CloudJournalScope): Promise<void> {
    return this.#mutate(async () => {
      const entries = await this.list();
      for (const entry of entries) {
        try {
          assertCloudJournalScope(entry, scope);
        } catch {
          throw new CloudJournalError(
            "scope_mismatch",
            `The Cloud delivery journal holds ${cloudJournalEntryKey(entry)} outside the sealed assignment; refusing to discard`,
          );
        }
      }
      for (const entry of entries) await this.#remove(cloudJournalEntryKey(entry));
    });
  }

  /* ------------------------------------------------------------------------------------------
   * IM deliveries (E4/E7 API preserved)
   * ---------------------------------------------------------------------------------------- */

  /**
   * Durable receipt: fsync BEFORE the receipt frame is sent. Recording the same dispatch twice
   * (idempotent retransmission) keeps the original turn id; a different request id, a different
   * input payload, or a different allocation for the same delivery is a visible conflict and must
   * never be silently merged or re-run.
   */
  async recordReceived(input: {
    delivery: DirectImMessageDeliveryRequest;
    scope: CloudJournalScope;
    deliveryId: string;
    requestId: string;
    turnId: string;
  }): Promise<CloudJournalDeliveryEntry> {
    return this.#mutate(async () => {
      const scope = CloudJournalScopeSchema.parse(input.scope);
      const inputHash = computeCloudDeliveryInputHash(input.delivery);
      const existing = await this.#readEntry(input.deliveryId);
      if (existing) {
        if (existing.kind !== "delivery") {
          throw new CloudJournalError("conflict", `Journal entry ${input.deliveryId} is not an IM delivery`);
        }
        assertCloudJournalScope(existing, scope);
        if (existing.requestId !== input.requestId) {
          throw new CloudJournalError(
            "conflict",
            `Journal entry for delivery ${input.deliveryId} belongs to a different dispatch`,
          );
        }
        if (existing.inputHash !== inputHash) {
          throw new CloudJournalError(
            "conflict",
            `Journal entry for delivery ${input.deliveryId} was already received with different input`,
          );
        }
        return existing;
      }
      await this.#assertCapacity();
      const entry: CloudJournalDeliveryEntry = {
        kind: "delivery",
        delivery: input.delivery,
        inputHash,
        scope,
        deliveryId: input.deliveryId,
        requestId: input.requestId,
        turnId: input.turnId,
        phase: "received",
      };
      await this.#write(input.deliveryId, entry);
      return entry;
    });
  }

  /** received -> started, fsynced BEFORE the native worker launches. */
  async markStarted(deliveryId: string, scope: CloudJournalScope): Promise<CloudJournalDeliveryEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedDeliveryEntry(deliveryId, scope);
      if (entry.phase === "received") return this.#transitionDelivery(entry, "started");
      if (entry.phase === "started") return entry;
      throw new CloudJournalError(
        "invalid_transition",
        `Delivery ${deliveryId} cannot start from phase ${entry.phase}`,
      );
    });
  }

  /**
   * started -> reported with the exact Turn Report, fsynced BEFORE the report frame is sent.
   * received -> reported is admitted ONLY for a terminal `not_started` failure that proves no
   * native/Pi/tool work happened (missing/expired model grant, expired deadline, cancel).
   */
  async recordReport(
    deliveryId: string,
    scope: CloudJournalScope,
    report: TurnReportRequest,
  ): Promise<CloudJournalDeliveryEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedDeliveryEntry(deliveryId, scope);
      if (entry.phase === "reported") {
        if (entry.report?.resultHash !== report.resultHash) {
          throw new CloudJournalError("conflict", `Delivery ${deliveryId} already has a different journaled report`);
        }
        return entry;
      }
      if (entry.phase === "received" && report.executionEffects !== "not_started") {
        throw new CloudJournalError(
          "invalid_transition",
          `Delivery ${deliveryId} cannot report effects "${report.executionEffects}" from phase received`,
        );
      }
      return this.#transitionDelivery(entry, "reported", report);
    });
  }

  /**
   * The Server explicitly refused custody before any start (stale scope/generation). Only a
   * `received` entry may retire this way; a started/reported entry represents real durable state.
   */
  async clearRejected(deliveryId: string, scope: CloudJournalScope): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedDeliveryEntry(deliveryId, scope);
      if (entry.phase !== "received") {
        throw new CloudJournalError(
          "invalid_transition",
          `Delivery ${deliveryId} cannot be retired as rejected from phase ${entry.phase}`,
        );
      }
      await this.#remove(deliveryId);
    });
  }

  /**
   * The Server durably acknowledged THIS exact report: only a matching turn id, result hash, and
   * recorded/already_recorded status retires the entry. Conflicts and stale-generation acks leave
   * the durable report in place for reconciliation.
   */
  async clearAcknowledged(deliveryId: string, scope: CloudJournalScope, ack: CloudJournalDurableAck): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedDeliveryEntry(deliveryId, scope);
      if (entry.phase !== "reported" || !entry.report) {
        throw new CloudJournalError(
          "invalid_transition",
          `Delivery ${deliveryId} has no durable report to acknowledge (phase ${entry.phase})`,
        );
      }
      if (
        entry.turnId !== ack.turnId ||
        entry.report.resultHash !== ack.resultHash ||
        (ack.status !== "recorded" && ack.status !== "already_recorded")
      ) {
        throw new CloudJournalError("ack_mismatch", `The acknowledgement does not match the journaled report`);
      }
      await this.#remove(deliveryId);
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Session messages (E8)
   * ---------------------------------------------------------------------------------------- */

  /** Journal one authorized Session message (fsync) BEFORE its receipt frame. */
  async recordSessionReceived(input: CloudJournalSessionRecordInput): Promise<CloudJournalSessionEntry> {
    return this.#mutate(async () => {
      const scope = CloudJournalScopeSchema.parse(input.scope);
      assertSessionEnvelope(input.sessionKind, input.outboxContext);
      const messageId = input.message.messageId;
      const inputHash = computeCloudSessionInputHash({
        message: input.message,
        sessionKind: input.sessionKind,
        ...(input.outboxContext ? { outboxContext: input.outboxContext } : {}),
      });
      const existing = await this.#readEntry(messageId);
      if (existing) return this.#reuseSessionEntry(existing, input, inputHash, scope);
      await this.#assertCapacity();
      const entry: CloudJournalSessionEntry = {
        kind: "session-message",
        message: input.message,
        inputHash,
        scope,
        messageId,
        requestId: input.requestId,
        turnId: input.turnId,
        phase: "received",
        sessionKind: input.sessionKind,
        ...(input.outboxContext ? { outboxContext: input.outboxContext } : {}),
      };
      await this.#write(messageId, entry);
      return entry;
    });
  }

  /**
   * Reuse one already-journaled Session dispatch: same request identity and input under the same
   * allocation. Any difference is a visible conflict, never a second execution.
   */
  #reuseSessionEntry(
    existing: CloudJournalEntry,
    input: CloudJournalSessionRecordInput,
    inputHash: string,
    scope: CloudJournalScope,
  ): CloudJournalSessionEntry {
    const messageId = input.message.messageId;
    if (existing.kind !== "session-message") {
      throw new CloudJournalError("conflict", `Journal entry ${messageId} is not a Session message`);
    }
    assertCloudJournalScope(existing, scope);
    if (existing.requestId !== input.requestId) {
      throw new CloudJournalError(
        "conflict",
        `Journal entry for Session message ${messageId} belongs to a different dispatch`,
      );
    }
    if (existing.inputHash !== inputHash) {
      throw new CloudJournalError(
        "conflict",
        `Journal entry for Session message ${messageId} was already received with different input`,
      );
    }
    return existing;
  }

  /** received -> started, fsynced BEFORE the native worker launches. */
  async markSessionStarted(messageId: string, scope: CloudJournalScope): Promise<CloudJournalSessionEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedSessionEntry(messageId, scope);
      if (entry.phase === "received") return this.#transitionSession(entry, "started");
      if (entry.phase === "started") return entry;
      throw new CloudJournalError(
        "invalid_transition",
        `Session message ${messageId} cannot start from phase ${entry.phase}`,
      );
    });
  }

  /**
   * Terminal Session settlement, fsynced BEFORE the settled frame. Immutable once written: a
   * replay with the same outcome returns the recorded entry and a different one is a conflict.
   * `received -> reported` is admitted only for a non-completed outcome (cancel/failure before any
   * effect), never for `completed`.
   */
  async recordSessionSettled(
    messageId: string,
    scope: CloudJournalScope,
    outcome: CloudJournalSettlementOutcome,
  ): Promise<CloudJournalSessionEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedSessionEntry(messageId, scope);
      if (entry.phase === "reported") {
        if (entry.settlement?.outcome !== outcome) {
          throw new CloudJournalError(
            "conflict",
            `Session message ${messageId} already has a different journaled settlement`,
          );
        }
        return entry;
      }
      if (entry.phase === "received" && outcome === "completed") {
        throw new CloudJournalError(
          "invalid_transition",
          `Session message ${messageId} cannot report completion from phase received`,
        );
      }
      return this.#transitionSession(entry, "reported", outcome);
    });
  }

  /** The Server refused custody before any start; only a `received` Session entry may retire. */
  async clearSessionRejected(messageId: string, scope: CloudJournalScope): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedSessionEntry(messageId, scope);
      if (entry.phase !== "received") {
        throw new CloudJournalError(
          "invalid_transition",
          `Session message ${messageId} cannot be retired as rejected from phase ${entry.phase}`,
        );
      }
      await this.#remove(messageId);
    });
  }

  /**
   * Retire a `received` Session entry whose journaled input was superseded by a new dispatch
   * attempt and journal the new attempt instead. The old entry never started — a verified that
   * arrives later misses its retired request id — so no execution evidence is erased; the Server
   * replaces its never-executed custody record with the new attempt. The new entry REPLACES the
   * entry file through the existing atomic temp-write + rename (`#write`), so a crash or IO
   * failure leaves either the old entry or the new entry fully intact — never a torn file — and
   * the failed call surfaces instead of silently erasing custody.
   */
  async replaceSessionReceived(input: CloudJournalSessionRecordInput): Promise<CloudJournalSessionEntry> {
    return this.#mutate(async () => {
      const scope = CloudJournalScopeSchema.parse(input.scope);
      assertSessionEnvelope(input.sessionKind, input.outboxContext);
      const messageId = input.message.messageId;
      const existing = await this.#requireScopedSessionEntry(messageId, scope);
      if (existing.phase !== "received") {
        throw new CloudJournalError(
          "invalid_transition",
          `Session message ${messageId} cannot be superseded from phase ${existing.phase}`,
        );
      }
      const entry: CloudJournalSessionEntry = {
        kind: "session-message",
        message: input.message,
        inputHash: computeCloudSessionInputHash({
          message: input.message,
          sessionKind: input.sessionKind,
          ...(input.outboxContext ? { outboxContext: input.outboxContext } : {}),
        }),
        scope,
        messageId,
        requestId: input.requestId,
        turnId: input.turnId,
        phase: "received",
        sessionKind: input.sessionKind,
        ...(input.outboxContext ? { outboxContext: input.outboxContext } : {}),
      };
      await this.#write(messageId, entry);
      return entry;
    });
  }

  /**
   * Correlate a `received` Session entry with a new dispatch attempt of identical input. The Turn
   * identity and phase are untouched — only the receipt correlation id moves, fsynced before the
   * new attempt's receipt is sent. A started/reported entry keeps its established identity: its
   * settlement is already correlated with the Server's custody record.
   */
  async updateSessionRequestId(
    messageId: string,
    scope: CloudJournalScope,
    requestId: string,
  ): Promise<CloudJournalSessionEntry> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedSessionEntry(messageId, scope);
      if (entry.requestId === requestId) return entry;
      if (entry.phase !== "received") {
        throw new CloudJournalError(
          "invalid_transition",
          `Session message ${messageId} cannot be re-correlated from phase ${entry.phase}`,
        );
      }
      const next: CloudJournalSessionEntry = { ...entry, requestId };
      await this.#write(messageId, next);
      return next;
    });
  }

  /**
   * Exact settlement ack: only a matching turn id and recorded/already_recorded status retire the
   * immutable terminal entry. Unknown or mismatched acks leave it durable for replay.
   */
  async clearSessionAcknowledged(
    messageId: string,
    scope: CloudJournalScope,
    ack: CloudJournalSettlementAck,
  ): Promise<void> {
    return this.#mutate(async () => {
      const entry = await this.#requireScopedSessionEntry(messageId, scope);
      if (entry.phase !== "reported" || !entry.settlement) {
        throw new CloudJournalError(
          "invalid_transition",
          `Session message ${messageId} has no durable settlement to acknowledge (phase ${entry.phase})`,
        );
      }
      if (entry.turnId !== ack.turnId || (ack.status !== "recorded" && ack.status !== "already_recorded")) {
        throw new CloudJournalError("ack_mismatch", "The acknowledgement does not match the journaled settlement");
      }
      await this.#remove(messageId);
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Shared surface
   * ---------------------------------------------------------------------------------------- */

  /** Read one entry without scope assumptions; callers assert scope before acting on it. */
  async read(entryKey: string): Promise<CloudJournalEntry | undefined> {
    return this.#readEntry(entryKey);
  }

  async #requireScopedDeliveryEntry(deliveryId: string, scope: CloudJournalScope): Promise<CloudJournalDeliveryEntry> {
    const entry = await this.#readEntry(deliveryId);
    if (!entry) throw new CloudJournalError("unknown_entry", `No journaled delivery ${deliveryId}`);
    if (entry.kind !== "delivery") {
      throw new CloudJournalError("unknown_entry", `No journaled delivery ${deliveryId}`);
    }
    assertCloudJournalScope(entry, scope);
    return entry;
  }

  async #requireScopedSessionEntry(messageId: string, scope: CloudJournalScope): Promise<CloudJournalSessionEntry> {
    const entry = await this.#readEntry(messageId);
    if (entry?.kind !== "session-message") {
      throw new CloudJournalError("unknown_entry", `No journaled Session message ${messageId}`);
    }
    assertCloudJournalScope(entry, scope);
    return entry;
  }

  async #assertCapacity(): Promise<void> {
    const entryNames = await this.#entryNames();
    if (entryNames.length >= CLOUD_JOURNAL_MAX_ENTRIES) {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal is at its ${CLOUD_JOURNAL_MAX_ENTRIES}-entry capacity`,
      );
    }
  }

  async #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutations.then(operation, operation);
    this.#mutations = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Durable entry file names, sorted; used for the capacity check and full reads. */
  async #entryNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => ENTRY_NAME.test(name)).sort();
  }

  async #readEntry(entryKey: string): Promise<CloudJournalEntry | undefined> {
    try {
      return await this.#readFile(`${entryKey}.json`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async #readFile(name: string): Promise<CloudJournalEntry> {
    if (!ENTRY_NAME.test(name)) {
      throw new CloudJournalError("store_failed", `Unsafe Cloud delivery journal entry name ${name}`);
    }
    let raw: string;
    try {
      raw = await readFile(join(this.#directory, name), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry ${name} could not be read`);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry ${name} is not valid JSON`);
    }
    const session = CloudJournalSessionEntrySchema.safeParse(parsedJson);
    if (session.success) {
      return {
        kind: "session-message",
        message: session.data.message,
        inputHash: session.data.inputHash,
        scope: session.data.scope,
        messageId: session.data.messageId,
        requestId: session.data.requestId,
        turnId: session.data.turnId,
        phase: session.data.phase,
        sessionKind: session.data.sessionKind,
        ...(session.data.outboxContext ? { outboxContext: session.data.outboxContext } : {}),
        ...(session.data.settlement ? { settlement: session.data.settlement } : {}),
      };
    }
    const delivery = CloudJournalDeliveryEntrySchema.safeParse(parsedJson);
    if (delivery.success) {
      return {
        kind: "delivery",
        delivery: delivery.data.delivery,
        inputHash: delivery.data.inputHash,
        scope: delivery.data.scope,
        deliveryId: delivery.data.deliveryId,
        requestId: delivery.data.requestId,
        turnId: delivery.data.turnId,
        phase: delivery.data.phase,
        ...(delivery.data.report ? { report: delivery.data.report } : {}),
      };
    }
    throw new CloudJournalError("store_failed", `The Cloud delivery journal entry ${name} is unreadable`);
  }

  async #transitionDelivery(
    entry: CloudJournalDeliveryEntry,
    phase: "started" | "reported",
    report?: TurnReportRequest,
  ): Promise<CloudJournalDeliveryEntry> {
    const next: CloudJournalDeliveryEntry = { ...entry, phase, ...(report ? { report } : {}) };
    await this.#write(entry.deliveryId, next);
    return next;
  }

  async #transitionSession(
    entry: CloudJournalSessionEntry,
    phase: "started" | "reported",
    settlement?: CloudJournalSettlementOutcome,
  ): Promise<CloudJournalSessionEntry> {
    const next: CloudJournalSessionEntry = {
      ...entry,
      phase,
      ...(settlement ? { settlement: { outcome: settlement } } : {}),
    };
    await this.#write(entry.messageId, next);
    return next;
  }

  /** Atomic write: temp file, fsync, rename, directory fsync. Serialized by the caller. */
  async #write(entryKey: string, entry: CloudJournalEntry): Promise<void> {
    const target = this.#path(entryKey);
    const serialized = `${JSON.stringify({ version: CLOUD_JOURNAL_VERSION, ...entry } satisfies Record<string, unknown>)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > CLOUD_JOURNAL_ENTRY_MAX_BYTES) {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal entry for ${entryKey} exceeds ${CLOUD_JOURNAL_ENTRY_MAX_BYTES} bytes`,
      );
    }
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    } catch {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal entry for ${entryKey} could not be written`,
      );
    }
    try {
      await file.writeFile(serialized, "utf8");
      await file.sync();
    } catch {
      throw new CloudJournalError(
        "store_failed",
        `The Cloud delivery journal entry for ${entryKey} could not be synced`,
      );
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, target);
      await this.#syncDirectory();
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new CloudJournalError("store_failed", `The Cloud delivery journal entry for ${entryKey} was not durable`);
    }
  }

  async #remove(entryKey: string): Promise<void> {
    await rm(this.#path(entryKey), { force: true });
    await this.#syncDirectory();
  }

  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#directory, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  #path(entryKey: string): string {
    if (!/^[a-zA-Z0-9-]{1,256}$/.test(entryKey)) {
      throw new CloudJournalError("store_failed", "Unsafe delivery id for the journal path");
    }
    return join(this.#directory, `${entryKey}.json`);
  }
}
