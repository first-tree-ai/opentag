import type {
  AccountSandboxRunnerAcceptanceRequest,
  AccountSandboxRunnerAcceptanceResponse,
  AccountSandboxRunnerStatusResponse,
  RunnerReadiness,
} from "@opentag/shared";
import { and, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { sandboxes } from "../../db/schema/index.js";
import { type CloudRunAdmin, CloudRunAdminError, type RunnerInstanceIdentityInput } from "../cloud-run/index.js";
import { SandboxServiceError, sandboxNotFound } from "./errors.js";
import { loadManagedSandboxById, loadOwnedSandbox } from "./owned-sandbox.js";
import type { RunnerBootstrapClaims, RunnerBootstrapTokenService } from "./runner-bootstrap-token.js";
import { RunnerAcceptanceUnavailableError, type RunnerHub, type RunnerScope } from "./runner-hub.js";

/**
 * E3 allocation orchestration for Session-owned Sandboxes: exactly one Cloud Run Instance per
 * Sandbox environment generation.
 *
 * Discipline:
 * - The reservation (`unallocated -> preparing`, generation + 1) is a transaction/CAS committed
 *   BEFORE any cloud call and persists the deterministic resource name. The winner that commits
 *   the reservation is the only caller allowed to submit the create request for that generation.
 *   No database transaction is ever held through cloud I/O.
 * - Subsequent and concurrent starts reconcile the deterministic name with GET/operation reads;
 *   they never POST a second create for the same generation. Because the name is known before the
 *   first byte leaves the process, a stop can never "clear" a generation whose create might still
 *   materialize.
 * - `lastErrorCode` carries the durable create phase for a generation whose UID is not yet
 *   tracked: `cloud_create_pending` (submission committed), `cloud_create_uncertain` (unknown
 *   result), `cloud_create_rejected` / `cloud_create_failed` (definitive: retry or release is
 *   safe), `cloud_instance_unverified` (a resource answers at our name but failed policy
 *   verification: never retried and never deleted unverified).
 * - Every mutation of the row is CAS-guarded on (id, generation, name), so a stale in-flight
 *   operation can never mutate a newer environment. A tracked resource reference is never erased
 *   while removal is uncertain: delete completes only when the read-back is 404 or the name is
 *   owned by a different UID.
 * - `ready` requires an authenticated CURRENT Runner at the exact expected version plus verified
 *   Cloud policy for the CURRENT generation — never a signedRunner frame alone. An early Runner
 *   report is deferred, not rejected, until the create caller records the verified UID.
 */

export interface SandboxRunnerServiceOptions {
  cloudAdmin: CloudRunAdmin;
  tokens: RunnerBootstrapTokenService;
  hub: RunnerHub;
  environment: "dev" | "staging" | "prod";
  backendUrl: string;
  /** Exact pinned Runner build the image must report before an environment may become ready. */
  expectedRunnerVersion: string;
  acceptanceTimeoutMs: number;
  /** Bounded window for adopting a submitted create and for verifying cleanup by read-back. */
  createConvergeTimeoutMs: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  deleteVerifyTimeoutMs?: number;
}

const DELETE_VERIFY_DEFAULT_MS = 60_000;
/** Durable create-phase markers recorded in `lastErrorCode`. */
const MARKER_RETRYABLE = ["cloud_create_rejected", "cloud_create_failed"] as const;
type Marker =
  | "cloud_create_pending"
  | "cloud_create_uncertain"
  | "cloud_instance_unverified"
  | (typeof MARKER_RETRYABLE)[number];
const RETRYABLE_MARKER_LIST: string[] = [...MARKER_RETRYABLE];
const RETRYABLE_MARKERS = new Set<string>(MARKER_RETRYABLE);

/** Evidence that no create for this generation can still materialize. */
function isDefinitiveNoResourceMarker(marker: string | null): boolean {
  return marker !== null && RETRYABLE_MARKERS.has(marker);
}

export type RunnerReadyOutcome = "ready" | "deferred" | "stale" | "version_mismatch";

export class SandboxRunnerService {
  readonly #database: DatabaseClient;
  readonly #cloud: CloudRunAdmin;
  readonly #tokens: RunnerBootstrapTokenService;
  readonly #hub: RunnerHub;
  readonly #environment: "dev" | "staging" | "prod";
  readonly #backendUrl: string;
  readonly #expectedRunnerVersion: string;
  readonly #acceptanceTimeoutMs: number;
  readonly #createConvergeTimeoutMs: number;
  readonly #deleteVerifyTimeoutMs: number;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(database: DatabaseClient, options: SandboxRunnerServiceOptions) {
    if (!options.expectedRunnerVersion) throw new Error("SandboxRunnerService requires the expected Runner version");
    this.#database = database;
    this.#cloud = options.cloudAdmin;
    this.#tokens = options.tokens;
    this.#hub = options.hub;
    this.#environment = options.environment;
    this.#backendUrl = options.backendUrl;
    this.#expectedRunnerVersion = options.expectedRunnerVersion;
    this.#acceptanceTimeoutMs = options.acceptanceTimeoutMs;
    this.#createConvergeTimeoutMs = options.createConvergeTimeoutMs;
    this.#deleteVerifyTimeoutMs = options.deleteVerifyTimeoutMs ?? DELETE_VERIFY_DEFAULT_MS;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /* ------------------------------------------------------------------------------------------
   * Account-facing operations
   * ---------------------------------------------------------------------------------------- */

  async startForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    const reservation = await this.#database.transaction(async (transaction) => {
      // Start/execute requires the CURRENT authority chain: active Pi Agent, active binding,
      // un-ended Session, non-suspended Account, owned Cloud Computer.
      const owned = await loadOwnedSandbox(transaction, accountId, sandboxId, { lock: true, authority: "manage" });
      if (!owned) throw sandboxNotFound();
      const row = owned.sandbox;
      if (row.lifecycle === "releasing") {
        throw runnerConflict("The Sandbox environment is being released; retry after release completes");
      }
      if (row.lifecycle === "unallocated") return this.#reserveNewGeneration(transaction, row);
      return this.#reserveExistingAllocation(row);
    });

    if (reservation.action === "allocate") await this.#submitCreate(reservation.row, { claimed: true });
    else if (reservation.action === "retry") await this.#submitCreate(reservation.row, { claimed: false });
    else if (reservation.action === "reconcile") {
      try {
        await this.#reconcileAllocation(reservation.row);
      } catch (error) {
        throw mapCloudError(error, "reconcile the Sandbox environment");
      }
    }
    await this.#promoteReadyIfReported(sandboxId);
    return this.statusForAccount(accountId, sandboxId);
  }

  /** `unallocated -> preparing`, generation + 1, deterministic name persisted before any I/O. */
  async #reserveNewGeneration(
    transaction: DatabaseTransaction,
    row: typeof sandboxes.$inferSelect,
  ): Promise<{ action: "allocate"; row: typeof sandboxes.$inferSelect }> {
    const now = this.#now();
    const generation = row.environmentGeneration + 1;
    const resourceName = this.#resourceNameFor(row, generation);
    const [updated] = await transaction
      .update(sandboxes)
      .set({
        lifecycle: "preparing",
        environmentGeneration: generation,
        currentResourceName: resourceName,
        currentResourceUid: null,
        currentOperationName: null,
        // The durable submission commitment is part of the reservation transaction: from the
        // instant `preparing` is visible, exactly this winner may POST, and a concurrent stop
        // knows a create may be in flight.
        lastErrorCode: "cloud_create_pending",
        lastErrorAt: now,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.lifecycle, "unallocated"),
        ),
      )
      .returning();
    if (!updated) throw runnerConflict("The Sandbox environment changed concurrently");
    return { action: "allocate", row: updated };
  }

  /** preparing/ready: retry only after a definitive failure; otherwise reconcile with GET. */
  #reserveExistingAllocation(row: typeof sandboxes.$inferSelect): {
    action: "retry" | "reconcile" | "report";
    row: typeof sandboxes.$inferSelect;
  } {
    if (row.currentResourceName !== null && row.currentResourceUid !== null) return { action: "report", row };
    if (RETRYABLE_MARKERS.has(row.lastErrorCode ?? "")) return { action: "retry", row };
    return { action: "reconcile", row };
  }

  async statusForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "read" });
    if (!owned) throw sandboxNotFound();
    return this.#toStatus(owned.sandbox);
  }

  async stopForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    const transition = await this.#database.transaction(async (transaction) => {
      const owned = await loadOwnedSandbox(transaction, accountId, sandboxId, { lock: true, authority: "read" });
      if (!owned) throw sandboxNotFound();
      const row = owned.sandbox;
      const now = this.#now();
      if (row.lifecycle === "unallocated") return { action: "report" as const, row };
      if (row.lifecycle === "releasing") return { action: "release" as const, row };
      const [updated] = await transaction
        .update(sandboxes)
        .set({ lifecycle: "releasing", lastActivityAt: now, updatedAt: now })
        .where(
          and(
            eq(sandboxes.id, row.id),
            eq(sandboxes.environmentGeneration, row.environmentGeneration),
            or(eq(sandboxes.lifecycle, "preparing"), eq(sandboxes.lifecycle, "ready")),
          ),
        )
        .returning();
      if (!updated) throw runnerConflict("The Sandbox environment changed concurrently");
      return { action: "release" as const, row: updated };
    });

    if (transition.action === "release") {
      // Invalidate Runner execution immediately: a releasing environment must never accept or
      // resolve work while its Instance is being removed.
      this.#closeRunnerScope(transition.row);
      try {
        await this.#releaseAllocation(transition.row);
      } catch (error) {
        // Preserve an in-flight submission marker: `cloud_create_pending` is the only evidence
        // that the winner may still POST, so a stop failure must never erase it.
        await this.#recordError(transition.row, "cloud_delete_incomplete", error, { preservePending: true });
        throw mapCloudError(error, "release the Sandbox environment");
      }
    }
    return this.statusForAccount(accountId, sandboxId);
  }

  /**
   * Explicit Account-triggered bounded acceptance run. Requires the CURRENT environment to be
   * ready (authenticated Runner + native readiness) and the current authority chain to be active.
   * Correlated by requestId, bounded by the configured deadline, and cancelled on the Runner when
   * the HTTP caller goes away.
   */
  async runAcceptanceForAccount(
    accountId: string,
    sandboxId: string,
    input: AccountSandboxRunnerAcceptanceRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<AccountSandboxRunnerAcceptanceResponse> {
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "manage" });
    if (!owned) throw sandboxNotFound();
    const row = owned.sandbox;
    if (row.lifecycle !== "ready") {
      throw runnerConflict("The Sandbox environment is not ready; start it and wait for runner readiness");
    }
    const snapshot = this.#hub.describe(sandboxId);
    if (
      !snapshot.connected ||
      !snapshot.ready ||
      !snapshot.scope ||
      snapshot.scope.environmentGeneration !== row.environmentGeneration ||
      snapshot.scope.resourceName !== row.currentResourceName
    ) {
      throw runnerConflict("No ready Runner is attached to the current Sandbox environment");
    }
    const socket = this.#hub.currentSocket(sandboxId);
    if (!socket) throw runnerConflict("No ready Runner is attached to the current Sandbox environment");
    const deadlineAtMs = this.#now().getTime() + this.#acceptanceTimeoutMs;
    try {
      const result = await this.#hub.runAcceptance(
        sandboxId,
        {
          mode: input.mode,
          deadlineAtMs,
          ...(input.piConfig ? { piConfig: input.piConfig } : {}),
        },
        { timeoutMs: this.#acceptanceTimeoutMs, socket, ...(options.signal ? { signal: options.signal } : {}) },
      );
      return {
        requestId: result.requestId,
        sandboxId,
        environmentGeneration: row.environmentGeneration,
        mode: input.mode,
        outcome: result.outcome,
        ...(result.report ? { report: result.report } : {}),
        ...(result.failure ? { failure: result.failure } : {}),
      };
    } catch (error) {
      if (error instanceof RunnerAcceptanceUnavailableError) throw runnerConflict(error.message);
      throw error;
    }
  }

  /* ------------------------------------------------------------------------------------------
   * Runner control-channel validation (WebSocket route calls these)
   * ---------------------------------------------------------------------------------------- */

  /**
   * Validate bootstrap claims against the CURRENT database allocation AND the current authority
   * chain. Called on every connect/reconnect (and before accepting results/readiness); a token
   * from a superseded generation, a suspended Agent/binding/Account, or an ended Session fails
   * here even though the token itself is unexpired.
   */
  async validateRunnerScope(claims: RunnerBootstrapClaims): Promise<RunnerScope | undefined> {
    const owned = await loadManagedSandboxById(this.#database, claims.sandboxId);
    if (!owned) return undefined;
    const row = owned.sandbox;
    if (row.sessionId !== claims.sessionId) return undefined;
    if (row.lifecycle !== "preparing" && row.lifecycle !== "ready") return undefined;
    if (row.environmentGeneration !== claims.environmentGeneration) return undefined;
    if (row.currentResourceName === null || row.currentResourceName !== claims.resourceName) return undefined;
    return {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName,
    };
  }

  /**
   * An authenticated Runner reported native sandbox/tool readiness. Readiness is accepted only
   * for the current allocation AND the exact configured Runner version, and only once the Cloud
   * resource for this generation has been policy-verified and its UID tracked. An early Runner
   * whose report arrives before the create caller records the UID is DEFERRED: a bounded GET
   * reconcile runs, and if the resource is not yet readable the connection stays authenticated.
   * The create caller promotes the deferred report when tracking completes.
   */
  async markRunnerReady(scope: RunnerScope, readiness: RunnerReadiness): Promise<RunnerReadyOutcome> {
    if (readiness.runnerVersion !== this.#expectedRunnerVersion) return "version_mismatch";
    const current = await this.#currentScopeRow(scope);
    if (!current) return "stale";
    if (current.lifecycle === "ready") return "ready";
    if (current.lifecycle !== "preparing") return "stale";
    if (current.currentResourceUid === null) {
      try {
        await this.#reconcileAllocation(current);
      } catch {
        // A transport/provider failure must not evict a legitimate Runner; readiness stays
        // deferred and the next message or create completion reconciles again.
        return "deferred";
      }
      const refreshed = await this.#currentScopeRow(scope);
      if (!refreshed) return "stale";
      if (refreshed.lifecycle === "ready") return "ready";
      if (refreshed.lifecycle !== "preparing" || refreshed.currentResourceUid === null) return "deferred";
    }
    return (await this.#promoteReadyIfReported(scope.sandboxId)) ? "ready" : "deferred";
  }

  /** A deferred readiness report may be promoted once the verified UID is tracked. */
  async promoteDeferredReadiness(sandboxId: string): Promise<boolean> {
    return this.#promoteReadyIfReported(sandboxId);
  }

  /* ------------------------------------------------------------------------------------------
   * Allocation and release (no database transaction is held across cloud I/O)
   * ---------------------------------------------------------------------------------------- */

  /**
   * The only path that submits a create request. A durable CAS marks the generation as
   * `cloud_create_pending` before the POST; a concurrent stop therefore knows a create may be in
   * flight and never erases the reference, and no later start can submit a second POST for the
   * same generation (the CAS only accepts `null` or a definitive-failure marker).
   */
  async #submitCreate(row: typeof sandboxes.$inferSelect, options: { claimed: boolean }): Promise<void> {
    const resourceName = row.currentResourceName;
    if (resourceName === null) {
      throw new CloudRunAdminError("conflict", "The Sandbox environment has no deterministic resource name");
    }
    if (!options.claimed) {
      // A retry after a DEFINITIVE failure must win the durable pending CAS BEFORE issuing any
      // credential: only the winner may record a local pre-submission failure. The CAS also
      // clears the previous operation identity. A concurrent start or stop that moved the row on
      // wins instead and this caller never mints a token or POSTs.
      const claimed = await this.#claimSubmission(row, resourceName);
      if (!claimed) return;
    }
    const identity = this.#identityFor(row, row.environmentGeneration);
    let bootstrapToken: string;
    try {
      bootstrapToken = await this.#tokens.issue({
        sandboxId: row.id,
        sessionId: row.sessionId,
        environmentGeneration: row.environmentGeneration,
        resourceName,
      });
    } catch (error) {
      // Local failure before any submission: retry is safe. Only the submission owner reaches
      // here (reservation winner, or the retry that just won the pending CAS).
      await this.#recordError(row, "cloud_create_failed", error);
      throw error;
    }
    let result: Awaited<ReturnType<CloudRunAdmin["createInstance"]>>;
    try {
      result = await this.#cloud.createInstance(
        {
          ...identity,
          environment: this.#environment,
          backendUrl: this.#backendUrl,
          bootstrapToken,
        },
        { onOperation: (operationName) => this.#trackOperation(row, resourceName, operationName) },
      );
    } catch (error) {
      return this.#handleCreateFailure(row, error);
    }
    try {
      this.#cloud.verifyInstance(result.instance, identity);
    } catch (error) {
      await this.#recordError(row, "cloud_instance_unverified", error);
      throw mapCloudError(error, "adopt the Sandbox environment allocation");
    }
    const tracked = await this.#trackResource(row, resourceName, result.instance.uid, result.operationName ?? null);
    if (tracked === "tracked") {
      // A stop may have moved the row to `releasing` while the create was in flight; finish that
      // pending release now instead of leaving it for a second user stop.
      await this.#afterReconcile(row.id);
      return;
    }
    // The row moved on while the create was in flight: this resource belongs to a stale
    // generation. Remove exactly what we created/adopted (UID-verified), never the row. A failed
    // cleanup is not swallowed.
    await this.#deleteOrphaned(resourceName, result.instance.uid);
  }

  /** Classify a failed create attempt: record the marker and throw when it must be surfaced. */
  async #handleCreateFailure(row: { id: string; environmentGeneration: number }, error: unknown): Promise<void> {
    await this.#recordCreateFailure(row, error);
    // ONLY an explicit rejected create response (`createRejected`) proves no allocation was
    // submitted. An invalid/ownership error from the adapter's post-POST GET+policy verify
    // describes a resource that may exist: it is visible, never retried and never cleared.
    if (error instanceof CloudRunAdminError && error.createRejected) {
      throw mapCloudError(error, "allocate the Sandbox environment");
    }
    if (error instanceof CloudRunAdminError && (error.kind === "invalid" || error.kind === "ownership_mismatch")) {
      throw mapCloudError(error, "adopt the Sandbox environment allocation");
    }
    if (!(error instanceof CloudRunAdminError)) throw mapCloudError(error, "allocate the Sandbox environment");
  }

  /**
   * CAS the durable submission marker for a RETRY after a definitive failure. The winning retry is
   * the only submitter for this cycle, so the previous operation identity is cleared in the SAME
   * update: a concurrent stop must never re-read a finished previous LRO and clear the row while
   * this request is still allowed to POST.
   */
  async #claimSubmission(row: typeof sandboxes.$inferSelect, resourceName: string): Promise<boolean> {
    const now = this.#now();
    const [claimed] = await this.#database
      .update(sandboxes)
      .set({
        lastErrorCode: "cloud_create_pending",
        lastErrorAt: now,
        currentOperationName: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.currentResourceName, resourceName),
          eq(sandboxes.lifecycle, "preparing"),
          isNull(sandboxes.currentResourceUid),
          inArray(sandboxes.lastErrorCode, RETRYABLE_MARKER_LIST),
        ),
      )
      .returning({ id: sandboxes.id });
    return claimed !== undefined;
  }

  /**
   * Record explicit rejection evidence only while the INSPECTED operation is still the row's
   * current one (same generation/name, no UID, submission phase). Clears the operation identity
   * so the evidence is single-use. Returns false when a newer submission already owns the row:
   * the stale LRO must neither overwrite its pending marker nor trigger another retry.
   */
  async #markOperationRejected(
    row: { id: string; environmentGeneration: number },
    resourceName: string,
    operationName: string,
  ): Promise<boolean> {
    const now = this.#now();
    const [updated] = await this.#database
      .update(sandboxes)
      .set({ lastErrorCode: "cloud_create_rejected", lastErrorAt: now, currentOperationName: null, updatedAt: now })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.currentResourceName, resourceName),
          eq(sandboxes.currentOperationName, operationName),
          isNull(sandboxes.currentResourceUid),
          inArray(sandboxes.lifecycle, ["preparing", "releasing"]),
        ),
      )
      .returning({ id: sandboxes.id });
    return updated !== undefined;
  }

  /**
   * Reconcile a generation that is preparing without a verified UID. 404 alone is never proof a
   * late create cannot materialize; only a completed operation with an error, or a definitive
   * pre-submission failure marker, unlocks a retry. Once the Instance is visible it is policy
   * verified and its UID tracked (even while releasing, so stop can finish verified cleanup).
   */
  async #reconcileAllocation(row: typeof sandboxes.$inferSelect): Promise<void> {
    const current = await this.#ensureDeterministicName(row);
    if (!current) return;
    const resourceName = current.currentResourceName as string;
    const view = await this.#getVerifiedAndTracked(current, resourceName);
    if (view) {
      await this.#afterReconcile(current.id);
      return;
    }
    if (current.currentOperationName) {
      await this.#reconcileOperation(current, resourceName);
      return;
    }
    if (isDefinitiveNoResourceMarker(current.lastErrorCode)) {
      await this.#submitCreate(current, { claimed: false });
      return;
    }
    // Unknown create outcome with no operation to inspect: keep the reference and report it.
    await this.#marker(current, "cloud_create_uncertain");
  }

  /** Legacy rows without a persisted name get the deterministic name for their generation. */
  async #ensureDeterministicName(
    row: typeof sandboxes.$inferSelect,
  ): Promise<typeof sandboxes.$inferSelect | undefined> {
    if (row.currentResourceName !== null) return row;
    const resourceName = this.#resourceNameFor(row, row.environmentGeneration);
    const [assigned] = await this.#database
      .update(sandboxes)
      .set({ currentResourceName: resourceName, updatedAt: this.#now() })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.lifecycle, "preparing"),
          isNull(sandboxes.currentResourceName),
        ),
      )
      .returning();
    return assigned;
  }

  async #reconcileOperation(current: typeof sandboxes.$inferSelect, resourceName: string): Promise<void> {
    const inspectedOperation = current.currentOperationName as string;
    const operation = await this.#cloud.getOperation(inspectedOperation);
    if (!operation.done) {
      await this.#marker(current, "cloud_create_uncertain");
      return;
    }
    if (operation.errorCode !== undefined) {
      // Only an explicit operation error establishes rejection, and only while this exact
      // operation is still current: a newer retry may have replaced it while we awaited the LRO.
      const recorded = await this.#markOperationRejected(current, resourceName, inspectedOperation);
      if (!recorded) return;
      const [refreshed] = await this.#rowById(current.id);
      if (refreshed?.lifecycle === "preparing" && refreshed.currentResourceUid === null) {
        await this.#submitCreate(refreshed, { claimed: false });
      }
      return;
    }
    if (operation.resourceName === undefined) {
      // done=true with neither an error nor a resource is ambiguous, not proof of nothing.
      await this.#marker(current, "cloud_create_uncertain");
      return;
    }
    if (operation.resourceName !== resourceName) {
      throw new CloudRunAdminError("ownership_mismatch", "Create operation reported a different resource");
    }
    await this.#pollTracked(current, resourceName);
  }

  /** Allow the read to catch up inside the convergence window (bounded iterations). */
  async #pollTracked(current: typeof sandboxes.$inferSelect, resourceName: string): Promise<void> {
    const deadline = this.#now().getTime() + this.#createConvergeTimeoutMs;
    for (let attempt = 0; attempt < 3 && this.#now().getTime() < deadline; attempt += 1) {
      await this.#sleep(Math.min(1_000, Math.max(0, deadline - this.#now().getTime())));
      const view = await this.#getVerifiedAndTracked(current, resourceName);
      if (view) {
        await this.#afterReconcile(current.id);
        return;
      }
    }
    await this.#marker(current, "cloud_create_uncertain");
  }

  /** Read the deterministic name, verify Cloud policy, and track the UID (accepting releasing). */
  async #getVerifiedAndTracked(
    row: typeof sandboxes.$inferSelect,
    resourceName: string,
  ): Promise<Awaited<ReturnType<CloudRunAdmin["getInstance"]>> | undefined> {
    const view = await this.#cloud.getInstance(resourceName);
    if (!view) return undefined;
    try {
      this.#cloud.verifyInstance(view, this.#identityFor(row, row.environmentGeneration));
    } catch (error) {
      await this.#marker(row, "cloud_instance_unverified");
      throw mapCloudError(error, "adopt the Sandbox environment allocation");
    }
    await this.#trackResource(row, resourceName, view.uid, row.currentOperationName);
    return view;
  }

  /** Promote, and if the row moved to releasing while reconciling, finish verified cleanup. */
  async #afterReconcile(sandboxId: string): Promise<void> {
    const [row] = await this.#rowById(sandboxId);
    if (!row) return;
    if (row.lifecycle === "releasing") {
      this.#closeRunnerScope(row);
      await this.#releaseAllocation(row);
      return;
    }
    await this.#promoteReadyIfReported(sandboxId);
  }

  /**
   * CAS-track the verified resource. Accepts a row that has already moved to `ready` (a
   * concurrent readiness promotion) or `releasing` (a concurrent stop): a phase change alone is
   * never proof the resource is stale. Returns "superseded" when the row now belongs to a
   * different generation/name, in which case the caller cleans up what it created.
   */
  async #trackResource(
    row: { id: string; environmentGeneration: number },
    resourceName: string,
    resourceUid: string,
    operationName: string | null,
  ): Promise<"tracked" | "superseded"> {
    const now = this.#now();
    const [updated] = await this.#database
      .update(sandboxes)
      .set({
        currentResourceUid: resourceUid,
        currentOperationName: operationName,
        lastErrorCode: null,
        lastErrorAt: null,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.currentResourceName, resourceName),
          inArray(sandboxes.lifecycle, ["preparing", "ready", "releasing"]),
          or(isNull(sandboxes.currentResourceUid), eq(sandboxes.currentResourceUid, resourceUid)),
        ),
      )
      .returning({ id: sandboxes.id });
    if (updated) return "tracked";
    const [current] = await this.#rowById(row.id);
    if (
      current &&
      current.environmentGeneration === row.environmentGeneration &&
      current.currentResourceName === resourceName &&
      current.currentResourceUid === resourceUid
    ) {
      return "tracked";
    }
    return "superseded";
  }

  /** Promptly persist the accepted operation name without disturbing the tracked phase. */
  async #trackOperation(
    row: { id: string; environmentGeneration: number },
    resourceName: string,
    operationName: string,
  ): Promise<void> {
    const now = this.#now();
    await this.#database
      .update(sandboxes)
      .set({ currentOperationName: operationName, lastActivityAt: now, updatedAt: now })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.currentResourceName, resourceName),
          inArray(sandboxes.lifecycle, ["preparing", "ready", "releasing"]),
        ),
      );
  }

  /**
   * Stop's release half. The Runner was already detached. A resource with a tracked UID is
   * deleted and verified by read-back. Without a UID the create outcome is awaited for a bounded
   * window: a visible Instance is verified/tracked and then deleted, a completed operation with
   * an error proves nothing was allocated, and anything still unknown keeps `releasing` plus the
   * full reference and reports incomplete — the reference is never erased on uncertainty.
   */
  async #releaseAllocation(row: typeof sandboxes.$inferSelect): Promise<void> {
    const resourceName = row.currentResourceName;
    if (resourceName === null) {
      await this.#clearReleased(row, null, null);
      return;
    }
    if (row.currentResourceUid === null) {
      await this.#awaitUnknownAllocation(row, resourceName);
      return;
    }
    await this.#deleteVerified(resourceName, row.currentResourceUid);
    await this.#clearReleased(row, resourceName, row.currentResourceUid);
  }

  /**
   * The create result was never observed. A visible Instance is verified/tracked and deleted; a
   * completed operation proves the outcome; anything still unknown keeps `releasing` plus the
   * full reference and reports incomplete after the bounded window.
   */
  async #awaitUnknownAllocation(row: typeof sandboxes.$inferSelect, resourceName: string): Promise<void> {
    const deadline = this.#now().getTime() + this.#deleteVerifyTimeoutMs;
    for (;;) {
      const view = await this.#cloud.getInstance(resourceName);
      if (view) {
        this.#cloud.verifyInstance(view, this.#identityFor(row, row.environmentGeneration));
        await this.#trackResource(row, resourceName, view.uid, row.currentOperationName);
        await this.#deleteVerified(resourceName, view.uid);
        await this.#clearReleased(row, resourceName, view.uid);
        return;
      }
      if (await this.#releaseFromDefinitiveEvidence(row, resourceName)) return;
      if (this.#now().getTime() >= deadline) {
        await this.#marker(row, "cloud_create_uncertain");
        throw new CloudRunAdminError(
          "unavailable",
          `Allocation cleanup for ${resourceName} is incomplete: the create outcome is still unknown; the resource reference is preserved`,
        );
      }
      await this.#sleep(Math.min(2_000, Math.max(50, deadline - this.#now().getTime())));
    }
  }

  /** True only when an explicit operation error proves no Instance was allocated. */
  async #releaseFromDefinitiveEvidence(row: typeof sandboxes.$inferSelect, resourceName: string): Promise<boolean> {
    if (row.currentOperationName) {
      const inspectedOperation = row.currentOperationName;
      const operation = await this.#cloud.getOperation(inspectedOperation);
      if (!operation.done) return false;
      if (operation.errorCode !== undefined) {
        // Consume the rejection evidence only while this exact operation is still current; a
        // stale LRO must never clear the row or overwrite a newer pending marker.
        const recorded = await this.#markOperationRejected(row, resourceName, inspectedOperation);
        if (!recorded) return false;
        await this.#clearReleased(row, resourceName, null);
        return true;
      }
      // done=true without an error means success (the resource may still be materializing) or is
      // ambiguous; both keep `releasing` + the reference and the bounded GET reconciliation.
      if (operation.resourceName !== undefined && operation.resourceName !== resourceName) {
        throw new CloudRunAdminError(
          "ownership_mismatch",
          "Create operation reported a different resource; refusing to treat the release as reconciled",
        );
      }
      return false;
    }
    if (isDefinitiveNoResourceMarker(row.lastErrorCode)) {
      await this.#clearReleased(row, resourceName, null);
      return true;
    }
    return false;
  }

  /** Delete is a fact only when the read-back is 404. A different UID at the name is reported. */
  async #deleteVerified(resourceName: string, resourceUid: string): Promise<void> {
    const deleted = await this.#cloud.deleteInstance(resourceName, resourceUid);
    if (deleted.alreadyGone) return;
    const deadline = this.#now().getTime() + this.#deleteVerifyTimeoutMs;
    for (;;) {
      const view = await this.#cloud.getInstance(resourceName);
      if (!view) return;
      if (view.uid !== resourceUid) {
        // Our UID is gone, but a same-name resource now belongs to someone else. Do not delete it
        // and do not pretend the release is fully reconciled: keep the row releasing with
        // evidence and let an operator resolve the replacement.
        throw new CloudRunAdminError(
          "ownership_mismatch",
          `Cloud Run Instance ${resourceName} is now owned by a different UID than the tracked allocation`,
        );
      }
      if (this.#now().getTime() >= deadline) {
        throw new CloudRunAdminError(
          "unavailable",
          `Cloud Run Instance ${resourceName} removal was not verified in time`,
        );
      }
      await this.#sleep(2_000);
    }
  }

  /**
   * A late result for a generation that moved on. Delete exactly the UID we created/adopted; a
   * name already owned by a different UID means ours is gone. A failed cleanup is never swallowed.
   */
  async #deleteOrphaned(resourceName: string, resourceUid: string): Promise<void> {
    try {
      await this.#deleteVerified(resourceName, resourceUid);
    } catch (error) {
      // A name owned by a different UID means ours is already gone; any other failure is a
      // visible cleanup failure carrying the ownership evidence (name + UID).
      if (error instanceof CloudRunAdminError && error.kind === "ownership_mismatch") return;
      throw new CloudRunAdminError(
        "unavailable",
        `Late allocation cleanup for ${resourceName} (uid ${resourceUid}) failed: ${error instanceof Error ? error.message : "unknown failure"}`,
      );
    }
  }

  /** CAS the release completion; clears the reference only when it still names this allocation. */
  async #clearReleased(
    row: { id: string; environmentGeneration: number; sessionId: string },
    resourceName: string | null,
    resourceUid: string | null,
  ): Promise<boolean> {
    const now = this.#now();
    const [cleared] = await this.#database
      .update(sandboxes)
      .set({
        lifecycle: "unallocated",
        currentResourceName: null,
        currentResourceUid: null,
        currentOperationName: null,
        lastErrorCode: null,
        lastErrorAt: null,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.lifecycle, "releasing"),
          resourceName === null
            ? isNull(sandboxes.currentResourceName)
            : eq(sandboxes.currentResourceName, resourceName),
          resourceUid === null ? isNull(sandboxes.currentResourceUid) : eq(sandboxes.currentResourceUid, resourceUid),
        ),
      )
      .returning({ id: sandboxes.id });
    if (!cleared) return false;
    if (resourceName !== null) {
      this.#hub.closeScope({
        sandboxId: row.id,
        sessionId: row.sessionId,
        environmentGeneration: row.environmentGeneration,
        resourceName,
      });
    }
    return true;
  }

  /* ------------------------------------------------------------------------------------------
   * Small helpers
   * ---------------------------------------------------------------------------------------- */

  #closeRunnerScope(row: typeof sandboxes.$inferSelect): void {
    if (row.currentResourceName === null) return;
    this.#hub.closeScope({
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName,
    });
  }

  async #currentScopeRow(scope: RunnerScope): Promise<typeof sandboxes.$inferSelect | undefined> {
    const owned = await loadManagedSandboxById(this.#database, scope.sandboxId);
    if (!owned) return undefined;
    const row = owned.sandbox;
    if (
      row.sessionId !== scope.sessionId ||
      row.environmentGeneration !== scope.environmentGeneration ||
      row.currentResourceName !== scope.resourceName
    ) {
      return undefined;
    }
    return row;
  }

  /**
   * Promote `preparing -> ready` when the hub holds readiness from a CURRENT connection. This is
   * what closes the early-Runner race: the readiness frame may arrive before the create caller
   * tracked the verified UID, and this promotion runs immediately after tracking.
   */
  async #promoteReadyIfReported(sandboxId: string): Promise<boolean> {
    const snapshot = this.#hub.describe(sandboxId);
    if (
      !snapshot.connected ||
      !snapshot.ready ||
      !snapshot.readiness ||
      !snapshot.scope ||
      snapshot.readiness.runnerVersion !== this.#expectedRunnerVersion
    ) {
      return false;
    }
    const now = this.#now();
    const [promoted] = await this.#database
      .update(sandboxes)
      .set({ lifecycle: "ready", lastActivityAt: now, updatedAt: now })
      .where(
        and(
          eq(sandboxes.id, sandboxId),
          eq(sandboxes.environmentGeneration, snapshot.scope.environmentGeneration),
          eq(sandboxes.currentResourceName, snapshot.scope.resourceName),
          eq(sandboxes.lifecycle, "preparing"),
          isNotNull(sandboxes.currentResourceUid),
        ),
      )
      .returning({ id: sandboxes.id });
    if (promoted) return true;
    const [row] = await this.#rowById(sandboxId);
    return (
      row?.lifecycle === "ready" &&
      row.environmentGeneration === snapshot.scope.environmentGeneration &&
      row.currentResourceName === snapshot.scope.resourceName
    );
  }

  async #recordCreateFailure(row: { id: string; environmentGeneration: number }, error: unknown): Promise<void> {
    const kind = error instanceof CloudRunAdminError ? error.kind : undefined;
    // ONLY `createRejected` (an explicit rejected create response) proves nothing was allocated.
    // Post-POST GET/policy errors describe a resource that may exist and are never retryable or
    // clearable; everything else is uncertain.
    const code: Marker = createFailureMarker(error, kind);
    await this.#recordError(row, code, error);
  }

  async #marker(
    row: { id: string; environmentGeneration: number },
    code: Marker,
    options: { preservePending?: boolean } = {},
  ): Promise<void> {
    const now = this.#now();
    // `cloud_create_pending` is the only durable evidence that a winner is committed to POST. An
    // unrelated uncertainty update must not erase it; explicit rejection evidence may replace it.
    const preservePending = options.preservePending ?? code === "cloud_create_uncertain";
    await this.#database
      .update(sandboxes)
      .set({ lastErrorCode: code, lastErrorAt: now, updatedAt: now })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          inArray(sandboxes.lifecycle, ["preparing", "releasing"]),
          ...(preservePending
            ? [or(isNull(sandboxes.lastErrorCode), ne(sandboxes.lastErrorCode, "cloud_create_pending"))]
            : []),
        ),
      );
  }

  /** Persist the failure state. A failed write is itself surfaced, never swallowed. */
  async #recordError(
    row: { id: string; environmentGeneration: number },
    code: string,
    original: unknown,
    options: { preservePending?: boolean } = {},
  ): Promise<void> {
    try {
      const now = this.#now();
      await this.#database
        .update(sandboxes)
        .set({ lastErrorCode: code, lastErrorAt: now, updatedAt: now })
        .where(
          and(
            eq(sandboxes.id, row.id),
            eq(sandboxes.environmentGeneration, row.environmentGeneration),
            ...(options.preservePending
              ? [or(isNull(sandboxes.lastErrorCode), ne(sandboxes.lastErrorCode, "cloud_create_pending"))]
              : []),
          ),
        );
    } catch (recordError) {
      throw new SandboxServiceError(
        "SERVICE_UNAVAILABLE",
        "transient",
        `The Sandbox failure state could not be persisted (${failureText(recordError)}); original failure: ${failureText(original)}`,
        503,
      );
    }
  }

  async #rowById(sandboxId: string): Promise<(typeof sandboxes.$inferSelect)[]> {
    return this.#database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
  }

  #identityFor(row: typeof sandboxes.$inferSelect, generation: number): RunnerInstanceIdentityInput {
    return {
      environment: this.#environment,
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: generation,
    };
  }

  #resourceNameFor(row: { id: string; sessionId: string }, generation: number): string {
    return this.#cloud.resourceNameFor(
      this.#cloud.instanceIdFor({
        environment: this.#environment,
        sandboxId: row.id,
        sessionId: row.sessionId,
        environmentGeneration: generation,
      }),
    );
  }

  #toStatus(row: typeof sandboxes.$inferSelect): AccountSandboxRunnerStatusResponse {
    const snapshot = this.#hub.describe(row.id);
    const currentScope =
      snapshot.scope !== null &&
      snapshot.scope.environmentGeneration === row.environmentGeneration &&
      snapshot.scope.resourceName === row.currentResourceName;
    return {
      sandboxId: row.id,
      sessionId: row.sessionId,
      lifecycle: row.lifecycle,
      environmentGeneration: row.environmentGeneration,
      currentResourceName: row.currentResourceName,
      currentResourceUid: row.currentResourceUid,
      currentOperationName: row.currentOperationName,
      runnerConnected: snapshot.connected && currentScope,
      runnerReady: row.lifecycle === "ready" && snapshot.ready && currentScope,
      runnerReadiness: currentScope ? snapshot.readiness : null,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

function runnerConflict(message: string): SandboxServiceError {
  return new SandboxServiceError("SANDBOX_RUNNER_CONFLICT", "deterministic", message, 409);
}

/** Durable marker for a failed create attempt; only `createRejected` is definitive. */
function createFailureMarker(error: unknown, kind: CloudRunAdminError["kind"] | undefined): Marker {
  if (error instanceof CloudRunAdminError && error.createRejected) return "cloud_create_rejected";
  if (kind === "ownership_mismatch" || kind === "invalid") return "cloud_instance_unverified";
  return "cloud_create_uncertain";
}

function mapCloudError(error: unknown, action: string): unknown {
  if (error instanceof SandboxServiceError) return error;
  if (error instanceof CloudRunAdminError) {
    if (error.kind === "invalid" || error.kind === "credential" || error.kind === "ownership_mismatch") {
      return new SandboxServiceError(
        "SERVICE_UNAVAILABLE",
        "deterministic",
        `Cloud Runner configuration cannot ${action}: ${error.message}`,
        503,
      );
    }
    return new SandboxServiceError("SERVICE_UNAVAILABLE", "transient", `Failed to ${action}: ${error.message}`, 503);
  }
  return error;
}

function failureText(error: unknown): string {
  return error instanceof Error ? error.message : "unknown failure";
}
