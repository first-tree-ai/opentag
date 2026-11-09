import type {
  AccountSandboxRunnerAcceptanceRequest,
  AccountSandboxRunnerAcceptanceResponse,
  AccountSandboxRunnerStatusResponse,
  AccountSandboxRunnerStopRequest,
  RunnerReadiness,
} from "@opentag/shared";
import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
import { and, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { computers, sandboxes } from "../../db/schema/index.js";
import type { BackgroundFailureSupervisor } from "../../observability/background-failure-supervisor.js";
import { type PerformanceLogger, updateCurrentPerformanceContext } from "../../observability/performance-logger.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { type CloudRunAdmin, CloudRunAdminError, type RunnerInstanceIdentityInput } from "../cloud-run/index.js";
import {
  CloudCapacityExceededError,
  SandboxServiceError,
  sandboxNotFound,
  WorkspaceRestoreRequiredError,
  WorkspaceSaveError,
  WorkspaceSaveFailedError,
} from "./errors.js";
import {
  loadManagedSandboxById,
  loadOwnedSandbox,
  loadSandboxOwnerById,
  loadSandboxRecordById,
} from "./owned-sandbox.js";
import type { RunnerBootstrapClaims, RunnerBootstrapTokenService } from "./runner-bootstrap-token.js";
import { RunnerAcceptanceUnavailableError, type RunnerHub, type RunnerScope } from "./runner-hub.js";
import {
  type CloudCapacityLimits,
  cloudCapacityAdmission,
  countCloudCapacityOccupancy,
  lockCloudCapacityAdmission,
  normalizeCloudCapacityLimits,
} from "./sandbox-capacity.js";
import { SandboxIdleReclaim } from "./sandbox-idle-reclaim.js";
import {
  automaticAttemptMatches,
  CLOUD_DELETE_PENDING,
  isDefinitiveNoResourceMarker,
  MARKER_RETRYABLE,
  runnerConflict,
  WORKSPACE_SAVE_FAILED,
  WORKSPACE_SAVE_REQUIRED,
} from "./sandbox-runner-state.js";
import { SandboxTokenAuthority } from "./sandbox-token-authority.js";
import { SandboxWorkspaceSealer } from "./sandbox-workspace-sealer.js";
import type { WorkspaceObjectStore } from "./workspace-object-store.js";

export { CLOUD_DELETE_PENDING, WORKSPACE_RECOVERY_RETRY_DELAY_MS } from "./sandbox-runner-state.js";

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
 *   verification: never retried and never deleted unverified). A delete-phase failure
 *   (`cloud_delete_incomplete`) and the weak `cloud_create_uncertain` update are recorded only
 *   when no create-phase marker exists, so a stop error can never erase the evidence a later
 *   stop needs to release the row safely (a failed GET followed by a 404 must recover).
 * - After a proven automatic seal and accepted DELETE, `cloud_delete_pending` replaces the
 *   save marker. `lastErrorAt` anchors its confirmation deadline; due sweeps read once without
 *   resubmitting DELETE. This normal phase is hidden from public failure diagnostics.
 * - Every mutation of the row is CAS-guarded on (id, generation, name), so a stale in-flight
 *   operation can never mutate a newer environment. A tracked resource reference is never erased
 *   while removal is uncertain. Normal release requires a 404; a same-name replacement UID
 *   remains an ownership conflict. Orphan cleanup may recognize its replaced UID as gone.
 * - `ready` requires an authenticated CURRENT Runner at the exact expected version plus verified
 *   Cloud policy for the CURRENT generation — never a signedRunner frame alone. An early Runner
 *   report is deferred, not rejected, until the create caller records the verified UID. The
 *   single exception is a previously verified tracked READY allocation reconnecting after a
 *   deployment target change: its Instance already passed strict initial acceptance, so the
 *   provider-verified original generation-1, digest-pinned image (tracked name/UID/ownership plus every non-image
 *   policy check) substitutes for the version equality first admission requires.
 * - E9 admission: a brand-new generation is charged exactly once inside its reservation
 *   transaction (see sandbox-capacity.ts); reused, existing, releasing and recovering
 *   allocations are never charged or blocked by a full limit.
 */

export interface SandboxRunnerServiceOptions {
  /** Composition-owned observers; allocation never depends on a consumer's successful wakeup. */
  readinessNotifications?: {
    onReady: (allocation: ReadyRunnerAllocation) => Promise<void>;
    supervisor: BackgroundFailureSupervisor;
  };
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
  /**
   * E7 single idle budget: a ready environment with no business activity for this long is
   * reclaimed by the periodic sweep. A same-account borrow is on demand for any quiescent
   * candidate and is not gated on this budget. One clock (`lastActivityAt`), never heartbeat
   * activity.
   */
  idleTimeoutMs?: number;
  /** E9 admission ceilings; only a brand-new generation reservation is charged. Defaults 3/20. */
  capacity?: CloudCapacityLimits;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  deleteVerifyTimeoutMs?: number;
  logger?: ServiceLogger;
  performanceLogger?: PerformanceLogger;
  /**
   * E5 workspace persistence, present exactly when the deployment configured the object store.
   * With it, Instances are created with the workspace env flag, execution-capable Runners must
   * negotiate and restore the workspace, and releasing a previously-ready environment must first
   * prove the sealed archive (Runner seal request + metadata read-back) before deletion.
   */
  workspace?: {
    store: WorkspaceObjectStore;
    /** Covers drain, two uploads and archive processing; defaults to 4 x the transfer timeout. */
    sealTimeoutMs?: number;
  };
  /**
   * E8 Session collaboration liveness: accepted-unfinished Session-message work on the exact
   * allocation being considered. Consulted next to `hub.isBusy` under the same Sandbox row lock,
   * so an idle claim or a sibling borrow can never interrupt a collaboration Turn the IM custody
   * rows cannot see (Session messages have no durable Turn columns by design). The allocation
   * identity (Sandbox + generation + resource) keeps a stale registration on a replaced
   * allocation from pinning its successor.
   */
  sessionWorkBusy?: (allocation: { sandboxId: string; environmentGeneration: number; resourceName: string }) => boolean;
  /**
   * The authoritative durable barrier, awaited inside the same row-lock transaction as the claim.
   * It reads the existing `runtime_durable_work` `session-message` records and compares their
   * recorded allocation with the exact allocation being claimed, so accepted work blocks reclaim
   * only while its own Instance still holds it. A record whose allocation was retired or replaced
   * can never execute again and must not pin a replacement environment.
   */
  sessionWorkBarrier?: (input: {
    allocation: { sandboxId: string; environmentGeneration: number; resourceName: string };
    sessionId: string;
    transaction: DatabaseTransaction;
  }) => Promise<boolean>;
}

const DELETE_VERIFY_DEFAULT_MS = 60_000;
const IDLE_RECLAIM_DEFAULT_MS = 120_000;
/** Durable create-phase markers recorded in `lastErrorCode`. */
type Marker =
  | "cloud_create_pending"
  | "cloud_create_uncertain"
  | "cloud_instance_unverified"
  | (typeof MARKER_RETRYABLE)[number];
const RETRYABLE_MARKER_LIST: string[] = [...MARKER_RETRYABLE];
/**
 * Every durable create-phase marker. A delete-phase failure (`cloud_delete_incomplete`) or the
 * weak `cloud_create_uncertain` update must never overwrite one of these: they are the only
 * evidence distinguishing "release/retry is safe" from "create outcome still unknown", and the
 * `cloud_instance_unverified` diagnostic.
 */
const CREATE_PHASE_MARKER_LIST: string[] = [
  "cloud_create_pending",
  "cloud_create_rejected",
  "cloud_create_failed",
  "cloud_create_uncertain",
  "cloud_instance_unverified",
];

