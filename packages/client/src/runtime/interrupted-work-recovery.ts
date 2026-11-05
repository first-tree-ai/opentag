import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionRecoverRequest, type SessionRecoverResult } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import {
  acknowledgedSteers,
  type Interruption,
  MAX_AUTOMATIC_RETRIES,
  nextRetry,
  type TurnRetryRecord,
  type TurnRetryStore,
} from "./interruption-retry.js";
import type { RuntimeConnection, RuntimeConnectionState } from "./runtime-connection.js";
import { defaultRuntimeRetryScheduler, type RuntimeRetryScheduler } from "./runtime-durability.js";
import type { SessionBindingStore } from "./session-binding-store.js";
import type { SessionMessageInbox } from "./session-message-inbox.js";
import type { InterruptedTurnResumer, SessionReconciler, SessionTurnIdentity } from "./session-reconciler.js";
import type { TurnCustodyOwner } from "./turn-custody-owner.js";

/** A recover request without a final answer is resent after this delay. */
const RECOVER_RESEND_MS = 10_000;
/** After this many unanswered or `retry` attempts the interrupted work is reported instead. */
const RECOVER_MAX_ATTEMPTS = 30;
/** After `scheduled`, the ready reconcile must arrive (and prepare the Session) within this window. */
const RECOVER_RECONCILE_MS = 60_000;

interface PendingTurn {
  record: TurnRetryRecord;
  interruption: Interruption;
  /** Captured steers the Server settled with this Turn (they have a durable steer receipt). */
  steers: TurnRetryRecord["steers"];
}

interface RecoverRequest {
  frame: SessionRecoverRequest;
  attempts: number;
  timer?: { cancel(): void };
}

export interface InterruptedWorkRecoveryOptions {
  bindingStore: Pick<SessionBindingStore, "read">;
  connection: Pick<RuntimeConnection, "capabilityVersion" | "send" | "subscribeState">;
  custody: Pick<TurnCustodyOwner, "resume">;
  inbox: Pick<
    SessionMessageInbox,
    "failAwaitingPreparation" | "failJoinedRun" | "sessionPrepared" | "sessionsAwaitingPreparation"
  >;
  logger?: Pick<ClientLogger, "info" | "warn">;
  now?: () => number;
  reconciler: Pick<SessionReconciler, "clearRecovery" | "setRecovery">;
  retries: Pick<TurnRetryStore, "list" | "remove" | "write">;
  scheduler?: RuntimeRetryScheduler;
}

/**
 * Owns resuming accepted work after a process interruption on a Local Computer.
 *
 * On startup it finds accepted IM Turns that the previous daemon left unresolved (crash, power loss,
 * or an orderly stop), counts the interruption as a retry durably, and fences their
 * Sessions. Once connected it asks the Server to re-prepare every Session with interrupted work
 * (`session:recover`); the resulting ready reconcile resumes the Turn with a continuation notice.
 * Internal and visible Session messages waiting in the inbox ride on the same request. When the
 * Server cannot recover a Session, or does not support recovery, the work falls back to ordinary
 * failure reporting: an IM Turn gets its recovery report, a Session message fails with a notice.
 */
export class InterruptedWorkRecovery implements InterruptedTurnResumer {
  readonly #options: InterruptedWorkRecoveryOptions;
  readonly #logger: Pick<ClientLogger, "info" | "warn">;
  readonly #now: () => number;
  readonly #scheduler: RuntimeRetryScheduler;
  readonly #turns = new Map<string, PendingTurn>();
  readonly #requests = new Map<string, RecoverRequest>();
  readonly #unsubscribe: () => void;
  #stopped = false;

  constructor(options: InterruptedWorkRecoveryOptions) {
    this.#options = options;
    this.#logger = options.logger ?? createLogger("interrupted-work-recovery");
    this.#now = options.now ?? Date.now;
    this.#scheduler = options.scheduler ?? defaultRuntimeRetryScheduler;
    this.#unsubscribe = options.connection.subscribeState((state) => this.#onConnectionState(state));
  }

  /** Scan durable Turn input left by the previous daemon. Call before the connection starts. */
  async start(): Promise<void> {
    let records: TurnRetryRecord[];
    try {
      records = await this.#options.retries.list();
    } catch {
      this.#logger.warn({ code: "TURN_RETRY_SCAN_FAILED" }, "Interrupted Turn scan failed");
      return;
    }
    for (const record of records) await this.#restore(record);
  }

