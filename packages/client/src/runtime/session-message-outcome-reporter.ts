import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  RUNTIME_SESSION_COLLABORATION_RUN_OUTCOME_VERSION,
  type SessionMessageOutcomeReport,
  SessionMessageOutcomeReportSchema,
  type SessionMessageOutcomeResult,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import type { RuntimeConnection, RuntimeConnectionState } from "./runtime-connection.js";
import {
  type DurableWorkRecord,
  defaultRuntimeRetryScheduler,
  type RuntimeDurabilityStore,
  type RuntimeRetryPolicy,
  type RuntimeRetryScheduler,
  retryDelay,
  retryExhausted,
} from "./runtime-durability.js";

/** The report identity without the per-send correlation id. */
export type SessionMessageOutcomeInput = Omit<SessionMessageOutcomeReport, "type" | "requestId">;

/**
 * Creator notices are worth delivering long after the Run ended (the creator may be busy or its
 * Computer briefly offline), so the reporter keeps retrying for a day with a bounded backoff.
 * The age is the only default exhaustion condition: an attempt cap would end the day early when
 * the Server answers `retry` immediately or the peer is below collaboration v4 (the 5-minute
 * backoff ceiling alone needs ~294 attempts to span 24 hours).
 */
export const SESSION_MESSAGE_OUTCOME_RETRY_POLICY: RuntimeRetryPolicy = {
  baseDelayMs: 5_000,
  maxAgeMs: 24 * 60 * 60 * 1_000,
  maxAttempts: Number.POSITIVE_INFINITY,
  maxDelayMs: 5 * 60 * 1_000,
};
/** A report without any Server answer in this window is resent. */
const ACK_TIMEOUT_MS = 120_000;

interface InFlight {
  requestId: string;
  timer: { cancel(): void };
}

export interface SessionMessageOutcomeReporterOptions {
  connection: Pick<RuntimeConnection, "capabilityVersion" | "send" | "state" | "subscribeState">;
  logger?: Pick<ClientLogger, "warn">;
  now?: () => number;
  persistence?: RuntimeDurabilityStore;
  retryPolicy?: RuntimeRetryPolicy;
  scheduler?: RuntimeRetryScheduler;
}

/**
 * Durable, at-least-once delivery of Session-collaboration v4 Run outcome reports. The Server
 * keys the creator notice on the reported message, so a resend after a lost answer is harmless.
 * Nothing is sent unless the current connection negotiated `runtime.sessionCollaboration` >= 4;
 * an older Server never sees the frame, and the report waits (bounded) for an upgraded peer.
 */
export class SessionMessageOutcomeReporter {
  readonly #connection: SessionMessageOutcomeReporterOptions["connection"];
  readonly #logger: Pick<ClientLogger, "warn">;
  readonly #now: () => number;
  readonly #persistence?: RuntimeDurabilityStore;
  readonly #policy: RuntimeRetryPolicy;
  readonly #scheduler: RuntimeRetryScheduler;
  readonly #records = new Map<string, DurableWorkRecord<SessionMessageOutcomeInput>>();
  readonly #inFlight = new Map<string, InFlight>();
  readonly #retryTimers = new Map<string, { cancel(): void }>();
  readonly #readyPromise: Promise<void>;
  readonly #unsubscribe: () => void;
  #stopped = false;

  constructor(options: SessionMessageOutcomeReporterOptions) {
    this.#connection = options.connection;
    this.#logger = options.logger ?? createLogger("session-message-outcome");
    this.#now = options.now ?? Date.now;
    this.#persistence = options.persistence;
    this.#policy = options.retryPolicy ?? SESSION_MESSAGE_OUTCOME_RETRY_POLICY;
    this.#scheduler = options.scheduler ?? defaultRuntimeRetryScheduler;
    this.#unsubscribe = this.#connection.subscribeState((state) => this.#onConnectionState(state));
    this.#readyPromise = this.#hydrate();
  }

  ready(): Promise<void> {
    return this.#readyPromise;
  }

