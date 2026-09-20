import { randomUUID } from "node:crypto";
import {
  type EffectiveRuntimeSnapshot,
  RUNTIME_DEFAULT_MAX_DURATION_MS,
  RUNTIME_MAX_DURATION_MS,
  type RunnerCloudModelGrant,
  type RunnerCloudSessionMessageReceivedFrame,
  type RunnerCloudSessionMessageSettledFrame,
  type RuntimeDurableFailure,
  type RuntimeDurableWorkRecord,
  type RuntimeImOutboxContext,
  type SessionMessageDeliveryRequest,
} from "@opentag/shared";
import { and, eq, inArray, like } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imBindings,
  runtimeDurableWork,
  sandboxes,
  sessionMessages,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { RuntimeDispatchAdmission } from "../../runtime/runtime-domain-owner.js";
import {
  type CloudSessionWorkEnvelope,
  type CloudWorkAllocation,
  parseCloudSessionWorkEnvelope,
} from "../../runtime/runtime-durable-work-store.js";
import type { EffectiveRuntimeSnapshotAssembler } from "../runtime-config/index.js";
import type {
  RuntimeExecutionRegistryPort,
  SessionCliCloudProofAuthority,
  SessionCliCloudProofConnection,
  SessionCliProofService,
} from "../sessions/session-cli-proof-service.js";
import type { CloudSessionMessageOutcome } from "../sessions/session-collaboration-service.js";
import type { AuthorizedSessionMessageRoute, SessionService } from "../sessions/session-service.js";
import type { CloudModelGrantPort } from "./cloud-delivery-owner.js";
import { type CloudConnectionRecord, type CloudRuntimeFence, cloudInstanceIdFor } from "./cloud-runtime-fence.js";
import { CloudCapacityExceededError } from "./errors.js";
import { loadManagedSandboxBySessionId, loadSandboxRecordBySessionId } from "./owned-sandbox.js";
import type { RunnerControlSocket, RunnerHub } from "./runner-hub.js";
import type { IngressAllocationOutcome } from "./sandbox-runner-service.js";

/**
 * E8 Cloud Session collaboration owner. Dispatches authorized SessionMessages to the target
 * Session's own Cloud Sandbox Runner over the existing per-Sandbox control channel. There is no
 * Local reconcile step and no Computer WebSocket: the delivery boundary is the exact active
 * Sandbox allocation plus the exact execution-eligible Runner connection (the CloudRuntimeFence
 * record), and custody is the Runner's durable journal — `accepted` is answered only after the
 * Runner fsynced the message, matching the SessionMessage contract truthfully.
 *
 * Deliberately reused instead of rebuilt:
 * - sessionMessages logical id/idempotency, the dispatch admission lock, and the outcome
 *   recording stay in SessionService/SessionCollaborationService (this owner only transports);
 * - accepted work is recorded in the existing `runtime_durable_work` store under an explicit
 *   Cloud envelope (original request + allocation + turn), so the idle-reclaim/save barrier
 *   survives a Server restart, never depends on a best-effort terminal signal, and can be
 *   authoritatively retired when its allocation is gone;
 * - the model grant is the existing execution-scoped grant, minted at the verify boundary and
 *   revoked on every path that does not deliver it;
 * - the Session-CLI proof is minted by CloudDeliveryOwner at the ACTUAL credential execution
 *   open and correlated with that execution through the existing Runtime execution registry, so
 *   a finished Turn's proof can never be resurrected and a queued Turn never rotates an active
 *   Turn's proof.
 *
 * Session messages have no durable Turn columns by design: after `accepted`, execution custody is
 * the Runner journal plus the durable accepted record. Terminal state is committed only from an
 * acknowledged Runner journal terminal result, explicit cancellation, or authoritative
 * allocation retirement/replacement — never from a timer or a credential-liveness event.
 */

/** Cancel-frame correlation id: the logical message id (the cancel is message-scoped, not attempt-scoped). */
function dispatchRequestId(messageId: string): string {
  return messageId;
}

/** Bounded wait for the Runner's custody answer; aligned with the Local runtime request timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** The allocation ensure may outlive one HTTP read on a cold start; the wait is bounded and the durable reservation continues. */
const DEFAULT_ENSURE_TIMEOUT_MS = 20_000;
/** Grant transport allowance on top of the Turn budget (mirrors the IM delivery owner). */
const CLOUD_SESSION_GRANT_TRANSPORT_MS = 30_000;
/** Non-terminal durable work statuses: every one of them keeps the reclaim/save barrier. */
const UNSETTLED_DURABLE_STATUSES = ["accepted", "running", "retryable"] as const;

/** The verified frame this owner sends for one accepted receipt. */
type SessionMessageVerifiedFrame = {
  type: "session:message:verified";
  requestId: string;
  status: "verified";
  model: RunnerCloudModelGrant;
};

/**
 * The narrow durable-work surface: the existing Postgres store satisfies it. `read` is used only
 * to preserve/terminalize accepted Session work, never to invent a second record authority.
 */
export interface CloudSessionDurableWorkPort {
  write(computerId: string, record: RuntimeDurableWorkRecord): Promise<void>;
  read(
    computerId: string,
    kind: RuntimeDurableWorkRecord["kind"],
    key: string,
  ): Promise<RuntimeDurableWorkRecord | undefined>;
  /**
   * Compare-and-set custody replacement for a superseded Session-message record: replaces the row
   * with the fresh attempt's record only while the stored row still equals the exact record the
   * owner validated before its transaction. Absent only in degraded/test fixtures: custody
   * replacement then fails closed instead of borrowing a stale record.
   */
  replaceSessionMessageRecord?(
    computerId: string,
    expected: RuntimeDurableWorkRecord,
    record: RuntimeDurableWorkRecord,
  ): Promise<RuntimeDurableWorkRecord | undefined>;
}

/**
 * The proof authority the Cloud path of SessionCliProofService consults. Liveness is derived
 * exclusively from the existing Runtime credential execution registry: a proof is live only while
 * at least one actual execution correlated with it is open on the exact proof connection. A tiny
 * bounded per-Session correlation map is the only added state; registry close events remove it.
 */
export function createSessionCliCloudProofAuthority(input: {
  fence: CloudRuntimeFence;
  registry: RuntimeExecutionRegistryPort;
}): SessionCliCloudProofAuthority {
  interface ProofExecutionEntry {
    connectionId: string;
    executionIds: Set<string>;
    proofId: string;
  }
  const bySession = new Map<string, ProofExecutionEntry>();
  input.registry.onClose(({ executionId }) => {
    for (const [sessionId, entry] of bySession) {
      if (!entry.executionIds.delete(executionId)) continue;
      if (entry.executionIds.size === 0) bySession.delete(sessionId);
    }
  });
  return {
    connection(connectionId) {
      const record = input.fence.connectionById(connectionId);
      if (!record) return undefined;
      return {
        computerId: record.computerId,
        connectionId: record.connectionId,
        instanceId: record.instanceId,
        sandboxId: record.scope.sandboxId,
        sessionId: record.scope.sessionId,
        executionEligible: record.executionEligible,
        sessionCollaborationEligible: record.sessionCollaborationEligible,
      } satisfies SessionCliCloudProofConnection;
    },
    isProofLive: ({ sessionId, connectionId, proofId }) => {
      const entry = bySession.get(sessionId);
      if (!entry || entry.proofId !== proofId || entry.connectionId !== connectionId) return false;
      for (const executionId of entry.executionIds) {
        const record = input.registry.get(executionId);
        if (record && record.connectionId === connectionId) return true;
      }
      return false;
    },
    registerExecution: ({ connectionId, executionId, proofId, sessionId }) => {
      const existing = bySession.get(sessionId);
      const entry: ProofExecutionEntry =
        existing && existing.proofId === proofId
          ? existing
          : { connectionId, executionIds: new Set<string>(), proofId };
      entry.connectionId = connectionId;
      entry.executionIds.add(executionId);
      bySession.set(sessionId, entry);
    },
    dropExecution: ({ sessionId, proofId }) => {
      const entry = bySession.get(sessionId);
      if (!entry) return;
      if (proofId !== undefined && entry.proofId !== proofId) return;
      bySession.delete(sessionId);
    },
  };
}

/**
 * The `SessionService` Cloud source-authority verifier. A Cloud source Session's authority is the
 * exact current Runner connection named by its proof — never the logical always-online Computer.
 * Composition passes this as `SessionService`'s `cloudSourceConnection` option so proof-authenticated
 * `session create/send/list` calls are fenced at the same boundary as the dispatch itself.
 */
export function createCloudSourceConnectionVerifier(
  fence: CloudRuntimeFence,
): (input: { computerId: string; connectionInstanceId: string; sessionId: string }) => boolean {
  return ({ computerId, connectionInstanceId, sessionId }) => {
    const record = fence.connectionById(connectionInstanceId);
    return (
      record?.computerId === computerId &&
      record.scope.sessionId === sessionId &&
      record.executionEligible === true &&
      record.sessionCollaborationEligible === true
    );
  };
}

