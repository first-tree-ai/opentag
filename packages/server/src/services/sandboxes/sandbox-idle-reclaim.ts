import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
import { and, asc, eq, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { computers, imMessageDeliveries, sandboxes, sessionPlacements, sessions } from "../../db/schema/index.js";
import { type CloudRunAdmin, CloudRunAdminError } from "../cloud-run/index.js";
import { SandboxServiceError, WorkspaceSaveError } from "./errors.js";
import type { RunnerHub } from "./runner-hub.js";
import type { SandboxRunnerServiceOptions } from "./sandbox-runner-service.js";
import {
  automaticAttemptMatches,
  CLOUD_DELETE_PENDING,
  DELETE_CONFIRM_INTERVAL_MS,
  IDLE_RECLAIM_BATCH,
  type IdleSiblingSnapshot,
  runnerConflict,
  WORKSPACE_RECOVERY_RETRY_DELAY_MS,
  WORKSPACE_SAVE_FAILED,
  WORKSPACE_SAVE_REQUIRED,
} from "./sandbox-runner-state.js";
import type { SandboxWorkspace, SandboxWorkspaceSealer } from "./sandbox-workspace-sealer.js";
import type { WorkspaceObjectScope } from "./workspace-object-store.js";

type SandboxRow = typeof sandboxes.$inferSelect;

interface SandboxIdleReclaimOptions {
  database: DatabaseClient;
  cloud: CloudRunAdmin;
  hub: RunnerHub;
  environment: "dev" | "staging" | "prod";
  workspace: SandboxWorkspace | undefined;
  sealer: SandboxWorkspaceSealer;
  now: () => Date;
  idleTimeoutMs: number;
  createConvergeTimeoutMs: number;
  sessionWorkBusy: SandboxRunnerServiceOptions["sessionWorkBusy"];
  sessionWorkBarrier: SandboxRunnerServiceOptions["sessionWorkBarrier"];
  allocationStartMeta: Map<string, { generation: number; mode: "cold_start" | "warm_reuse"; startedAtMs: number }>;
  releaseCurrentAllocation: (row: SandboxRow, automatic?: boolean) => Promise<boolean>;
  clearReleased: (
    row: SandboxRow,
    resourceName: string | null,
    resourceUid: string | null,
    lifecycle?: Exclude<SandboxRow["lifecycle"], "unallocated">,
  ) => Promise<boolean>;
  promoteReadyIfReported: (sandboxId: string) => Promise<boolean>;
  recordError: (
    row: { id: string; environmentGeneration: number },
    code: string,
    original: unknown,
    options?: { preserveCreateMarkers?: boolean; automaticAttempt?: SandboxRow },
  ) => Promise<void>;
  setAllocationStartMeta: (
    sandboxId: string,
    value: { generation: number; mode: "cold_start" | "warm_reuse"; startedAtMs: number },
  ) => void;
  emitLifecycleLog: (operation: string, fields: Record<string, unknown>, level?: "info" | "warn") => void;
}

export class SandboxIdleReclaim {
  readonly #database: SandboxIdleReclaimOptions["database"];
  readonly #cloud: SandboxIdleReclaimOptions["cloud"];
  readonly #hub: SandboxIdleReclaimOptions["hub"];
  readonly #environment: SandboxIdleReclaimOptions["environment"];
  readonly #workspace: SandboxIdleReclaimOptions["workspace"];
  readonly #sealer: SandboxIdleReclaimOptions["sealer"];
  readonly #now: SandboxIdleReclaimOptions["now"];
  readonly #idleTimeoutMs: SandboxIdleReclaimOptions["idleTimeoutMs"];
  readonly #createConvergeTimeoutMs: SandboxIdleReclaimOptions["createConvergeTimeoutMs"];
  readonly #sessionWorkBusy: SandboxIdleReclaimOptions["sessionWorkBusy"];
  readonly #sessionWorkBarrier: SandboxIdleReclaimOptions["sessionWorkBarrier"];
  readonly #allocationStartMeta: SandboxIdleReclaimOptions["allocationStartMeta"];
  readonly #releaseCurrentAllocation: SandboxIdleReclaimOptions["releaseCurrentAllocation"];
  readonly #clearReleased: SandboxIdleReclaimOptions["clearReleased"];
  readonly #promoteReadyIfReported: SandboxIdleReclaimOptions["promoteReadyIfReported"];
  readonly #recordError: SandboxIdleReclaimOptions["recordError"];
  readonly #setAllocationStartMeta: SandboxIdleReclaimOptions["setAllocationStartMeta"];
  readonly #emitLifecycleLog: SandboxIdleReclaimOptions["emitLifecycleLog"];

  constructor(options: SandboxIdleReclaimOptions) {
    this.#database = options.database;
    this.#cloud = options.cloud;
    this.#hub = options.hub;
    this.#environment = options.environment;
    this.#workspace = options.workspace;
    this.#sealer = options.sealer;
    this.#now = options.now;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#createConvergeTimeoutMs = options.createConvergeTimeoutMs;
    this.#sessionWorkBusy = options.sessionWorkBusy;
    this.#sessionWorkBarrier = options.sessionWorkBarrier;
    this.#allocationStartMeta = options.allocationStartMeta;
    this.#releaseCurrentAllocation = options.releaseCurrentAllocation;
    this.#clearReleased = options.clearReleased;
    this.#promoteReadyIfReported = options.promoteReadyIfReported;
    this.#recordError = options.recordError;
    this.#setAllocationStartMeta = options.setAllocationStartMeta;
    this.#emitLifecycleLog = options.emitLifecycleLog;
  }

  /**
   * One bounded automatic idle sweep, safe under restarts and concurrent Server processes:
   * - a ready environment idle past the single budget is claimed (execution authority blocked),
   *   sealed through E5, then transitioned to releasing for verified deletion;
   * - already claimed or releasing rows retry after a durable cooldown on `updatedAt`;
   * - a provider-confirmed absent binding is cleared without a delete call;
   * - unknown reads and fail-create phases never clear a reference.
   * No transaction is held across cloud or storage I/O.
   */
  async reclaimIdleSandboxes(
    signal?: AbortSignal,
  ): Promise<{ claimed: number; released: number; recovered: number; failed: number }> {
    // Automatic deletion is enabled exactly when the deployment persists workspaces. Without the
    // object store a ready instance may hold the only copy of its workspace, so the sweep never
    // destroys it; explicit Account stop remains the operator path there.
    if (!this.#workspace) return { claimed: 0, released: 0, recovered: 0, failed: 0 };
    const now = this.#now();
    const idleCutoff = new Date(now.getTime() - this.#idleTimeoutMs);
    // Startup includes claim, archive download, the restored checkpoint upload and native
    // initialization. The create API's convergence budget alone cannot bound that work.
    const startupCutoff = new Date(now.getTime() - this.#createConvergeTimeoutMs - 4 * RUNNER_WORKSPACE_TIMEOUT_MS);
    let claimed = 0;
    let released = 0;
    let failed = 0;

    // The business idle budget stays on lastActivityAt; claimed rows also obey retry pacing.
    for (const candidate of await this.#idleReadyCandidates(idleCutoff)) {
      if (signal?.aborted) break;
      const outcome = await this.#reclaimIdleCandidate(candidate.id);
      if (outcome.claimed) claimed += 1;
      if (outcome.released) released += 1;
      if (outcome.failed) failed += 1;
    }

    const releasing = await this.#resumeAutomaticReleases(signal);

    const recovered = await this.#recoverStalePreparingAllocations(startupCutoff, signal);
    return {
      claimed,
      released: released + releasing.released,
      recovered: recovered.recovered,
      failed: failed + releasing.failed + recovered.failed,
    };
  }

  async #resumeAutomaticReleases(signal?: AbortSignal): Promise<{ released: number; failed: number }> {
    let released = 0;
    let failed = 0;
    // Explicit stop rows carry no automatic marker and stay outside this sweep.
    for (const candidate of await this.#automaticReleasingCandidates()) {
      if (signal?.aborted) break;
      const [current] = await this.#rowById(candidate.id);
      const reserved = current ? await this.#reserveAutomaticRetry(current, "releasing") : undefined;
      if (!reserved) continue;
      try {
        if (await this.#releaseCurrentAllocation(reserved, true)) released += 1;
      } catch {
        // The release funnel already recorded the durable failure state for the next sweep.
        failed += 1;
      }
    }

    return { released, failed };
  }

  /** Ready rows whose original activity budget has passed, claimed or not. */
  async #idleReadyCandidates(cutoff: Date): Promise<{ id: string }[]> {
    return this.#database
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.lifecycle, "ready"),
          isNotNull(sandboxes.currentResourceName),
          isNotNull(sandboxes.currentResourceUid),
          lte(sandboxes.lastActivityAt, cutoff),
          or(isNull(sandboxes.idleReclaimAt), this.#automaticRetryDue()),
        ),
      )
      .orderBy(asc(sandboxes.updatedAt), asc(sandboxes.id))
      .limit(IDLE_RECLAIM_BATCH);
  }

  /** Automatic-only releasing rows: the durable marker is the sweep's authorization. */
  async #automaticReleasingCandidates(): Promise<{ id: string }[]> {
    return this.#database
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.lifecycle, "releasing"), isNotNull(sandboxes.idleReclaimAt), this.#automaticRetryDue()))
      .orderBy(asc(sandboxes.updatedAt), asc(sandboxes.id))
      .limit(IDLE_RECLAIM_BATCH);
  }

  #automaticRetryDue() {
    const now = this.#now().getTime();
    return or(
      and(
        eq(sandboxes.lastErrorCode, CLOUD_DELETE_PENDING),
        lte(sandboxes.updatedAt, new Date(now - DELETE_CONFIRM_INTERVAL_MS)),
      ),
      and(
        or(isNull(sandboxes.lastErrorCode), ne(sandboxes.lastErrorCode, CLOUD_DELETE_PENDING)),
        lte(sandboxes.updatedAt, new Date(now - WORKSPACE_RECOVERY_RETRY_DELAY_MS)),
      ),
    );
  }

  async #reserveAutomaticRetry(row: typeof sandboxes.$inferSelect, lifecycle: "ready" | "releasing") {
    const [reserved] = await this.#database
      .update(sandboxes)
      .set({ updatedAt: this.#now() })
      .where(
        and(
          automaticAttemptMatches(row),
          eq(sandboxes.lifecycle, lifecycle),
          isNotNull(sandboxes.idleReclaimAt),
          this.#automaticRetryDue(),
        ),
      )
      .returning();
    return reserved;
  }

  /**
   * E7 stale-adoption recovery, bounded by create convergence plus workspace startup time (not
   * the idle budget). A `preparing` row whose tracked Instance has not produced a READY Runner
   * within that deadline would otherwise strand the borrower and its pending inputs forever. A
   * connected-but-never-ready Runner is included: restore attempts that never complete are a
   * startup failure, not disposable idle work, and the borrower's own archive is never touched.
   */
  async #recoverStalePreparingAllocations(
    startupCutoff: Date,
    signal?: AbortSignal,
  ): Promise<{ recovered: number; failed: number }> {
    const candidates = await this.#database
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.lifecycle, "preparing"),
          isNotNull(sandboxes.currentResourceName),
          isNotNull(sandboxes.currentResourceUid),
          isNull(sandboxes.idleReclaimAt),
          lte(sandboxes.lastActivityAt, startupCutoff),
        ),
      )
      .orderBy(asc(sandboxes.lastActivityAt), asc(sandboxes.id))
      .limit(IDLE_RECLAIM_BATCH);
    let recovered = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (signal?.aborted) break;
      // A ready connection is promoted by the normal readiness path, never recycled here.
      if (this.#hub.describe(candidate.id).ready) {
        await this.#promoteReadyIfReported(candidate.id).catch(() => undefined);
        continue;
      }
      try {
        if (await this.#releaseStalePreparing(candidate.id)) recovered += 1;
      } catch {
        failed += 1;
      }
    }
    return { recovered, failed };
  }

  /**
   * One bounded stale adoption: verify the tracked provider binding, then delete and clear. The
   * preparing -> releasing transition carries the automatic `idleReclaimAt` intent so ingress
   * keeps returning pending (never a terminal stopped) for inputs waiting on this Session, and a
   * failed delete is retried by the same sweep via the durable marker.
   */
  async #releaseStalePreparing(sandboxId: string): Promise<boolean> {
    const [row] = await this.#rowById(sandboxId);
    if (
      row?.lifecycle !== "preparing" ||
      row.currentResourceName === null ||
      row.currentResourceUid === null ||
      row.idleReclaimAt !== null
    ) {
      return false;
    }
    const resourceName = row.currentResourceName;
    const resourceUid = row.currentResourceUid;
    let view: Awaited<ReturnType<CloudRunAdmin["getInstance"]>>;
    try {
      view = await this.#cloud.getInstance(resourceName);
    } catch {
      // An unreadable provider proves nothing: keep the binding and retry on the next sweep.
      throw new CloudRunAdminError("unavailable", "The stale allocation could not be read");
    }
    if (!view || view.uid !== resourceUid) {
      return this.#clearReleased(row, resourceName, resourceUid, "preparing");
    }
    // Ownership only: a deployment image/config change must never block cleanup of an owned
    // legacy Instance.
    this.#cloud.verifyTrackedOwnership(view, { resourceName, resourceUid, environment: this.#environment });
    // Recheck AFTER the provider I/O: a connection that became ready while we were reading must
    // be promoted, never recycled as a failed startup; a row that moved on is left alone.
    if (this.#hub.describe(sandboxId).ready) {
      await this.#promoteReadyIfReported(sandboxId);
      return false;
    }
    const [current] = await this.#rowById(sandboxId);
    if (
      current?.lifecycle !== "preparing" ||
      current.idleReclaimAt !== null ||
      current.environmentGeneration !== row.environmentGeneration ||
      current.currentResourceName !== resourceName ||
      current.currentResourceUid !== resourceUid
    ) {
      return false;
    }
    const now = this.#now();
    const [releasing] = await this.#database
      .update(sandboxes)
      .set({ lifecycle: "releasing", idleReclaimAt: now, updatedAt: now })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.lifecycle, "preparing"),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.currentResourceName, resourceName),
          eq(sandboxes.currentResourceUid, resourceUid),
          isNull(sandboxes.idleReclaimAt),
        ),
      )
      .returning();
    if (!releasing) return false;
    return this.#releaseCurrentAllocation(releasing, true);
  }

  /** One bounded candidate: claim, prove the save, then release. Failures stay durably recorded. */
  async #reclaimIdleCandidate(sandboxId: string): Promise<{ claimed: boolean; released: boolean; failed: boolean }> {
    // Rotate unclaimed candidates for fairness without postponing a claimed row's retry.
    await this.#database
      .update(sandboxes)
      .set({ updatedAt: this.#now() })
      .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.lifecycle, "ready"), isNull(sandboxes.idleReclaimAt)));
    let claimed = false;
    let row: typeof sandboxes.$inferSelect | undefined;
    try {
      row = await this.#claimIdle(sandboxId, { automatic: true });
      claimed = row !== undefined;
    } catch {
      // Provider failure before the claim must not block ingress or the remainder of this pass.
      return { claimed: false, released: false, failed: true };
    }
    if (!claimed && this.#hub.isBusy(sandboxId)) return { claimed: false, released: false, failed: true };
    if (!row) {
      const [current] = await this.#rowById(sandboxId);
      if (current?.lifecycle !== "ready" || current.idleReclaimAt === null)
        return { claimed, released: false, failed: false };
      row = await this.#reserveAutomaticRetry(current, "ready");
    }
    if (!row) return { claimed, released: false, failed: false };
    try {
      // Seal BEFORE leaving `ready`: a failed save keeps the resource binding and the durable
      // claim for a paced retry; a proven archive short-circuits the Runner round-trip.
      await this.#sealer.sealWorkspaceIfOwed(row);
      const now = this.#now();
      const [releasing] = await this.#database
        .update(sandboxes)
        .set({ lifecycle: "releasing", updatedAt: now })
        .where(automaticAttemptMatches(row))
        .returning();
      if (!releasing) return { claimed, released: false, failed: false }; // stop or borrow won
      const released = await this.#releaseCurrentAllocation(releasing, true);
      return { claimed, released, failed: false };
    } catch (error) {
      if (error instanceof WorkspaceSaveError) {
        await this.#recordError(row, WORKSPACE_SAVE_FAILED, error, {
          preserveCreateMarkers: true,
          automaticAttempt: row,
        }).catch(() => undefined);
      } else if (!(error instanceof SandboxServiceError)) {
        await this.#recordError(row, "cloud_delete_incomplete", error, {
          preserveCreateMarkers: true,
          automaticAttempt: row,
        }).catch(() => undefined);
      }
      return { claimed, released: false, failed: true };
    }
  }

  /**
   * Atomic idle claim under the Sandbox row lock, shared by the automatic sweep and an on-demand
   * same-account borrow. The unsettled-delivery check runs AFTER the row lock, and dispatch
   * custody takes the same row lock — IM dispatch registers acceptance under it and the E8
   * Session-message owner re-verifies the unclaimed allocation under it before writing accepted
   * custody — so an accepted/claimed dispatch and a claim can never both commit. Any unsettled
   * work (pending/claimed dispatch, accepted/unreported) refuses the claim.
   */
  async #claimIdle(
    sandboxId: string,
    options: { automatic: boolean },
  ): Promise<typeof sandboxes.$inferSelect | undefined> {
    const [candidate] = await this.#rowById(sandboxId);
    if (
      candidate?.lifecycle !== "ready" ||
      candidate.idleReclaimAt !== null ||
      candidate.currentResourceName === null ||
      candidate.currentResourceUid === null
    )
      return undefined;
    // Preflight before taking execution authority. An old non-persistent Instance can never
    // fulfill a seal request, and an incompatible deployment cannot be reused. Neither should
    // make an otherwise usable Session permanently pending. Recheck the binding under the lock.
    const view = await this.#cloud.getInstance(candidate.currentResourceName);
    if (view?.uid === candidate.currentResourceUid) {
      if (view.workspacePersistence === false) return undefined;
      const identity = {
        resourceName: candidate.currentResourceName,
        resourceUid: candidate.currentResourceUid,
        environment: this.#environment,
      };
      if (options.automatic) this.#cloud.verifyTrackedOwnership(view, identity);
      else this.#cloud.verifyTrackedInstance(view, identity);
    }
    const now = this.#now();
    const cutoff = new Date(now.getTime() - this.#idleTimeoutMs);
    return this.#database.transaction(async (transaction) => {
      const [locked] = await transaction
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.id, sandboxId))
        .limit(1)
        .for("update");
      const row = this.#reclaimableRow(locked, candidate);
      if (!row) return undefined;
      // Acceptance registration also runs under this row lock (via the hub authorize hook), so
      // this in-memory check cannot miss a concurrent acceptance.
      if (this.#hub.isBusy(sandboxId)) return undefined;
      if (
        await this.#sessionWorkBlocksClaim(
          { environmentGeneration: row.environmentGeneration, resourceName: row.currentResourceName, sandboxId },
          row.sessionId,
          transaction,
        )
      ) {
        return undefined;
      }
      if (!this.#withinIdleBudget(row, options, now, cutoff)) return undefined;
      if (await this.#hasUnsettledWork(transaction, row.sessionId)) return undefined;
      const [claimed] = await transaction
        .update(sandboxes)
        .set({
          idleReclaimAt: now,
          lastErrorCode: WORKSPACE_SAVE_REQUIRED,
          lastErrorAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(sandboxes.id, row.id),
            eq(sandboxes.lifecycle, "ready"),
            isNull(sandboxes.idleReclaimAt),
            eq(sandboxes.environmentGeneration, row.environmentGeneration),
            eq(sandboxes.currentResourceName, row.currentResourceName),
            eq(sandboxes.currentResourceUid, row.currentResourceUid),
          ),
        )
        .returning();
      return claimed;
    });
  }

  /**
   * The row locked for a claim still holds the exact identity the un-locked preflight observed,
   * with a live allocation and no pending reclaim; otherwise the claim is refused.
   */
  #reclaimableRow(
    locked: typeof sandboxes.$inferSelect | undefined,
    candidate: typeof sandboxes.$inferSelect,
  ): (typeof sandboxes.$inferSelect & { currentResourceName: string; currentResourceUid: string }) | undefined {
    if (locked?.lifecycle !== "ready" || locked.idleReclaimAt !== null) return undefined;
    if (locked.currentResourceName === null || locked.currentResourceUid === null) return undefined;
    if (
      locked.environmentGeneration !== candidate.environmentGeneration ||
      locked.currentResourceName !== candidate.currentResourceName ||
      locked.currentResourceUid !== candidate.currentResourceUid
    ) {
      return undefined;
    }
    return locked as typeof locked & { currentResourceName: string; currentResourceUid: string };
  }

  /** The single budget check: `automatic` uses the idle cutoff, a borrow only refuses the future. */
  #withinIdleBudget(
    row: typeof sandboxes.$inferSelect,
    options: { automatic: boolean },
    now: Date,
    cutoff: Date,
  ): boolean {
    if (options.automatic) return row.lastActivityAt.getTime() <= cutoff.getTime();
    return row.lastActivityAt.getTime() <= now.getTime();
  }

  /**
   * E8 shared occupancy for one claim: the in-memory collaboration picture first (fast, catches
   * the pre-custody hand-off), then the durable accepted-work barrier that survives restarts and
   * lost settlement signals. Both are evaluated under the same Sandbox row lock as the claim.
   */
  async #sessionWorkBlocksClaim(
    allocation: { sandboxId: string; environmentGeneration: number; resourceName: string },
    sessionId: string,
    transaction: DatabaseTransaction,
  ): Promise<boolean> {
    if (this.#sessionWorkBusy?.(allocation)) return true;
    if (!this.#sessionWorkBarrier) return false;
    return this.#sessionWorkBarrier({ allocation, sessionId, transaction });
  }

  /** Unsettled work in the Session blocks every claim, under the same row lock as the claim. */
  async #hasUnsettledWork(transaction: DatabaseTransaction, sessionId: string): Promise<boolean> {
    const [unsettled] = await transaction
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          or(
            and(eq(imMessageDeliveries.state, "pending"), isNull(imMessageDeliveries.reason)),
            and(eq(imMessageDeliveries.state, "accepted"), isNull(imMessageDeliveries.reportedAt)),
          ),
        ),
      )
      .limit(1);
    return unsettled !== undefined;
  }

  /**
   * E7 on-demand borrow candidate: a same-account idle sibling with a connected reuse-capable
   * Runner, no active work, and the current deployment policy still verified on the provider.
   * Provider eligibility, claim and seal happen before any caller transaction. An unproven save
   * retains the claim; a proven seal that cannot transfer follows verified release.
   */
  async prepareIdleSiblingForReuse(
    accountId: string,
    claimantSandboxId: string,
  ): Promise<IdleSiblingSnapshot | undefined> {
    // Reuse is defined only with durable workspace persistence: without it a sealed Instance has
    // no archive to hand over, so the physical resource must never cross a Session boundary.
    if (!this.#workspace) return undefined;
    const candidates = await this.#idleSiblingCandidates(accountId, claimantSandboxId);
    for (const candidate of candidates) {
      if (!this.#isReuseCandidateReady(candidate)) continue;
      const prepared = await this.#claimAndSealSibling(candidate);
      if (prepared === "skip") continue;
      return prepared;
    }
    return undefined;
  }

  /** A candidate is borrowable only through a connected, ready, E7-negotiated, non-busy Runner. */
  #isReuseCandidateReady(candidate: typeof sandboxes.$inferSelect): boolean {
    const snapshot = this.#hub.describe(candidate.id);
    const resourceName = candidate.currentResourceName;
    return (
      snapshot.connected &&
      snapshot.ready &&
      snapshot.reuseCapable &&
      snapshot.scope !== null &&
      resourceName !== null &&
      snapshot.scope.environmentGeneration === candidate.environmentGeneration &&
      snapshot.scope.resourceName === resourceName &&
      !this.#hub.isBusy(candidate.id) &&
      this.#sessionWorkBusy?.({
        sandboxId: candidate.id,
        environmentGeneration: candidate.environmentGeneration,
        resourceName,
      }) !== true
    );
  }

  /**
   * Claim and seal one sibling. `"skip"` means this candidate cannot be used or was confirmed
   * absent (try the next one); `undefined` means the claim is retained for the sweep after a seal
   * failure. A prepared snapshot returns the exact claimed identity for the transfer transaction.
   */
  async #claimAndSealSibling(
    candidate: typeof sandboxes.$inferSelect,
  ): Promise<IdleSiblingSnapshot | undefined | "skip"> {
    let claimed: typeof sandboxes.$inferSelect | undefined;
    try {
      claimed = await this.#claimIdle(candidate.id, { automatic: false });
    } catch {
      return "skip";
    }
    if (!claimed) return "skip";
    try {
      await this.#sealer.sealWorkspaceIfOwed(claimed);
      await this.#clearClaimMarkers(claimed);
      const resourceName = claimed.currentResourceName;
      const resourceUid = claimed.currentResourceUid;
      if (resourceName === null || resourceUid === null) return "skip";
      const view = await this.#cloud.getInstance(resourceName);
      if (!view || view.uid !== resourceUid) {
        await this.#clearClaimedAbsent(claimed);
        return "skip";
      }
      this.#cloud.verifyTrackedInstance(view, { resourceName, resourceUid, environment: this.#environment });
      if (view.workspacePersistence === false) {
        throw new WorkspaceSaveError("the idle Instance does not carry workspace persistence");
      }
      const scope: WorkspaceObjectScope = {
        storageUri: claimed.storageUri,
        sandboxId: claimed.id,
        sessionId: claimed.sessionId,
        environmentGeneration: claimed.environmentGeneration,
      };
      if (!(await this.#sealer.workspaceSealProven(scope, claimed.environmentGeneration))) {
        throw new WorkspaceSaveError("the idle workspace archive could not be verified");
      }
      return {
        sandboxId: claimed.id,
        sessionId: claimed.sessionId,
        environmentGeneration: claimed.environmentGeneration,
        resourceName,
        resourceUid,
      };
    } catch {
      // A proven seal can be released immediately; an unproven save remains claimed for retry.
      // Never "unclaim" a sealed Runner: its controller can no longer execute the old generation.
      await this.releaseUnusedBorrow({
        sandboxId: claimed.id,
        sessionId: claimed.sessionId,
        environmentGeneration: claimed.environmentGeneration,
        resourceName: claimed.currentResourceName as string,
        resourceUid: claimed.currentResourceUid as string,
      });
      return undefined;
    }
  }

  /** A sealed hand-off that did not commit follows normal verified deletion, without another idle wait. */
  async releaseUnusedBorrow(candidate: IdleSiblingSnapshot): Promise<void> {
    const [releasing] = await this.#database
      .update(sandboxes)
      .set({ lifecycle: "releasing", updatedAt: this.#now() })
      .where(
        and(
          eq(sandboxes.id, candidate.sandboxId),
          eq(sandboxes.lifecycle, "ready"),
          eq(sandboxes.environmentGeneration, candidate.environmentGeneration),
          eq(sandboxes.currentResourceName, candidate.resourceName),
          eq(sandboxes.currentResourceUid, candidate.resourceUid),
          isNotNull(sandboxes.idleReclaimAt),
          isNull(sandboxes.lastErrorCode),
        ),
      )
      .returning();
    if (!releasing) return;
    try {
      await this.#releaseCurrentAllocation(releasing);
    } catch {
      // The normal release path records the failure; the existing sweep retries releasing rows.
    }
  }

  /** Same-account idle siblings, oldest activity first; the uniqueness index picks one owner. */
  async #idleSiblingCandidates(
    accountId: string,
    excludeSandboxId: string,
  ): Promise<(typeof sandboxes.$inferSelect)[]> {
    const rows = await this.#database
      .select({ sandbox: sandboxes })
      .from(sandboxes)
      .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(computers.ownerAccountId, accountId),
          eq(computers.kind, "cloud"),
          ne(sandboxes.id, excludeSandboxId),
          eq(sandboxes.lifecycle, "ready"),
          isNotNull(sandboxes.currentResourceName),
          isNotNull(sandboxes.currentResourceUid),
          isNull(sandboxes.idleReclaimAt),
        ),
      )
      .orderBy(asc(sandboxes.lastActivityAt), asc(sandboxes.id))
      .limit(4);
    return rows.map((row) => row.sandbox);
  }

  /**
   * Single-winner ownership hand-off. The reservation's advisory admission lock is held first,
   * the claimant row lock second (held by the caller), the candidate third here. There is no
   * lock cycle to order around: a candidate must be `ready` with a tracked binding and a
   * claimant must be `unallocated`, so the two roles are disjoint and concurrent transfers
   * touch disjoint candidate rows. The candidate is revalidated against the exact claim
   * (`idle_reclaim_at`, same account, generation, name, UID, no pending marker), cleared first
   * so the unique indexes never see two owners, and only then assigned to the claimant with
   * generation + 1. A lost race returns undefined and leaves the candidate for the caller to
   * release through the normal verified cleanup path.
   */
  async transferClaimedAllocation(
    transaction: DatabaseTransaction,
    claimant: typeof sandboxes.$inferSelect,
    candidate: IdleSiblingSnapshot,
    accountId: string,
  ): Promise<typeof sandboxes.$inferSelect | undefined> {
    // Lock order: advisory admission lock, then the claimant row lock (held by `startForAccount`),
    // then the candidate here. The dependency is acyclic because a row can only be a candidate
    // while it is `ready` with a tracked binding and a claimant while it is `unallocated`; those
    // states are disjoint, so no transfer ever locks another transfer's claimant, and
    // concurrent transfers touch disjoint candidate rows.
    const [claimed] = await transaction
      .select()
      .from(sandboxes)
      .where(eq(sandboxes.id, candidate.sandboxId))
      .limit(1)
      .for("update");
    if (
      claimed?.lifecycle !== "ready" ||
      claimed.idleReclaimAt === null ||
      claimed.environmentGeneration !== candidate.environmentGeneration ||
      claimed.currentResourceName !== candidate.resourceName ||
      claimed.currentResourceUid !== candidate.resourceUid ||
      claimed.lastErrorCode !== null
    ) {
      return undefined;
    }
    // Revalidate same-account ownership under the lock AFTER the awaited seal/provider calls: the
    // candidate selection ran in a different statement, and a borrow must never cross accounts.
    const [candidateOwner] = await transaction
      .select({ accountId: computers.ownerAccountId, kind: computers.kind })
      .from(sandboxes)
      .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(eq(sandboxes.id, claimed.id))
      .limit(1);
    if (candidateOwner?.kind !== "cloud" || candidateOwner.accountId !== accountId) {
      return undefined;
    }
    const now = this.#now();
    const [cleared] = await transaction
      .update(sandboxes)
      .set({
        lifecycle: "unallocated",
        currentResourceName: null,
        currentResourceUid: null,
        currentOperationName: null,
        idleReclaimAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, claimed.id),
          eq(sandboxes.lifecycle, "ready"),
          isNotNull(sandboxes.idleReclaimAt),
          eq(sandboxes.environmentGeneration, candidate.environmentGeneration),
          eq(sandboxes.currentResourceName, candidate.resourceName),
          eq(sandboxes.currentResourceUid, candidate.resourceUid),
        ),
      )
      .returning({ id: sandboxes.id });
    if (!cleared) return undefined;
    const [adopted] = await transaction
      .update(sandboxes)
      .set({
        lifecycle: "preparing",
        environmentGeneration: claimant.environmentGeneration + 1,
        currentResourceName: candidate.resourceName,
        currentResourceUid: candidate.resourceUid,
        currentOperationName: null,
        idleReclaimAt: null,
        lastErrorCode: null,
        lastErrorAt: null,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(sandboxes.id, claimant.id),
          eq(sandboxes.lifecycle, "unallocated"),
          eq(sandboxes.environmentGeneration, claimant.environmentGeneration),
        ),
      )
      .returning();
    if (!adopted) {
      throw runnerConflict("The Sandbox environment changed while the physical Instance was being adopted");
    }
    this.#allocationStartMeta.delete(candidate.sandboxId);
    this.#setAllocationStartMeta(adopted.id, {
      generation: adopted.environmentGeneration,
      mode: "warm_reuse",
      startedAtMs: now.getTime(),
    });
    this.#emitLifecycleLog("sandbox.lifecycle.borrow", {
      sandboxId: adopted.id,
      sessionId: adopted.sessionId,
      accountId,
      environmentGeneration: adopted.environmentGeneration,
      sourceSandboxId: candidate.sandboxId,
      sourceSessionId: candidate.sessionId,
      sourceGeneration: candidate.environmentGeneration,
      resourceName: candidate.resourceName,
      resourceUid: candidate.resourceUid,
      startupMode: "warm_reuse",
    });
    return adopted;
  }

  /** Provider-confirmed absence: safe to clear the exact tracked binding without a delete call. */
  async #clearClaimedAbsent(row: typeof sandboxes.$inferSelect): Promise<void> {
    if (row.currentResourceName === null || row.currentResourceUid === null) return;
    if (!(await this.#clearReleased(row, row.currentResourceName, row.currentResourceUid, "ready"))) {
      throw runnerConflict("The Sandbox environment changed while absence was being verified");
    }
  }

  /**
   * A proven seal resolves the claim's save debt: clear the marker while the automatic claim is
   * still held, so a following transfer revalidation sees a clean claim and the sweep does not
   * request a second Runner round-trip. The record is also the durable "sealed" intent a restart
   * reads before deciding whether the resource may be deleted.
   */
  async #clearClaimMarkers(row: typeof sandboxes.$inferSelect): Promise<void> {
    if (row.currentResourceName === null || row.currentResourceUid === null) return;
    await this.#database
      .update(sandboxes)
      .set({ lastErrorCode: null, lastErrorAt: null, updatedAt: this.#now() })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.currentResourceName, row.currentResourceName),
          eq(sandboxes.currentResourceUid, row.currentResourceUid),
          isNotNull(sandboxes.idleReclaimAt),
        ),
      );
  }

  async #rowById(sandboxId: string): Promise<SandboxRow[]> {
    return this.#database.select().from(sandboxes).where(eq(sandboxes.id, sandboxId)).limit(1);
  }
}