  /** Reports still waiting for a final Server answer. */
  get pendingCount(): number {
    let count = 0;
    for (const record of this.#records.values()) if (!isFinal(record)) count += 1;
    return count;
  }

  /**
   * Record one terminal non-completed Run outcome and start delivering it. Idempotent per message.
   * Resolves only once the report is durable (or already known); rejects otherwise, so the inbox
   * keeps its terminal record's outcome-report intent `pending` and hands it over again on restart.
   */
  async report(input: SessionMessageOutcomeInput): Promise<void> {
    await this.#readyPromise;
    if (this.#stopped) throw new Error("Session message outcome reporter is stopped");
    const key = recordKey(input);
    if (this.#records.has(key)) return;
    const now = this.#now();
    const record: DurableWorkRecord<SessionMessageOutcomeInput> = {
      acceptedAt: now,
      attempts: 0,
      key,
      kind: "session-message-outcome",
      payload: input,
      status: "accepted",
      updatedAt: now,
    };
    let persistError: unknown;
    try {
      await this.#persist(record);
    } catch (error) {
      // Still deliver from memory now; the caller's pending intent covers a restart.
      persistError = error;
      this.#records.set(key, record);
      this.#logger.warn(
        { code: "SESSION_MESSAGE_OUTCOME_PERSISTENCE_FAILED", messageId: input.messageId },
        "Session message outcome report could not be persisted",
      );
    }
    this.#send(key);
    if (persistError !== undefined) throw persistError;
  }

  /** Apply the Server's answer for the exact in-flight send; stale answers are ignored. */
  handleResult(result: SessionMessageOutcomeResult): void {
    const entry = [...this.#inFlight.entries()].find(([, inFlight]) => inFlight.requestId === result.requestId);
    if (!entry) return;
    const [key, inFlight] = entry;
    inFlight.timer.cancel();
    this.#inFlight.delete(key);
    const record = this.#records.get(key);
    if (!record || record.payload.messageId !== result.messageId) return;
    if (result.status === "notified" || result.status === "ignored") {
      void this.#finish(record, result.status === "notified" ? "succeeded" : "failed");
      return;
    }
    // `retry` and `unsupported_capability` back off; `stale_generation` waits for the next
    // registration, whose state change resends every pending report.
    void this.#retryLater(record, result.status);
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#unsubscribe();
    for (const inFlight of this.#inFlight.values()) inFlight.timer.cancel();
    for (const timer of this.#retryTimers.values()) timer.cancel();
    this.#inFlight.clear();
    this.#retryTimers.clear();
  }

  async #hydrate(): Promise<void> {
    if (!this.#persistence) return;
    let stored: DurableWorkRecord<SessionMessageOutcomeInput>[];
    try {
      stored = await this.#persistence.list<SessionMessageOutcomeInput>("session-message-outcome");
    } catch {
      this.#logger.warn(
        { code: "SESSION_MESSAGE_OUTCOME_HYDRATE_FAILED" },
        "Session message outcome reports could not be loaded",
      );
      return;
    }
    for (const record of stored) {
      const payload = SessionMessageOutcomeReportSchema.omit({ type: true, requestId: true }).safeParse(record.payload);
      if (!payload.success) continue;
      this.#records.set(record.key, { ...record, payload: payload.data });
    }
    for (const [key, record] of this.#records) {
      if (!isFinal(record)) this.#send(key);
    }
  }

  #onConnectionState(state: RuntimeConnectionState): void {
    if (state !== "registered" || this.#stopped) return;
    void this.#readyPromise.then(() => {
      for (const [key, record] of this.#records) {
        if (isFinal(record)) continue;
        this.#retryTimers.get(key)?.cancel();
        this.#retryTimers.delete(key);
        this.#inFlight.get(key)?.timer.cancel();
        this.#inFlight.delete(key);
        this.#send(key);
      }
    });
  }

  #canSend(): boolean {
    return (
      !this.#stopped &&
      this.#connection.state === "registered" &&
      (this.#connection.capabilityVersion(RUNTIME_CAPABILITY.sessionCollaboration) ?? 0) >=
        RUNTIME_SESSION_COLLABORATION_RUN_OUTCOME_VERSION
    );
  }

  #send(key: string): void {
    const record = this.#records.get(key);
    if (!record || isFinal(record) || this.#inFlight.has(key) || this.#retryTimers.has(key)) return;
    // The age limit ends retries after a failed attempt (`#retryLater`), not before one: a Computer that was
    // off for a day still gets to tell the Server, and any failure then gives up at once.
    if (!this.#canSend()) {
      // A registered peer below v4 cannot accept the frame yet; an unregistered connection
      // resends on its next registration.
      if (this.#connection.state === "registered") void this.#retryLater(record, "unsupported_capability");
      return;
    }
    const requestId = randomUUID();
    const frame: SessionMessageOutcomeReport = { type: "session:message:outcome", requestId, ...record.payload };
    const timer = this.#scheduler.schedule(ACK_TIMEOUT_MS, () => {
      if (this.#inFlight.get(key)?.requestId !== requestId) return;
      this.#inFlight.delete(key);
      void this.#retryLater(record, "ack_timeout");
    });
    this.#inFlight.set(key, { requestId, timer });
    this.#connection.send(frame, { priority: "report" }).catch(() => {
      // Transport failures resend on the next registration or the acknowledgement timer.
    });
  }

  async #retryLater(record: DurableWorkRecord<SessionMessageOutcomeInput>, reason: string): Promise<void> {
    if (this.#stopped) return;
    const current = this.#records.get(record.key) ?? record;
    if (isFinal(current) || this.#retryTimers.has(current.key)) return;
    const attempts = current.attempts + 1;
    const now = this.#now();
    const next: DurableWorkRecord<SessionMessageOutcomeInput> = {
      ...current,
      attempts,
      nextAttemptAt: now + retryDelay(this.#policy, attempts),
      status: "retryable",
      updatedAt: now,
    };
    if (retryExhausted(this.#policy, next, now)) {
      await this.#finish(next, "dead-letter", reason);
      return;
    }
    await this.#persist(next).catch(() => this.#records.set(next.key, next));
    const timer = this.#scheduler.schedule(Math.max(0, (next.nextAttemptAt ?? now) - now), () => {
      this.#retryTimers.delete(next.key);
      this.#send(next.key);
    });
    this.#retryTimers.set(next.key, timer);
  }

  async #finish(
    record: DurableWorkRecord<SessionMessageOutcomeInput>,
    status: "succeeded" | "failed" | "dead-letter",
    reason?: string,
  ): Promise<void> {
    const next = { ...record, status, nextAttemptAt: undefined, updatedAt: this.#now() };
    await this.#persist(next).catch(() => this.#records.set(next.key, next));
    if (status === "dead-letter") {
      this.#logger.warn(
        { code: "SESSION_MESSAGE_OUTCOME_UNDELIVERED", messageId: record.payload.messageId, reason },
        "Session message outcome report gave up without a Server answer",
      );
    }
  }

  async #persist(record: DurableWorkRecord<SessionMessageOutcomeInput>): Promise<void> {
    this.#records.set(record.key, record);
    await this.#persistence?.write(record);
  }
}

function recordKey(input: Pick<SessionMessageOutcomeInput, "messageId" | "targetSessionId">): string {
  return `${input.targetSessionId}:${input.messageId}`;
}

function isFinal(record: DurableWorkRecord): boolean {
  return record.status === "succeeded" || record.status === "failed" || record.status === "dead-letter";
}