/** The exact allocation identity a tracked entry belongs to; reuses the durable envelope shape. */
type TrackedAllocation = CloudWorkAllocation;

function trackedAllocationKey(allocation: TrackedAllocation): string {
  return `${allocation.sandboxId}:${allocation.environmentGeneration}:${allocation.resourceName}`;
}

/**
 * In-memory per-allocation picture of accepted-unfinished Session collaboration work. Entries are
 * scoped to the exact allocation (Sandbox + environment generation + resource name) they were
 * registered under, so a replacement allocation created without any Session-collaboration
 * dispatch (the IM ingress path) never inherits a stale predecessor's busy state, and no
 * sweeper is needed to un-pin the same Sandbox id across generations. It is only a fast
 * pre-filter and cancellation index; the durable record is the authoritative reclaim/save
 * barrier, so this map deliberately carries no expiry and never decides completion.
 */
export class CloudSessionWorkTracker {
  readonly #byAllocation = new Map<string, Map<string, { turnId?: string }>>();

  register(allocation: TrackedAllocation, messageId: string, turnId?: string): void {
    const key = trackedAllocationKey(allocation);
    let entries = this.#byAllocation.get(key);
    if (!entries) {
      entries = new Map();
      this.#byAllocation.set(key, entries);
    }
    const existing = entries.get(messageId);
    const resolvedTurnId = turnId ?? existing?.turnId;
    entries.set(messageId, resolvedTurnId ? { turnId: resolvedTurnId } : {});
  }

  settle(allocation: TrackedAllocation, messageId: string): { turnId?: string } | undefined {
    const key = trackedAllocationKey(allocation);
    const entries = this.#byAllocation.get(key);
    if (!entries) return undefined;
    const removed = entries.get(messageId);
    entries.delete(messageId);
    if (entries.size === 0) this.#byAllocation.delete(key);
    return removed ? { ...(removed.turnId ? { turnId: removed.turnId } : {}) } : {};
  }

  /**
   * Settle only one exact Turn's registration. A newer attempt of the same message keeps its
   * entry: clearing by message alone would drop a live attempt's busy tracking together with the
   * retired allocation's.
   */
  settleTurn(allocation: TrackedAllocation, messageId: string, turnId: string): void {
    const key = trackedAllocationKey(allocation);
    const entries = this.#byAllocation.get(key);
    const existing = entries?.get(messageId);
    if (!entries || existing?.turnId !== turnId) return;
    entries.delete(messageId);
    if (entries.size === 0) this.#byAllocation.delete(key);
  }

  /**
   * Settle a failed dispatch's registration only while it never learned its Turn identity. A
   * registration that already merged live custody (a concurrent re-announcement of the accepted
   * entry) is preserved: the failed dispatch never owned that Turn.
   */
  settleUnassigned(allocation: TrackedAllocation, messageId: string): void {
    const key = trackedAllocationKey(allocation);
    const entries = this.#byAllocation.get(key);
    const existing = entries?.get(messageId);
    if (!entries || existing?.turnId !== undefined) return;
    entries.delete(messageId);
    if (entries.size === 0) this.#byAllocation.delete(key);
  }