/**
 * E5 durable release-phase markers. `workspace_save_required` is stamped atomically by the
 * ready -> releasing transition so a Server restart can never mistake a used environment for an
 * unused one; `workspace_save_failed` records a seal/save failure that kept the resource binding.
 * Failure or uncertain-phase writes never erase these markers. After a proven automatic seal,
 * an accepted DELETE may replace its save marker with `cloud_delete_pending`.
 */
const WORKSPACE_DISCARD_REQUESTED = "workspace_discard_requested";
const WORKSPACE_RELEASE_MARKER_LIST: string[] = [
  WORKSPACE_SAVE_REQUIRED,
  WORKSPACE_SAVE_FAILED,
  WORKSPACE_DISCARD_REQUESTED,
];

/**
 * Markers a weaker failure write must never overwrite. A workspace release marker may overwrite
 * another workspace release marker (same phase, newer fact), but create-phase evidence is never
 * erased by anything but a stronger create/adopt verdict.
 */
function preservedMarkersFor(incomingCode: string): string[] {
  return WORKSPACE_RELEASE_MARKER_LIST.includes(incomingCode)
    ? [...CREATE_PHASE_MARKER_LIST, WORKSPACE_DISCARD_REQUESTED]
    : [...CREATE_PHASE_MARKER_LIST, ...WORKSPACE_RELEASE_MARKER_LIST];
}

/** Account stops are generation-fenced under the same row lock that records release intent. */
function stopReleaseMarker(
  row: Pick<typeof sandboxes.$inferSelect, "lifecycle" | "environmentGeneration" | "lastErrorCode">,
  input: AccountSandboxRunnerStopRequest | undefined,
  persistence: boolean,
): string | undefined {
  if (input && input.environmentGeneration !== row.environmentGeneration) {
    throw runnerConflict("The release request refers to a different environment generation");
  }
  if (input && "discardUnsavedChanges" in input) {
    if (row.lifecycle === "ready" || WORKSPACE_RELEASE_MARKER_LIST.includes(row.lastErrorCode ?? "")) {
      return WORKSPACE_DISCARD_REQUESTED;
    }
  }
  return persistence && row.lifecycle === "ready" ? WORKSPACE_SAVE_REQUIRED : undefined;
}

export type RunnerReadyOutcome = "ready" | "deferred" | "stale" | "version_mismatch" | "workspace_not_restored";

/** Readiness of the current control connection AND its verified, persisted allocation. */
export interface ReadyRunnerAllocation extends RunnerScope {
  readonly resourceUid: string;
}

/** Automatic ingress allocation outcome; `restore_required` is the E5 guard, never a retry loop. */
export type IngressAllocationOutcome = "ready" | "pending" | "stopped" | "restore_required";

/**
 * Bounded, read-only allocation reconciliation through the injected Cloud API. `physical` is the
 * only field that may prove a persisted resource is gone; `untracked` means the create outcome
 * was never verified and therefore proves nothing.
 */
export interface SandboxAllocationReconciliation {
  scope: RunnerScope | null;
  lifecycle: "unallocated" | "preparing" | "ready" | "releasing";
  resourceUid: string | null;
  physical: "present" | "absent" | "untracked" | "unknown";
}

export class SandboxRunnerService {
  readonly #tokenAuthority: SandboxTokenAuthority;
  readonly #workspaceSealer: SandboxWorkspaceSealer;
  readonly #idleReclaim: SandboxIdleReclaim;
  readonly #readinessNotifications: SandboxRunnerServiceOptions["readinessNotifications"];
  readonly #publishedReadiness = new WeakSet<object>();
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
  readonly #idleTimeoutMs: number;
  readonly #capacity: CloudCapacityLimits;
  readonly #workspace: { store: WorkspaceObjectStore; sealTimeoutMs: number } | undefined;
  readonly #now: () => Date;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #logger: ServiceLogger | undefined;
  readonly #perfLogger: PerformanceLogger | undefined;
  readonly #allocationStartMeta = new Map<
    string,
    { generation: number; mode: "cold_start" | "warm_reuse"; startedAtMs: number }
  >();

