import { randomUUID } from "node:crypto";
import {
  computeDirectInputHash,
  computeTurnResultHash,
  type DirectImMessageDeliveryRequest,
  DirectImMessageDeliveryRequestSchema,
  type EffectiveRuntimeSnapshot,
  RUNTIME_CAPABILITY,
  type RunnerCloudModelGrant,
  type RuntimeCredentialClientFrame,
  type RuntimeCredentialServerFrame,
  type TurnReportRequest,
} from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  type sandboxes,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { RuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import type { RuntimeCredentialOwner } from "../../runtime-credentials/runtime-credential-owner.js";
import type { CloudModelGrantIssue } from "./cloud-model-grants.js";
import { type CloudConnectionRecord, type CloudRuntimeFence, cloudInstanceIdFor } from "./cloud-runtime-fence.js";
import { loadManagedSandboxBySessionId, loadSandboxRecordBySessionId } from "./owned-sandbox.js";
import type { RunnerControlSocket, RunnerHub, RunnerScope } from "./runner-hub.js";
import type { SandboxAllocationReconciliation } from "./sandbox-runner-service.js";

/**
 * E4 Session-scoped Cloud IM delivery owner. Routes claimed IM deliveries to the exact Sandbox
 * Runner of the Session over the E3 control channel, persists durable custody transitions on the
 * existing `im_message_deliveries` columns, and forwards #633 credential control frames to the
 * single `RuntimeCredentialOwner` over the composed Local + Cloud control authority (no second
 * credential authority lives here). Every durable transition is scope-fenced twice: the RunnerHub
 * scope (Sandbox + Session + environment generation + resource) and the exact per-attach
 * connection record from CloudRuntimeFence. The Local ConnectionRegistry and the logical Computer
 * online state are never touched; one Cloud Computer may hold many Session Runners concurrently.
 *
 * Durable sequence per delivery (mirrors the Local custody model):
 *   dispatchDelivery   -> beginDeliveryDispatch (dispatch columns persisted) + `delivery:run`
 *   handleReceived     -> acceptDelivery (state=accepted, turnId, report owner) + `delivery:verified`
 *   handleReport       -> recordTurn (turn_report/result_hash/reported_at) + `delivery:report:ack`
 * A receipt or report replay is idempotent. Accepted work is recovered from the PERSISTED
 * allocation identity (`reportOwnerInstanceId` vs `cloudInstanceIdFor`) — never from the presence
 * of an in-memory socket: a Server restart or transient disconnect keeps the turn pending, and
 * only a proven retired/superseded allocation (durable stop state or a verified physical absence)
 * may settle it as unknown without replay.
 */

export type CloudDispatchFailure =
  | "environment_not_ready"
  | "runner_not_ready"
  | "send_failed"
  | "dispatch_conflict"
  | "stale_generation"
  | "model_unavailable";

export class CloudDeliveryDispatchError extends Error {
  readonly code: CloudDispatchFailure;

  constructor(code: CloudDispatchFailure, message: string) {
    super(message);
    this.name = "CloudDeliveryDispatchError";
    this.code = code;
  }
}

/**
 * The Server-owned slice of the model grant service this owner depends on. Deliberately
 * structural so the model service can evolve (`defaultModel`, `expiresAt`) without this owner
 * reaching into its internals; revocation always goes through the injected dependency.
 */
export interface CloudModelGrantPort {
  /** First configured allowlisted model; the deployment default for an unspecified runtime model. */
  readonly defaultModel: string;
  isModelAllowed(model: string): boolean;
  issue(input: {
    executionId: string;
    sandboxId: string;
    sessionId: string;
    model: string;
    expiresAt?: Date;
  }): Promise<CloudModelGrantIssue | undefined>;
  revokeExecution(executionId: string): number;
}

export interface CloudDeliveryOwnerCredentialDeps {
  /** The one credential control owner; Local and Cloud frames share its authority chain. */
  owner: RuntimeCredentialOwner;
}

export interface CloudDeliveryOwnerOptions {
  custody: RuntimeCustodyStore;
  database: DatabaseClient;
  fence: CloudRuntimeFence;
  hub: RunnerHub;
  /** #633 credential stack; absent disables the credential tunnel (deliveries still dispatch). */
  credentials?: CloudDeliveryOwnerCredentialDeps;
  logger?: ServiceLogger;
  /** Public base URL of the model proxy (`{publicUrl}/api/v1/cloud-model`); required with grants. */
  modelBaseUrl?: string;
  /** Present exactly when the deployment model proxy is enabled. */
  modelGrants?: CloudModelGrantPort;
  /** Bounded physical allocation reconciliation from the existing SandboxRunnerService. */
  allocationStatus?: (sandboxId: string) => Promise<SandboxAllocationReconciliation | undefined>;
}

/** Transport allowance added to the dispatch deadline when minting an execution-scoped grant. */
const CLOUD_MODEL_GRANT_TRANSPORT_MS = 30_000;

export type CloudSessionCancelOutcome = {
  deliveryId: string;
  status: "cancelled" | "no_connection" | "send_failed";
};

export class CloudDeliveryOwner {
  readonly #credentials?: CloudDeliveryOwnerCredentialDeps;
  readonly #custody: RuntimeCustodyStore;
  readonly #database: DatabaseClient;
  readonly #fence: CloudRuntimeFence;
  readonly #hub: RunnerHub;
  readonly #logger?: ServiceLogger;
  readonly #modelBaseUrl?: string;
  readonly #modelGrants?: CloudModelGrantPort;
  readonly #allocationStatus?: (sandboxId: string) => Promise<SandboxAllocationReconciliation | undefined>;
  /**
   * Live model-grant ownership per turn: which connection is allowed to hand out or revoke this
   * turn's permission. `generation` distinguishes concurrent mint attempts on the same connection
   * so a late completion still counts as its own, while any attempt from a superseded connection
   * can never take over or clean up the replacement's permission.
   */
  readonly #grantOwnershipByTurn = new Map<string, { connectionId: string; generation: number }>();
  #grantGeneration = 0;
  /** Per-connection abort for in-flight credential broker calls. */
  readonly #signals = new Map<string, AbortController>();
  /** In-flight recovery queries awaiting the Runner's journaled answer. */
  readonly #pendingQueries = new Map<
    string,
    {
      connectionId: string;
      resolve: (phase: "none" | "received" | "started" | "reported" | undefined) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: CloudDeliveryOwnerOptions) {
    this.#credentials = options.credentials;
    this.#custody = options.custody;
    this.#database = options.database;
    this.#fence = options.fence;
    this.#hub = options.hub;
    this.#logger = options.logger;
    this.#modelBaseUrl = options.modelBaseUrl;
    this.#modelGrants = options.modelGrants;
    this.#allocationStatus = options.allocationStatus;
  }

  /* ------------------------------------------------------------------------------------------
   * Dispatch (worker -> Runner)
   * ---------------------------------------------------------------------------------------- */

  /**
   * Resolve the runtime snapshot against the deployment model allowlist BEFORE any dispatch
   * payload (and therefore any input hash) is frozen. An Agent without an explicit model uses the
   * deployment default; a model the deployment does not allow never reaches a Sandbox.
   */
  resolveRuntimeModel(runtime: EffectiveRuntimeSnapshot): EffectiveRuntimeSnapshot | undefined {
    const grants = this.#modelGrants;
    if (!grants || !this.#modelBaseUrl) return undefined;
    if (runtime.model && grants.isModelAllowed(runtime.model)) return runtime;
    if (runtime.model) return undefined;
    // The grant service owns the deployment default (first configured allowlisted model).
    const fallback = grants.defaultModel;
    if (!grants.isModelAllowed(fallback)) return undefined;
    return { ...runtime, model: fallback };
  }

  /** True when the deployment has a usable model path; allocation must not run without it. */
  isModelPathConfigured(): boolean {
    return Boolean(this.#modelGrants && this.#modelBaseUrl);
  }

  /** True when this exact model is admitted by the deployment allowlist. */
  isModelAllowed(model: string | undefined): boolean {
    return Boolean(model && this.#modelGrants?.isModelAllowed(model));
  }

  /**
   * Persist the dispatch columns and send `delivery:run` to the current Session Runner. A retry
   * with the same persisted dispatch re-sends the identical frame; the Runner dedupes by request
   * id through its journal. Throws CloudDeliveryDispatchError for every non-dispatched outcome.
   */
  async dispatchDelivery(input: {
    computerId: string;
    inputHash: string;
    installationId: string;
    request: DirectImMessageDeliveryRequest;
  }): Promise<void> {
    const request = input.request;
    const owned = await loadManagedSandboxBySessionId(this.#database, request.sessionId);
    if (!owned) throw new CloudDeliveryDispatchError("environment_not_ready", "The Session has no current Sandbox");
    const row = owned.sandbox;
    if (row.lifecycle !== "ready" || row.currentResourceName === null) {
      throw new CloudDeliveryDispatchError("environment_not_ready", "The Sandbox environment is not ready");
    }
    const snapshot = this.#hub.describe(row.id);
    if (
      !snapshot.connected ||
      !snapshot.ready ||
      !snapshot.scope ||
      snapshot.scope.sessionId !== request.sessionId ||
      snapshot.scope.environmentGeneration !== row.environmentGeneration ||
      snapshot.scope.resourceName !== row.currentResourceName
    ) {
      throw new CloudDeliveryDispatchError("runner_not_ready", "No ready Runner is attached to the Sandbox");
    }
    if (!this.#modelGrants || !this.#modelBaseUrl) {
      throw new CloudDeliveryDispatchError("model_unavailable", "The deployment model path is not configured");
    }
    if (!this.#modelGrants.isModelAllowed(request.runtime.model ?? "")) {
      throw new CloudDeliveryDispatchError("model_unavailable", "The Session model is not allowlisted");
    }
    const connection = this.#fence.connectionForSandbox(row.id);
    if (!connection || connection.instanceId !== cloudInstanceIdFor(snapshot.scope)) {
      throw new CloudDeliveryDispatchError("runner_not_ready", "The Runner connection is not fenced");
    }
    const socket = this.#socketFor(connection);
    if (!socket) throw new CloudDeliveryDispatchError("runner_not_ready", "The Runner connection was replaced");
    const dispatch = await this.#custody.beginDeliveryDispatch(request, input.inputHash, {
      computerId: input.computerId,
      instanceId: connection.instanceId,
    });
    if (dispatch === "stale_generation") {
      throw new CloudDeliveryDispatchError("stale_generation", "The delivery placement generation is stale");
    }
    if (dispatch === "conflict") {
      throw new CloudDeliveryDispatchError("dispatch_conflict", "The delivery dispatch state conflicts");
    }
    const sent = this.#hub.sendToCurrent(row.id, socket, {
      type: "delivery:run",
      requestId: request.requestId,
      delivery: request,
    });
    if (!sent) throw new CloudDeliveryDispatchError("send_failed", "The Runner control channel is not writable");
  }

  /* ------------------------------------------------------------------------------------------
   * Receipt -> durable custody -> verified
   * ---------------------------------------------------------------------------------------- */

  async handleDeliveryReceived(
    connection: CloudConnectionRecord,
    frame: { deliveryId: string; requestId: string; turnId: string },
  ): Promise<void> {
    if (!this.#isExactConnection(connection)) return;
    const scopeCheck = await this.#loadDispatchForScope(connection, frame.deliveryId, frame.requestId);
    if (!scopeCheck) {
      this.#sendVerified(connection, frame.requestId, "rejected", "dispatch_unknown");
      return;
    }
    // After the awaited read: the connection must still be the exact current one, and the
    // Session's PERSISTED allocation must still be the scope this connection attached with. A
    // Session placement can lag behind a new environment generation; the dispatch columns alone
    // cannot prove the accepted work belongs to the current resource.
    if (!this.#isExactConnection(connection)) return;
    const sandbox = await this.#loadCurrentAllocation(connection);
    if (!this.#isExactConnection(connection)) return;
    if (!sandbox) {
      this.#sendVerified(connection, frame.requestId, "rejected", "stale_generation");
      return;
    }
    const { request } = scopeCheck;
    const inputHash = computeDirectInputHash(request);
    const custody = await this.#custody.acceptDelivery(request, inputHash, frame.turnId, this.#context(connection));
    if (custody !== "accepted" && custody !== "already_accepted") {
      this.#sendVerified(connection, frame.requestId, "rejected", custody);
      return;
    }
    // Revalidate the FULL current authorization immediately around the async mint: exact
    // connection, current allocation, active Session/Agent chain, and unfinished custody. Only
    // then may an accepted turn whose permission was revoked by a lost connection rotate it.
    const custodyRef = { deliveryId: frame.deliveryId, turnId: frame.turnId };
    if (!(await this.#canAuthorizeExecution(connection, custodyRef))) return;
    const grant = await this.#mintModelGrant(connection, frame.turnId, request, { supersedeRevoked: true });
    if (!grant) {
      this.#sendVerified(connection, frame.requestId, "rejected", "model_unavailable");
      return;
    }
    // The exact socket is frozen with the connection record: a replacement connection that owns
    // the same Sandbox id must never receive the superseded turn's execution permission. The
    // full authorization (including unfinished custody) is re-checked AFTER the grant await,
    // because a stop, report, or replacement may have landed while the permission was minting.
    if (!(await this.#canAuthorizeExecution(connection, custodyRef))) {
      this.#revokeIfOwned(frame.turnId, connection.connectionId);
      return;
    }
    const frameWithGrant = this.#verifiedFrame(frame.requestId, "verified", undefined, grant);
    if (!this.#sendToConnection(connection, frameWithGrant)) {
      this.#revokeIfOwned(frame.turnId, connection.connectionId);
    }
  }

  async #mintModelGrant(
    connection: CloudConnectionRecord,
    turnId: string,
    request: DirectImMessageDeliveryRequest,
    options: { supersedeRevoked?: boolean } = {},
  ): Promise<RunnerCloudModelGrant | undefined> {
    const grants = this.#modelGrants;
    const baseUrl = this.#modelBaseUrl;
    const model = request.runtime.model;
    if (!grants || !baseUrl || !model) return undefined;
    const expiresAt = this.#resolveMintExpiry(request);
    if (!expiresAt) return undefined;
    // Only the exact current connection may mint for this turn. Claim it before the async mint so
    // a superseded connection's late completion can never take over or revoke the replacement's
    // permission; the grant service itself is idempotent per execution identity.
    if (!this.#isExactConnection(connection)) return undefined;
    const ownership = { connectionId: connection.connectionId, generation: ++this.#grantGeneration };
    this.#grantOwnershipByTurn.set(turnId, ownership);
    const issued = await grants.issue({
      executionId: turnId,
      model,
      sandboxId: connection.scope.sandboxId,
      sessionId: connection.scope.sessionId,
      expiresAt,
      ...(options.supersedeRevoked ? { supersedeRevoked: true } : {}),
    });
    return this.#resolveMintOutcome({ baseUrl, connection, issued, model, ownership, turnId });
  }

  /** The exact bounded permission window: the frozen dispatch deadline plus transport allowance. */
  #resolveMintExpiry(request: DirectImMessageDeliveryRequest): Date | undefined {
    const deadlineMs = request.deadlineAt === undefined ? Number.NaN : Date.parse(request.deadlineAt);
    if (!Number.isFinite(deadlineMs)) return undefined;
    // An already-expired window never becomes a fresh permission.
    const expiresAt = new Date(deadlineMs + CLOUD_MODEL_GRANT_TRANSPORT_MS);
    return expiresAt.getTime() <= Date.now() ? undefined : expiresAt;
  }

  /**
   * Decide the outcome of one async mint against the CURRENT ownership: only the connection that
   * still owns the turn may receive the permission. A late generation from a superseded connection
   * is dropped without revoking the replacement's live token, and a terminal revoke (missing
   * ownership) kills the orphaned generation.
   */
  #resolveMintOutcome(input: {
    baseUrl: string;
    connection: CloudConnectionRecord;
    issued: { expiresAt: Date; token: string } | undefined;
    model: string;
    ownership: { connectionId: string; generation: number };
    turnId: string;
  }): RunnerCloudModelGrant | undefined {
    const current = this.#grantOwnershipByTurn.get(input.turnId);
    if (!input.issued) {
      if (current?.generation === input.ownership.generation) this.#grantOwnershipByTurn.delete(input.turnId);
      return undefined;
    }
    if (!current || current.connectionId !== input.connection.connectionId) {
      // The turn was terminally revoked (report/stop/unknown) or handed to a replacement while
      // this mint was in flight: with no owner the late generation is orphaned and unreachable,
      // with an owner it belongs to that connection and must not be revoked here.
      if (!current) this.#modelGrants?.revokeExecution(input.turnId);
      return undefined;
    }
    if (!this.#isExactConnection(input.connection)) {
      // This connection ended while signing and no replacement claimed the turn yet: release the
      // claim and kill the generation this call produced (it can never be delivered).
      if (current.generation === input.ownership.generation) {
        this.#grantOwnershipByTurn.delete(input.turnId);
        this.#modelGrants?.revokeExecution(input.turnId);
      }
      return undefined;
    }
    return {
      baseUrl: input.baseUrl,
      expiresAt: input.issued.expiresAt.toISOString(),
      model: input.model,
      token: input.issued.token,
    };
  }

  #verifiedFrame(
    requestId: string,
    status: "verified" | "rejected",
    code?: string,
    model?: RunnerCloudModelGrant,
  ): RuntimeServerVerifiedFrame {
    return {
      type: "delivery:verified",
      requestId,
      status,
      ...(code ? { code } : {}),
      ...(model ? { model } : {}),
    };
  }

  #sendVerified(
    connection: CloudConnectionRecord,
    requestId: string,
    status: "verified" | "rejected",
    code?: string,
    model?: RunnerCloudModelGrant,
  ): void {
    this.#sendToConnection(connection, this.#verifiedFrame(requestId, status, code, model));
  }

  /* ------------------------------------------------------------------------------------------
   * Turn Report -> durable record -> ack
   * ---------------------------------------------------------------------------------------- */

  async handleDeliveryReport(
    connection: CloudConnectionRecord,
    frame: { requestId: string; report: TurnReportRequest },
  ) {
    const { report } = frame;
    if (!this.#isExactConnection(connection)) return;
    // The accepted turn's report stays recordable after an explicit Session end (durable custody
    // plus the exact prior allocation identity is the authority), but it must still belong to the
    // connection's OWN allocation. `recordTurn` re-checks turnId/reportOwnerInstanceId.
    const sandbox = await this.#loadCurrentAllocation(connection, { allowReleasing: true });
    if (!this.#isExactConnection(connection)) return;
    if (!sandbox) {
      this.#sendReportAck(connection, frame.requestId, report, "stale_generation", report.turnId);
      return;
    }
    const status = await this.#custody.recordTurn(report, this.#context(connection));
    const mapped: "recorded" | "already_recorded" | "conflict" | "stale_generation" =
      status === "recorded" || status === "already_recorded" || status === "stale_generation" ? status : "conflict";
    if (mapped === "recorded" || mapped === "already_recorded") {
      this.#revokeTurnGrants(report.turnId);
    }
    this.#sendReportAck(connection, frame.requestId, report, mapped, report.turnId);
    if (mapped === "conflict" || mapped === "stale_generation") {
      this.#logger?.warn(
        { code: "CLOUD_DELIVERY_REPORT_REJECTED", deliveryId: report.deliveryId, status: mapped },
        "Cloud Turn Report rejected by durable custody",
      );
    }
  }

  #sendReportAck(
    connection: CloudConnectionRecord,
    requestId: string,
    report: TurnReportRequest,
    status: "recorded" | "already_recorded" | "conflict" | "stale_generation",
    turnId: string,
  ): void {
    this.#sendToConnection(connection, {
      type: "delivery:report:ack",
      requestId,
      resultHash: report.resultHash,
      status,
      turnId,
    });
  }

  /* ------------------------------------------------------------------------------------------
   * Stop and orphan reconciliation
   * ---------------------------------------------------------------------------------------- */

  /**
   * Explicit Session stop: revoke the privileges of every accepted-unreported turn (model grants
   * and credential executions) and best-effort cancel the owning turn on the exact allocation that
   * accepted it. Returns one meaningful outcome per delivery; a lost socket is `no_connection` and
   * stays reconcilable through `recoverAccepted`'s durable stopped-state route, never silent.
   */
  async cancelSessionDeliveries(sessionId: string): Promise<CloudSessionCancelOutcome[]> {
    const rows = await this.#database
      .select({
        id: imMessageDeliveries.id,
        turnId: imMessageDeliveries.turnId,
        reportOwnerInstanceId: imMessageDeliveries.reportOwnerInstanceId,
      })
      .from(imMessageDeliveries)
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          eq(imMessageDeliveries.state, "accepted"),
          isNull(imMessageDeliveries.reportedAt),
        ),
      );
    for (const row of rows) {
      if (row.turnId) this.#revokeTurnGrants(row.turnId);
    }
    this.#credentials?.owner.closeSessionExecutions(sessionId, "execution_closed");
    const outcomes: CloudSessionCancelOutcome[] = [];
    for (const row of rows) {
      const sandbox = await loadSandboxRecordBySessionId(this.#database, sessionId);
      const record = sandbox ? this.#fence.connectionForSandbox(sandbox.id) : undefined;
      if (!record || record.instanceId !== row.reportOwnerInstanceId || !this.#isExactConnection(record)) {
        outcomes.push({ deliveryId: row.id, status: "no_connection" });
        continue;
      }
      const sent = this.#sendToConnection(record, {
        type: "delivery:cancel",
        deliveryId: row.id,
        requestId: randomUUID(),
      });
      outcomes.push({ deliveryId: row.id, status: sent ? "cancelled" : "send_failed" });
    }
    return outcomes;
  }

  /**
   * Worker recovery for one accepted Cloud delivery, driven by the PERSISTED allocation identity
   * (`reportOwnerInstanceId`) rather than any in-memory fence entry:
   * - a superseded generation or a durably stopped/released allocation settles exactly once as
   *   unknown/turn_state_unknown and is never replayed;
   * - a live allocation with a live exact connection queries the Runner's journal (`received`
   *   re-verifies, `started` stays pending — it is a live phase, not a crash — `reported` awaits
   *   the Runner's replayed report, and only an explicit `none` settles unknown);
   * - a live allocation with no connection stays pending while the allocation is physically
   *   present or its create outcome is still unverified, so a Server restart or transient
   *   disconnect can never destroy a genuine result.
   */
  async recoverAccepted(deliveryId: string): Promise<"pending" | "resolved" | "noop"> {
    const [row] = await this.#database
      .select()
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1);
    const delivery = row;
    if (delivery?.state !== "accepted" || delivery.reportedAt !== null) return "noop";
    if (!delivery.turnId || !delivery.reportOwnerInstanceId) return "noop";

    const allocation = await this.#resolveAcceptedAllocation(delivery);
    if (allocation.kind === "settle") return this.#settleUnknown(deliveryId);
    if (allocation.kind === "pending") return "pending";

    const record = this.#fence.connectionForSandbox(allocation.sandboxId);
    if (record && record.instanceId === delivery.reportOwnerInstanceId && this.#isExactConnection(record)) {
      return this.#recoverLive(record, delivery);
    }
    // No exact live connection. A physically verified absence of the tracked resource is the only
    // additional proof that no report can ever arrive; anything else stays pending for the replay.
    const reconciliation = await this.#allocationStatus?.(allocation.sandboxId);
    return reconciliation?.physical === "absent" ? this.#settleUnknown(deliveryId) : "pending";
  }

  /**
   * Classify the persisted allocation for an accepted turn: `settle` means a superseded/released/
   * absent allocation can never report again, `live` means the exact current allocation owns the
   * turn, `pending` means the create outcome is still unverified and must not be treated as loss.
   */
  async #resolveAcceptedAllocation(
    delivery: typeof imMessageDeliveries.$inferSelect,
  ): Promise<{ kind: "settle" } | { kind: "pending" } | { kind: "live"; sandboxId: string }> {
    const sandbox = await loadSandboxRecordBySessionId(this.#database, delivery.sessionId);
    if (!sandbox) return { kind: "settle" };
    if (sandbox.environmentGeneration === 0 || sandbox.currentResourceName === null) {
      // No allocation was ever reserved for this Session: nothing can report for the accepted turn.
      return { kind: "settle" };
    }
    const expectedInstanceId = cloudInstanceIdFor({
      sandboxId: sandbox.id,
      sessionId: delivery.sessionId,
      environmentGeneration: sandbox.environmentGeneration,
      resourceName: sandbox.currentResourceName,
    });
    if (expectedInstanceId !== delivery.reportOwnerInstanceId) {
      // A superseded allocation can never report the accepted turn again.
      return { kind: "settle" };
    }
    if (sandbox.lifecycle === "releasing" || sandbox.lifecycle === "unallocated") {
      // Explicit durable stop state: the allocation is retired (or being retired) and no Runner
      // will ever report this turn; settle once so it cannot stay invisibly pending forever.
      return { kind: "settle" };
    }
    return { kind: "live", sandboxId: sandbox.id };
  }

  /** Ask the exact owning Runner about its durable journal and act on the answer. */
  async #recoverLive(
    record: CloudConnectionRecord,
    delivery: typeof imMessageDeliveries.$inferSelect,
  ): Promise<"pending" | "resolved" | "noop"> {
    const answer = await this.#queryRunner(record, {
      deliveryId: delivery.id,
      turnId: delivery.turnId as string,
    });
    if (!answer || answer === "reported") return "pending";
    if (answer === "received") {
      await this.#recoverReceivedEntry(record, delivery);
      return "pending";
    }
    // "started" is the LIVE phase of a turn the current Runner still executes: it must stay
    // pending and wait for the real report. "none" means the current Runner's durable journal has
    // no record of this turn, so no execution was ever authorized from it: an explicit
    // crash-unknown, not a missing socket.
    if (answer === "started") return "pending";
    return this.#settleUnknown(delivery.id);
  }

  /**
   * A never-started journal entry. While the active authority chain is alive, re-verify with a
   * fresh rotated permission (the reconnect path). Once the chain is definitively stopped, the
   * exact current Runner is asked to settle the entry through the SAME `delivery:cancel` path an
   * explicit stop uses, so a receipt that committed after the stop selection still produces a
   * truthful `not_started` cancellation instead of looping on a reverify that can never authorize.
   * Started/reported entries are never cancelled here: they may hold a real outcome.
   */
  async #recoverReceivedEntry(
    record: CloudConnectionRecord,
    delivery: typeof imMessageDeliveries.$inferSelect,
  ): Promise<void> {
    const deliveryRef = { deliveryId: delivery.id, turnId: delivery.turnId as string };
    // Re-check after the query await: a replaced connection, superseded allocation, or terminal
    // report must never turn into a cancellation of another resource's work.
    if (!this.#isExactConnection(record) || !(await this.#isExactAllocation(record))) return;
    if (!(await this.#isAcceptedUnfinished(record, deliveryRef))) return;
    if (await this.#loadActiveAuthority(record)) {
      await this.#reverifyReceived(record, delivery);
      return;
    }
    // Persisted stopped authority + a never-started entry: reuse the explicit-stop cancellation
    // to the authenticated current Runner; its `not_started` report lands through the normal
    // durable report path. A disconnected/replaced socket is left pending, never settled here.
    this.#sendToConnection(record, {
      type: "delivery:cancel",
      deliveryId: delivery.id,
      requestId: randomUUID(),
    });
  }

  async #settleUnknown(deliveryId: string): Promise<"resolved" | "noop"> {
    const scope = await this.#deliveryScope(deliveryId);
    if (!scope) return "noop";
    const report = this.#unknownReport(scope.delivery, scope.agentId);
    const recorded = await this.#custody.recordTurn(report, {
      computerId: scope.computerId,
      installationId: "",
      instanceId: scope.delivery.reportOwnerInstanceId as string,
      signal: new AbortController().signal,
    });
    if (recorded !== "recorded" && recorded !== "already_recorded") return "noop";
    // A turn settled as unknown must lose its execution permission immediately, even when the
    // granting Server already restarted (revocation is by execution/turn id).
    if (scope.delivery.turnId) this.#revokeTurnGrants(scope.delivery.turnId);
    return "resolved";
  }

  /** Re-issue the verified grant for a delivery the Runner journaled but never started. */
  async #reverifyReceived(
    connection: CloudConnectionRecord,
    delivery: typeof imMessageDeliveries.$inferSelect,
  ): Promise<void> {
    const parsed = DirectImMessageDeliveryRequestSchema.safeParse(delivery.dispatchPayload);
    if (!parsed.success || !delivery.dispatchRequestId) return;
    const custodyRef = { deliveryId: delivery.id, turnId: delivery.turnId as string };
    if (!(await this.#canAuthorizeExecution(connection, custodyRef))) return;
    const grant = await this.#mintModelGrant(connection, custodyRef.turnId, parsed.data, { supersedeRevoked: true });
    if (!grant) return;
    if (!(await this.#canAuthorizeExecution(connection, custodyRef))) {
      this.#revokeIfOwned(custodyRef.turnId, connection.connectionId);
      return;
    }
    if (
      !this.#sendToConnection(connection, this.#verifiedFrame(delivery.dispatchRequestId, "verified", undefined, grant))
    ) {
      this.#revokeIfOwned(custodyRef.turnId, connection.connectionId);
    }
  }

  /** Correlate a Runner journal answer with the pending recovery query. */
  handleQueryResult(
    connection: CloudConnectionRecord,
    frame: { requestId: string; phase: "none" | "received" | "started" | "reported" },
  ): void {
    const pending = this.#pendingQueries.get(frame.requestId);
    if (!pending || pending.connectionId !== connection.connectionId) return;
    clearTimeout(pending.timer);
    this.#pendingQueries.delete(frame.requestId);
    pending.resolve(frame.phase);
  }

  async #queryRunner(
    connection: CloudConnectionRecord,
    input: { deliveryId: string; turnId: string },
  ): Promise<"none" | "received" | "started" | "reported" | undefined> {
    const socket = this.#socketFor(connection);
    if (!socket) return undefined;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingQueries.delete(requestId);
        resolve(undefined);
      }, 10_000);
      timer.unref?.();
      this.#pendingQueries.set(requestId, { connectionId: connection.connectionId, resolve, timer });
      try {
        socket.send({
          type: "delivery:query",
          deliveryId: input.deliveryId,
          requestId,
          turnId: input.turnId,
        });
      } catch {
        clearTimeout(timer);
        this.#pendingQueries.delete(requestId);
        resolve(undefined);
      }
    });
  }

  /* ------------------------------------------------------------------------------------------
   * #633 credential tunnel (delegated to the single RuntimeCredentialOwner)
   * ---------------------------------------------------------------------------------------- */

  async handleCredentialFrame(
    connection: CloudConnectionRecord,
    frame: RuntimeCredentialClientFrame,
  ): Promise<RuntimeCredentialServerFrame | undefined> {
    const deps = this.#credentials;
    if (!deps) return credentialFailure(frame, "owner_unavailable");
    return deps.owner.handle(frame, this.#context(connection));
  }

  /** Exact-connection revocation routing for the credential owner's sweep/close notifications. */
  sendRevocationToInstance(computerId: string, instanceId: string, frame: RuntimeCredentialServerFrame): boolean {
    const record = this.#fence.connectionForInstance(computerId, instanceId);
    if (!record) return false;
    // Cloud control frames travel inside the runner-channel credential tunnel.
    return this.#sendToConnection(record, { type: "credential:frame", frame });
  }

  /* ------------------------------------------------------------------------------------------
   * Connection lifecycle (runner-ws route calls these)
   * ---------------------------------------------------------------------------------------- */

  attachConnection(input: {
    computerId: string;
    installationId: string;
    scope: RunnerScope;
    socket?: RunnerControlSocket;
  }): CloudConnectionRecord {
    // A same-Sandbox replacement (reconnect or newer generation) must tear down the superseded
    // connection's privileges even when the fence entry is replaced inside attach.
    const previous = this.#fence.connectionForSandbox(input.scope.sandboxId);
    const record = this.#fence.attach(input);
    if (previous && previous.connectionId !== record.connectionId) this.#teardownConnection(previous.connectionId);
    this.#signals.set(record.connectionId, new AbortController());
    return record;
  }

  /** A detached connection kills its credential executions and model grants, never its journal. */
  detachConnection(connectionId: string): void {
    this.#fence.detach(connectionId);
    this.#teardownConnection(connectionId);
  }

  #teardownConnection(connectionId: string): void {
    this.#signals.get(connectionId)?.abort();
    this.#signals.delete(connectionId);
    for (const [requestId, pending] of [...this.#pendingQueries.entries()]) {
      if (pending.connectionId !== connectionId) continue;
      clearTimeout(pending.timer);
      this.#pendingQueries.delete(requestId);
      // An unanswered query is unknown, not "none": never settle unknown-offline here; the
      // Runner's journal re-sends its report on reconnect and recovery retries later.
      pending.resolve(undefined);
    }
    this.#credentials?.owner.closeConnection(connectionId, "connection_replaced");
    for (const [turnId, ownership] of [...this.#grantOwnershipByTurn.entries()]) {
      if (ownership.connectionId !== connectionId) continue;
      this.#revokeIfOwned(turnId, connectionId);
    }
  }

  /**
   * Revoke the turn's permission only while THIS connection still owns it. A replacement that
   * claimed the turn during an await must never lose its fresh permission to a stale cleanup.
   */
  #revokeIfOwned(turnId: string, connectionId: string): void {
    const ownership = this.#grantOwnershipByTurn.get(turnId);
    if (!ownership || ownership.connectionId !== connectionId) return;
    this.#grantOwnershipByTurn.delete(turnId);
    this.#modelGrants?.revokeExecution(turnId);
  }

  /**
   * Terminal revocation (report recorded, explicit stop, unknown settlement): kill every
   * generation for the turn regardless of which connection minted it.
   */
  #revokeTurnGrants(turnId: string): void {
    this.#grantOwnershipByTurn.delete(turnId);
    this.#modelGrants?.revokeExecution(turnId);
  }

  /* ------------------------------------------------------------------------------------------
   * Small helpers
   * ---------------------------------------------------------------------------------------- */

  #context(connection: CloudConnectionRecord): RuntimeBusinessContext {
    return {
      computerId: connection.computerId,
      connectionId: connection.connectionId,
      installationId: connection.installationId,
      instanceId: connection.instanceId,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.providerProxy]: 1,
        [RUNTIME_CAPABILITY.runtimeCredential]: 1,
      },
      signal: (this.#signals.get(connection.connectionId) ?? new AbortController()).signal,
    };
  }

  /**
   * The exact socket for a connection: only ever the socket this connection authenticated on,
   * and only while this exact connection record is still the fence's current entry for the
   * Sandbox. Never "whichever socket now owns the sandbox id".
   */
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

  #isExactConnection(connection: CloudConnectionRecord): boolean {
    return this.#fence.isCurrent(connection.computerId, connection.instanceId, connection.connectionId);
  }

  #sendToConnection(connection: CloudConnectionRecord, frame: Parameters<RunnerHub["sendToCurrent"]>[2]): boolean {
    const socket = this.#socketFor(connection);
    if (!socket) return false;
    return this.#hub.sendToCurrent(connection.scope.sandboxId, socket, frame);
  }

  /**
   * The Session's CURRENT persisted allocation, proven to equal the connection's attached scope.
   * `allowReleasing` keeps report recording possible while an explicit stop is finishing cleanup;
   * receipts never accept work on a releasing/unallocated environment.
   */
  async #loadCurrentAllocation(
    connection: CloudConnectionRecord,
    options: { allowReleasing?: boolean } = {},
  ): Promise<typeof sandboxes.$inferSelect | undefined> {
    const sandbox = await loadSandboxRecordBySessionId(this.#database, connection.scope.sessionId);
    if (
      !sandbox ||
      sandbox.id !== connection.scope.sandboxId ||
      sandbox.sessionId !== connection.scope.sessionId ||
      sandbox.environmentGeneration !== connection.scope.environmentGeneration ||
      sandbox.currentResourceName === null ||
      sandbox.currentResourceName !== connection.scope.resourceName
    ) {
      return undefined;
    }
    if (sandbox.lifecycle === "unallocated") return undefined;
    if (sandbox.lifecycle === "releasing" && options.allowReleasing !== true) return undefined;
    return sandbox;
  }

  async #isExactAllocation(connection: CloudConnectionRecord): Promise<boolean> {
    return Boolean(await this.#loadCurrentAllocation(connection));
  }

  /**
   * Execution permission needs the exact connection, the exact current allocation, the CURRENT
   * active authority chain, and UNFINISHED custody for this specific turn. Checked immediately
   * around every await that can outlive a stop, report, or replacement, so a permission minted
   * during one of those is revoked instead of sent.
   */
  async #canAuthorizeExecution(
    connection: CloudConnectionRecord,
    delivery: { deliveryId: string; turnId: string },
  ): Promise<boolean> {
    if (!this.#isExactConnection(connection) || !(await this.#isExactAllocation(connection))) return false;
    if (!(await this.#loadActiveAuthority(connection))) return false;
    return this.#isAcceptedUnfinished(connection, delivery);
  }

  /**
   * The persisted ACTIVE authority chain for this exact connection, or undefined when it is
   * definitively stopped (ended Session, suspended Agent/Account, inactive binding) or belongs to
   * another allocation. Undefined is authority evidence, never a transient-error signal: database
   * failures throw and stay pending.
   */
  async #loadActiveAuthority(
    connection: CloudConnectionRecord,
  ): Promise<Awaited<ReturnType<typeof loadManagedSandboxBySessionId>> | undefined> {
    const owned = await loadManagedSandboxBySessionId(this.#database, connection.scope.sessionId);
    if (
      !owned ||
      owned.sandbox.id !== connection.scope.sandboxId ||
      owned.sandbox.environmentGeneration !== connection.scope.environmentGeneration ||
      owned.sandbox.currentResourceName !== connection.scope.resourceName
    ) {
      return undefined;
    }
    return owned;
  }

  /** The delivery is still accepted, unreported, and owned by this exact allocation instance. */
  async #isAcceptedUnfinished(
    connection: CloudConnectionRecord,
    delivery: { deliveryId: string; turnId: string },
  ): Promise<boolean> {
    const [row] = await this.#database
      .select({
        state: imMessageDeliveries.state,
        turnId: imMessageDeliveries.turnId,
        reportedAt: imMessageDeliveries.reportedAt,
        reportOwnerInstanceId: imMessageDeliveries.reportOwnerInstanceId,
      })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, delivery.deliveryId))
      .limit(1);
    return Boolean(
      row &&
        row.state === "accepted" &&
        row.turnId === delivery.turnId &&
        row.reportedAt === null &&
        row.reportOwnerInstanceId === connection.instanceId,
    );
  }

  async #deliveryScope(
    deliveryId: string,
  ): Promise<{ agentId: string; computerId: string; delivery: typeof imMessageDeliveries.$inferSelect } | undefined> {
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        agentId: agents.id,
        computerId: sessionPlacements.computerId,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1);
    return row;
  }

  #unknownReport(delivery: typeof imMessageDeliveries.$inferSelect, agentId: string): TurnReportRequest {
    const base = {
      type: "turn:report" as const,
      requestId: randomUUID(),
      deliveryId: delivery.id,
      turnId: delivery.turnId as string,
      sessionId: delivery.sessionId,
      agentId,
      placementGeneration: delivery.placementGeneration,
      outcome: "unknown" as const,
      executionEffects: "may_have_occurred" as const,
      errorReason: "turn_state_unknown" as const,
      traceSummary: { droppedEvents: 0, lastSequence: 0 },
    };
    return { ...base, resultHash: computeTurnResultHash(base) };
  }

  async #loadDispatchForScope(
    connection: CloudConnectionRecord,
    deliveryId: string,
    requestId: string,
  ): Promise<{ request: DirectImMessageDeliveryRequest } | undefined> {
    const [row] = await this.#database
      .select({
        dispatchPayload: imMessageDeliveries.dispatchPayload,
        dispatchRequestId: imMessageDeliveries.dispatchRequestId,
        sessionId: imMessageDeliveries.sessionId,
      })
      .from(imMessageDeliveries)
      .where(eq(imMessageDeliveries.id, deliveryId))
      .limit(1);
    if (!row || row.sessionId !== connection.scope.sessionId || row.dispatchRequestId !== requestId) return undefined;
    const parsed = DirectImMessageDeliveryRequestSchema.safeParse(row.dispatchPayload);
    if (!parsed.success) return undefined;
    if (parsed.data.deliveryId !== deliveryId || parsed.data.sessionId !== connection.scope.sessionId) return undefined;
    return { request: parsed.data };
  }
}

/** The exact wire frame shape the delivery:verified sender may produce. */
type RuntimeServerVerifiedFrame = Extract<Parameters<RunnerHub["sendToCurrent"]>[2], { type: "delivery:verified" }>;

function credentialFailure(
  frame: RuntimeCredentialClientFrame,
  code: string,
): RuntimeCredentialServerFrame | undefined {
  if (frame.type === "runtime:execution:open") {
    return { type: "runtime:execution:result", code: code as never, requestId: frame.requestId, status: "rejected" };
  }
  if (frame.type === "runtime:execution:close") {
    return {
      type: "runtime:execution:closed",
      code: code as never,
      executionId: frame.executionId,
      requestId: frame.requestId,
      status: "rejected",
    };
  }
  if (frame.type === "runtime:proxy:ticket") {
    return { type: "runtime:proxy:ticket:result", code: code as never, requestId: frame.requestId, status: "rejected" };
  }
  return { type: "runtime:credential:result", code: code as never, requestId: frame.requestId, status: "rejected" };
}