  stop(): void {
    this.#stopped = true;
    this.#unsubscribe();
    for (const request of this.#requests.values()) request.timer?.cancel();
    this.#requests.clear();
  }

  /** Accepted IM Turns waiting for their automatic retry; protected work for the upgrade gate. */
  get pendingCount(): number {
    return this.#turns.size;
  }

  isPendingRetry(sessionId: string, turnId: string): boolean {
    return this.#supported() && this.#turns.get(sessionId)?.record.turnId === turnId;
  }

  pending(sessionId: string, turn: SessionTurnIdentity): boolean {
    const pending = this.#turns.get(sessionId);
    return this.#supported() && pending?.record.turnId === turn.turnId && pending.record.deliveryId === turn.deliveryId;
  }

  resume(sessionId: string, turn: SessionTurnIdentity): boolean {
    const pending = this.#turns.get(sessionId);
    if (!pending || pending.record.turnId !== turn.turnId) return false;
    const started = this.#options.custody.resume(pending.record.request, pending.record.turnId, {
      continuation: pending.interruption,
      steers: pending.steers,
    });
    this.#logger.info(
      { sessionId, turnId: turn.turnId, reason: pending.interruption.reason, started },
      started ? "Interrupted Turn automatic retry started" : "Interrupted Turn retry could not start yet",
    );
    if (!started) {
      // The Turn keeps its pending retry; the open recover request asks for another ready reconcile
      // and gives up (reporting the Turn) only when its attempts run out.
      const request = this.#requests.get(sessionId);
      if (request) this.#scheduleResend(sessionId, request);
      return false;
    }
    this.#turns.delete(sessionId);
    this.#settle(sessionId);
    // Waiting Session messages join the resumed Turn as soon as it can take them.
    this.#options.inbox.sessionPrepared(sessionId);
    return true;
  }

  abandon(sessionId: string, turn: SessionTurnIdentity, reason: string): void {
    const pending = this.#turns.get(sessionId);
    if (!pending || pending.record.turnId !== turn.turnId) return;
    this.#turns.delete(sessionId);
    this.#logger.warn(
      { code: "TURN_RETRY_ABANDONED", sessionId, turnId: turn.turnId, reason },
      "Interrupted Turn falls back to failure reporting",
    );
    // The Session could not be prepared for its retry: waiting Session messages cannot run either.
    if (this.#settle(sessionId)) void this.#options.inbox.failAwaitingPreparation(sessionId, normalizeReason(reason));
  }

  /**
   * A ready reconcile prepared the Session. Its waiting Session messages may run now, unless its Turn
   * has not been resumed yet: they then wait for `resume`.
   */
  sessionPrepared(sessionId: string): void {
    if (this.#turns.has(sessionId)) return;
    this.#settle(sessionId);
    this.#options.inbox.sessionPrepared(sessionId);
  }

  /** The ready reconcile for a Session under recovery was refused: give the waiting work up. */
  reconcileRejected(sessionId: string, reason: string): void {
    if (!this.#requests.has(sessionId)) return;
    void this.#giveUp(sessionId, reason);
  }

  handleResult(result: SessionRecoverResult): void {
    const request = this.#requests.get(result.sessionId);
    if (!request || request.frame.requestId !== result.requestId) return;
    request.timer?.cancel();
    if (result.status === "scheduled") {
      // Stay the owner until the ready reconcile actually prepares the Session; a lost or failed
      // reconcile is retried and eventually given up like any other failure.
      request.timer = this.#scheduler.schedule(RECOVER_RECONCILE_MS, () =>
        this.#scheduleResend(result.sessionId, request),
      );
      return;
    }
    if (result.status === "retry") {
      this.#scheduleResend(result.sessionId, request);
      return;
    }
    this.#requests.delete(result.sessionId);
    void this.#giveUp(result.sessionId, result.reason ?? result.status);
  }

  /** Ends the open recover request for a Session; true when one was open. */
  #settle(sessionId: string): boolean {
    const request = this.#requests.get(sessionId);
    if (!request) return false;
    request.timer?.cancel();
    this.#requests.delete(sessionId);
    return true;
  }

  async #restore(record: TurnRetryRecord): Promise<void> {
    let unresolved: Awaited<ReturnType<SessionBindingStore["read"]>>;
    try {
      unresolved = await this.#options.bindingStore.read(record.agentId, record.sessionId);
    } catch {
      return;
    }
    const turn = unresolved?.unresolvedTurn;
    if (!unresolved || !turn || turn.turnId !== record.turnId || turn.deliveryId !== record.deliveryId) {
      // The Turn was recorded (or replaced) before the record could be removed.
      await this.#options.retries.remove(record.sessionId, record.turnId).catch(() => undefined);
      return;
    }
    // A Turn that already reported follows ordinary report recovery.
    if (turn.phase === "reporting") return;
    const interruption = record.interruption ?? {
      reason: "daemon_crash" as const,
      at: new Date(this.#now()).toISOString(),
    };
    // Counted before anything runs; a 429 was counted when it failed and its retry has not started. The
    // reason goes to the resumed Turn's notice; what ends that Turn is recorded anew.
    const counted = record.interruption?.reason === "provider_rate_limited";
    const { count, exhausted } = counted
      ? { count: record.retries, exhausted: record.retries > MAX_AUTOMATIC_RETRIES }
      : nextRetry({ count: record.retries, ranMs: record.retryRanMs ?? 0 });
    const { interruption: _ended, ...attempt } = record;
    const spent: TurnRetryRecord = { ...attempt, retries: count, retryRanMs: 0 };
    try {
      await this.#options.retries.write(spent);
    } catch {
      return;
    }
    if (exhausted) {
      this.#logger.warn(
        { code: "TURN_RETRIES_EXHAUSTED", sessionId: record.sessionId, turnId: record.turnId },
        "Interrupted Turn used its automatic retries and falls back to failure reporting",
      );
      // The messages steered into this Turn share its count, so they fail with it.
      await this.#options.inbox.failJoinedRun(record.turnId);
      return;
    }
    this.#turns.set(record.sessionId, {
      record: spent,
      interruption,
      steers: acknowledgedSteers(record.steers, unresolved),
    });
    this.#options.reconciler.setRecovery(record.sessionId, { deliveryId: record.deliveryId, turnId: record.turnId });
    this.#logger.info(
      { sessionId: record.sessionId, turnId: record.turnId, reason: interruption.reason },
      "Interrupted Turn waits for its automatic retry",
    );
  }

  #supported(): boolean {
    return this.#options.connection.capabilityVersion(RUNTIME_CAPABILITY.sessionRecovery) === 1;
  }

  #onConnectionState(state: RuntimeConnectionState): void {
    if (state !== "registered" || this.#stopped) return;
    if (!this.#supported()) {
      // An older Server cannot prepare the Sessions: report the interrupted work instead.
      for (const [sessionId, pending] of [...this.#turns]) {
        this.abandon(sessionId, pending.record, "unsupported_capability");
      }
      for (const session of this.#options.inbox.sessionsAwaitingPreparation()) {
        void this.#options.inbox.failAwaitingPreparation(session.sessionId, "session_recovery_unavailable");
      }
      return;
    }
    const targets = new Map<string, Omit<SessionRecoverRequest, "type" | "requestId">>();
    for (const session of this.#options.inbox.sessionsAwaitingPreparation()) targets.set(session.sessionId, session);
    for (const [sessionId, pending] of this.#turns) {
      targets.set(sessionId, {
        sessionId,
        agentId: pending.record.agentId,
        placementGeneration: pending.record.request.placementGeneration,
        deliveryId: pending.record.deliveryId,
        turnId: pending.record.turnId,
      });
    }
    for (const target of targets.values()) {
      const existing = this.#requests.get(target.sessionId);
      existing?.timer?.cancel();
      const request: RecoverRequest = {
        frame: { type: "session:recover", requestId: randomUUID(), ...target },
        attempts: existing?.attempts ?? 0,
      };
      this.#requests.set(target.sessionId, request);
      this.#send(target.sessionId, request);
    }
  }

  #send(sessionId: string, request: RecoverRequest): void {
    if (this.#stopped) return;
    request.attempts += 1;
    request.frame = { ...request.frame, requestId: randomUUID() };
    void this.#options.connection.send(request.frame).catch(() => undefined);
    // No answer in time counts as `retry`; a reconnect also resends every open request.
    request.timer = this.#scheduler.schedule(RECOVER_RESEND_MS * 3, () => this.#scheduleResend(sessionId, request));
  }

  #scheduleResend(sessionId: string, request: RecoverRequest): void {
    request.timer?.cancel();
    if (this.#stopped || this.#requests.get(sessionId) !== request) return;
    if (request.attempts >= RECOVER_MAX_ATTEMPTS) {
      this.#requests.delete(sessionId);
      void this.#giveUp(sessionId, "session_recovery_timeout");
      return;
    }
    request.timer = this.#scheduler.schedule(RECOVER_RESEND_MS, () => this.#send(sessionId, request));
  }

  async #giveUp(sessionId: string, reason: string): Promise<void> {
    this.#settle(sessionId);
    const pending = this.#turns.get(sessionId);
    if (pending) this.abandon(sessionId, pending.record, reason);
    await this.#options.inbox.failAwaitingPreparation(sessionId, normalizeReason(reason));
  }
}

function normalizeReason(reason: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : "session_recovery_rejected";
}