  /** Clear every generation of one Sandbox (test/restart simulation only). */
  clearSandbox(sandboxId: string): void {
    for (const key of [...this.#byAllocation.keys()]) {
      if (key.startsWith(`${sandboxId}:`)) this.#byAllocation.delete(key);
    }
  }

  /** Approximate liveness for the fast pre-filter: exact allocation identity only. */
  isBusy(allocation: TrackedAllocation): boolean {
    return (this.#byAllocation.get(trackedAllocationKey(allocation))?.size ?? 0) > 0;
  }

  /** Any tracked work on any generation of one Sandbox (diagnostics/tests). */
  isSandboxBusy(sandboxId: string): boolean {
    const prefix = `${sandboxId}:`;
    for (const key of this.#byAllocation.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Every tracked message of one Sandbox across generations, for the explicit-stop cancellation path. */
  trackedMessages(sandboxId: string): { messageId: string; turnId?: string }[] {
    const prefix = `${sandboxId}:`;
    const tracked = new Map<string, { messageId: string; turnId?: string }>();
    for (const [key, entries] of this.#byAllocation) {
      if (!key.startsWith(prefix)) continue;
      for (const [messageId, entry] of entries) {
        if (!tracked.has(messageId)) {
          tracked.set(messageId, { messageId, ...(entry.turnId ? { turnId: entry.turnId } : {}) });
        }
      }
    }
    return [...tracked.values()];
  }
}

/** The narrow allocation surface; composition adapts the existing SandboxService/SandboxRunnerService. */
export interface CloudSessionCollaborationAllocationPort {
  /** Idempotent Session -> Sandbox ensure; undefined when the Session's authority chain is inactive. */
  ensureSandbox(sessionId: string): Promise<{ sandboxId: string; accountId: string } | undefined>;
  /** Existing bounded ingress allocation convergence. */
  ensureEnvironmentAllocated(input: { accountId: string; sandboxId: string }): Promise<IngressAllocationOutcome>;
}

export interface CloudSessionCollaborationOwnerOptions {
  database: DatabaseClient;
  fence: CloudRuntimeFence;
  hub: RunnerHub;
  work: CloudSessionWorkTracker;
  assembler: Pick<EffectiveRuntimeSnapshotAssembler, "assembleForSession">;
  /** Session-CLI proof revocation for Cloud Sessions; minting happens at the credential open. */
  proofs?: Pick<SessionCliProofService, "revokeForConnection" | "revokeForSession">;
  /** Accepted-outcome recording; the same attempt fencing as the Local path. */
  sessions?: Pick<SessionService, "recordMessageOutcome">;
  /** Existing durable work store; absent keeps the in-memory picture only (tests, degraded mode). */
  durableWork?: CloudSessionDurableWorkPort;
  modelGrants?: CloudModelGrantPort;
  modelBaseUrl?: string;
  allocation?: CloudSessionCollaborationAllocationPort;
  /** E7 business-activity clock; best-effort, never on heartbeats. */
  noteActivity?: (sandboxId: string) => Promise<void>;
  logger?: Pick<ServiceLogger, "error" | "warn">;
  now?: () => number;
  requestTimeoutMs?: number;
  ensureTimeoutMs?: number;
}

export type CloudSessionCancelOutcome = {
  messageId: string;
  /**
   * `requested` means the cancellation frame was handed to the exact Runner connection. It is NOT
   * a statement that execution stopped: drain/checkpoint/settlement still have to be observed.
   */
  status: "requested" | "no_connection" | "send_failed";
};

/** The dispatch could not reach a dispatchable Runner connection at the fenced boundary. */
class CloudSessionDispatchUnavailableError extends Error {
  readonly code = "runtime_not_ready";

  constructor() {
    super("The Session Sandbox Runner is not dispatchable");
    this.name = "CloudSessionDispatchUnavailableError";
  }
}

/** The Runner's custody answer did not arrive within the bounded request window. */
class CloudSessionDispatchTimeoutError extends Error {
  readonly code = "delivery_timeout";

  constructor() {
    super("The Session message dispatch timed out");
    this.name = "CloudSessionDispatchTimeoutError";
  }
}

/** The target Session's visible/internal role plus the bridge-derived nonsecret outbox context. */
export interface CloudSessionTargetEnvelope {
  readonly sessionKind: "internal" | "visible";
  readonly outboxContext?: RuntimeImOutboxContext;
}

export interface CloudSessionDeliveryInput {
  route: AuthorizedSessionMessageRoute;
  message: { id: string; content: string };
  runtime: EffectiveRuntimeSnapshot;
  /** The durable attempt fencing token from the dispatch authorization transaction. */
  attemptCount: number;
}

export class CloudSessionCollaborationOwner {
  readonly #database: DatabaseClient;
  readonly #fence: CloudRuntimeFence;
  readonly #hub: RunnerHub;
  readonly #work: CloudSessionWorkTracker;
  readonly #assembler: CloudSessionCollaborationOwnerOptions["assembler"];
  readonly #proofs?: CloudSessionCollaborationOwnerOptions["proofs"];
  readonly #sessions?: CloudSessionCollaborationOwnerOptions["sessions"];
  readonly #durableWork?: CloudSessionDurableWorkPort;
  readonly #modelGrants?: CloudModelGrantPort;
  readonly #modelBaseUrl?: string;
  readonly #allocation?: CloudSessionCollaborationAllocationPort;
  readonly #noteActivity?: (sandboxId: string) => Promise<void>;
  readonly #logger?: Pick<ServiceLogger, "error" | "warn">;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #ensureTimeoutMs: number;
  /** In-flight dispatches awaiting the Runner's journaled receipt, keyed by dispatch request id. */
  readonly #pending = new Map<
    string,
    {
      connectionId: string;
      resolve: (frame: RunnerCloudSessionMessageReceivedFrame) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Per-target-Session dispatch serialization: one in-flight dispatch keeps same-Session FIFO order. */
  readonly #tails = new Map<string, Promise<unknown>>();

  constructor(options: CloudSessionCollaborationOwnerOptions) {
    this.#database = options.database;
    this.#fence = options.fence;
    this.#hub = options.hub;
    this.#work = options.work;
    this.#assembler = options.assembler;
    this.#proofs = options.proofs;
    this.#sessions = options.sessions;
    this.#durableWork = options.durableWork;
    this.#modelGrants = options.modelGrants;
    this.#modelBaseUrl = options.modelBaseUrl;
    this.#allocation = options.allocation;
    this.#noteActivity = options.noteActivity;
    this.#logger = options.logger;
    this.#now = options.now ?? (() => Date.now());
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#ensureTimeoutMs = options.ensureTimeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
  }

  /**
   * Approximate in-memory busy pre-filter for one exact allocation (synchronous, consulted inside
   * the Sandbox row lock); the composition consults the tracker directly. Stale registrations on
   * a replaced allocation never count here or there.
   */
  isSandboxBusy(allocation: CloudWorkAllocation): boolean {
    return this.#work.isBusy(allocation);
  }

  /** Number of serialized per-Session dispatch tails; bounded by the caller-awaiting HTTP requests. */
  get activeDispatchTargets(): number {
    return this.#tails.size;
  }

  /* ------------------------------------------------------------------------------------------
   * Dispatch (Session collaboration service -> Runner)
   * ---------------------------------------------------------------------------------------- */

  async deliver(
    input: CloudSessionDeliveryInput,
    admission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame>,
  ): Promise<CloudSessionMessageOutcome> {
    const { route } = input;
    // Same-Session dispatches are serialized so the Runner journals them in call order (FIFO).
    const tail = this.#tails.get(route.targetSessionId) ?? Promise.resolve();
    const run: Promise<CloudSessionMessageOutcome> = tail.then(() => this.#deliverSerialized(input, admission));
    const next = run.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(route.targetSessionId, next);
    void next.finally(() => {
      if (this.#tails.get(route.targetSessionId) === next) this.#tails.delete(route.targetSessionId);
    });
    return run;
  }

  async #deliverSerialized(
    input: CloudSessionDeliveryInput,
    admission: RuntimeDispatchAdmission<RunnerCloudSessionMessageReceivedFrame>,
  ): Promise<CloudSessionMessageOutcome> {
    const { route, message } = input;
    const runtime = this.#resolveRuntimeModel(input.runtime);
    if (!runtime) return { status: "unreachable", code: "model_unavailable" };
    const envelope = await this.#loadTargetEnvelope(route.targetSessionId);
    if (!envelope) return { status: "unreachable", code: "outbox_unavailable" };
    // Authoritative retirement runs before placement: accepted work whose Instance is gone can
    // never execute, so it is retired here instead of blocking a replacement allocation forever.
    await this.reconcileSessionWork(route.targetSessionId);

    const ready = await this.#ensureReady(route.targetSessionId);
    if (ready.kind !== "ready") return ready.outcome;
    const sandbox = ready.sandbox;

    const request: SessionMessageDeliveryRequest = {
      type: "session:message:deliver",
      // A fresh request-attempt identity per dispatch: the Runner correlates this exact attempt
      // while its journal and execution dedup stay on the logical messageId. A retry with a stale
      // journaled entry can then be told apart from this attempt instead of timing out silently.
      requestId: randomUUID(),
      messageId: message.id,
      sourceSessionId: route.sourceSessionId,
      targetSessionId: route.targetSessionId,
      agentId: route.agentId,
      placementGeneration: route.targetPlacementGeneration,
      content: { kind: "text", text: message.content },
      runtime,
    };

    // The busy guard is registered under the exact current allocation before the frame leaves, so
    // an idle claim racing the dispatch under the Sandbox row lock sees the in-flight handoff;
    // every non-accepted exit settles it. A failure before custody releases only the dispatch's
    // own unassigned registration: custody a concurrent re-announcement already merged stays.
    const workAllocation: CloudWorkAllocation = {
      sandboxId: sandbox.id,
      environmentGeneration: sandbox.environmentGeneration,
      resourceName: sandbox.currentResourceName as string,
    };
    this.#work.register(workAllocation, message.id);
    let receipt: RunnerCloudSessionMessageReceivedFrame;
    try {
      const admitted = await admission(async (onDispatched) => {
        // Resolved INSIDE the authority admission: the freshest exact fenced connection is the
        // only legal dispatch target, and the admission's row locks prove the route's authority.
        const connection = this.#dispatchableConnection(sandbox);
        if (!connection) throw new CloudSessionDispatchUnavailableError();
        const socket = this.#socketFor(connection);
        if (!socket) throw new CloudSessionDispatchUnavailableError();
        const receiptPromise = this.#registerPending(connection, request.requestId);
        const sent = this.#hub.sendToCurrent(sandbox.id, socket, {
          type: "session:message:run",
          requestId: request.requestId,
          message: request,
          sessionKind: envelope.sessionKind,
          ...(envelope.outboxContext ? { outboxContext: envelope.outboxContext } : {}),
        });
        if (!sent) {
          this.#failPending(request.requestId, new CloudSessionDispatchUnavailableError());
          throw new CloudSessionDispatchUnavailableError();
        }
        await this.#recordActivity(sandbox.id);
        onDispatched();
        return receiptPromise;
      });
      if (!admitted.admitted) {
        this.#work.settleUnassigned(workAllocation, message.id);
        return { status: "unreachable", code: "runtime_unavailable" };
      }
      receipt = await admitted.result;
    } catch (error) {
      this.#work.settleUnassigned(workAllocation, message.id);
      if (error instanceof CloudSessionDispatchUnavailableError) {
        return { status: "unreachable", code: "runtime_not_ready" };
      }
      if (error instanceof CloudSessionDispatchTimeoutError) {
        return { status: "unknown", code: "delivery_timeout" };
      }
      throw error;
    }
    const result = await this.#settleReceipt(sandbox, receipt, request, input.attemptCount);
    if (result.status !== "accepted") this.#work.settleUnassigned(workAllocation, message.id);
    return result;
  }

  /**
   * The Runner's journaled answer. The receipt is a durable custody claim: the accepted outcome is
   * persisted and the durable work record written only now, BEFORE any permission frame leaves,
   * so the Runner can never open a credential execution against an outcome that is not yet
   * `accepted`. Every failure before the send revokes the grant and leaves the Runner's received
   * entry to the truthful re-announcement/rejection path (no verified frame reaches a stale
   * connection).
   */
  async #settleReceipt(
    sandbox: typeof sandboxes.$inferSelect,
    receipt: RunnerCloudSessionMessageReceivedFrame,
    request: SessionMessageDeliveryRequest,
    attemptCount: number,
  ): Promise<CloudSessionMessageOutcome> {
    if (receipt.status === "rejected") {
      return receipt.reason === "client_busy"
        ? { status: "unreachable", code: "capacity" }
        : { status: "rejected", code: receipt.reason };
    }
    const connection = this.#fence.connectionForSandbox(sandbox.id);
    if (!connection || !this.#isExactConnection(connection) || connection.executionEligible !== true) {
      return { status: "unreachable", code: "runtime_not_ready" };
    }
    const workAllocation: CloudWorkAllocation = {
      sandboxId: sandbox.id,
      environmentGeneration: sandbox.environmentGeneration,
      resourceName: sandbox.currentResourceName as string,
    };
    // The Turn is already running on the Runner (a retry answered for a started entry): custody
    // and the grant were delivered earlier, so this is a truthful duplicate acceptance. A
    // missing/conflicting record instead fails closed: nothing is registered and the running
    // Turn settles through its own re-announcement path.
    if (receipt.phase === "started") {
      const custody = await this.#ensureAcceptedCustody(connection, request, attemptCount, receipt.turnId);
      if (custody !== "accepted") return { status: "unreachable", code: "runtime_unavailable" };
      this.#work.register(workAllocation, receipt.messageId, receipt.turnId);
      return { status: "accepted" };
    }
    // A long cold-start wait may have spanned a configuration change. Re-read the current
    // configuration at the actual permission boundary and refuse to start with the stale frozen
    // snapshot; the Runner retires the entry and the source retries with fresh configuration.
    if (await this.#configurationChanged(request.targetSessionId, request.runtime)) {
      this.#rejectReceipt(connection, receipt, "stale_configuration");
      return { status: "unreachable", code: "stale_configuration" };
    }
    // Between the unlocked readiness read and this custody commit an idle claim may have won the
    // Sandbox row lock (its busy/barrier checks legitimately saw nothing yet). Re-verify under
    // the same row lock the claim takes: either this boundary sees the committed claim and
    // refuses custody — the Runner retires its entry so the reclaim drain converges and the
    // source retries — or the claim later sees the registered busy work and refuses itself. The
    // lock is taken alone here (no admission transaction or durable write is held across the
    // receipt wait), so there is no lock ordering or async deadlock to design around.
    if (!(await this.#allocationStillDispatchable(sandbox))) {
      this.#rejectReceipt(connection, receipt, "environment_reclaimed");
      return { status: "unreachable", code: "runtime_not_ready" };
    }
    const custody = await this.#ensureAcceptedCustody(connection, request, attemptCount, receipt.turnId);
    if (custody === "refused") {
      // A terminal duplicate or live custody belonging to another Turn/allocation: never borrow
      // it. The Runner's entry is retired so it cannot replay, and the source's next attempt
      // re-evaluates against the current record.
      this.#rejectReceipt(connection, receipt, "not_accepted");
      return { status: "unreachable", code: "runtime_unavailable" };
    }
    if (custody !== "accepted") return { status: "unreachable", code: "runtime_unavailable" };
    const budgetMs = turnBudgetMs(request.runtime);
    const verified = await this.#mintVerified(connection, receipt.turnId, receipt.requestId, {
      budgetMs,
      runtime: request.runtime,
    }).catch((error: unknown) => {
      this.#revokeGrant(receipt.turnId);
      throw error;
    });
    if (!verified) {
      return { status: "unreachable", code: "runtime_unavailable" };
    }
    this.#work.register(workAllocation, receipt.messageId, receipt.turnId);
    if (!this.#sendToConnection(connection, verified)) {
      this.#revokeGrant(receipt.turnId);
      this.#work.settleTurn(workAllocation, receipt.messageId, receipt.turnId);
      return { status: "unreachable", code: "runtime_unavailable" };
    }
    return { status: "accepted" };
  }

  /** True when the current assembled configuration no longer matches the frozen request snapshot. */
  async #configurationChanged(sessionId: string, frozen: EffectiveRuntimeSnapshot): Promise<boolean> {
    const assembled = await this.#assembleRuntime(sessionId);
    return assembled !== undefined && !sameRuntimeRevision(assembled, frozen);
  }

  /**
   * Record accepted custody before execution permission: the durable Cloud envelope is written
   * first (the restart/`allocation-loss` barrier) and `session_messages.lastOutcome=accepted` is
   * recorded second (what the credential execution open authorizes against). Both are committed
   * before any verified frame; a duplicate receipt for an already-accepted entry is idempotent.
   * `refused` means the existing record is a terminal duplicate or another attempt's live
   * custody: the caller must reject the receipt instead of borrowing the record.
   */
  async #ensureAcceptedCustody(
    connection: CloudConnectionRecord,
    request: SessionMessageDeliveryRequest,
    attemptCount: number,
    turnId: string,
  ): Promise<"accepted" | "unavailable" | "refused"> {
    const durable = await this.#writeDurableAccepted(connection, request, turnId);
    if (durable === "refused") return "refused";
    if (!durable) return "unavailable";
    const sessions = this.#sessions;
    if (sessions) {
      const updated = await sessions
        .recordMessageOutcome({
          attemptCount,
          messageId: request.messageId,
          outcome: "accepted",
        })
        .catch(() => false);
      if (!updated) return "unavailable";
    }
    if (!this.#isExactConnection(connection)) return "unavailable";
    return "accepted";
  }

  /**
   * Persist the accepted record for one receipt. Only an exact same-attempt record — same Turn
   * and same allocation, still non-terminal — is reused as current custody. The one replaceable
   * case is a superseded never-started entry re-journaled by the Runner on the SAME allocation
   * (see `custodyDecision`), and it is written as a compare-and-set against the exact record this
   * preflight read. Terminal records — including `allocation_retired`, which cannot prove the
   * lost Turn never executed — are immutable: custody is refused, never revived. Any other
   * existing record (another attempt's live custody on a different allocation, a legacy payload)
   * refuses instead of being borrowed, so an executed Turn can never lose its terminal record and
   * its ack.
   */
  async #writeDurableAccepted(
    connection: CloudConnectionRecord,
    request: SessionMessageDeliveryRequest,
    turnId: string,
  ): Promise<RuntimeDurableWorkRecord | "refused" | undefined> {
    const store = this.#durableWork;
    if (!store) return undefined;
    const key = durableKey(request.targetSessionId, request.messageId);
    const existing = await store.read(connection.computerId, "session-message", key).catch(() => undefined);
    const decision = custodyDecision(existing, connection, turnId);
    if (decision === "reuse") return existing;
    if (decision === "refuse") return "refused";
    const now = this.#now();
    const record: RuntimeDurableWorkRecord = {
      acceptedAt: now,
      attempts: 0,
      key,
      kind: "session-message",
      payload: {
        type: "cloud-session-message-work",
        request,
        allocation: {
          sandboxId: connection.scope.sandboxId,
          environmentGeneration: connection.scope.environmentGeneration,
          resourceName: connection.scope.resourceName,
        },
        turnId,
      } satisfies CloudSessionWorkEnvelope,
      status: "accepted",
      updatedAt: now,
    };
    if (decision === "write") {
      try {
        await store.write(connection.computerId, record);
        return record;
      } catch {
        // A concurrent writer may have created a record first; re-read and re-decide once.
        const raced = await store.read(connection.computerId, "session-message", key).catch(() => undefined);
        const retry = custodyDecision(raced, connection, turnId);
        if (retry === "reuse") return raced;
        if (retry === "refuse") return "refused";
        if (retry !== "replace") {
          this.#logger?.warn(
            { code: "CLOUD_SESSION_DURABLE_WRITE_FAILED", messageId: request.messageId },
            "Accepted Session work could not be persisted durably; the attempt stays retryable",
          );
          return undefined;
        }
        return this.#replaceDurableAccepted(store, connection, request.messageId, record, raced);
      }
    }
    return this.#replaceDurableAccepted(store, connection, request.messageId, record, existing);
  }

  /**
   * Atomically replace a superseded never-started record with this attempt's accepted record,
   * compare-and-set against the exact record the preflight validated. A concurrent writer (a
   * settlement, a re-announcement repair, another attempt) makes the store return undefined and
   * this attempt fails closed. The replaced Turn's grant is revoked: its entry is gone on the
   * Runner, so the grant must never outlive the custody it was minted against.
   */
  async #replaceDurableAccepted(
    store: CloudSessionDurableWorkPort,
    connection: CloudConnectionRecord,
    messageId: string,
    record: RuntimeDurableWorkRecord,
    replaced: RuntimeDurableWorkRecord | undefined,
  ): Promise<RuntimeDurableWorkRecord | undefined> {
    if (!store.replaceSessionMessageRecord || !replaced) {
      this.#logger?.warn(
        { code: "CLOUD_SESSION_DURABLE_WRITE_FAILED", messageId },
        "Accepted Session work could not replace a stale durable record; the attempt stays retryable",
      );
      return undefined;
    }
    try {
      const written = await store.replaceSessionMessageRecord(connection.computerId, replaced, record);
      if (!written) {
        // The record moved under the preflight: this attempt stays retryable and nothing is
        // overwritten.
        return undefined;
      }
      const replacedEnvelope = parseCloudSessionWorkEnvelope(replaced.payload);
      if (replacedEnvelope) this.#revokeGrant(replacedEnvelope.turnId);
      return written;
    } catch (error) {
      this.#logger?.warn(
        { code: "CLOUD_SESSION_DURABLE_WRITE_FAILED", messageId, err: error },
        "Accepted Session work could not replace a stale durable record; the attempt stays retryable",
      );
      return undefined;
    }
  }

  /**
   * Mint the execution-scoped model grant for one accepted receipt. The Session-CLI proof is NOT
   * delivered here: it is minted at the actual credential execution open inside the Runner
   * (CloudDeliveryOwner), which is the only place that proves the common worker reached its FIFO
   * head and opened a real execution. Returns undefined (with the grant revoked) when the exact
   * connection or the mint authority lapsed.
   */
  async #mintVerified(
    connection: CloudConnectionRecord,
    turnId: string,
    requestId: string,
    input: { budgetMs: number; runtime: EffectiveRuntimeSnapshot },
  ): Promise<SessionMessageVerifiedFrame | undefined> {
    const grants = this.#modelGrants;
    const baseUrl = this.#modelBaseUrl;
    const model = input.runtime.model;
    if (!grants || !baseUrl || !model) return undefined;
    if (!this.#isExactConnection(connection)) return undefined;
    const grant = await grants.issue({
      executionId: turnId,
      model,
      sandboxId: connection.scope.sandboxId,
      sessionId: connection.scope.sessionId,
      expiresAt: new Date(this.#now() + input.budgetMs + CLOUD_SESSION_GRANT_TRANSPORT_MS),
      supersedeRevoked: true,
    });
    if (!grant) return undefined;
    if (!this.#isExactConnection(connection)) {
      this.#revokeGrant(turnId);
      return undefined;
    }
    return {
      type: "session:message:verified",
      requestId,
      status: "verified",
      model: { baseUrl, expiresAt: grant.expiresAt.toISOString(), model, token: grant.token },
    };
  }

  /**
   * Ensure the target Session's Sandbox row exists and its current allocation is dispatch-ready.
   * A cold target is woken through the existing ingress allocation path; an environment that
   * cannot be ready yet is a truthful `runtime_not_ready` — the reservation is durable and the
   * next attempt picks it up.
   */
  async #ensureReady(
    targetSessionId: string,
  ): Promise<
    | { kind: "ready"; sandbox: typeof sandboxes.$inferSelect }
    | { kind: "unreachable"; outcome: CloudSessionMessageOutcome }
  > {
    const notReady: { kind: "unreachable"; outcome: CloudSessionMessageOutcome } = {
      kind: "unreachable",
      outcome: { status: "unreachable", code: "runtime_not_ready" },
    };
    const allocation = this.#allocation;
    let owned = await loadManagedSandboxBySessionId(this.#database, targetSessionId);
    if (!owned) {
      if (!allocation) return notReady;
      const ensured = await allocation.ensureSandbox(targetSessionId).catch(() => undefined);
      if (!ensured) return notReady;
      owned = await loadManagedSandboxBySessionId(this.#database, targetSessionId);
      if (!owned) return notReady;
    }
    const row = owned.sandbox;
    if (isDispatchReadySandbox(row)) return { kind: "ready", sandbox: row };
    if (!allocation) return notReady;
    const accountId = await this.#accountForSession(targetSessionId);
    if (!accountId) return notReady;
    const outcome = await this.#convergeAllocation(allocation, accountId, row.id);
    if (outcome === "restore_required") {
      // Previously used storage with no persistence: allocating would be a blank replacement.
      return { kind: "unreachable", outcome: { status: "rejected", code: "restore_required" } };
    }
    if (outcome === "capacity") {
      // Capacity admission rejected the NEW allocation this child needs: terminate the message
      // durably before any execution with a stable reason the source caller can plan around.
      // The rejected message id is terminal in SessionService; only a NEW logical message may
      // retry after resources become available.
      return { kind: "unreachable", outcome: { status: "rejected", code: "cloud_capacity_exceeded" } };
    }
    if (outcome !== "ready") return notReady;
    const converged = await loadManagedSandboxBySessionId(this.#database, targetSessionId);
    if (!converged || !isDispatchReadySandbox(converged.sandbox)) return notReady;
    return { kind: "ready", sandbox: converged.sandbox };
  }

  /**
   * The Sandbox row lock the idle claim takes, held only for this read: true when the allocation
   * observed at readiness is still current and unclaimed. Combined with the busy registration
   * made before the dispatch, this makes the dispatch/claim race serial in both directions — the
   * claim either sees the registered work and refuses, or commits first and is seen here.
   */
  async #allocationStillDispatchable(sandbox: typeof sandboxes.$inferSelect): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [locked] = await transaction
        .select({
          lifecycle: sandboxes.lifecycle,
          idleReclaimAt: sandboxes.idleReclaimAt,
          environmentGeneration: sandboxes.environmentGeneration,
          currentResourceName: sandboxes.currentResourceName,
        })
        .from(sandboxes)
        .where(eq(sandboxes.id, sandbox.id))
        .limit(1)
        .for("update");
      return (
        locked?.lifecycle === "ready" &&
        locked.idleReclaimAt === null &&
        locked.environmentGeneration === sandbox.environmentGeneration &&
        locked.currentResourceName === sandbox.currentResourceName
      );
    });
  }

  /**
   * Bounded cold-start convergence: the HTTP caller waits at most `ensureTimeoutMs`, while the
   * durable allocation reservation keeps converging for the next attempt.
   */
  async #convergeAllocation(
    allocation: CloudSessionCollaborationAllocationPort,
    accountId: string,
    sandboxId: string,
  ): Promise<IngressAllocationOutcome | "timeout" | "failed" | "capacity"> {
    const convergence = allocation.ensureEnvironmentAllocated({ accountId, sandboxId });
    // A rejected convergence is transient here: the durable reservation stays retryable.
    void convergence.catch(() => {
      this.#logger?.warn(
        { code: "CLOUD_SESSION_ALLOCATION_FAILED", sandboxId },
        "Cloud Session Sandbox allocation convergence failed; the input stays retryable",
      );
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        convergence.catch((error): "failed" | "capacity" =>
          error instanceof CloudCapacityExceededError ? "capacity" : "failed",
        ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.#ensureTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      // The race timer must not outlive a convergence that won first.
      clearTimeout(timer);
    }
  }

  async #accountForSession(sessionId: string): Promise<string | undefined> {
    const [row] = await this.#database
      .select({ accountId: agents.createdByUserId })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row?.accountId;
  }

  /**
   * The target's actual role and nonsecret outbox context, derived from the Session row and its
   * IM binding — never from instruction prose or from missing credentials. A visible target with
   * no active binding fails closed before any dispatch; an internal child never gets IM context.
   */
  async #loadTargetEnvelope(sessionId: string): Promise<CloudSessionTargetEnvelope | undefined> {
    const [row] = await this.#database
      .select({
        bindingStatus: imBindings.status,
        channelId: sessions.channelId,
        provider: imBindings.provider,
        sessionKind: sessions.kind,
        threadKey: sessions.threadKey,
        endedAt: sessions.endedAt,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row || row.endedAt !== null) return undefined;
    if (row.sessionKind === "internal") return { sessionKind: "internal" };
    if (row.bindingStatus !== "active") return undefined;
    const thread = row.threadKey ?? undefined;
    return {
      sessionKind: "visible",
      outboxContext:
        row.provider === "feishu"
          ? {
              provider: "feishu",
              sessionKind: row.sessionKind,
              chatId: row.channelId,
              ...(thread ? { threadId: thread } : {}),
            }
          : {
              provider: "slack",
              sessionKind: row.sessionKind,
              channelId: row.channelId,
              ...(thread ? { threadTs: thread } : {}),
            },
    };
  }

  /** The exact fenced, execution-eligible, collaboration-negotiated connection for the current ready allocation. */
  #dispatchableConnection(row: typeof sandboxes.$inferSelect): CloudConnectionRecord | undefined {
    const snapshot = this.#hub.describe(row.id);
    if (
      !snapshot.connected ||
      !snapshot.ready ||
      !snapshot.scope ||
      snapshot.scope.sessionId !== row.sessionId ||
      snapshot.scope.environmentGeneration !== row.environmentGeneration ||
      snapshot.scope.resourceName !== row.currentResourceName
    ) {
      return undefined;
    }
    const connection = this.#fence.connectionForSandbox(row.id);
    if (!connection || connection.instanceId !== cloudInstanceIdFor(snapshot.scope)) return undefined;
    if (connection.executionEligible !== true) return undefined;
    // Legacy E7 connections never negotiated E8: no session frame may ever reach them.
    if (connection.sessionCollaborationEligible !== true) return undefined;
    return connection;
  }

  #registerPending(
    connection: CloudConnectionRecord,
    requestId: string,
  ): Promise<RunnerCloudSessionMessageReceivedFrame> {
    const promise = new Promise<RunnerCloudSessionMessageReceivedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new CloudSessionDispatchTimeoutError());
      }, this.#requestTimeoutMs);
      timer.unref?.();
      this.#pending.set(requestId, { connectionId: connection.connectionId, resolve, reject, timer });
    });
    // The dispatch flow adopts this promise only after the send/activity hand-off completes; a
    // failed send, a timeout, or a disconnect inside that gap rejects it before any awaiter is
    // attached. Observing the rejection immediately can never change the rejected result the
    // adopter receives — it only keeps the gap from surfacing as an unhandled rejection.
    void promise.catch(() => undefined);
    return promise;
  }

  #failPending(requestId: string, error: Error): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  /* ------------------------------------------------------------------------------------------
   * Runner -> Server frames
   * ---------------------------------------------------------------------------------------- */

  /**
   * Runner custody receipt: the dispatch answer when a dispatch is pending, otherwise a reconnect
   * re-announcement. Re-announcements re-verify only work with recorded custody; a terminal
   * durable record makes the message definitively settled, so a retransmitted entry is retired
   * instead of ever executing a second time.
   */
  async handleReceived(
    connection: CloudConnectionRecord,
    frame: RunnerCloudSessionMessageReceivedFrame,
  ): Promise<void> {
    if (!this.#isExactConnection(connection)) return;
    // The pending dispatch correlates by its unique request-attempt identity; a receipt for any
    // older attempt (or a reconnect re-announcement) falls through to the re-announcement path.
    const pending = this.#pending.get(frame.requestId);
    if (pending && pending.connectionId === connection.connectionId) {
      this.#pending.delete(frame.requestId);
      clearTimeout(pending.timer);
      pending.resolve(frame);
      return;
    }
    if (frame.status !== "accepted") return;
    await this.#handleReannouncement(connection, frame);
  }

  async #handleReannouncement(
    connection: CloudConnectionRecord,
    frame: Extract<RunnerCloudSessionMessageReceivedFrame, { status: "accepted" }>,
  ): Promise<void> {
    const row = await this.#loadMessageAuthority(frame.messageId);
    if (!this.#isExactConnection(connection)) return;
    if (!row || row.targetSessionId !== connection.scope.sessionId) {
      // No such authorized message for this Session: retire the Runner's entry, never execute.
      this.#work.settle(connection.scope, frame.messageId);
      this.#rejectReceipt(connection, frame, "target_mismatch");
      return;
    }
    const durable = await this.#readDurable(connection.computerId, row.targetSessionId, frame.messageId);
    if (durable && isTerminalDurable(durable.status)) {
      // The message already reached a verified terminal outcome; retransmission must never
      // re-execute it. Only the exact settled Turn's registration may be cleared — never a newer
      // attempt's.
      const terminalEnvelope = parseCloudSessionWorkEnvelope(durable.payload);
      this.#work.settleTurn(connection.scope, frame.messageId, terminalEnvelope?.turnId ?? frame.turnId);
      this.#rejectReceipt(connection, frame, "not_accepted");
      return;
    }
    if (durable === undefined) {
      // No accepted custody record, so a settlement could never be committed or acked. That holds
      // for a never-accepted attempt and for an `accepted` outcome whose record is gone; either
      // way the journaled entry is retired instead of running blind, and the source's next
      // attempt re-dispatches cleanly. A current in-flight attempt's registration is untouched:
      // it has no Turn identity yet and belongs to a different attempt than this stale frame.
      this.#work.settleTurn(connection.scope, frame.messageId, frame.turnId);
      this.#rejectReceipt(connection, frame, "not_accepted");
      return;
    }
    const envelope = parseCloudSessionWorkEnvelope(durable.payload);
    if (!envelope || envelope.turnId !== frame.turnId) {
      // The record names a different Turn: this receipt belongs to a superseded attempt whose
      // entry the Runner already replaced (or should now retire). It must never be re-verified
      // into a second execution, and it must never clear the current attempt's occupancy.
      this.#work.settleTurn(connection.scope, frame.messageId, frame.turnId);
      this.#rejectReceipt(connection, frame, "not_accepted");
      return;
    }
    const stopped = row.sessionEndedAt !== null || row.agentStatus !== "active" || row.suspendedAt !== null;
    const sandbox = stopped ? undefined : await loadSandboxRecordBySessionId(this.#database, row.targetSessionId);
    if (!this.#isExactConnection(connection)) return;
    const retiring =
      stopped ||
      sandbox === undefined ||
      sandbox.lifecycle === "releasing" ||
      sandbox.lifecycle === "unallocated" ||
      sandbox.idleReclaimAt !== null;
    if (retiring) {
      // The authority chain can never let this Turn finish (stopped Session/Agent, suspended
      // user, or a draining allocation — the report-only reconnect case). Terminalizing custody
      // here would race the Turn's real outcome and strand the Runner's immutable journal entry
      // forever (the conflicting settlement can never be committed or acked). Instead request
      // cancellation — exactly like the explicit-stop path — and let the truthful settlement
      // terminalize and clear custody; a received entry answers `cancelled/not_started`, a
      // started Turn answers its real outcome.
      this.#work.register(connection.scope, frame.messageId, frame.turnId);
      this.#revokeGrant(frame.turnId);
      this.#sendToConnection(connection, {
        type: "session:message:cancel",
        messageId: frame.messageId,
        requestId: dispatchRequestId(frame.messageId),
      });
      return;
    }
    await this.#reverifyAcceptedCustody(connection, frame, row);
  }

  async #loadMessageAuthority(messageId: string): Promise<MessageAuthorityRow | undefined> {
    const [row] = await this.#database
      .select({
        outcome: sessionMessages.lastOutcome,
        attemptCount: sessionMessages.attemptCount,
        targetSessionId: sessionMessages.targetSessionId,
        sessionEndedAt: sessions.endedAt,
        agentStatus: agents.status,
        bindingStatus: imBindings.status,
        suspendedAt: users.suspendedAt,
        placementGeneration: sessionPlacements.generation,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(users, eq(users.id, agents.createdByUserId))
      .where(eq(sessionMessages.id, messageId))
      .limit(1);
    return row;
  }

  /**
   * Accepted custody. A live-started Turn only needs its liveness re-registered; a received
   * entry needs a fresh grant minted against the CURRENT authorization and placement.
   */
  async #reverifyAcceptedCustody(
    connection: CloudConnectionRecord,
    frame: Extract<RunnerCloudSessionMessageReceivedFrame, { status: "accepted" }>,
    row: MessageAuthorityRow,
  ): Promise<void> {
    const runtime = await this.#assembleRuntime(connection.scope.sessionId);
    const budgetMs = runtime ? turnBudgetMs(runtime) : RUNTIME_DEFAULT_MAX_DURATION_MS;
    this.#work.register(connection.scope, frame.messageId, frame.turnId);
    if (frame.phase === "started") return;
    if (row.bindingStatus !== "active") {
      // A transient IM reauthorization pauses new grants but never erases accepted custody: keep
      // the entry pending; the restored authority re-handshakes the Runner and re-announces.
      return;
    }
    if (connection.executionEligible !== true) return;
    if (!runtime) {
      // An assembly failure proves nothing about custody: stay silent and let the next
      // re-announcement re-verify, instead of falsely retiring the Runner's journaled entry
      // while the accepted record still exists.
      return;
    }
    if (row.outcome !== "accepted") {
      // A thrown repair error propagates (the connection closes and the Runner re-announces from
      // its retained journal); only a clean negative attempt fence may retire the entry.
      const repaired = await this.#sessions?.recordMessageOutcome({
        attemptCount: row.attemptCount,
        messageId: frame.messageId,
        outcome: "accepted",
      });
      if (this.#sessions && repaired === false) {
        this.#rejectReceipt(connection, frame, "not_accepted");
        return;
      }
    }
    if (!this.#isExactConnection(connection)) return;
    const verified = await this.#mintVerified(connection, frame.turnId, frame.requestId, { budgetMs, runtime });
    if (!verified) return;
    if (!this.#isExactConnection(connection)) {
      this.#revokeGrant(frame.turnId);
      return;
    }
    if (!this.#sendToConnection(connection, verified)) {
      this.#revokeGrant(frame.turnId);
    }
  }

  /**
   * Terminal settlement evidence. An ack is sent ONLY for an exact durable terminal commit: the
   * record must belong to this Session's current allocation and this exact Turn, and the outcome
   * must be newly committed (`recorded`) or already committed identically (`already_recorded`).
   * A missing/mismatched record, an uncommittable write, or a conflicting terminal state is never
   * falsely acked, so the Runner keeps its immutable result and replays it on reconnect.
   */
  async handleSettled(connection: CloudConnectionRecord, frame: RunnerCloudSessionMessageSettledFrame): Promise<void> {
    if (!this.#isExactConnection(connection)) return;
    // The request id is per-attempt correlation, not evidence: the durable fence is the exact
    // record keyed by message id plus the envelope's Turn and allocation identity.
    const existing = await this.#readDurable(connection.computerId, connection.scope.sessionId, frame.messageId);
    const envelope = existing ? parseCloudSessionWorkEnvelope(existing.payload) : undefined;
    if (
      !existing ||
      !envelope ||
      envelope.turnId !== frame.turnId ||
      envelope.allocation.sandboxId !== connection.scope.sandboxId ||
      envelope.allocation.environmentGeneration !== connection.scope.environmentGeneration ||
      envelope.allocation.resourceName !== connection.scope.resourceName
    ) {
      return;
    }
    const removed = this.#work.settle(connection.scope, frame.messageId);
    if (removed?.turnId) this.#revokeGrant(removed.turnId);
    const outcome = settledOutcome(frame.outcome);
    const committed = await this.#terminalizeDurable({
      ...outcome,
      computerId: connection.computerId,
      messageId: frame.messageId,
      sessionId: connection.scope.sessionId,
    });
    if (!committed) return;
    this.#sendToConnection(connection, {
      type: "session:message:settled:ack",
      messageId: frame.messageId,
      requestId: frame.requestId,
      status: committed,
      turnId: frame.turnId,
    });
    await this.#recordActivity(connection.scope.sandboxId);
  }

  #rejectReceipt(
    connection: CloudConnectionRecord,
    frame: Extract<RunnerCloudSessionMessageReceivedFrame, { status: "accepted" }>,
    code: string,
  ): void {
    this.#sendToConnection(connection, {
      type: "session:message:verified",
      requestId: frame.requestId,
      status: "rejected",
      code,
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Durable accepted work: reclaim barrier and authoritative recovery
   * ---------------------------------------------------------------------------------------- */

  /**
   * Non-terminal accepted Session work that still belongs to the exact allocation being claimed.
   * Evaluated inside the Sandbox claim transaction. A record whose allocation was retired or
   * replaced is not a barrier: its Runner journal is gone, so it can never execute and must not
   * pin a replacement environment. Records without the Cloud envelope (legacy Local shape) stay
   * conservative.
   */
  async hasUnsettledSessionWork(input: {
    allocation?: CloudWorkAllocation;
    sessionId: string;
    transaction?: DatabaseTransaction;
  }): Promise<boolean> {
    const executor = input.transaction ?? this.#database;
    // Only records written under the Session's own placement Computer are authoritative: a Local
    // runtime HTTP writer must never be able to inject work into a Cloud Session's barrier scope.
    const computerId = await this.#sessionComputerId(input.sessionId, executor);
    if (!computerId) return false;
    const rows = await executor
      .select({ payload: runtimeDurableWork.payload })
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, computerId),
          eq(runtimeDurableWork.kind, "session-message"),
          inArray(runtimeDurableWork.status, [...UNSETTLED_DURABLE_STATUSES]),
          like(runtimeDurableWork.recordKey, `${input.sessionId}:%`),
        ),
      );
    const allocation = input.allocation;
    if (!allocation) return rows.length > 0;
    return rows.some(({ payload }) => {
      const envelope = parseCloudSessionWorkEnvelope(payload);
      if (!envelope) return true;
      return allocationMatches(envelope.allocation, allocation);
    });
  }

  /**
   * Authoritative allocation-loss recovery. A non-terminal Cloud record whose recorded allocation
   * is gone or has been replaced by a new generation/resource can never execute again (the Runner
   * journal lived in that Instance), so it is terminalized conservatively as failed. Timeout is
   * never used as evidence, and terminal work is never replayed. Returns the retired count.
   */
  async reconcileSessionWork(sessionId: string): Promise<number> {
    const store = this.#durableWork;
    if (!store) return 0;
    const computerId = await this.#sessionComputerId(sessionId);
    if (!computerId) return 0;
    const rows = await this.#database
      .select({
        computerId: runtimeDurableWork.computerId,
        payload: runtimeDurableWork.payload,
        recordKey: runtimeDurableWork.recordKey,
      })
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, computerId),
          eq(runtimeDurableWork.kind, "session-message"),
          inArray(runtimeDurableWork.status, [...UNSETTLED_DURABLE_STATUSES]),
          like(runtimeDurableWork.recordKey, `${sessionId}:%`),
        ),
      );
    if (rows.length === 0) return 0;
    const sandbox = await loadSandboxRecordBySessionId(this.#database, sessionId);
    let retired = 0;
    for (const row of rows) {
      const envelope = parseCloudSessionWorkEnvelope(row.payload);
      if (!envelope) continue;
      const allocation = envelope.allocation;
      const current =
        sandbox !== undefined &&
        sandbox.id === allocation.sandboxId &&
        sandbox.environmentGeneration === allocation.environmentGeneration &&
        sandbox.currentResourceName === allocation.resourceName;
      if (current) continue;
      const messageId = row.recordKey.slice(sessionId.length + 1);
      const committed = await this.#terminalizeDurable({
        code: "allocation_retired",
        computerId: row.computerId,
        messageId,
        sessionId,
        status: "failed",
      });
      if (committed) {
        retired += 1;
        // Clear the in-memory picture for the exact retired Turn only: a newer attempt of the
        // same message keeps its busy registration, and a late settle from the old Turn can never
        // arrive (its Instance is gone), so nothing else will clear this entry.
        this.#work.settleTurn(allocation, messageId, envelope.turnId);
        this.#revokeGrant(envelope.turnId);
      }
    }
    return retired;
  }

  async #readDurable(
    computerId: string,
    sessionId: string,
    messageId: string,
  ): Promise<RuntimeDurableWorkRecord | undefined> {
    const store = this.#durableWork;
    if (!store) return undefined;
    // Read failures propagate, like the authority-load reads above the callers: the connection
    // handler closes on processing errors and the Runner reconnects and re-announces from its
    // retained journal. A transient failure must never look like proven absence here — that
    // would falsely retire accepted custody (or its settlement evidence) and strand its barrier.
    return store.read(computerId, "session-message", durableKey(sessionId, messageId));
  }

  /**
   * Terminalize one durable record after a verified fact. Only monotonic transitions are written;
   * a missing record or an identical already-terminal record is reported, while a conflicting
   * terminal state is never overwritten and never acked.
   */
  async #terminalizeDurable(input: {
    computerId: string;
    sessionId: string;
    messageId: string;
    status: "succeeded" | "failed";
    code?: string;
  }): Promise<"recorded" | "already_recorded" | undefined> {
    const store = this.#durableWork;
    if (!store) return undefined;
    const key = durableKey(input.sessionId, input.messageId);
    try {
      const existing = await store.read(input.computerId, "session-message", key);
      if (!existing) return undefined;
      if (isTerminalDurable(existing.status)) {
        return existing.status === input.status && existing.lastError?.code === input.code
          ? "already_recorded"
          : undefined;
      }
      const next: RuntimeDurableWorkRecord = {
        ...existing,
        status: input.status,
        updatedAt: Math.max(this.#now(), existing.updatedAt + 1),
      };
      if (input.code) {
        next.lastError = {
          category: "runtime",
          code: input.code,
          message: "The Session message Turn did not complete successfully",
          phase: "runtime",
          requestId: input.messageId,
          retryability: "terminal",
        } satisfies RuntimeDurableFailure;
      } else {
        delete next.lastError;
      }
      await store.write(input.computerId, next);
      return "recorded";
    } catch (error) {
      this.#logger?.warn(
        { code: "CLOUD_SESSION_DURABLE_SETTLE_FAILED", messageId: input.messageId, err: error },
        "Durable Session work could not be terminalized; the reclaim barrier stays conservative",
      );
      return undefined;
    }
  }

  /* ------------------------------------------------------------------------------------------
   * Explicit stop and connection loss
   * ---------------------------------------------------------------------------------------- */

  /**
   * Explicit Session stop. Cancellation is REQUESTED and authority is revoked; execution
   * termination is never assumed. The durable record and the in-memory picture are retained until
   * the Runner's terminal settlement is acknowledged or the recorded allocation is authoritatively
   * retired, so an idle/reuse claim can never free an environment whose tools may still be running.
   * Durable-only work (for example after a Server restart) is cancelled too, not just the tracked
   * in-memory messages.
   */
  async cancelSessionMessages(sessionId: string): Promise<CloudSessionCancelOutcome[]> {
    const outcomes: CloudSessionCancelOutcome[] = [];
    const sandbox = await loadSandboxRecordBySessionId(this.#database, sessionId);
    if (sandbox) {
      const record = this.#fence.connectionForSandbox(sandbox.id);
      for (const entry of await this.#pendingSessionMessages(sessionId, sandbox.id)) {
        outcomes.push(this.#requestCancellation(record, entry));
      }
      // Only work whose allocation is already authoritatively gone is retired here; every other
      // record keeps blocking until its exact Runner terminal evidence arrives.
      await this.reconcileSessionWork(sessionId);
    }
    await this.#proofs
      ?.revokeForSession(sessionId)
      .catch(() =>
        this.#logger?.warn({ code: "CLOUD_SESSION_PROOF_REVOKE_FAILED", sessionId }, "Session CLI proof revoke failed"),
      );
    return outcomes;
  }

  /**
   * Every unfinished Session message a stop must request cancellation for: the in-memory picture
   * plus durable-only envelopes after a Server restart. Durable records whose payload is a bare
   * Local request still contribute their message id (the grant is process-local and already gone).
   */
  async #pendingSessionMessages(
    sessionId: string,
    sandboxId: string,
  ): Promise<{ messageId: string; turnId?: string }[]> {
    const pending = new Map<string, { messageId: string; turnId?: string }>();
    for (const entry of this.#work.trackedMessages(sandboxId)) pending.set(entry.messageId, entry);
    for (const row of await this.#durableWorkRows(sessionId)) {
      const messageId = row.recordKey.slice(sessionId.length + 1);
      if (pending.has(messageId)) continue;
      const envelope = parseCloudSessionWorkEnvelope(row.payload);
      pending.set(messageId, envelope ? { messageId, turnId: envelope.turnId } : { messageId });
    }
    return [...pending.values()];
  }

  /** Revoke one Turn's grant and request cancellation on its exact owning connection. */
  #requestCancellation(
    record: CloudConnectionRecord | undefined,
    entry: { messageId: string; turnId?: string },
  ): CloudSessionCancelOutcome {
    if (entry.turnId) this.#revokeGrant(entry.turnId);
    if (!record || !this.#isExactConnection(record)) {
      return { messageId: entry.messageId, status: "no_connection" };
    }
    const sent = this.#sendToConnection(record, {
      type: "session:message:cancel",
      messageId: entry.messageId,
      requestId: dispatchRequestId(entry.messageId),
    });
    return { messageId: entry.messageId, status: sent ? "requested" : "send_failed" };
  }

  /**
   * Connection loss. Pending dispatches fail synchronously and the Session proof stops
   * authenticating synchronously through the credential registry close that precedes this call
   * (CloudDeliveryOwner teardown). The durable proof-row cleanup is asynchronous and its failures
   * are handled here, never at the teardown boundary.
   */
  detachConnection(connectionId: string): void {
    for (const [messageId, pending] of [...this.#pending.entries()]) {
      if (pending.connectionId !== connectionId) continue;
      this.#failPending(messageId, new CloudSessionDispatchUnavailableError());
    }
    void this.#proofs?.revokeForConnection(connectionId).catch(() => {
      this.#logger?.warn(
        { code: "CLOUD_SESSION_PROOF_REVOKE_FAILED", connectionId },
        "Session CLI proof connection revoke failed",
      );
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Small helpers
   * ---------------------------------------------------------------------------------------- */

  /**
   * The Session's placement Computer: the only scope whose durable records are authoritative.
   * Records a Local runtime writer creates under a different Computer can never enter a Cloud
   * Session's barrier or recovery scope.
   */
  async #sessionComputerId(
    sessionId: string,
    executor: DatabaseClient | DatabaseTransaction = this.#database,
  ): Promise<string | undefined> {
    const [placement] = await executor
      .select({ computerId: sessionPlacements.computerId })
      .from(sessionPlacements)
      .where(eq(sessionPlacements.sessionId, sessionId))
      .limit(1);
    return placement?.computerId;
  }

  /** Non-terminal durable rows for one Session under its own placement Computer. */
  async #durableWorkRows(sessionId: string): Promise<{ computerId: string; recordKey: string; payload: unknown }[]> {
    const computerId = await this.#sessionComputerId(sessionId);
    if (!computerId) return [];
    return this.#database
      .select({
        computerId: runtimeDurableWork.computerId,
        payload: runtimeDurableWork.payload,
        recordKey: runtimeDurableWork.recordKey,
      })
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, computerId),
          eq(runtimeDurableWork.kind, "session-message"),
          inArray(runtimeDurableWork.status, [...UNSETTLED_DURABLE_STATUSES]),
          like(runtimeDurableWork.recordKey, `${sessionId}:%`),
        ),
      );
  }

  #resolveRuntimeModel(runtime: EffectiveRuntimeSnapshot): EffectiveRuntimeSnapshot | undefined {
    const grants = this.#modelGrants;
    if (!grants || !this.#modelBaseUrl) return undefined;
    if (runtime.model && grants.isModelAllowed(runtime.model)) return runtime;
    if (runtime.model) return undefined;
    const fallback = grants.defaultModel;
    if (!grants.isModelAllowed(fallback)) return undefined;
    return { ...runtime, model: fallback };
  }

  async #assembleRuntime(sessionId: string): Promise<EffectiveRuntimeSnapshot | undefined> {
    try {
      const assembled = await this.#assembler.assembleForSession(sessionId);
      return this.#resolveRuntimeModel(assembled);
    } catch {
      return undefined;
    }
  }

  #revokeGrant(turnId: string): void {
    this.#modelGrants?.revokeExecution(turnId);
  }

  async #recordActivity(sandboxId: string): Promise<void> {
    const note = this.#noteActivity;
    if (!note) return;
    try {
      await note(sandboxId);
    } catch {
      this.#logger?.warn(
        { code: "CLOUD_SESSION_ACTIVITY_TOUCH_FAILED", sandboxId },
        "Sandbox business-activity clock update failed",
      );
    }
  }

  #isExactConnection(connection: CloudConnectionRecord): boolean {
    return this.#fence.isCurrent(connection.computerId, connection.instanceId, connection.connectionId);
  }

  #socketFor(connection: CloudConnectionRecord): RunnerControlSocket | undefined {
    if (this.#fence.connectionForSandbox(connection.scope.sandboxId)?.connectionId !== connection.connectionId) {
      return undefined;
    }
    if (connection.socket) {
      return this.#hub.isCurrent(connection.scope.sandboxId, connection.socket) ? connection.socket : undefined;
    }
    // Fence-only fixtures (tests/recovery snapshots) carry no socket; the hub's current socket is
    // only acceptable while this exact connection is still the fence's current one (checked above).
    return this.#hub.currentSocket(connection.scope.sandboxId);
  }

  #sendToConnection(connection: CloudConnectionRecord, frame: Parameters<RunnerHub["sendToCurrent"]>[2]): boolean {
    const socket = this.#socketFor(connection);
    if (!socket) return false;
    return this.#hub.sendToCurrent(connection.scope.sandboxId, socket, frame);
  }
}

