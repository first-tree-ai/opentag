import { randomUUID } from "node:crypto";
import type {
  FeishuSetupActivation,
  FeishuSetupActivationReason,
  FeishuSetupAttempt,
  FeishuSetupIntent,
  ImBindingMessagingExpectation,
} from "@opentag/shared";
import { and, asc, eq, gt, inArray, isNull, lt, lte, ne, or } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../../db/client.js";
import { agents, imBindings } from "../../../db/schema/index.js";
import { isUniqueViolation } from "../../../db/unique-violation.js";
import type { BackgroundFailureSupervisor } from "../../../observability/background-failure-supervisor.js";
import type { ApplicationCipher } from "../../crypto.js";
import {
  type ImBindingService,
  ImBindingServiceError,
  ImBindingUnbindRequiredError,
  type VerifiedFeishuBinding,
} from "../im-binding-service.js";
import {
  FeishuCandidateExpiredError,
  FeishuOperationError,
  feishuSetupFailureCode,
  safeFeishuSetupErrorCode,
} from "./errors.js";
import type { FeishuAppProfile, FeishuRegistration, FeishuRegistrationGateway } from "./registration.js";
import {
  classifyFeishuCandidateFailure,
  type FeishuCandidateCheckOutcome,
  type FeishuClaimedCheckOutcome,
} from "./setup-check.js";
import {
  type DecodedFeishuSetupContext,
  decodeFeishuSetupContext,
  encodeFeishuSetupCandidate,
  encodeFeishuSetupQr,
  FEISHU_SETUP_CANDIDATE_KIND,
  FEISHU_SETUP_CANDIDATE_VERSION,
  type FeishuSetupCandidateContext,
} from "./setup-context.js";

type SetupRow = typeof imBindings.$inferSelect;

export interface FeishuBindingActivation {
  /**
   * Channel-free readiness probe for one durable candidate; must never open a message socket.
   * Implementations that predate the durable check seam may omit it: activation itself re-runs the
   * same admission checks under the claim fence, so the probe is an optimization, never a gate.
   * `signal` aborts an in-flight probe when the setup attempt is stopped, canceled or bounded out.
   */
  checkCandidate?(input: {
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
    signal?: AbortSignal;
  }): Promise<FeishuCandidateCheckOutcome>;
  activateAtomicAttempt(input: {
    attemptId: string;
    ownerInstanceId: string;
    agentId: string;
    appId: string;
    appSecret: string;
    teamBrand?: "feishu" | "lark";
    /**
     * The durable candidate's retention deadline. Absent for a legacy QR attempt: the device code
     * TTL no longer gates activation once the credential has already been issued.
     */
    candidateExpiresAt?: Date;
    /** Aborts provider and channel work before the fenced commit; the commit itself re-checks state. */
    signal?: AbortSignal;
  }): Promise<VerifiedFeishuBinding>;
}

export interface FeishuSetupTiming {
  ownerHeartbeatMs?: number;
  ownerStaleMs?: number;
  checkIntervalMs?: number;
  checkJitterMs?: number;
  candidateTtlMs?: number;
  sweepPageSize?: number;
  maxConcurrentChecks?: number;
  /** Wall-clock bound for one claimed check, including its channel-free probe and activation. */
  checkDeadlineMs?: number;
}

export const DEFAULT_FEISHU_CANDIDATE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const DEFAULT_TIMING = {
  ownerHeartbeatMs: 5_000,
  ownerStaleMs: 15_000,
  checkIntervalMs: 60_000,
  checkJitterMs: 15_000,
  candidateTtlMs: DEFAULT_FEISHU_CANDIDATE_TTL_MS,
  sweepPageSize: 50,
  maxConcurrentChecks: 4,
  checkDeadlineMs: 30_000,
} as const;

/** States that keep a setup attempt open. A stored attempt in any other state is terminal. */
const OPEN_SETUP_STATES = ["awaiting_user", "pending_activation", "validating"] as const;

/** Candidate-only expiry code, shared with the parent-owned error class and distinct from the QR code. */
const CANDIDATE_EXPIRED_CODE = new FeishuCandidateExpiredError().code;

/*
 * Abort reasons the setup service writes onto its own check controllers. They separate "the claim
 * is gone" (stop/cancel, never settle or activate) from "the check ran out of time" (settle back to
 * a bounded wait).
 */
const STOPPED_ABORT_REASON = "FEISHU_SETUP_SERVICE_STOPPED";
const CANCELED_ABORT_REASON = "FEISHU_SETUP_ATTEMPT_CANCELED";
const CHECK_DEADLINE_ABORT_REASON = "FEISHU_SETUP_CHECK_DEADLINE_EXCEEDED";

type CheckAbortKind = "none" | "fenced" | "deadline";

function isOpenSetupState(state: string | null | undefined): boolean {
  return state !== null && state !== undefined && (OPEN_SETUP_STATES as readonly string[]).includes(state);
}

/** Settles when either the operation resolves or the signal aborts, whichever happens first. */
function withCheckBound<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function checkAbortKind(controller: AbortController): CheckAbortKind {
  if (!controller.signal.aborted) return "none";
  const reason = controller.signal.reason;
  return reason === STOPPED_ABORT_REASON || reason === CANCELED_ABORT_REASON ? "fenced" : "deadline";
}

interface CandidateClaim {
  claimUuid: string;
  row: SetupRow;
}

interface SlotAdmission {
  kind: "reused" | "admitted";
  row: SetupRow;
}

export class FeishuSetupService {
  readonly #activation: FeishuBindingActivation;
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #instanceId: string;
  readonly #imBindings: ImBindingService;
  readonly #onDiagnostic: (code: string) => void;
  readonly #supervisor?: BackgroundFailureSupervisor;
  readonly #registrations = new Map<string, FeishuRegistration>();
  /** In-flight claimed checks, keyed by the fresh per-check owner UUID. */
  readonly #checks = new Map<string, { attemptId: string; controller: AbortController }>();
  /** Synchronous concurrency reservations taken before the asynchronous claim, keyed by attempt. */
  readonly #reservations = new Set<string>();
  /** Attempts canceled while a claim was still in flight; never probed or activated afterwards. */
  readonly #canceledAttempts = new Set<string>();
  readonly #gateway: FeishuRegistrationGateway;
  readonly #timing: { -readonly [K in keyof typeof DEFAULT_TIMING]: number };
  readonly #now: () => Date;
  readonly #random: () => number;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  /** Keyset cursor retained across bounded passes so saturated slots cannot starve the tail. */
  #sweepCursor: string | undefined;
  #stopped = false;
  #sweeping = false;

  constructor(input: {
    database: DatabaseClient;
    cipher: ApplicationCipher;
    instanceId: string;
    imBindings: ImBindingService;
    registrations: FeishuRegistrationGateway;
    activation: FeishuBindingActivation;
    onDiagnostic?: (code: string) => void;
    supervisor?: BackgroundFailureSupervisor;
    timing?: FeishuSetupTiming;
    now?: () => Date;
    random?: () => number;
  }) {
    this.#database = input.database;
    this.#cipher = input.cipher;
    this.#instanceId = input.instanceId;
    this.#imBindings = input.imBindings;
    this.#gateway = input.registrations;
    this.#activation = input.activation;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
    this.#supervisor = input.supervisor;
    this.#now = input.now ?? (() => new Date());
    this.#random = input.random ?? Math.random;
    this.#timing = { ...DEFAULT_TIMING, ...definedTiming(input.timing) };
  }