  constructor(database: DatabaseClient, options: SandboxRunnerServiceOptions) {
    if (!options.expectedRunnerVersion) throw new Error("SandboxRunnerService requires the expected Runner version");
    this.#database = database;
    this.#readinessNotifications = options.readinessNotifications;
    this.#cloud = options.cloudAdmin;
    this.#tokens = options.tokens;
    this.#hub = options.hub;
    this.#environment = options.environment;
    this.#backendUrl = options.backendUrl;
    this.#expectedRunnerVersion = options.expectedRunnerVersion;
    this.#acceptanceTimeoutMs = options.acceptanceTimeoutMs;
    this.#createConvergeTimeoutMs = options.createConvergeTimeoutMs;
    this.#deleteVerifyTimeoutMs = options.deleteVerifyTimeoutMs ?? DELETE_VERIFY_DEFAULT_MS;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? IDLE_RECLAIM_DEFAULT_MS;
    if (!Number.isSafeInteger(this.#idleTimeoutMs) || this.#idleTimeoutMs < 1) {
      throw new Error("SandboxRunnerService requires a positive idleTimeoutMs");
    }
    this.#capacity = normalizeCloudCapacityLimits(options.capacity);
    this.#workspace = options.workspace
      ? {
          store: options.workspace.store,
          sealTimeoutMs: options.workspace.sealTimeoutMs ?? 4 * RUNNER_WORKSPACE_TIMEOUT_MS,
        }
      : undefined;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#logger = options.logger;
    this.#perfLogger = options.performanceLogger;
    this.#tokenAuthority = new SandboxTokenAuthority({
      database,
      cloud: this.#cloud,
      tokens: this.#tokens,
      environment: this.#environment,
      workspacePersistenceEnabled: this.#workspace !== undefined,
    });
    this.#workspaceSealer = new SandboxWorkspaceSealer({
      cloud: this.#cloud,
      hub: this.#hub,
      workspace: this.#workspace,
      now: this.#now,
      performanceLogger: this.#perfLogger,
      emitLifecycleLog: (operation, fields) => this.#emitLifecycleLog(operation, fields),
    });
    this.#idleReclaim = new SandboxIdleReclaim({
      database,
      cloud: this.#cloud,
      hub: this.#hub,
      environment: this.#environment,
      workspace: this.#workspace,
      sealer: this.#workspaceSealer,
      now: this.#now,
      idleTimeoutMs: this.#idleTimeoutMs,
      createConvergeTimeoutMs: this.#createConvergeTimeoutMs,
      sessionWorkBusy: options.sessionWorkBusy,
      sessionWorkBarrier: options.sessionWorkBarrier,
      allocationStartMeta: this.#allocationStartMeta,
      releaseCurrentAllocation: (...args) => this.#releaseCurrentAllocation(...args),
      clearReleased: (...args) => this.#clearReleased(...args),
      promoteReadyIfReported: (...args) => this.#promoteReadyIfReported(...args),
      recordError: (...args) => this.#recordError(...args),
      setAllocationStartMeta: (...args) => this.#setAllocationStartMeta(...args),
      emitLifecycleLog: (...args) => this.#emitLifecycleLog(...args),
    });
  }

  /** True when this deployment persists workspaces; the Runner capability gates key off this. */
  get workspacePersistenceEnabled(): boolean {
    return this.#workspace !== undefined;
  }

  /** E9 admission ceilings (defaults 3/20); occupancy is counted from the durable Sandbox facts. */
  get capacityLimits(): CloudCapacityLimits {
    return this.#capacity;
  }

  /* ------------------------------------------------------------------------------------------
   * Account-facing operations
   * ---------------------------------------------------------------------------------------- */

  async startForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    const start = () => this.#startForAccount(accountId, sandboxId);
    return this.#perfLogger
      ? this.#perfLogger.traceAsync(
          { module: "sandboxes", category: "service", operation: "sandbox.allocation.start", sandboxId },
          start,
          { resultAttributes: (result) => ({ lifecycle: result.lifecycle }) },
        )
      : start();
  }

  async #startForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    await this.#releaseMissingReadyAllocation(accountId, sandboxId);
    await this.#prepareWorkspaceAllocation(accountId, sandboxId);
    // E7 on-demand borrow: a fresh unallocated Session may take a same-account idle sibling's
    // physical Instance. The candidate is claimed (execution blocked) and sealed BEFORE the
    // reservation transaction, so no database transaction spans the E5 seal or a cloud read.
    const preflight = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "manage" });
    if (!preflight) throw sandboxNotFound();
    updateCurrentPerformanceContext({ sessionId: preflight.sandbox.sessionId });
    const borrowed =
      preflight.sandbox.lifecycle === "unallocated"
        ? await this.#idleReclaim.prepareIdleSiblingForReuse(accountId, preflight.sandbox.id)
        : undefined;
    const reservation = await this.#database
      .transaction(async (transaction) => {
        /*
         * Admission lock order: the environment-wide advisory lock is the FIRST lock of every
         * reservation transaction, before any Sandbox row lock, so every new physical reservation
         * serializes here and the occupancy count sees every committed one. A waiter holds no
         * row locks yet, so it cannot deadlock stop/claim/acceptance transactions, which never
         * take this lock. It covers only this short reservation — never seal or cloud I/O.
         */
        await lockCloudCapacityAdmission(transaction);
        // Start/execute requires the CURRENT authority chain: active Pi Agent, active binding,
        // un-ended Session, non-suspended Account, owned Cloud Computer.
        const owned = await loadOwnedSandbox(transaction, accountId, sandboxId, {
          lock: true,
          authority: "manage",
          expectedAgentRevision: preflight.agentRevision,
        });
        if (!owned) throw sandboxNotFound();
        const row = owned.sandbox;
        if (row.lifecycle === "releasing") {
          throw runnerConflict("The Sandbox environment is being released; retry after release completes");
        }
        if (row.lifecycle === "unallocated") {
          if (borrowed) {
            const adopted = await this.#idleReclaim.transferClaimedAllocation(transaction, row, borrowed, accountId);
            if (adopted) return { action: "reuse" as const, row: adopted };
          }
          return this.#reserveNewGeneration(transaction, row, accountId);
        }
        return this.#reserveExistingAllocation(row);
      })
      .catch(async (error: unknown) => {
        if (borrowed) await this.#idleReclaim.releaseUnusedBorrow(borrowed);
        throw error;
      });
    updateCurrentPerformanceContext({ environmentGeneration: reservation.row.environmentGeneration });
    if (borrowed && reservation.action !== "reuse") await this.#idleReclaim.releaseUnusedBorrow(borrowed);

    if (reservation.action === "allocate" || reservation.action === "retry") {
      try {
        await this.#submitCreate(reservation.row, { claimed: reservation.action === "allocate" });
      } catch (error) {
        // A CloudRun failure escaping the submit path (pending-release cleanup after a late
        // track, orphaned-resource removal) must surface the same 503 envelope as every other
        // cloud failure, never a raw 500.
        throw mapCloudError(error, "allocate the Sandbox environment");
      }
    } else if (reservation.action === "reconcile") {
      try {
        await this.#reconcileAllocation(reservation.row);
      } catch (error) {
        throw mapCloudError(error, "reconcile the Sandbox environment");
      }
    } else if (reservation.action === "reuse" && borrowed) {
      // The transfer committed: the physical Instance is now owned by the claimant, so the old
      // holder's Runner channel must close and reconnect through its physical control credential,
      // which resolves the unique current holder (the claimant) on the next attach.
      this.#hub.closeScope({
        sandboxId: borrowed.sandboxId,
        sessionId: borrowed.sessionId,
        environmentGeneration: borrowed.environmentGeneration,
        resourceName: borrowed.resourceName,
      });
    }
    await this.#promoteReadyIfReported(sandboxId);
    return this.statusForAccount(accountId, sandboxId);
  }

  /**
   * A lost used Instance needs no seal/delete, but its binding must stop claiming ready. Only
   * provider-confirmed absence of the exact UID permits this CAS; a disconnected Runner or a
   * failed GET never does. Clearing directly avoids exposing an automatic repair as an explicit
   * stop (`releasing`) to concurrent ingress. The normal start path restores the SAME storage URI.
   */
  async #releaseMissingReadyAllocation(accountId: string, sandboxId: string): Promise<void> {
    if (!this.#workspace || this.#hub.describe(sandboxId).connected) return;
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "manage" });
    if (!owned) throw sandboxNotFound();
    const row = owned.sandbox;
    if (row.lifecycle !== "ready" || !row.currentResourceName || !row.currentResourceUid) return;
    let view: Awaited<ReturnType<CloudRunAdmin["getInstance"]>>;
    try {
      view = await this.#cloud.getInstance(row.currentResourceName);
    } catch (error) {
      throw mapCloudError(error, "verify the Sandbox environment");
    }
    if (view?.uid === row.currentResourceUid || this.#hub.describe(sandboxId).connected) return;
    // Generation/name/UID/lifecycle CAS cannot undo a concurrent stop or clear a new allocation.
    if (!(await this.#clearReleased(row, row.currentResourceName, row.currentResourceUid, "ready"))) {
      throw runnerConflict("The Sandbox environment changed while recovery was being verified");
    }
  }

  /** Validate storage before reservation, without holding a transaction through storage I/O. */
  async #prepareWorkspaceAllocation(accountId: string, sandboxId: string): Promise<void> {
    if (!this.#workspace) return;
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "manage" });
    if (!owned) throw sandboxNotFound();
    const row = owned.sandbox;
    if (row.lifecycle !== "unallocated") return;
    try {
      if (row.environmentGeneration > 0) {
        const object = await this.#workspace.store.head({
          storageUri: row.storageUri,
          sandboxId: row.id,
          sessionId: row.sessionId,
          environmentGeneration: row.environmentGeneration,
        });
        if (!object) throw new WorkspaceRestoreRequiredError();
        return;
      }
      // No DB transaction spans storage I/O. Conditional creation coalesces concurrent starters;
      // the reservation below revalidates current authority and allocation under the row lock.
      await this.#workspace.store.claim(
        {
          storageUri: row.storageUri,
          sandboxId: row.id,
          sessionId: row.sessionId,
          environmentGeneration: 1,
        },
        { initialize: true },
      );
    } catch (error) {
      if (error instanceof WorkspaceRestoreRequiredError) throw error;
      throw new SandboxServiceError(
        "SERVICE_UNAVAILABLE",
        "transient",
        "The workspace storage could not be prepared",
        503,
      );
    }
  }

  /** `unallocated -> preparing`, generation + 1, deterministic name persisted before any I/O. */
  async #reserveNewGeneration(
    transaction: DatabaseTransaction,
    row: typeof sandboxes.$inferSelect,
    accountId: string,
  ): Promise<{ action: "allocate"; row: typeof sandboxes.$inferSelect }> {
    // Charged exactly once per NEW generation, under the admission lock; the count invariant
    // lives in sandbox-capacity.ts. A full limit throws the stable capacity error and rolls the
    // reservation back; transfers, retries and reconciles never pass through here.
    const admission = cloudCapacityAdmission(await countCloudCapacityOccupancy(transaction, accountId), this.#capacity);
    if (!admission.admitted) throw new CloudCapacityExceededError(admission.scope);
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
    this.#setAllocationStartMeta(updated.id, {
      generation,
      mode: "cold_start",
      startedAtMs: now.getTime(),
    });
    this.#emitLifecycleLog("sandbox.lifecycle.provision", {
      sandboxId: updated.id,
      sessionId: updated.sessionId,
      accountId,
      environmentGeneration: generation,
      resourceName,
      startupMode: "cold_start",
    });
    return { action: "allocate", row: updated };
  }

  /** preparing/ready: retry only after a definitive failure; otherwise reconcile with GET. */
  #reserveExistingAllocation(row: typeof sandboxes.$inferSelect): {
    action: "reclaiming" | "retry" | "reconcile" | "report";
    row: typeof sandboxes.$inferSelect;
  } {
    // An automatic idle claim owns the environment (seal/borrow in flight): a start must never
    // race it, and ingress stays pending until the claim resolves to a transfer or a fresh
    // allocation. Retrying is always safe because the claim is durable.
    if (row.idleReclaimAt !== null) return { action: "reclaiming", row };
    if (row.currentResourceName !== null && row.currentResourceUid !== null) return { action: "report", row };
    if (isDefinitiveNoResourceMarker(row.lastErrorCode)) return { action: "retry", row };
    return { action: "reconcile", row };
  }

  async statusForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "read" });
    if (!owned) throw sandboxNotFound();
    return this.#toStatus(owned.sandbox);
  }

  /**
   * Normal-ingress allocation (IM delivery worker). Without workspace persistence this never
   * creates a replacement generation for previously used storage: a released generation > 0
   * whose workspace would be blank (`restore_required`) is reported instead of allocating. With
   * persistence configured, the replacement Runner restores the sealed archive from the stable
   * storage URI, so replacement is permitted; a Runner that cannot restore never reports
   * `workspaceRestored`, so the allocation stays `preparing` and no blank environment is ever
   * dispatched. The first generation and an in-flight reservation converge through the existing
   * idempotent start/reconcile logic, so repeated claim attempts are safe.
   */
  async ensureIngressAllocation(accountId: string, sandboxId: string): Promise<IngressAllocationOutcome> {
    const ensure = () => this.#ensureIngressAllocation(accountId, sandboxId);
    return this.#perfLogger
      ? this.#perfLogger.traceAsync(
          { module: "sandboxes", category: "service", operation: "sandbox.allocation.ensure", sandboxId },
          ensure,
          { resultAttributes: (allocationOutcome) => ({ allocationOutcome }) },
        )
      : ensure();
  }

  async #ensureIngressAllocation(accountId: string, sandboxId: string): Promise<IngressAllocationOutcome> {
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "manage" });
    if (!owned) throw sandboxNotFound();
    const row = owned.sandbox;
    updateCurrentPerformanceContext({ sessionId: row.sessionId, environmentGeneration: row.environmentGeneration });
    // An automatic idle claim blocks execution but never terminates the input: the Session either
    // gets the physical Instance back through a fresh allocation later or a sibling was borrowed,
    // so ingress keeps retrying instead of rejecting the message as a stopped environment.
    if (row.idleReclaimAt !== null) return "pending";
    if (row.lifecycle === "ready" && (!this.#workspace || this.#hub.describe(sandboxId).connected)) return "ready";
    if (row.lifecycle === "releasing") return "stopped";
    if (row.lifecycle === "unallocated" && row.environmentGeneration > 0 && !this.#workspace) return "restore_required";
    try {
      const status = await this.startForAccount(accountId, sandboxId);
      updateCurrentPerformanceContext({ environmentGeneration: status.environmentGeneration });
      return status.lifecycle === "ready" ? "ready" : "pending";
    } catch (error) {
      if (error instanceof WorkspaceRestoreRequiredError) return "restore_required";
      throw error;
    }
  }

  /**
   * Read-only allocation status reconciliation through the injected Cloud API. Never creates,
   * deletes, tracks, or mutates anything: it answers whether the persisted allocation identity is
   * still physically present, definitively absent, or unverified.
   */
  async reconcileAllocation(sandboxId: string): Promise<SandboxAllocationReconciliation | undefined> {
    const row = await loadSandboxRecordById(this.#database, sandboxId);
    if (!row) return undefined;
    const scope: RunnerScope | null =
      row.currentResourceName === null
        ? null
        : {
            sandboxId: row.id,
            sessionId: row.sessionId,
            environmentGeneration: row.environmentGeneration,
            resourceName: row.currentResourceName,
          };
    const base = {
      scope,
      lifecycle: row.lifecycle,
      resourceUid: row.currentResourceUid,
    } as const;
    if (scope === null || row.lifecycle === "unallocated" || row.lifecycle === "releasing") {
      return { ...base, physical: "untracked" };
    }
    if (row.currentResourceUid === null) return { ...base, physical: "untracked" };
    let view: Awaited<ReturnType<CloudRunAdmin["getInstance"]>>;
    try {
      view = await this.#cloud.getInstance(scope.resourceName);
    } catch {
      // A failed read proves nothing; the caller must keep awaiting the Runner's replay.
      return { ...base, physical: "unknown" };
    }
    if (!view || view.uid !== row.currentResourceUid) return { ...base, physical: "absent" };
    return { ...base, physical: "present" };
  }

  async verifySavedForAccount(accountId: string, sandboxId: string, environmentGeneration: number): Promise<boolean> {
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "read" });
    if (!owned) throw sandboxNotFound();
    if (owned.sandbox.environmentGeneration !== environmentGeneration) return false;
    return this.#workspaceSealer.workspaceSealProven(
      { storageUri: owned.sandbox.storageUri, sandboxId, sessionId: owned.sessionId, environmentGeneration },
      environmentGeneration,
    );
  }

  async stopForAccount(
    accountId: string,
    sandboxId: string,
    input?: AccountSandboxRunnerStopRequest,
  ): Promise<AccountSandboxRunnerStatusResponse> {
    const transition = await this.#database.transaction(async (transaction) => {
      const owned = await loadOwnedSandbox(transaction, accountId, sandboxId, { lock: true, authority: "read" });
      if (!owned) throw sandboxNotFound();
      const row = owned.sandbox;
      const now = this.#now();
      const releaseMarker = stopReleaseMarker(row, input, this.#workspace !== undefined);
      if (row.lifecycle === "unallocated") return { action: "report" as const, row };
      if (
        row.lifecycle === "releasing" &&
        row.idleReclaimAt === null &&
        releaseMarker !== WORKSPACE_DISCARD_REQUESTED
      ) {
        return { action: "release" as const, row };
      }
      // Stamp save/discard intent with the phase transition. Pending-create markers remain
      // untouched: a never-ready allocation owes no workspace save, even on explicit discard.
      const [updated] = await transaction
        .update(sandboxes)
        .set({
          lifecycle: "releasing",
          // An explicit stop is the operator's decision and must win over a late borrow: clear the
          // automatic claim marker in the SAME transition that precedes cloud DELETE, so no
          // in-flight transfer can still revalidate and take the physical Instance.
          idleReclaimAt: null,
          ...(releaseMarker ? { lastErrorCode: releaseMarker, lastErrorAt: now } : {}),
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(sandboxes.id, row.id),
            eq(sandboxes.environmentGeneration, row.environmentGeneration),
            inArray(sandboxes.lifecycle, ["preparing", "ready", "releasing"]),
          ),
        )
        .returning();
      if (!updated) throw runnerConflict("The Sandbox environment changed concurrently");
      return { action: "release" as const, row: updated };
    });

    if (transition.action === "release") {
      await this.#releaseCurrentAllocation(transition.row);
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
    if (row.lifecycle !== "ready" || row.idleReclaimAt !== null) {
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
    // An acceptance run can hold the Sandbox for many minutes: count its start and end as
    // business activity so the single idle budget never fires mid-run.
    await this.noteActivity(sandboxId);
    try {
      const result = await this.#hub.runAcceptance(
        sandboxId,
        {
          mode: input.mode,
          deadlineAtMs,
          ...(input.piConfig ? { piConfig: input.piConfig } : {}),
        },
        {
          timeoutMs: this.#acceptanceTimeoutMs,
          socket,
          ...(options.signal ? { signal: options.signal } : {}),
          // Registration happens inside the hub BEFORE this hook; the hook takes the Sandbox row
          // lock and refuses when an idle claim already owns the row. The database transaction is
          // released before the run itself, so execution never holds a connection.
          authorize: () => this.#acceptanceStillOwned(sandboxId),
        },
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
    } finally {
      await this.noteActivity(sandboxId).catch(() => undefined);
    }
  }

  /**
   * Short row-lock validation for an acceptance that already registered in the hub. It runs after
   * registration and before any frame leaves the Server, so an idle claim (which checks the same
   * hub busy state under the same row lock) and an acceptance can never both win.
   */
  async #acceptanceStillOwned(sandboxId: string): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      const [row] = await transaction
        .select({ lifecycle: sandboxes.lifecycle, idleReclaimAt: sandboxes.idleReclaimAt })
        .from(sandboxes)
        .where(eq(sandboxes.id, sandboxId))
        .limit(1)
        .for("update");
      return row?.lifecycle === "ready" && row.idleReclaimAt === null;
    });
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
  validateRunnerScope(claims: RunnerBootstrapClaims): Promise<RunnerScope | undefined> {
    return this.#tokenAuthority.validateRunnerScope(claims);
  }

  /**
   * Report/query-capable channel scope: the exact persisted allocation identity without requiring
   * the active Agent/binding/Session/Account chain. An already accepted turn's final or
   * cancellation report must remain deliverable after an explicit Session end or Agent suspend;
   * starting NEW work still requires `validateRunnerScope` (manage). Ownership is unaffected:
   * the channel still has to have authenticated with a current bootstrap token, and every new
   * execution is fenced again by the credential scope resolver.
   */
  validateRunnerChannelScope(claims: RunnerBootstrapClaims): Promise<RunnerScope | undefined> {
    return this.#tokenAuthority.validateRunnerChannelScope(claims);
  }

  /** Expired tokens may renew only against the still-current, physically present allocation. */
  renewExpiredBootstrap(claims: RunnerBootstrapClaims): Promise<string | undefined> {
    return this.#tokenAuthority.renewExpiredBootstrap(claims);
  }

  /**
   * E7 physical binding for one immutable birth identity: the unique row that currently holds
   * `claims.resourceName` is the only valid owner. No account or Session token can steer this;
   * the caller must already have verified the signed control credential.
   */
  resolveRunnerControlHolder(claims: RunnerBootstrapClaims): Promise<RunnerBootstrapClaims | undefined> {
    return this.#tokenAuthority.resolveRunnerControlHolder(claims);
  }

  /**
   * Renewal-only physical evidence for an expired control credential: the signature must name the
   * same birth identity, and the provider must still show the tracked binding. The returned
   * credential keeps the original birth claims; the fresh ordinary handshake resolves the current
   * holder again.
   */
  renewExpiredControl(claims: RunnerBootstrapClaims): Promise<string | undefined> {
    return this.#tokenAuthority.renewExpiredControl(claims);
  }

  /**
   * E4: authority facts for an already-validated Runner scope — the owning Cloud Computer, its
   * current installation, and the tracked resource UID. Re-validates the exact allocation, so a
   * superseded generation never yields authority facts. Used by the control channel to fence the
   * per-attach connection and to echo the UID inside the welcome frame.
   */ async describeScopeAuthority(
    scope: RunnerScope,
  ): Promise<{ computerId: string; installationId: string; resourceUid: string | null } | undefined> {
    // Allocation facts only: an already authenticated E4 channel may reconnect after the active
    // chain ended and still needs the exact Computer/installation/UID for report-only delivery.
    // New work is fenced separately by the manage authority chain.
    const owned = await loadSandboxOwnerById(this.#database, scope.sandboxId);
    if (
      !owned ||
      owned.sandbox.sessionId !== scope.sessionId ||
      owned.sandbox.environmentGeneration !== scope.environmentGeneration ||
      owned.sandbox.currentResourceName !== scope.resourceName
    ) {
      return undefined;
    }
    const [computer] = await this.#database
      .select({ id: computers.id, currentInstallationId: computers.currentInstallationId })
      .from(computers)
      .where(eq(computers.id, owned.computerId))
      .limit(1);
    if (!computer) return undefined;
    return {
      computerId: computer.id,
      installationId: computer.currentInstallationId,
      resourceUid: owned.sandbox.currentResourceUid,
    };
  }

  /**
   * Initial admission uses database CAS/promotion only; an early report stays deferred until
   * create has verified and tracked the UID. Never reconcile/create/release resources in the
   * serial frame chain. A previously READY allocation reporting a different version gets one
   * short provider read to prove its unchanged original image (see `#markOriginalImageReady`).
   */
  async markRunnerReady(
    scope: RunnerScope,
    readiness: RunnerReadiness,
    options: { workspaceRestored?: boolean } = {},
  ): Promise<RunnerReadyOutcome> {
    if (readiness.runnerVersion !== this.#expectedRunnerVersion) {
      // A target upgrade/rollback does not invalidate an Instance this Server already verified:
      // only the exact tracked READY allocation may reconnect on its unchanged original image.
      return this.#markOriginalImageReady(scope, options);
    }
    // E5: with persistence configured, an execution-capable Runner proves it restored the claimed
    // workspace archive before anything may become ready; an old Runner without the capability
    // fails closed here and can never promote the environment.
    if (this.#workspace && options.workspaceRestored !== true) return "workspace_not_restored";
    const current = await this.#currentScopeRow(scope);
    if (!current) return "stale";
    // A claimed environment is quiescing for a transfer or deletion: its Runner must never
    // re-publish readiness. Return `deferred` (not `stale`) so an authenticated connection that
    // is needed for the E5 seal stays attached instead of being closed by the readiness path.
    if (current.idleReclaimAt !== null) return "deferred";
    if (current.lifecycle === "ready") {
      this.#emitLifecycleLog("sandbox.lifecycle.ready", {
        sandboxId: current.id,
        sessionId: current.sessionId,
        environmentGeneration: current.environmentGeneration,
        resourceName: current.currentResourceName,
        resourceUid: current.currentResourceUid,
        runnerVersion: readiness.runnerVersion,
        startupMode: "reconnect",
      });
      return "ready";
    }
    if (current.lifecycle !== "preparing") return "stale";
    const existingStartMeta = this.#allocationStartMeta.get(current.id);
    if (!existingStartMeta || existingStartMeta.generation !== current.environmentGeneration) {
      this.#setAllocationStartMeta(current.id, {
        generation: current.environmentGeneration,
        mode: "cold_start",
        startedAtMs: current.lastActivityAt.getTime(),
      });
    }
    // No verified UID is tracked yet: stay deferred. Allocation I/O belongs to start/stop only.
    if (current.currentResourceUid === null) return "deferred";
    return (await this.#promoteReadyIfReported(scope.sandboxId)) ? "ready" : "deferred";
  }

  /** A deferred readiness report may be promoted once the verified UID is tracked. */
  async promoteDeferredReadiness(sandboxId: string): Promise<boolean> {
    const promoted = await this.#promoteReadyIfReported(sandboxId);
    // Already-ready reconnects can retain their verified original image after a target change.
    // They need notification after Hub acceptance even when no preparing row was promoted.
    this.#publishReadiness(sandboxId);
    return promoted;
  }

  /** Read-only authority for readiness consumers; no provider I/O or allocation effects. */
  async readyAllocation(sandboxId: string): Promise<ReadyRunnerAllocation | undefined> {
    const socket = this.#hub.currentSocket(sandboxId);
    const connection = this.#hub.currentConnectionIdentity(sandboxId);
    const snapshot = this.#hub.describe(sandboxId);
    if (!socket || !snapshot.ready || !snapshot.scope) return undefined;
    const row = await this.#currentScopeRow(snapshot.scope);
    if (
      row?.lifecycle !== "ready" ||
      row.idleReclaimAt !== null ||
      !row.currentResourceUid ||
      this.#hub.currentConnectionIdentity(sandboxId) !== connection ||
      !this.#hub.isCurrent(sandboxId, socket)
    )
      return undefined;
    return { ...snapshot.scope, resourceUid: row.currentResourceUid };
  }

  #publishReadiness(sandboxId: string): void {
    const observer = this.#readinessNotifications;
    const socket = this.#hub.currentSocket(sandboxId);
    const connection = this.#hub.currentConnectionIdentity(sandboxId);
    if (!observer || !socket || !connection || this.#publishedReadiness.has(connection)) return;
    observer.supervisor.track(
      async () => {
        const allocation = await this.readyAllocation(sandboxId);
        if (
          !allocation ||
          !this.#hub.isCurrent(sandboxId, socket) ||
          this.#hub.currentConnectionIdentity(sandboxId) !== connection ||
          this.#publishedReadiness.has(connection)
        )
          return;
        this.#publishedReadiness.add(connection);
        await observer.onReady(allocation);
      },
      {
        code: "RUNNER_READY_NOTIFICATION_FAILED",
        category: "internal",
        retryability: "backoff",
        phase: "worker",
        operation: "sandbox-runner.readiness-notification",
      },
    );
  }

  /**
   * Target upgrade/rollback reconnect: a readiness report naming a different Runner version is
   * acceptable only from the exact tracked READY allocation whose physical Instance already
   * passed strict initial acceptance under its ORIGINAL pinned image (a tracked READY row is the
   * durable proof of that earlier verdict). The bounded provider read re-proves the tracked
   * name/UID, unchanged provider generation and ownership, the full non-image execution policy, and an
   * observed image that differs from the current target; a wrong-version report on the CURRENT
   * target image stays rejected. Preparing/untracked allocations are first admission and remain
   * fail-closed without any cloud I/O. The scope/UID is rechecked after the provider read, so a
   * released or replaced allocation gets the strict stale verdict and a new idle claim defers
   * (its seal still needs the channel).
   */
  async #markOriginalImageReady(
    scope: RunnerScope,
    options: { workspaceRestored?: boolean },
  ): Promise<RunnerReadyOutcome> {
    const current = await this.#currentScopeRow(scope);
    if (!current) return "stale";
    // A claimed environment is quiescing for a transfer or deletion: keep the seal-capable
    // channel attached without re-publishing readiness, exactly like the version-matched path.
    if (current.idleReclaimAt !== null) return "deferred";
    // First admission (preparing), an untracked create outcome and a releasing environment are
    // never a legacy reconnect: they keep the strict fail-closed verdict without cloud I/O.
    if (current.lifecycle !== "ready" || current.currentResourceUid === null) return "version_mismatch";
    const resourceUid = current.currentResourceUid;
    // Keep this read well below the heartbeat deadline, even if allocation API timeouts are
    // configured longer. Transport failures propagate to the existing socket close/backoff:
    // a version_mismatch frame alone would leave a healthy channel permanently unready.
    const view = await this.#cloud.getInstance(scope.resourceName, 10_000);
    if (!view) return "version_mismatch";
    try {
      this.#cloud.verifyTrackedOriginalImage(view, {
        resourceName: scope.resourceName,
        resourceUid,
        environment: this.#environment,
      });
    } catch {
      // A deterministic ownership/policy mismatch cannot prove the original image.
      return "version_mismatch";
    }
    // Recheck AFTER the bounded provider read: the exact tracked READY binding must still own
    // this scope. A released/replaced row is stale; a claim that landed meanwhile defers.
    const rechecked = await this.#currentScopeRow(scope);
    if (!rechecked) return "stale";
    if (rechecked.idleReclaimAt !== null) return "deferred";
    if (rechecked.lifecycle !== "ready" || rechecked.currentResourceUid !== resourceUid) return "stale";
    // E5 proof is version-independent: an execution-capable Runner still must have restored its
    // workspace before anything may report ready.
    if (this.#workspace && options.workspaceRestored !== true) return "workspace_not_restored";
    this.#emitLifecycleLog("sandbox.lifecycle.ready", {
      sandboxId: rechecked.id,
      sessionId: rechecked.sessionId,
      environmentGeneration: rechecked.environmentGeneration,
      resourceName: rechecked.currentResourceName,
      resourceUid: rechecked.currentResourceUid,
      startupMode: "reconnect",
    });
    return "ready";
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
    let controlToken: string;
    try {
      const claims = {
        sandboxId: row.id,
        sessionId: row.sessionId,
        environmentGeneration: row.environmentGeneration,
        resourceName,
      };
      bootstrapToken = await this.#tokens.issue(claims);
      // E7 physical control credential: the same immutable birth identity under a separate
      // audience. It lets a restarted Runner process find the CURRENT holder after a transfer;
      // the Session bearer above can never do that.
      controlToken = await this.#tokens.issueControl(claims);
    } catch (error) {
      // Local failure before any submission: retry is safe. Only the submission owner reaches
      // here (reservation winner, or the retry that just won the pending CAS).
      await this.#recordError(row, "cloud_create_failed", error);
      throw error;
    }
    const createStarted = performance.now();
    const allocation = {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName,
    };
    let result: Awaited<ReturnType<CloudRunAdmin["createInstance"]>>;
    try {
      result = await this.#cloud.createInstance(
        {
          ...identity,
          environment: this.#environment,
          backendUrl: this.#backendUrl,
          bootstrapToken,
          controlToken,
          // E5: only a workspace-enabled allocation arms the Runner-side restore/save path.
          ...(this.#workspace ? { workspacePersistence: true } : {}),
        },
        {
          onAccepted: (apiVersion) =>
            this.#emitLifecycleLog("sandbox.lifecycle.create_accepted", {
              ...allocation,
              apiVersion,
              durationMs: performance.now() - createStarted,
            }),
          onOperation: (operationName) => this.#trackOperation(row, resourceName, operationName),
        },
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
    this.#emitLifecycleLog("sandbox.lifecycle.instance_verified", {
      ...allocation,
      resourceUid: result.instance.uid,
      createOutcome: result.outcome,
      durationMs: performance.now() - createStarted,
    });
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
    this.#emitLifecycleLog("sandbox.lifecycle.instance_verified", {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName,
      resourceUid: view.uid,
      createOutcome: "reconciled",
    });
    await this.#trackResource(row, resourceName, view.uid, row.currentOperationName);
    return view;
  }

  /** Promote, and if the row moved to releasing while reconciling, finish verified cleanup. */
  async #afterReconcile(sandboxId: string): Promise<void> {
    const [row] = await this.#rowById(sandboxId);
    if (!row) return;
    if (row.lifecycle === "releasing") {
      // Another request may have promoted and then stopped this allocation while create was
      // in flight. Always use the current durable release marker and the same seal-proof funnel.
      if (this.#workspace) {
        await this.#releaseCurrentAllocation(row);
        return;
      }
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
        lastErrorCode: sql`case when ${inArray(sandboxes.lastErrorCode, WORKSPACE_RELEASE_MARKER_LIST)} then ${sandboxes.lastErrorCode} else null end`,
        lastErrorAt: sql`case when ${inArray(sandboxes.lastErrorCode, WORKSPACE_RELEASE_MARKER_LIST)} then ${sandboxes.lastErrorAt} else null end`,
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
   * The single release funnel (account stop and the late-track reconcile both land here).
   * Legacy mode keeps the exact E3/E4 behavior: the Runner scope is invalidated immediately and
   * the existing verified cleanup runs. With workspace persistence the Runner channel stays alive
   * until the sealed archive is proven (or proven unnecessary), and every failure is recorded
   * without erasing create-phase or workspace-phase evidence.
   */
  async #releaseCurrentAllocation(row: typeof sandboxes.$inferSelect, automatic = false): Promise<boolean> {
    try {
      if (this.#workspace) {
        return await this.#releaseSavingWorkspace(row, automatic);
      } else {
        // Invalidate Runner execution immediately: a releasing environment must never accept or
        // resolve work while its Instance is being removed.
        this.#closeRunnerScope(row);
        return await this.#releaseAllocation(row, automatic);
      }
    } catch (error) {
      if (error instanceof WorkspaceSaveError) {
        // The sealed archive could not be proven: keep the physical resource binding and the
        // releasing lifecycle so a later stop retries. Never erased by delete-phase writes.
        await this.#recordError(row, WORKSPACE_SAVE_FAILED, error, {
          preserveCreateMarkers: true,
          automaticAttempt: automatic ? row : undefined,
        });
        throw new WorkspaceSaveFailedError(
          `Failed to release the Sandbox environment: the workspace could not be saved (${error.message})`,
        );
      }
      // A delete-phase failure must never erase create-phase evidence: `cloud_create_pending`
      // is the only proof a winner may still POST, `cloud_create_rejected` /
      // `cloud_create_failed` are the only definitive markers a later stop can release from,
      // and `cloud_instance_unverified` is a diagnostic that must survive. Without this, one
      // failed `getInstance` during stop strands the row in `releasing` forever: the next
      // stop reads 404, finds no definitive marker, and can never clear.
      await this.#recordError(row, "cloud_delete_incomplete", error, {
        preserveCreateMarkers: true,
        automaticAttempt: automatic ? row : undefined,
      });
      throw mapCloudError(error, "release the Sandbox environment");
    }
  }

  /**
   * E5 release path. A save is owed exactly when the durable marker says this environment was
   * previously ready (used). A PRESENT resource of the tracked UID is sealed first; a resource
   * proven absent or owned by a different UID has no local copy to save, so the last archived
   * object is retained and the existing safe release proceeds. Without a tracked UID the create
   * outcome is resolved by the existing bounded reconciliation (a generation whose UID was never
   * tracked was never ready, so it owes no save).
   */
  async #releaseSavingWorkspace(row: typeof sandboxes.$inferSelect, automatic: boolean): Promise<boolean> {
    await this.#workspaceSealer.sealWorkspaceIfOwed(row);
    // Only now does the Runner channel close; the existing verified cloud cleanup follows.
    this.#closeRunnerScope(row);
    return this.#releaseAllocation(row, automatic);
  }

  /**
   * Stop's release half. A resource with a tracked UID is
   * deleted and verified by read-back. Without a UID the create outcome is awaited for a bounded
   * window: a visible Instance is verified/tracked and then deleted, a completed operation with
   * an error proves nothing was allocated, and anything still unknown keeps `releasing` plus the
   * full reference and reports incomplete — the reference is never erased on uncertainty.
   */
  async #releaseAllocation(row: typeof sandboxes.$inferSelect, automatic = false): Promise<boolean> {
    const resourceName = row.currentResourceName;
    if (resourceName === null) {
      return this.#clearReleased(row, null, null);
    }
    if (row.currentResourceUid === null) {
      return this.#awaitUnknownAllocation(row, resourceName, automatic);
    }
    if (automatic && !(await this.#deleteAutomatic(row, resourceName, row.currentResourceUid))) return false;
    if (!automatic) await this.#deleteVerified(resourceName, row.currentResourceUid);
    return this.#clearReleased(row, resourceName, row.currentResourceUid);
  }

  /**
   * The create result was never observed. A visible Instance is ownership-verified, tracked and
   * deleted; a completed operation proves the outcome; anything still unknown keeps `releasing`
   * plus the full reference and reports incomplete after the bounded window.
   */
  async #awaitUnknownAllocation(
    row: typeof sandboxes.$inferSelect,
    resourceName: string,
    automatic: boolean,
  ): Promise<boolean> {
    const deadline = this.#now().getTime() + this.#deleteVerifyTimeoutMs;
    for (;;) {
      const view = await this.#cloud.getInstance(resourceName);
      if (view) {
        // Deletion requires OWNERSHIP only: the deterministic name plus the allocation labels
        // here, and the UID + etag inside the conditional delete itself. A policy failure must
        // never protect our own resource from cleanup — full policy verification stays
        // mandatory on the adopt/ready path, never on the delete path.
        this.#cloud.verifyOwnership(view, this.#identityFor(row, row.environmentGeneration));
        await this.#trackResource(row, resourceName, view.uid, row.currentOperationName);
        return this.#releaseObservedAllocation(row, resourceName, view.uid, automatic);
      }
      if (await this.#releaseFromDefinitiveEvidence(row, resourceName)) return true;
      if (automatic || this.#now().getTime() >= deadline) {
        await this.#marker(row, "cloud_create_uncertain");
        throw new CloudRunAdminError(
          "unavailable",
          `Allocation cleanup for ${resourceName} is incomplete: the create outcome is still unknown; the resource reference is preserved`,
        );
      }
      await this.#sleep(Math.min(2_000, Math.max(50, deadline - this.#now().getTime())));
    }
  }

  async #releaseObservedAllocation(
    row: typeof sandboxes.$inferSelect,
    resourceName: string,
    resourceUid: string,
    automatic: boolean,
  ): Promise<boolean> {
    if (!automatic) {
      await this.#deleteVerified(resourceName, resourceUid);
      return this.#clearReleased(row, resourceName, resourceUid);
    }
    const [tracked] = await this.#rowById(row.id);
    if (
      tracked?.lifecycle !== "releasing" ||
      tracked.idleReclaimAt === null ||
      tracked.environmentGeneration !== row.environmentGeneration ||
      tracked.currentResourceName !== resourceName ||
      tracked.currentResourceUid !== resourceUid
    )
      return false;
    return this.#releaseAllocation(tracked, true);
  }

  async #deleteAutomatic(
    row: typeof sandboxes.$inferSelect,
    resourceName: string,
    resourceUid: string,
  ): Promise<boolean> {
    if (row.lastErrorCode === CLOUD_DELETE_PENDING) {
      if (await this.#deletionConfirmed(resourceName, resourceUid)) return true;
      if (
        row.lastErrorAt === null ||
        this.#now().getTime() - row.lastErrorAt.getTime() >= this.#deleteVerifyTimeoutMs
      ) {
        throw new CloudRunAdminError(
          "unavailable",
          `Cloud Run Instance ${resourceName} removal was not verified in time`,
        );
      }
      return false;
    }
    const deleted = await this.#cloud.deleteInstance(resourceName, resourceUid);
    const confirmationStartedAt = this.#now();
    if (deleted.alreadyGone || (await this.#deletionConfirmed(resourceName, resourceUid))) return true;
    if (this.#now().getTime() - confirmationStartedAt.getTime() >= this.#deleteVerifyTimeoutMs) {
      throw new CloudRunAdminError(
        "unavailable",
        `Cloud Run Instance ${resourceName} removal was not verified in time`,
      );
    }
    // Sealing succeeded before DELETE. Persist only for this exact automatic attempt; a lost
    // acknowledgement is reconciled by the next UID/etag-fenced delete after the retry cooldown.
    const now = this.#now();
    await this.#database
      .update(sandboxes)
      .set({ lastErrorCode: CLOUD_DELETE_PENDING, lastErrorAt: confirmationStartedAt, updatedAt: now })
      .where(automaticAttemptMatches(row));
    return false;
  }

  async #deletionConfirmed(resourceName: string, resourceUid: string): Promise<boolean> {
    const view = await this.#cloud.getInstance(resourceName);
    if (!view) return true;
    if (view.uid !== resourceUid) {
      throw new CloudRunAdminError(
        "ownership_mismatch",
        `Cloud Run Instance ${resourceName} is now owned by a different UID than the tracked allocation`,
      );
    }
    return false;
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
      if (await this.#deletionConfirmed(resourceName, resourceUid)) return;
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
    expectedLifecycle: "preparing" | "releasing" | "ready" = "releasing",
  ): Promise<boolean> {
    const now = this.#now();
    const [cleared] = await this.#database
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
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          eq(sandboxes.lifecycle, expectedLifecycle),
          resourceName === null
            ? isNull(sandboxes.currentResourceName)
            : eq(sandboxes.currentResourceName, resourceName),
          resourceUid === null ? isNull(sandboxes.currentResourceUid) : eq(sandboxes.currentResourceUid, resourceUid),
        ),
      )
      .returning({ id: sandboxes.id });
    if (!cleared) return false;
    this.#allocationStartMeta.delete(row.id);
    this.#emitLifecycleLog("sandbox.lifecycle.release", {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName,
      resourceUid,
      previousLifecycle: expectedLifecycle,
    });
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
   * E7 idle reclamation and same-account physical reuse
   * ---------------------------------------------------------------------------------------- */

  /**
   * Business activity on a ready environment. Heartbeats never call this: the single idle budget
   * is measured from real work boundaries only, and the `idle_reclaim_at is null` guard means a
   * late activity write can never un-claim a row.
   */
  async noteActivity(sandboxId: string): Promise<void> {
    const now = this.#now();
    await this.#database
      .update(sandboxes)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.lifecycle, "ready"), isNull(sandboxes.idleReclaimAt)));
  }

  reclaimIdleSandboxes(
    signal?: AbortSignal,
  ): Promise<{ claimed: number; released: number; recovered: number; failed: number }> {
    return this.#idleReclaim.reclaimIdleSandboxes(signal);
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
          isNull(sandboxes.idleReclaimAt),
          isNotNull(sandboxes.currentResourceUid),
        ),
      )
      .returning({
        id: sandboxes.id,
        sessionId: sandboxes.sessionId,
        environmentGeneration: sandboxes.environmentGeneration,
        currentResourceName: sandboxes.currentResourceName,
        currentResourceUid: sandboxes.currentResourceUid,
      });
    if (promoted) {
      const startMeta = this.#allocationStartMeta.get(sandboxId);
      this.#allocationStartMeta.delete(sandboxId);
      const startupMode =
        startMeta && startMeta.generation === promoted.environmentGeneration ? startMeta.mode : "cold_start";
      const startupDurationMs =
        startMeta && startMeta.generation === promoted.environmentGeneration
          ? Math.max(0, now.getTime() - startMeta.startedAtMs)
          : undefined;
      this.#emitLifecycleLog("sandbox.lifecycle.ready", {
        sandboxId: promoted.id,
        sessionId: promoted.sessionId,
        environmentGeneration: promoted.environmentGeneration,
        resourceName: promoted.currentResourceName,
        resourceUid: promoted.currentResourceUid,
        runnerVersion: snapshot.readiness.runnerVersion,
        startupMode,
        ...(startupDurationMs !== undefined ? { startupDurationMs } : {}),
      });
      this.#publishReadiness(sandboxId);
      return true;
    }
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

  async #marker(row: { id: string; environmentGeneration: number }, code: Marker): Promise<void> {
    const now = this.#now();
    // `cloud_create_uncertain` is the weakest evidence: it must never erase any create-phase
    // marker (`cloud_create_pending` is the only proof a winner may still POST; the definitive
    // markers are the only release/retry evidence; `cloud_instance_unverified` is a diagnostic
    // that must survive stop errors). Stronger evidence (explicit rejection, an unverified
    // visible resource) may still replace them.
    const preserveCreateMarkers = code === "cloud_create_uncertain";
    await this.#database
      .update(sandboxes)
      .set({ lastErrorCode: code, lastErrorAt: now, updatedAt: now })
      .where(
        and(
          eq(sandboxes.id, row.id),
          eq(sandboxes.environmentGeneration, row.environmentGeneration),
          inArray(sandboxes.lifecycle, ["preparing", "releasing"]),
          ...(preserveCreateMarkers
            ? [or(isNull(sandboxes.lastErrorCode), notInArray(sandboxes.lastErrorCode, preservedMarkersFor(code)))]
            : [
                or(isNull(sandboxes.lastErrorCode), notInArray(sandboxes.lastErrorCode, WORKSPACE_RELEASE_MARKER_LIST)),
              ]),
        ),
      );
  }

  /**
   * Persist the failure state. Guarded on the generation AND an active lifecycle so a late
   * failure from an in-flight operation can never stamp a stale error onto an `unallocated`
   * (or superseded) row. A failed write is itself surfaced, never swallowed.
   */
  async #recordError(
    row: { id: string; environmentGeneration: number },
    code: string,
    original: unknown,
    options: { preserveCreateMarkers?: boolean; automaticAttempt?: typeof sandboxes.$inferSelect } = {},
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
            ...(options.automaticAttempt ? [automaticAttemptMatches(options.automaticAttempt)] : []),
            or(
              inArray(sandboxes.lifecycle, ["preparing", "releasing"]),
              // E7: a ready row claimed for idle reclamation still owns its physical binding and
              // must be able to record a seal/delete failure until the claim resolves.
              and(eq(sandboxes.lifecycle, "ready"), isNotNull(sandboxes.idleReclaimAt)),
            ),
            ...(options.preserveCreateMarkers
              ? [or(isNull(sandboxes.lastErrorCode), notInArray(sandboxes.lastErrorCode, preservedMarkersFor(code)))]
              : WORKSPACE_RELEASE_MARKER_LIST.includes(code)
                ? []
                : [
                    or(
                      isNull(sandboxes.lastErrorCode),
                      notInArray(sandboxes.lastErrorCode, WORKSPACE_RELEASE_MARKER_LIST),
                    ),
                  ]),
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

  #setAllocationStartMeta(
    sandboxId: string,
    meta: { generation: number; mode: "cold_start" | "warm_reuse"; startedAtMs: number },
  ): void {
    this.#allocationStartMeta.delete(sandboxId);
    if (this.#allocationStartMeta.size >= 1_024) {
      const oldestKey = this.#allocationStartMeta.keys().next().value;
      if (oldestKey !== undefined) this.#allocationStartMeta.delete(oldestKey);
    }
    this.#allocationStartMeta.set(sandboxId, meta);
  }

  #emitLifecycleLog(operation: string, fields: Record<string, unknown>, level: "info" | "warn" = "info"): void {
    try {
      this.#logger?.[level](
        {
          operation,
          outcome: level === "warn" ? "error" : "success",
          ...fields,
        },
        `Sandbox lifecycle event: ${operation}`,
      );
    } catch {
      // Observability logging must never affect sandbox lifecycle state transitions.
    }
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
      runnerReady: row.lifecycle === "ready" && row.idleReclaimAt === null && snapshot.ready && currentScope,
      runnerReadiness: currentScope ? snapshot.readiness : null,
      lastErrorCode: row.lastErrorCode,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
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