interface MessageAuthorityRow {
  agentStatus: typeof agents.$inferSelect.status;
  attemptCount: number;
  bindingStatus: typeof imBindings.$inferSelect.status;
  outcome: typeof sessionMessages.$inferSelect.lastOutcome;
  placementGeneration: number;
  sessionEndedAt: Date | null;
  suspendedAt: Date | null;
  targetSessionId: string;
}

function durableKey(sessionId: string, messageId: string): string {
  return `${sessionId}:${messageId}`;
}

/** A ready Sandbox row with a live allocation and no pending reclaim claim. */
function isDispatchReadySandbox(row: typeof sandboxes.$inferSelect): boolean {
  return row.lifecycle === "ready" && row.currentResourceName !== null && row.idleReclaimAt === null;
}

function isTerminalDurable(status: RuntimeDurableWorkRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "dead-letter";
}

/**
 * The custody decision for one receipt against an existing durable record. `reuse` only an exact
 * same-attempt record (same Turn, same allocation, non-terminal). A terminal record is immutable
 * evidence and is never revived or replaced: `failed/allocation_retired` in particular proves
 * only that the allocation was lost while the record was unsettled — the Turn may or may not
 * have executed — so a retry must never replay it. The single replaceable case is a NON-terminal
 * record for a different Turn on the SAME exact allocation: the Runner journals a new Turn only
 * after retiring the old `received` entry, the journaled `started` boundary precedes any
 * execution, and a retired request id can never start — so the superseded record names a Turn
 * that provably never ran. The replacement itself is compare-and-set against the exact old record
 * inside the store transaction (`replaceSessionMessageRecord`), so a concurrent settlement or
 * re-announcement can never be overwritten after this preflight.
 */