  start(): void {
    if (this.#heartbeatTimer) return;
    this.#stopped = false;
    this.#heartbeatTimer = setInterval(() => {
      this.#trackDetached("FEISHU_SETUP_HEARTBEAT_FAILED", this.#heartbeat(), "scheduler");
      this.#trackDetached("FEISHU_SETUP_SWEEP_FAILED", this.#sweep(), "scheduler");
    }, this.#timing.ownerHeartbeatMs);
    this.#heartbeatTimer.unref();
  }

  /**
   * Shutdown outlives the process's ability to serve callbacks, but it must not discard durable
   * work: QR attempts owned by this instance fail as before, claimed candidates are released back
   * to `pending_activation` with their encrypted context intact, and every in-flight check is
   * aborted so a late probe result can never start activation after the service stopped.
   *
   * Ordering is load-bearing. Check claims are aborted first so no in-flight activation can still
   * commit while shutdown proceeds. The QR fail-write is awaited before registrations are aborted:
   * an aborted registration rejects with a cancel-shaped error, and its late completion write is
   * fenced on this instance still owning the row — once the restart write has cleared the owner,
   * that late write matches nothing and the attempt keeps FEISHU_SETUP_OWNER_RESTARTED instead of
   * racing to FEISHU_SETUP_CANCELED.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeatTimer) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    const checks = [...this.#checks.entries()];
    for (const [, check] of checks) check.controller.abort(STOPPED_ABORT_REASON);
    this.#checks.clear();
    this.#reservations.clear();
    const now = this.#now();
    try {
      await this.#database
        .update(imBindings)
        .set({
          setupState: "failed",
          lastErrorCode: "FEISHU_SETUP_OWNER_RESTARTED",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          encryptedSetupContext: null,
          setupExpiresAt: null,
          updatedAt: now,
        })
        .where(and(eq(imBindings.setupOwnerInstanceId, this.#instanceId), eq(imBindings.setupState, "awaiting_user")));
    } finally {
      // Database failure must not leave the registration SDK polling during shutdown.
      for (const registration of this.#registrations.values()) registration.abort();
      this.#registrations.clear();
    }
    const claims = checks.map(([claimUuid]) => claimUuid);
    if (claims.length > 0) {
      await this.#database
        .update(imBindings)
        .set({
          setupState: "pending_activation",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          updatedAt: now,
        })
        .where(and(inArray(imBindings.setupOwnerInstanceId, claims), eq(imBindings.setupState, "validating")));
    }
  }

  async createOrReuse(
    callerUserId: string,
    agentId: string,
    intent: FeishuSetupIntent,
    expectedMessaging?: ImBindingMessagingExpectation,
  ): Promise<FeishuSetupAttempt> {
    await this.#imBindings.assertCanManage(callerUserId, agentId);
    const current = await this.#currentForAgent(agentId);
    this.#assertMessagingStartAllowed(current, intent, expectedMessaging);
    const reusedEarly = this.#openAttemptReuse(current);
    if (reusedEarly) return reusedEarly;

    const [agent] = await this.#database
      .select({ computerId: agents.computerId, displayName: agents.displayName, receiveMode: agents.receiveMode })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    // Activation refuses an Agent with no Computer, so the setup is refused here rather than after
    // the Account has registered a Feishu App it cannot use. It carries the same deterministic 409
    // activation returns: an untyped throw would reach the Account as an internal failure and invite
    // a retry that cannot succeed.
    if (agent.computerId === null) {
      throw new ImBindingServiceError(
        "AGENT_COMPUTER_NOT_BOUND",
        409,
        "The Agent must be bound to a Computer before messaging can be connected",
      );
    }
    const existing = current;
    const profile: FeishuAppProfile = {
      name: agent.displayName,
      description: `OpenTag Agent: ${agent.displayName}`,
    };
    let registration: FeishuRegistration;
    try {
      registration = this.#gateway.start({
        profile,
        intent,
        existingAppId: intent === "reauthorize" ? (existing?.externalAppId ?? undefined) : undefined,
        receiveMode: agent.receiveMode,
      });
    } catch (cause) {
      throw new FeishuOperationError(feishuSetupFailureCode(cause));
    }
    let qr: Awaited<FeishuRegistration["qrReady"]>;
    try {
      qr = await registration.qrReady;
    } catch (cause) {
      void registration.result.catch(() => undefined);
      registration.abort();
      throw new FeishuOperationError(feishuSetupFailureCode(cause));
    }

    const attemptId = randomUUID();
    const now = this.#now();
    let admission: SlotAdmission | undefined;
    try {
      admission = await this.#database.transaction(async (transaction) => {
        await this.#imBindings.assertCanManageForMutation(callerUserId, agentId, transaction);
        // Re-read under the Agent mutation lock: an attempt saved while our registration ran is
        // authoritative, so a durable candidate is reused instead of being overwritten by this QR.
        const fenced = await this.#currentForAgent(agentId, transaction, true);
        this.#assertMessagingStartAllowed(fenced, intent, expectedMessaging);
        const reused = await this.#reuseOpenAttemptUnderLock(transaction, fenced, now);
        if (reused) return { kind: "reused", row: reused } satisfies SlotAdmission;
        return this.#admitAttempt(transaction, agentId, fenced, attemptId, intent, qr, now);
      });
    } catch (error) {
      return this.#convergeInsertRace(agentId, registration, error);
    }

    if (!admission || admission.kind === "reused" || this.#attemptIdOrUndefined(admission.row) !== attemptId) {
      void registration.result.catch(() => undefined);
      registration.abort();
      if (admission?.row) return this.#projectAttempt(admission.row);
      const concurrent = await this.#currentForAgent(agentId);
      if (concurrent?.setupAttemptId && isOpenSetupState(concurrent.setupState)) {
        return this.#projectAttempt(concurrent);
      }
      throw new Error("Feishu setup slot admission did not converge");
    }
    this.#registrations.set(attemptId, registration);
    this.#trackDetached(
      "FEISHU_SETUP_COMPLETION_FAILED",
      this.#complete(attemptId, agentId, registration),
      "provider",
      attemptId,
    );
    return this.#projectAttempt(admission.row);
  }

  /**
   * The read-only fast path: an open attempt that is clearly reusable is returned before a new
   * registration is started. The authoritative decision is repeated under the Agent lock, because
   * another creator may persist a durable candidate while this one waits for its QR.
   */
  #openAttemptReuse(row: SetupRow | undefined): FeishuSetupAttempt | undefined {
    if (!row?.setupAttemptId || !row.setupState) return undefined;
    const now = this.#now();
    if (row.setupState === "awaiting_user") {
      const expired = row.setupExpiresAt !== null && row.setupExpiresAt <= now;
      return !expired && !this.#qrOwnerLost(row, now) ? this.#projectAttempt(row) : undefined;
    }
    if (row.setupState === "pending_activation" || row.setupState === "validating") {
      const context = this.#decodeContext(row);
      if (context?.kind !== "candidate") return undefined;
      return this.#candidateExpired(row, now) ? undefined : this.#projectAttempt(row);
    }
    return undefined;
  }

  /**
   * The authoritative reuse decision, taken under the row lock. A durable candidate saved by a
   * concurrent creator is never overwritten by this registration; a lapsed or ownerless legacy
   * attempt is cleared first so the new attempt can take the slot.
   */
  async #reuseOpenAttemptUnderLock(
    transaction: DatabaseTransaction,
    fenced: SetupRow | undefined,
    now: Date,
  ): Promise<SetupRow | undefined> {
    if (!fenced?.setupAttemptId || !fenced.setupState) return undefined;
    if (fenced.setupState === "pending_activation") return this.#reusePendingUnderLock(transaction, fenced, now);
    if (fenced.setupState === "validating") return this.#reuseValidatingUnderLock(transaction, fenced, now);
    if (fenced.setupState === "awaiting_user") return this.#reuseAwaitingUserUnderLock(transaction, fenced, now);
    return undefined;
  }

  /** A pending candidate is reused while retained; a lapsed or malformed one is cleared under lock. */
  async #reusePendingUnderLock(
    transaction: DatabaseTransaction,
    fenced: SetupRow,
    now: Date,
  ): Promise<SetupRow | undefined> {
    const context = this.#decodeContext(fenced);
    if (context?.kind === "candidate") {
      if (!this.#candidateExpired(fenced, now)) return fenced;
      await this.#expireCandidate(fenced, now, transaction);
      return undefined;
    }
    await this.#failInvalidContextInTransaction(transaction, fenced, now);
    return undefined;
  }

  /** A validating durable candidate is reused; legacy QR rows reuse or clear by owner liveness. */
  async #reuseValidatingUnderLock(
    transaction: DatabaseTransaction,
    fenced: SetupRow,
    now: Date,
  ): Promise<SetupRow | undefined> {
    const context = this.#decodeContext(fenced);
    if (context?.kind === "candidate") {
      if (!this.#candidateExpired(fenced, now)) return fenced;
      await this.#expireCandidate(fenced, now, transaction);
      return undefined;
    }
    if (context === undefined) {
      await this.#failInvalidContextInTransaction(transaction, fenced, now);
      return undefined;
    }
    if (this.#qrOwnerLost(fenced, now)) {
      await this.#terminateOwnedAttempt(
        fenced,
        { state: "failed", code: "FEISHU_SETUP_OWNER_RESTARTED" },
        now,
        transaction,
      );
      return undefined;
    }
    return fenced;
  }

  async #reuseAwaitingUserUnderLock(
    transaction: DatabaseTransaction,
    fenced: SetupRow,
    now: Date,
  ): Promise<SetupRow | undefined> {
    const expired = fenced.setupExpiresAt !== null && fenced.setupExpiresAt <= now;
    if (!expired && !this.#qrOwnerLost(fenced, now)) return fenced;
    // A lapsed challenge expires; only a live challenge whose owner vanished is a restart. The
    // projection reads the same distinction, so the terminal write must not collapse them.
    await this.#terminateOwnedAttempt(
      fenced,
      expired
        ? { state: "expired", code: "FEISHU_SETUP_EXPIRED" }
        : { state: "failed", code: "FEISHU_SETUP_OWNER_RESTARTED" },
      now,
      transaction,
    );
    return undefined;
  }

  /** Writes this registration's QR attempt into the locked slot (or inserts a fresh binding row). */
  async #admitAttempt(
    transaction: DatabaseTransaction,
    agentId: string,
    fenced: SetupRow | undefined,
    attemptId: string,
    intent: FeishuSetupIntent,
    qr: { url: string; expiresAt: Date },
    now: Date,
  ): Promise<SlotAdmission | undefined> {
    if (fenced) {
      const [updated] = await transaction
        .update(imBindings)
        .set({
          setupAttemptId: attemptId,
          setupIntent: intent,
          setupState: "awaiting_user",
          setupOwnerInstanceId: this.#instanceId,
          setupOwnerHeartbeatAt: now,
          encryptedSetupContext: encodeFeishuSetupQr(this.#cipher, qr.url, fenced.id, attemptId),
          setupExpiresAt: qr.expiresAt,
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(eq(imBindings.id, fenced.id), ne(imBindings.status, "disabled"), isNull(imBindings.setupOwnerInstanceId)),
        )
        .returning();
      return updated ? { kind: "admitted", row: updated } : undefined;
    }
    // Use the row identity for the existing credential cipher context (AAD when writing v2).
    const bindingId = randomUUID();
    const [created] = await transaction
      .insert(imBindings)
      .values({
        id: bindingId,
        agentId,
        provider: "feishu",
        status: "provisioning",
        setupAttemptId: attemptId,
        setupIntent: intent,
        setupState: "awaiting_user",
        setupOwnerInstanceId: this.#instanceId,
        setupOwnerHeartbeatAt: now,
        encryptedSetupContext: encodeFeishuSetupQr(this.#cipher, qr.url, bindingId, attemptId),
        setupExpiresAt: qr.expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created ? { kind: "admitted", row: created } : undefined;
  }

  async #convergeInsertRace(
    agentId: string,
    registration: FeishuRegistration,
    error: unknown,
  ): Promise<FeishuSetupAttempt> {
    void registration.result.catch(() => undefined);
    registration.abort();
    // Only the current-binding uniqueness race is convergence. Authority, lifecycle, and stale
    // expectation errors are deliberate fences and must reach the caller unchanged.
    if (!isUniqueViolation(error, "im_bindings_agent_current_unique")) throw error;
    const concurrent = await this.#currentForAgent(agentId);
    if (concurrent?.setupAttemptId && isOpenSetupState(concurrent.setupState)) {
      return this.#projectAttempt(concurrent);
    }
    throw error;
  }

  async get(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const row = await this.#load(attemptId);
    if (!row) throw new Error("FEISHU_SETUP_NOT_FOUND");
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    return this.#projectAttempt(row);
  }

  /**
   * The Agent-owned setup attempt as it stands right now, including expiry and owner-liveness
   * projection, without taking on a caller. Readers that already established Account authority over
   * the Agent (the setup snapshot) use this so the attempt's liveness rules stay in one place.
   */
  async observeForAgent(agentId: string): Promise<FeishuSetupAttempt | undefined> {
    const row = await this.#currentForAgent(agentId);
    if (!row?.setupAttemptId || !row.setupIntent || !row.setupState) return undefined;
    return this.#projectAttempt(row);
  }

  /**
   * The explicit Account-triggered check. It shares the scheduler's admission: an attempt that is
   * not yet due returns its current projection without an upstream call, and a due attempt takes
   * the same synchronous slot reservation and exact-ciphertext claim as the background sweep, so a
   * button press can never multiply provider requests or exceed the concurrency bound.
   */
  async check(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const row = await this.#load(attemptId);
    if (!row) throw new Error("FEISHU_SETUP_NOT_FOUND");
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    if (row.setupState !== "pending_activation" || this.#stopped) return this.#projectAttempt(row);
    const context = this.#decodeContext(row);
    const now = this.#now();
    if (context?.kind !== "candidate") {
      await this.#failInvalidContext(row);
      return this.#reloadProjection(row);
    }
    if (this.#candidateExpired(row, now)) {
      await this.#expireCandidate(row, now);
      return this.#reloadProjection(row);
    }
    if (!this.#isDue(context.candidate, now)) return this.#projectAttempt(row);
    await this.#startClaimedCheck(row, context.candidate, now, "await");
    return this.#reloadProjection(row);
  }

  async cancel(callerUserId: string, attemptId: string): Promise<FeishuSetupAttempt> {
    const row = await this.#load(attemptId);
    if (!row) throw new Error("FEISHU_SETUP_NOT_FOUND");
    await this.#imBindings.assertCanManage(callerUserId, row.agentId);
    const projected = this.#projectAttempt(row);
    if (!["awaiting_user", "pending_activation", "validating"].includes(projected.state)) {
      // A lapsed durable candidate already projects terminal; retire its secret under the deadline
      // fence here instead of leaving the ciphertext for the next sweep.
      const observedAt = this.#now();
      if (
        projected.state === "expired" &&
        (row.setupState === "pending_activation" || row.setupState === "validating") &&
        this.#candidateExpired(row, observedAt)
      ) {
        await this.#expireCandidate(row, observedAt);
      }
      return projected;
    }
    const now = this.#now();
    const canceled = await this.#database.transaction(async (transaction) => {
      await this.#imBindings.assertCanManageForMutation(callerUserId, row.agentId, transaction);
      const [updated] = await transaction
        .update(imBindings)
        .set({
          setupState: "canceled",
          lastErrorCode: "FEISHU_SETUP_CANCELED",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          encryptedSetupContext: null,
          setupExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(imBindings.setupAttemptId, attemptId),
            inArray(imBindings.setupState, ["awaiting_user", "pending_activation", "validating"]),
          ),
        )
        .returning();
      return updated;
    });
    // Activation may commit while cancellation waits for the Agent lock. Report the committed
    // outcome rather than the stale pre-lock projection so callers can refresh a completed binding.
    if (!canceled) return this.#reloadProjection(row);
    if (this.#reservations.has(attemptId) || this.#hasAttemptCheck(attemptId)) {
      this.#canceledAttempts.add(attemptId);
    }
    this.#registrations.get(attemptId)?.abort();
    this.#abortClaimForAttempt(attemptId);
    return this.#toAttempt(canceled);
  }

  async #complete(attemptId: string, agentId: string, registration: FeishuRegistration): Promise<void> {
    // Only the authorization itself belongs to Feishu; candidate persistence and validation are ours.
    let awaitingAuthorization = true;
    try {
      const result = await registration.result;
      awaitingAuthorization = false;
      const saved = await this.#saveCandidate(attemptId, agentId, result);
      if (!saved) return;
      await this.#checkAttempt(saved);
    } catch (error) {
      const code = awaitingAuthorization ? safeFeishuSetupErrorCode(error) : "FEISHU_SETUP_FAILED";
      const state =
        code === "FEISHU_SETUP_EXPIRED" ? "expired" : code === "FEISHU_SETUP_CANCELED" ? "canceled" : "failed";
      try {
        await this.#database
          .update(imBindings)
          .set({
            setupState: state,
            lastErrorCode: code,
            setupOwnerInstanceId: null,
            setupOwnerHeartbeatAt: null,
            encryptedSetupContext: null,
            setupExpiresAt: null,
            updatedAt: this.#now(),
          })
          .where(
            and(
              eq(imBindings.setupAttemptId, attemptId),
              eq(imBindings.setupOwnerInstanceId, this.#instanceId),
              inArray(imBindings.setupState, ["awaiting_user", "validating"]),
            ),
          );
      } catch {
        this.#onDiagnostic("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED");
      }
    } finally {
      this.#registrations.delete(attemptId);
    }
  }

  /**
   * The save-first step. The SDK-returned credentials become a durable, versioned candidate before
   * any upstream validation runs; the previous working credential, identity and generation are not
   * touched. `awaiting_user`, the owning instance and the exact attempt are the admission fence, so
   * a late result can never replace a canceled, taken-over or already-validated attempt.
   */
  async #saveCandidate(
    attemptId: string,
    agentId: string,
    result: { appId: string; appSecret: string; teamBrand?: "feishu" | "lark" },
  ): Promise<SetupRow | undefined> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(imBindings)
        .where(
          and(
            eq(imBindings.setupAttemptId, attemptId),
            eq(imBindings.agentId, agentId),
            ne(imBindings.status, "disabled"),
          ),
        )
        .limit(1)
        .for("update");
      if (!row) return undefined;
      if (row.setupState !== "awaiting_user" || row.setupOwnerInstanceId !== this.#instanceId) {
        return undefined;
      }
      const now = this.#now();
      const candidate = this.#candidateContext({
        bindingId: row.id,
        attemptId,
        appId: result.appId,
        appSecret: result.appSecret,
        teamBrand: result.teamBrand ?? null,
        savedAt: now.toISOString(),
        nextCheckAt: now.toISOString(),
        observation: null,
      });
      const [updated] = await transaction
        .update(imBindings)
        .set({
          setupState: "pending_activation",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          encryptedSetupContext: encodeFeishuSetupCandidate(this.#cipher, candidate, row.id, attemptId),
          setupExpiresAt: new Date(now.getTime() + this.#timing.candidateTtlMs),
          lastErrorCode: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(imBindings.id, row.id),
            eq(imBindings.setupAttemptId, attemptId),
            eq(imBindings.setupState, "awaiting_user"),
            eq(imBindings.setupOwnerInstanceId, this.#instanceId),
          ),
        )
        .returning();
      return updated;
    });
  }

  /** The immediate post-save check; the long-running part is detached and supervised. */
  async #checkAttempt(row: SetupRow): Promise<void> {
    if (this.#stopped) return;
    const context = this.#decodeContext(row);
    const now = this.#now();
    if (context?.kind !== "candidate") {
      await this.#failInvalidContext(row);
      return;
    }
    if (this.#candidateExpired(row, now)) {
      await this.#expireCandidate(row, now);
      return;
    }
    if (row.setupState !== "pending_activation" || !this.#isDue(context.candidate, now)) return;
    await this.#startClaimedCheck(row, context.candidate, now, "detach");
  }

  /** Reserves one of the bounded check slots synchronously, before any asynchronous claim work. */
  #reserveCheckSlot(attemptId: string): boolean {
    if (this.#stopped || this.#canceledAttempts.has(attemptId)) return false;
    if (this.#reservations.has(attemptId) || this.#hasAttemptCheck(attemptId)) return false;
    if (this.#checks.size + this.#reservations.size >= this.#timing.maxConcurrentChecks) return false;
    this.#reservations.add(attemptId);
    return true;
  }

  #hasAttemptCheck(attemptId: string): boolean {
    for (const check of this.#checks.values()) {
      if (check.attemptId === attemptId) return true;
    }
    return false;
  }

  /**
   * Claim admission shared by the sweep, the explicit check and the immediate post-save check:
   * reserve a slot synchronously, take the exact-ciphertext claim, then run (bounded) or detach.
   */
  async #startClaimedCheck(
    row: SetupRow,
    candidate: FeishuSetupCandidateContext,
    now: Date,
    mode: "await" | "detach",
  ): Promise<void> {
    const attemptId = this.#attemptId(row);
    if (!this.#reserveCheckSlot(attemptId)) return;
    let claim: CandidateClaim | undefined;
    try {
      claim = await this.#claim(row, now);
    } catch (error) {
      this.#reservations.delete(attemptId);
      this.#canceledAttempts.delete(attemptId);
      throw error;
    }
    if (!claim) {
      this.#reservations.delete(attemptId);
      this.#canceledAttempts.delete(attemptId);
      return;
    }
    const run = this.#runClaimedCheck(claim, candidate, attemptId);
    if (mode === "await") {
      await run;
      return;
    }
    this.#trackDetached("FEISHU_SETUP_CHECK_FAILED", run, "provider", attemptId);
  }

  /** Exact-ciphertext CAS admission: one fresh claim token, one ownerless pending candidate. */
  async #claim(row: SetupRow, now: Date): Promise<CandidateClaim | undefined> {
    if (this.#stopped) return undefined;
    const claimUuid = randomUUID();
    const [claimed] = await this.#database
      .update(imBindings)
      .set({
        setupState: "validating",
        setupOwnerInstanceId: claimUuid,
        setupOwnerHeartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.id, row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(row)),
          eq(imBindings.setupState, "pending_activation"),
          isNull(imBindings.setupOwnerInstanceId),
          eq(imBindings.encryptedSetupContext, row.encryptedSetupContext ?? ""),
          gt(imBindings.setupExpiresAt, now),
        ),
      )
      .returning();
    return claimed ? { claimUuid, row: claimed } : undefined;
  }

  /**
   * Converts the reservation into a live check, or releases a claim whose attempt was canceled or
   * whose service stopped while the claim update was in flight. A stopped service never launches
   * new upstream work and a canceled attempt is never probed.
   */
  async #runClaimedCheck(
    claim: CandidateClaim,
    candidate: FeishuSetupCandidateContext,
    reservationAttemptId: string,
  ): Promise<void> {
    const attemptId = this.#attemptId(claim.row);
    this.#reservations.delete(reservationAttemptId);
    try {
      if (this.#stopped || this.#canceledAttempts.has(attemptId)) {
        await this.#releaseClaimToPending(claim);
        return;
      }
      await this.#executeClaimedCheck(claim, candidate);
    } finally {
      this.#canceledAttempts.delete(attemptId);
    }
  }

  /**
   * Runs one claimed check end to end under a wall-clock deadline. The claim stays in `#checks`
   * while the probe and the fenced activation run, so `stop()` and `cancel()` can abort the whole
   * operation; a fenced abort never settles or activates, and a deadline abort settles back to a
   * bounded wait while the exact-ciphertext fence keeps any late result from committing.
   */
  async #executeClaimedCheck(claim: CandidateClaim, candidate: FeishuSetupCandidateContext): Promise<void> {
    const attemptId = this.#attemptId(claim.row);
    const controller = new AbortController();
    this.#checks.set(claim.claimUuid, { attemptId, controller });
    const deadline = setTimeout(() => controller.abort(CHECK_DEADLINE_ABORT_REASON), this.#timing.checkDeadlineMs);
    deadline.unref?.();
    try {
      const outcome = await this.#probeAndActivate(claim, candidate, controller);
      if (outcome) await this.#settleClaim(claim, candidate, outcome);
    } finally {
      clearTimeout(deadline);
      this.#checks.delete(claim.claimUuid);
    }
  }

  /** Returns the outcome to settle, or undefined when activation committed or the claim was fenced. */
  async #probeAndActivate(
    claim: CandidateClaim,
    candidate: FeishuSetupCandidateContext,
    controller: AbortController,
  ): Promise<FeishuClaimedCheckOutcome | undefined> {
    let outcome = await this.#probeCandidate(claim, candidate, controller);
    const abortKind = checkAbortKind(controller);
    if (abortKind === "fenced") return undefined;
    if (abortKind === "deadline") return boundedWait();
    if (outcome.status !== "ready") return outcome;
    if (checkAbortKind(controller) !== "none") return undefined;
    try {
      if (this.#candidateExpired(claim.row, this.#now())) return { status: "expired" };
      if (!(await withCheckBound(this.#claimStillCurrent(claim), controller.signal))) return undefined;
      controller.signal.throwIfAborted();
      await withCheckBound(
        this.#activation.activateAtomicAttempt({
          attemptId: this.#attemptId(claim.row),
          ownerInstanceId: claim.claimUuid,
          agentId: claim.row.agentId,
          appId: candidate.appId,
          appSecret: candidate.appSecret,
          ...(candidate.teamBrand ? { teamBrand: candidate.teamBrand } : {}),
          ...(claim.row.setupExpiresAt ? { candidateExpiresAt: claim.row.setupExpiresAt } : {}),
          signal: controller.signal,
        }),
        controller.signal,
      );
      return undefined;
    } catch (error) {
      outcome = classifyFeishuCandidateFailure(error, this.#now().getTime());
    }
    if (checkAbortKind(controller) === "fenced") return undefined;
    return outcome.status === "ready" ? undefined : outcome;
  }

  /** Cancellation or takeover on another Server must fence the next external activation too. */
  async #claimStillCurrent(claim: CandidateClaim): Promise<boolean> {
    const [row] = await this.#database
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(
        and(
          eq(imBindings.id, claim.row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(claim.row)),
          eq(imBindings.setupState, "validating"),
          eq(imBindings.setupOwnerInstanceId, claim.claimUuid),
          eq(imBindings.encryptedSetupContext, claim.row.encryptedSetupContext ?? ""),
          gt(imBindings.setupExpiresAt, this.#now()),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async #probeCandidate(
    claim: CandidateClaim,
    candidate: FeishuSetupCandidateContext,
    controller: AbortController,
  ): Promise<FeishuClaimedCheckOutcome> {
    const probe = this.#activation.checkCandidate;
    if (!probe) return { status: "ready" };
    try {
      // `call` keeps the activation implementation's own `this`; passing the method around
      // unbound would break class-field private access.
      return await withCheckBound(
        probe.call(this.#activation, {
          agentId: claim.row.agentId,
          appId: candidate.appId,
          appSecret: candidate.appSecret,
          ...(candidate.teamBrand ? { teamBrand: candidate.teamBrand } : {}),
          signal: controller.signal,
        }),
        controller.signal,
      );
    } catch (error) {
      return classifyFeishuCandidateFailure(error, this.#now().getTime());
    }
  }

  /** Releases an in-flight claim whose service stopped or whose attempt was canceled. */
  async #releaseClaimToPending(claim: CandidateClaim): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({
        setupState: "pending_activation",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        updatedAt: this.#now(),
      })
      .where(
        and(
          eq(imBindings.id, claim.row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(claim.row)),
          eq(imBindings.setupState, "validating"),
          eq(imBindings.setupOwnerInstanceId, claim.claimUuid),
        ),
      );
  }

  /** Writes one claimed check outcome under the claim fence. */
  async #settleClaim(
    claim: CandidateClaim,
    candidate: FeishuSetupCandidateContext,
    outcome: FeishuClaimedCheckOutcome,
  ): Promise<void> {
    if (outcome.status === "fence-lost") return;
    const attemptId = this.#attemptId(claim.row);
    const now = this.#now();
    if (outcome.status === "expired") {
      await this.#finishClaim(claim, "expired", CANDIDATE_EXPIRED_CODE, now);
      return;
    }
    if (outcome.status === "terminal") {
      await this.#finishClaim(claim, "failed", outcome.errorCode, now);
      return;
    }
    if (outcome.status !== "waiting") return;
    const delay = Math.max(this.#timing.checkIntervalMs + this.#jitter(), outcome.retryAfterMs ?? 0);
    const next = this.#candidateContext({
      ...candidate,
      nextCheckAt: new Date(now.getTime() + delay).toISOString(),
      observation: {
        checkedAt: now.toISOString(),
        reason: outcome.reason,
        ...(outcome.missingScopes.length > 0 ? { missingScopes: outcome.missingScopes } : {}),
      },
    });
    try {
      await this.#database
        .update(imBindings)
        .set({
          setupState: "pending_activation",
          setupOwnerInstanceId: null,
          setupOwnerHeartbeatAt: null,
          encryptedSetupContext: encodeFeishuSetupCandidate(this.#cipher, next, claim.row.id, attemptId),
          updatedAt: now,
        })
        .where(
          and(
            eq(imBindings.id, claim.row.id),
            eq(imBindings.setupAttemptId, attemptId),
            eq(imBindings.setupState, "validating"),
            eq(imBindings.setupOwnerInstanceId, claim.claimUuid),
            eq(imBindings.encryptedSetupContext, claim.row.encryptedSetupContext ?? ""),
            gt(imBindings.setupExpiresAt, now),
          ),
        );
    } catch (error) {
      // The check completed but its outcome could not be persisted; name that specifically before
      // the supervisor records the broader detached-check failure.
      this.#onDiagnostic("FEISHU_SETUP_FAILURE_STATE_WRITE_FAILED");
      throw error;
    }
  }

  async #finishClaim(claim: CandidateClaim, state: "expired" | "failed", errorCode: string, now: Date): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({
        setupState: state,
        lastErrorCode: errorCode,
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.id, claim.row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(claim.row)),
          eq(imBindings.setupState, "validating"),
          eq(imBindings.setupOwnerInstanceId, claim.claimUuid),
        ),
      );
  }

  /**
   * One fair keyset sweep over every open Feishu setup row. The cursor advances by primary key and
   * is retained across bounded passes, so saturating the check slots or finding the head due again
   * cannot starve the tail; only a completed round resets it. The claim CAS keeps concurrent
   * instances from double-checking one candidate.
   */
  async #sweep(): Promise<void> {
    if (this.#stopped || this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (;;) {
        const page = await this.#sweepPage(this.#sweepCursor);
        this.#sweepCursor = page.lastProcessedId;
        if (page.done || page.saturated) return;
      }
    } finally {
      this.#sweeping = false;
    }
  }

  /** One keyset page; `lastProcessedId` is retained only while a bounded pass is cut short. */
  async #sweepPage(
    afterId: string | undefined,
  ): Promise<{ done: boolean; saturated: boolean; lastProcessedId?: string }> {
    const rows = await this.#database
      .select()
      .from(imBindings)
      .where(
        and(
          eq(imBindings.provider, "feishu"),
          ne(imBindings.status, "disabled"),
          inArray(imBindings.setupState, ["pending_activation", "validating"]),
          ...(afterId ? [gt(imBindings.id, afterId)] : []),
        ),
      )
      .orderBy(asc(imBindings.id))
      .limit(this.#timing.sweepPageSize);
    let lastProcessedId = afterId;
    for (const row of rows) {
      if (this.#stopped) return { done: true, saturated: false };
      if (this.#checks.size + this.#reservations.size >= this.#timing.maxConcurrentChecks) {
        return { done: false, saturated: true, lastProcessedId };
      }
      await this.#considerRow(row);
      lastProcessedId = row.id;
    }
    if (rows.length < this.#timing.sweepPageSize) return { done: true, saturated: false };
    return { done: false, saturated: false, lastProcessedId };
  }

  async #considerRow(row: SetupRow): Promise<void> {
    const now = this.#now();
    const context = this.#decodeContext(row);
    if (row.setupState === "pending_activation") {
      await this.#considerPendingRow(row, context, now);
      return;
    }
    if (context?.kind === "candidate") {
      await this.#considerValidatingCandidate(row, now);
      return;
    }
    if (!this.#ownerStale(row, now)) return;
    // An unreadable context is never a legacy QR: once its owner is gone the row is terminally
    // invalid instead of remaining validating forever.
    if (context === undefined) {
      await this.#failInvalidContext(row);
      return;
    }
    // A legacy QR validating row whose owner is gone can never complete: the projection already
    // reads it as restarted, so the sweep persists that terminal state rather than leaving the
    // dead claim behind forever.
    await this.#terminateOwnedAttempt(row, { state: "failed", code: "FEISHU_SETUP_OWNER_RESTARTED" }, now);
  }

  async #considerPendingRow(row: SetupRow, context: DecodedFeishuSetupContext | undefined, now: Date): Promise<void> {
    if (context?.kind !== "candidate") {
      await this.#failInvalidContext(row);
      return;
    }
    if (this.#candidateExpired(row, now)) {
      await this.#expireCandidate(row, now);
      return;
    }
    if (!this.#isDue(context.candidate, now)) return;
    await this.#startClaimedCheck(row, context.candidate, now, "detach");
  }

  async #considerValidatingCandidate(row: SetupRow, now: Date): Promise<void> {
    // Expiry dominates even a fresh owner: heartbeats from a hung check must not extend a lapsed
    // candidate past its retention deadline.
    if (this.#candidateExpired(row, now)) {
      await this.#expireCandidate(row, now);
      return;
    }
    const owner = row.setupOwnerInstanceId;
    if (owner && (this.#checks.has(owner) || !this.#ownerStale(row, now))) return;
    await this.#releaseStaleClaim(row, now);
  }

  /** Releases a stale (or ownerless) claimed candidate back to `pending_activation`, context intact. */
  async #releaseStaleClaim(row: SetupRow, now: Date): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({
        setupState: "pending_activation",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.id, row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(row)),
          eq(imBindings.setupState, "validating"),
          row.setupOwnerInstanceId
            ? eq(imBindings.setupOwnerInstanceId, row.setupOwnerInstanceId)
            : isNull(imBindings.setupOwnerInstanceId),
          row.setupOwnerHeartbeatAt
            ? eq(imBindings.setupOwnerHeartbeatAt, row.setupOwnerHeartbeatAt)
            : isNull(imBindings.setupOwnerHeartbeatAt),
        ),
      );
  }

  async #heartbeat(): Promise<void> {
    const owners: Promise<unknown>[] = [];
    const now = this.#now();
    if (this.#registrations.size > 0) {
      owners.push(
        this.#database
          .update(imBindings)
          .set({ setupOwnerHeartbeatAt: now })
          .where(
            and(eq(imBindings.setupOwnerInstanceId, this.#instanceId), eq(imBindings.setupState, "awaiting_user")),
          ),
      );
    }
    const claims = [...this.#checks.keys()];
    if (claims.length > 0) {
      owners.push(
        this.#database
          .update(imBindings)
          .set({ setupOwnerHeartbeatAt: now })
          .where(and(inArray(imBindings.setupOwnerInstanceId, claims), eq(imBindings.setupState, "validating"))),
      );
    }
    await Promise.all(owners);
  }

  #trackDetached(code: string, operation: Promise<unknown>, phase: "provider" | "scheduler", requestId?: string): void {
    const observed = operation.catch((error: unknown) => {
      this.#onDiagnostic(code);
      throw error;
    });
    if (this.#supervisor) {
      this.#supervisor.track(observed, {
        code,
        category: phase === "provider" ? "dependency" : "internal",
        retryability: "backoff",
        phase,
        ...(requestId ? { requestId } : {}),
        operation: "feishu.setup",
      });
      return;
    }
    void observed.catch(() => undefined);
  }

  async #reloadProjection(row: SetupRow): Promise<FeishuSetupAttempt> {
    const current = await this.#load(this.#attemptId(row));
    return this.#projectAttempt(current ?? row);
  }

  async #currentForAgent(
    agentId: string,
    executor: DatabaseClient | DatabaseTransaction = this.#database,
    forUpdate = false,
  ): Promise<SetupRow | undefined> {
    const query = executor
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (forUpdate) {
      const [row] = await query.for("update");
      return row;
    }
    const [row] = await query;
    return row;
  }

  /**
   * One guard for every Feishu setup command. A current binding owned by another Provider fails closed
   * with the structured unbind-required identity; there is no direct Provider switch. A declared
   * expectation must match the exact current binding and credential generation. Same-Provider
   * reauthorization and replacement stay legal; create never replaces a configured binding.
   */
  #assertMessagingStartAllowed(
    current: SetupRow | undefined,
    intent: FeishuSetupIntent,
    expectedMessaging: ImBindingMessagingExpectation | undefined,
  ): void {
    if (current && current.provider !== "feishu") {
      throw new ImBindingUnbindRequiredError({
        currentProvider: current.provider,
        currentBindingId: current.id,
        requestedProvider: "feishu",
      });
    }
    const configured = current && current.status !== "provisioning" ? current : undefined;
    this.#assertExpectationMatches(configured, expectedMessaging);
    this.#assertIntentAllowed(configured, intent);
  }

  #assertExpectationMatches(
    configured: SetupRow | undefined,
    expectedMessaging: ImBindingMessagingExpectation | undefined,
  ): void {
    if (!expectedMessaging) return;
    const stale = new ImBindingServiceError(
      "IM_BINDING_CONFIGURATION_CONFLICT",
      409,
      "The Agent's messaging connection changed since it was observed; refresh and try again",
    );
    if (expectedMessaging.kind === "unbound") {
      if (configured) throw stale;
      return;
    }
    if (
      !configured ||
      configured.provider !== expectedMessaging.provider ||
      configured.id !== expectedMessaging.bindingId ||
      configured.credentialGeneration !== expectedMessaging.credentialGeneration
    ) {
      throw stale;
    }
  }

  #assertIntentAllowed(configured: SetupRow | undefined, intent: FeishuSetupIntent): void {
    if (intent === "create" && configured) {
      throw new ImBindingServiceError(
        "IM_BINDING_CONFIGURATION_CONFLICT",
        409,
        "The Agent already has a configured Feishu connection; reauthorize, replace, or unbind it first",
      );
    }
    if (intent === "reauthorize" && !configured?.externalAppId) {
      throw new ImBindingServiceError(
        "IM_BINDING_CONFIGURATION_CONFLICT",
        409,
        "Feishu reauthorization requires a current configured binding",
      );
    }
    if (intent === "replace" && !configured) {
      throw new ImBindingServiceError(
        "IM_BINDING_CONFIGURATION_CONFLICT",
        409,
        "Feishu replacement requires a current configured binding",
      );
    }
  }

  async #load(attemptId: string): Promise<SetupRow | undefined> {
    const [row] = await this.#database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId))
      .limit(1);
    return row;
  }

  /** Terminates an owned attempt, fenced on the exact owner and heartbeat that were read. */
  async #terminateOwnedAttempt(
    row: SetupRow,
    outcome: { state: "failed" | "expired"; code: string },
    now: Date,
    executor: DatabaseClient | DatabaseTransaction = this.#database,
  ): Promise<void> {
    await executor
      .update(imBindings)
      .set({
        setupState: outcome.state,
        lastErrorCode: outcome.code,
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.id, row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(row)),
          inArray(imBindings.setupState, ["awaiting_user", "validating"]),
          row.setupOwnerInstanceId
            ? eq(imBindings.setupOwnerInstanceId, row.setupOwnerInstanceId)
            : isNull(imBindings.setupOwnerInstanceId),
          row.setupOwnerHeartbeatAt
            ? eq(imBindings.setupOwnerHeartbeatAt, row.setupOwnerHeartbeatAt)
            : isNull(imBindings.setupOwnerHeartbeatAt),
        ),
      );
  }

  /** An unreadable or non-candidate context on a stale row can never activate. */
  async #failInvalidContext(row: SetupRow): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({
        setupState: "failed",
        lastErrorCode: "FEISHU_SETUP_CONTEXT_INVALID",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: this.#now(),
      })
      .where(this.#invalidContextWhere(row));
  }

  async #failInvalidContextInTransaction(transaction: DatabaseTransaction, row: SetupRow, now: Date): Promise<void> {
    await transaction
      .update(imBindings)
      .set({
        setupState: "failed",
        lastErrorCode: "FEISHU_SETUP_CONTEXT_INVALID",
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: now,
      })
      .where(this.#invalidContextWhere(row));
  }

  #invalidContextWhere(row: SetupRow) {
    return and(
      eq(imBindings.id, row.id),
      eq(imBindings.setupAttemptId, this.#attemptId(row)),
      inArray(imBindings.setupState, ["pending_activation", "validating"]),
      or(
        eq(imBindings.setupState, "pending_activation"),
        and(
          eq(imBindings.setupState, "validating"),
          or(isNull(imBindings.setupOwnerHeartbeatAt), lt(imBindings.setupOwnerHeartbeatAt, this.#staleBefore())),
        ),
      ),
    );
  }

  /**
   * Ends a lapsed candidate: the retention deadline passed, so the secret is cleared atomically.
   * The write is fenced on the deadline itself rather than on owner liveness, so expiry dominates
   * a hung check that is still heartbeating.
   */
  async #expireCandidate(row: SetupRow, now: Date, transaction?: DatabaseTransaction): Promise<void> {
    const executor = transaction ?? this.#database;
    await executor
      .update(imBindings)
      .set({
        setupState: "expired",
        lastErrorCode: CANDIDATE_EXPIRED_CODE,
        setupOwnerInstanceId: null,
        setupOwnerHeartbeatAt: null,
        encryptedSetupContext: null,
        setupExpiresAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.id, row.id),
          eq(imBindings.setupAttemptId, this.#attemptId(row)),
          inArray(imBindings.setupState, ["pending_activation", "validating"]),
          lte(imBindings.setupExpiresAt, now),
        ),
      );
  }

  #abortClaimForAttempt(attemptId: string): void {
    for (const [claimUuid, check] of this.#checks) {
      if (check.attemptId !== attemptId) continue;
      check.controller.abort(CANCELED_ABORT_REASON);
      this.#checks.delete(claimUuid);
    }
  }

  #candidateContext(input: {
    bindingId: string;
    attemptId: string;
    appId: string;
    appSecret: string;
    teamBrand: "feishu" | "lark" | null;
    savedAt: string;
    nextCheckAt: string;
    observation: FeishuSetupCandidateContext["observation"];
  }): FeishuSetupCandidateContext {
    return {
      version: FEISHU_SETUP_CANDIDATE_VERSION,
      kind: FEISHU_SETUP_CANDIDATE_KIND,
      bindingId: input.bindingId,
      attemptId: input.attemptId,
      appId: input.appId,
      appSecret: input.appSecret,
      teamBrand: input.teamBrand,
      savedAt: input.savedAt,
      nextCheckAt: input.nextCheckAt,
      observation: input.observation,
    };
  }

  #decodeContext(row: SetupRow, options: { strict?: boolean } = {}): DecodedFeishuSetupContext | undefined {
    if (!row.encryptedSetupContext || !row.setupAttemptId) return undefined;
    return decodeFeishuSetupContext(this.#cipher, row.encryptedSetupContext, row.id, row.setupAttemptId, options);
  }

  #candidateExpired(row: SetupRow, now: Date): boolean {
    return row.setupExpiresAt !== null && row.setupExpiresAt.getTime() <= now.getTime();
  }

  #isDue(candidate: FeishuSetupCandidateContext, now: Date): boolean {
    return Date.parse(candidate.nextCheckAt) <= now.getTime();
  }

  #ownerStale(row: SetupRow, now: Date): boolean {
    return (
      !row.setupOwnerHeartbeatAt || row.setupOwnerHeartbeatAt.getTime() < now.getTime() - this.#timing.ownerStaleMs
    );
  }

  #staleBefore(): Date {
    return new Date(this.#now().getTime() - this.#timing.ownerStaleMs);
  }

  #jitter(): number {
    return Math.floor(this.#random() * this.#timing.checkJitterMs);
  }

  #qrOwnerLost(row: SetupRow, now: Date): boolean {
    const attemptId = row.setupAttemptId;
    return (
      !attemptId ||
      (row.setupOwnerInstanceId === this.#instanceId && !this.#registrations.has(attemptId)) ||
      !row.setupOwnerHeartbeatAt ||
      row.setupOwnerHeartbeatAt.getTime() < now.getTime() - this.#timing.ownerStaleMs
    );
  }

  #attemptId(row: SetupRow): string {
    if (!row.setupAttemptId) throw new Error("FEISHU_SETUP_NOT_FOUND");
    return row.setupAttemptId;
  }

  #attemptIdOrUndefined(row: SetupRow): string | undefined {
    return row.setupAttemptId ?? undefined;
  }

  #projectAttempt(row: SetupRow): FeishuSetupAttempt {
    const attempt = this.#toAttempt(row);
    const context = this.#decodeContext(row, { strict: true });
    const now = this.#now();
    switch (row.setupState) {
      case "awaiting_user":
        return this.#projectAwaitingUser(attempt, row, context, now);
      case "pending_activation":
        return this.#projectPendingCandidate(attempt, row, context, now);
      case "validating":
        return this.#projectValidating(attempt, row, context, now);
      default:
        return { ...attempt, qrUrl: null };
    }
  }

  #projectAwaitingUser(
    attempt: FeishuSetupAttempt,
    row: SetupRow,
    context: DecodedFeishuSetupContext | undefined,
    now: Date,
  ): FeishuSetupAttempt {
    if (row.setupExpiresAt && row.setupExpiresAt <= now) {
      return this.#terminal(attempt, "expired", "FEISHU_SETUP_EXPIRED", row.setupExpiresAt);
    }
    if (this.#qrOwnerLost(row, now)) {
      return this.#terminal(attempt, "failed", "FEISHU_SETUP_OWNER_RESTARTED", now);
    }
    return { ...attempt, qrUrl: context?.kind === "qr" ? context.qrUrl : null };
  }

  #projectPendingCandidate(
    attempt: FeishuSetupAttempt,
    row: SetupRow,
    context: DecodedFeishuSetupContext | undefined,
    now: Date,
  ): FeishuSetupAttempt {
    if (context?.kind !== "candidate" || !row.setupExpiresAt) {
      return this.#terminal(attempt, "failed", "FEISHU_SETUP_CONTEXT_INVALID", now);
    }
    if (this.#candidateExpired(row, now)) {
      return this.#terminal(attempt, "expired", CANDIDATE_EXPIRED_CODE, row.setupExpiresAt);
    }
    return { ...attempt, state: "pending_activation", qrUrl: null, activation: activationFrom(context.candidate) };
  }

  #projectValidating(
    attempt: FeishuSetupAttempt,
    row: SetupRow,
    context: DecodedFeishuSetupContext | undefined,
    now: Date,
  ): FeishuSetupAttempt {
    if (context?.kind === "candidate") {
      if (!row.setupExpiresAt) {
        return this.#terminal(attempt, "failed", "FEISHU_SETUP_CONTEXT_INVALID", now);
      }
      if (this.#candidateExpired(row, now)) {
        return this.#terminal(attempt, "expired", CANDIDATE_EXPIRED_CODE, row.setupExpiresAt);
      }
      const claimed = this.#checks.has(row.setupOwnerInstanceId ?? "");
      if (claimed || !this.#ownerStale(row, now)) {
        return {
          ...attempt,
          state: "validating",
          qrUrl: null,
          activation: activationFrom(context.candidate, "checking"),
        };
      }
      // A stale claim is recoverable: the durable candidate is still there, so the reader sees the
      // waiting projection while the sweep releases the claim.
      return { ...attempt, state: "pending_activation", qrUrl: null, activation: activationFrom(context.candidate) };
    }
    if (context === undefined) {
      return this.#terminal(attempt, "failed", "FEISHU_SETUP_CONTEXT_INVALID", now);
    }
    if (this.#qrOwnerLost(row, now)) {
      return this.#terminal(attempt, "failed", "FEISHU_SETUP_OWNER_RESTARTED", now);
    }
    return { ...attempt, qrUrl: context.qrUrl };
  }

  #terminal(attempt: FeishuSetupAttempt, state: "failed" | "expired", errorCode: string, at: Date): FeishuSetupAttempt {
    return { ...attempt, state, qrUrl: null, errorCode, completedAt: at.toISOString() };
  }

  #toAttempt(row: SetupRow): FeishuSetupAttempt {
    if (!row.setupAttemptId || !row.setupIntent || !row.setupState) throw new Error("FEISHU_SETUP_NOT_FOUND");
    const terminal = !isOpenSetupState(row.setupState);
    return {
      id: row.setupAttemptId,
      agentId: row.agentId,
      intent: row.setupIntent,
      state: row.setupState,
      qrUrl: null,
      expiresAt: (row.setupExpiresAt ?? row.updatedAt).toISOString(),
      errorCode: row.lastErrorCode,
      completedAt: terminal ? row.updatedAt.toISOString() : null,
      createdAt: row.updatedAt.toISOString(),
    };
  }
}

/** Projects the bounded public attempt view; the App secret and candidate ciphertext never appear. */
function activationFrom(
  candidate: FeishuSetupCandidateContext,
  reason?: FeishuSetupActivationReason,
): FeishuSetupActivation {
  return {
    appId: candidate.appId,
    reason: reason ?? candidate.observation?.reason ?? "checking",
    missingScopes: candidate.observation?.missingScopes ?? [],
    lastCheckedAt: candidate.observation?.checkedAt ?? null,
    nextCheckAt: candidate.nextCheckAt,
  };
}

function boundedWait(): FeishuCandidateCheckOutcome {
  return { status: "waiting", reason: "temporary_failure", missingScopes: [] };
}

function definedTiming(
  timing: FeishuSetupTiming | undefined,
): Partial<{ -readonly [K in keyof typeof DEFAULT_TIMING]: number }> {
  if (!timing) return {};
  const defined: Partial<{ -readonly [K in keyof typeof DEFAULT_TIMING]: number }> = {};
  for (const key of Object.keys(DEFAULT_TIMING) as (keyof typeof DEFAULT_TIMING)[]) {
    const value = timing[key];
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}