function custodyDecision(
  existing: RuntimeDurableWorkRecord | undefined,
  connection: CloudConnectionRecord,
  turnId: string,
): "reuse" | "write" | "replace" | "refuse" {
  if (!existing) return "write";
  const envelope = parseCloudSessionWorkEnvelope(existing.payload);
  // A legacy/foreign payload shape stays a conservative barrier; it is never borrowed as custody.
  if (!envelope) return "refuse";
  // Terminal records are never replayed: the message already settled (possibly with real
  // execution effects, or with an unknowable state after allocation loss).
  if (isTerminalDurable(existing.status)) return "refuse";
  const sameTurn = envelope.turnId === turnId;
  const sameAllocation = allocationMatches(envelope.allocation, {
    sandboxId: connection.scope.sandboxId,
    environmentGeneration: connection.scope.environmentGeneration,
    resourceName: connection.scope.resourceName,
  });
  if (sameTurn) return sameAllocation ? "reuse" : "refuse";
  return sameAllocation ? "replace" : "refuse";
}

function allocationMatches(left: CloudWorkAllocation, right: CloudWorkAllocation): boolean {
  return (
    left.sandboxId === right.sandboxId &&
    left.environmentGeneration === right.environmentGeneration &&
    left.resourceName === right.resourceName
  );
}

/** The durable outcome for one acknowledged Runner terminal result; outcomes stay distinguishable. */
function settledOutcome(outcome: RunnerCloudSessionMessageSettledFrame["outcome"]): {
  status: "succeeded" | "failed";
  code?: string;
} {
  if (outcome === "completed") return { status: "succeeded" };
  if (outcome === "cancelled") return { status: "failed", code: "turn_cancelled" };
  if (outcome === "unknown") return { status: "failed", code: "turn_state_unknown" };
  return { status: "failed", code: "turn_failed" };
}

/** The frozen snapshot's exact configuration revision; a change means the permission must wait. */
function sameRuntimeRevision(left: EffectiveRuntimeSnapshot, right: EffectiveRuntimeSnapshot): boolean {
  return (
    left.revision.agent.id === right.revision.agent.id &&
    left.revision.agent.sequence === right.revision.agent.sequence &&
    left.revision.session.id === right.revision.session.id &&
    left.revision.session.sequence === right.revision.session.sequence
  );
}

/** The exact runtime budget for one Turn, bounded by the platform maximum (delivery deadline parity). */
function turnBudgetMs(runtime: EffectiveRuntimeSnapshot): number {
  const requested = runtime.budget?.maxDurationMs;
  const duration =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : RUNTIME_DEFAULT_MAX_DURATION_MS;
  return Math.min(Math.trunc(duration), RUNTIME_MAX_DURATION_MS);
}
