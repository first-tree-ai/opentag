import type {
  AccountSandboxRunnerAcceptanceRequest,
  AccountSandboxRunnerAcceptanceResponse,
  AccountSandboxRunnerStatusResponse,
  AccountSandboxRunnerStopRequest,
  RunnerReadiness,
} from "@opentag/shared";
import { RUNNER_WORKSPACE_TIMEOUT_MS } from "@opentag/shared";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, imBindings, imMessageDeliveries, sandboxes, sessions } from "../../db/schema/index.js";
import { type CloudRunAdmin, CloudRunAdminError, type RunnerInstanceIdentityInput } from "../cloud-run/index.js";
import { SandboxServiceError, sandboxNotFound, WorkspaceRestoreRequiredError, WorkspaceSaveError } from "./errors.js";
import {
  loadManagedSandboxById,
  loadOwnedSandbox,
  loadSandboxOwnerById,
  loadSandboxRecordById,
} from "./owned-sandbox.js";
import type { RunnerBootstrapClaims, RunnerBootstrapTokenService } from "./runner-bootstrap-token.js";
import { RunnerAcceptanceUnavailableError, type RunnerHub, type RunnerScope } from "./runner-hub.js";
import type { WorkspaceObjectScope, WorkspaceObjectStore } from "./workspace-object-store.js";

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
  /**
   * E7 single idle budget: a ready environment with no business activity for this long is
   * reclaimed by the periodic sweep. A same-account borrow is on demand for any quiescent
   * candidate and is not gated on this budget. One clock (`lastActivityAt`), never heartbeat
   * activity.
   */
  idleTimeoutMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  deleteVerifyTimeoutMs?: number;
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
   * E8 Session collaboration liveness: accepted-unfinished Session-message work on this Sandbox.
   * Consulted next to `hub.isBusy` under the same Sandbox row lock, so an idle claim or a
   * sibling borrow can never interrupt a collaboration Turn the IM custody rows cannot see
   * (Session messages have no durable Turn columns by design).
   */
  sessionWorkBusy?: (sandboxId: string) => boolean;
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
/** Bounded batch of idle rows one sweep pass may consider. */
const IDLE_RECLAIM_BATCH = 25;
/** Durable create-phase markers recorded in `lastErrorCode`. */
const MARKER_RETRYABLE = ["cloud_create_rejected", "cloud_create_failed"] as const;
type Marker =
  | "cloud_create_pending"
  | "cloud_create_uncertain"
  | "cloud_instance_unverified"
  | (typeof MARKER_RETRYABLE)[number];
const RETRYABLE_MARKER_LIST: string[] = [...MARKER_RETRYABLE];
const RETRYABLE_MARKERS = new Set<string>(MARKER_RETRYABLE);
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
 * Neither may be erased by a weaker delete-phase or uncertain-phase write.
 */
const WORKSPACE_SAVE_REQUIRED = "workspace_save_required";
const WORKSPACE_SAVE_FAILED = "workspace_save_failed";
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

/** The discard opt-in is checked under the same row lock that records its allocation-bound intent. */
function stopReleaseMarker(
  row: Pick<typeof sandboxes.$inferSelect, "lifecycle" | "environmentGeneration" | "lastErrorCode">,
  input: AccountSandboxRunnerStopRequest,
  persistence: boolean,
): string | undefined {
  if ("discardUnsavedChanges" in input) {
    if (input.environmentGeneration !== row.environmentGeneration) {
      throw runnerConflict("The discard request refers to a different environment generation");
    }
    if (row.lifecycle === "ready" || WORKSPACE_RELEASE_MARKER_LIST.includes(row.lastErrorCode ?? "")) {
      return WORKSPACE_DISCARD_REQUESTED;
    }
  }
  return persistence && row.lifecycle === "ready" ? WORKSPACE_SAVE_REQUIRED : undefined;
}

/** Evidence that no create for this generation can still materialize. */
function isDefinitiveNoResourceMarker(marker: string | null): boolean {
  return marker !== null && RETRYABLE_MARKERS.has(marker);
}

export type RunnerReadyOutcome = "ready" | "deferred" | "stale" | "version_mismatch" | "workspace_not_restored";

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

/** One sealed same-account idle sibling prepared for an on-demand physical hand-off. */
interface IdleSiblingSnapshot {
  sandboxId: string;
  sessionId: string;
  environmentGeneration: number;
  resourceName: string;
  resourceUid: string;
}

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
  readonly #idleTimeoutMs: number;
  readonly #workspace: { store: WorkspaceObjectStore; sealTimeoutMs: number } | undefined;
  readonly #sessionWorkBusy: ((sandboxId: string) => boolean) | undefined;
  readonly #sessionWorkBarrier:
    | ((input: {
        allocation: { sandboxId: string; environmentGeneration: number; resourceName: string };
        sessionId: string;
        transaction: DatabaseTransaction;
      }) => Promise<boolean>)
    | undefined;
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
    this.#idleTimeoutMs = options.idleTimeoutMs ?? IDLE_RECLAIM_DEFAULT_MS;
    if (!Number.isSafeInteger(this.#idleTimeoutMs) || this.#idleTimeoutMs < 1) {
      throw new Error("SandboxRunnerService requires a positive idleTimeoutMs");
    }
    this.#workspace = options.workspace
      ? {
          store: options.workspace.store,
          sealTimeoutMs: options.workspace.sealTimeoutMs ?? 4 * RUNNER_WORKSPACE_TIMEOUT_MS,
        }
      : undefined;
    this.#sessionWorkBusy = options.sessionWorkBusy;
    this.#sessionWorkBarrier = options.sessionWorkBarrier;
    this.#now = options.now ?? (() => new Date());
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** True when this deployment persists workspaces; the Runner capability gates key off this. */
  get workspacePersistenceEnabled(): boolean {
    return this.#workspace !== undefined;
  }

  /* ------------------------------------------------------------------------------------------
   * Account-facing operations
   * ---------------------------------------------------------------------------------------- */

  async startForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxRunnerStatusResponse> {
    await this.#releaseMissingReadyAllocation(accountId, sandboxId);
    await this.#prepareWorkspaceAllocation(accountId, sandboxId);
    // E7 on-demand borrow: a fresh unallocated Session may take a same-account idle sibling's
    // physical Instance. The candidate is claimed (execution blocked) and sealed BEFORE the
    // reservation transaction, so no database transaction spans the E5 seal or a cloud read.
    const preflight = await loadOwnedSandbox(this.#database, accountId, sandboxId, { authority: "manage" });
    if (!preflight) throw sandboxNotFound();
    const borrowed =
      preflight.sandbox.lifecycle === "unallocated"
        ? await this.#prepareIdleSiblingForReuse(accountId, preflight.sandbox.id)
        : undefined;
    const reservation = await this.#database
      .transaction(async (transaction) => {
        // Start/execute requires the CURRENT authority chain: active Pi Agent, active binding,
        // un-ended Session, non-suspended Account, owned Cloud Computer.
        const owned = await loadOwnedSandbox(transaction, accountId, sandboxId, { lock: true, authority: "manage" });
        if (!owned) throw sandboxNotFound();
        const row = owned.sandbox;
        if (row.lifecycle === "releasing") {
          throw runnerConflict("The Sandbox environment is being released; retry after release completes");
        }
        if (row.lifecycle === "unallocated") {
          if (borrowed) {
            const adopted = await this.#transferClaimedAllocation(transaction, row, borrowed, accountId);
            if (adopted) return { action: "reuse" as const, row: adopted };
          }
          return this.#reserveNewGeneration(transaction, row);
        }
        return this.#reserveExistingAllocation(row);
      })
      .catch(async (error: unknown) => {
        if (borrowed) await this.#releaseUnusedBorrow(borrowed);
        throw error;
      });
    if (borrowed && reservation.action !== "reuse") await this.#releaseUnusedBorrow(borrowed);

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
    action: "reclaiming" | "retry" | "reconcile" | "report";
    row: typeof sandboxes.$inferSelect;
  } {
    // An automatic idle claim owns the environment (seal/borrow in flight): a start must never
    // race it, and ingress stays pending until the claim resolves to a transfer or a fresh
    // allocation. Retrying is always safe because the claim is durable.
    if (row.idleReclaimAt !== null) return { action: "reclaiming", row };
    if (row.currentResourceName !== null && row.currentResourceUid !== null) return { action: "report", row };
    if (RETRYABLE_MARKERS.has(row.lastErrorCode ?? "")) return { action: "retry", row };
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
    const owned = await loadOwnedSandbox(this.#database, accountId, sandboxId, { lock: true, authority: "manage" });
    if (!owned) throw sandboxNotFound();
    const row = owned.sandbox;
    // An automatic idle claim blocks execution but never terminates the input: the Session either
    // gets the physical Instance back through a fresh allocation later or a sibling was borrowed,
    // so ingress keeps retrying instead of rejecting the message as a stopped environment.
    if (row.idleReclaimAt !== null) return "pending";
    if (row.lifecycle === "ready" && (!this.#workspace || this.#hub.describe(sandboxId).connected)) return "ready";
    if (row.lifecycle === "releasing") return "stopped";
    if (row.lifecycle === "unallocated" && row.environmentGeneration > 0 && !this.#workspace) return "restore_required";
    try {
      const status = await this.startForAccount(accountId, sandboxId);
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

  async stopForAccount(
    accountId: string,
    sandboxId: string,
    input: AccountSandboxRunnerStopRequest = {},
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
  async validateRunnerScope(claims: RunnerBootstrapClaims): Promise<RunnerScope | undefined> {
    const owned = await loadManagedSandboxById(this.#database, claims.sandboxId);
    if (!owned) return undefined;
    const row = owned.sandbox;
    if (row.sessionId !== claims.sessionId) return undefined;
    if (row.lifecycle !== "preparing" && row.lifecycle !== "ready") return undefined;
    // E7: an automatic idle claim revokes execution authority immediately. The Runner may stay
    // attached in the report/seal-capable channel scope (validateRunnerChannelScope) but can
    // never publish new execution until a transfer/resume assigns it a live environment.
    if (row.idleReclaimAt !== null) return undefined;
    if (row.environmentGeneration !== claims.environmentGeneration) return undefined;
    if (row.currentResourceName === null || row.currentResourceName !== claims.resourceName) return undefined;
    // An early pending Runner may connect before the create caller tracks its UID, but a
    // definitive failed/policy-rejected allocation must not authenticate or renew credentials.
    if (row.lastErrorCode === "cloud_instance_unverified" || isDefinitiveNoResourceMarker(row.lastErrorCode)) {
      return undefined;
    }
    return {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName,
    };
  }

  /**
   * Report/query-capable channel scope: the exact persisted allocation identity without requiring
   * the active Agent/binding/Session/Account chain. An already accepted turn's final or
   * cancellation report must remain deliverable after an explicit Session end or Agent suspend;
   * starting NEW work still requires `validateRunnerScope` (manage). Ownership is unaffected:
   * the channel still has to have authenticated with a current bootstrap token, and every new
   * execution is fenced again by the credential scope resolver.
   */
  async validateRunnerChannelScope(claims: RunnerBootstrapClaims): Promise<RunnerScope | undefined> {
    const row = await loadSandboxRecordById(this.#database, claims.sandboxId);
    if (!row) return undefined;
    if (row.sessionId !== claims.sessionId) return undefined;
    if (row.lifecycle === "unallocated") return undefined;
    if (row.environmentGeneration !== claims.environmentGeneration) return undefined;
    if (row.currentResourceName === null || row.currentResourceName !== claims.resourceName) return undefined;
    if (row.lastErrorCode === "cloud_instance_unverified" || isDefinitiveNoResourceMarker(row.lastErrorCode)) {
      return undefined;
    }
    return {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName,
    };
  }

  /** Expired tokens may renew only against the still-current, physically present allocation. */
  async renewExpiredBootstrap(claims: RunnerBootstrapClaims): Promise<string | undefined> {
    if (!this.#workspace || !(await this.validateRunnerChannelScope(claims))) return undefined;
    const row = await loadSandboxRecordById(this.#database, claims.sandboxId);
    if (!row?.currentResourceUid || row.currentResourceName !== claims.resourceName) return undefined;
    const view = await this.#cloud.getInstance(claims.resourceName);
    if (!view || view.uid !== row.currentResourceUid) return undefined;
    // Ownership only: the birth labels may belong to a previous Session after an ownership
    // transfer, and a deployment image/config change must not block renewal of an owned legacy
    // Instance.
    try {
      this.#cloud.verifyTrackedOwnership(view, {
        resourceName: claims.resourceName,
        resourceUid: row.currentResourceUid,
        environment: this.#environment,
      });
    } catch {
      return undefined;
    }
    const token = await this.#tokens.issue(claims);
    // Recheck after provider/signing awaits. A concurrent release/replacement revokes renewal.
    const current = await loadSandboxRecordById(this.#database, claims.sandboxId);
    if (!current || current.currentResourceUid !== row.currentResourceUid) return undefined;
    return (await this.validateRunnerChannelScope(claims)) ? token : undefined;
  }

  /**
   * E7 physical binding for one immutable birth identity: the unique row that currently holds
   * `claims.resourceName` is the only valid owner. No account or Session token can steer this;
   * the caller must already have verified the signed control credential.
   */
  async resolveRunnerControlHolder(claims: RunnerBootstrapClaims): Promise<RunnerBootstrapClaims | undefined> {
    const holder = await this.#holderByResourceName(claims.resourceName);
    if (!holder || holder.sandbox.lifecycle === "unallocated") return undefined;
    // The birth row still owns the account the physical Instance belongs to; a cross-account
    // binding can never validate even if a name collision were somehow materialized.
    const birth = await loadSandboxOwnerById(this.#database, claims.sandboxId);
    if (!birth) return undefined;
    const [birthComputer] = await this.#database
      .select({ ownerAccountId: computers.ownerAccountId })
      .from(computers)
      .where(eq(computers.id, birth.computerId))
      .limit(1);
    const [holderComputer] = await this.#database
      .select({ ownerAccountId: computers.ownerAccountId })
      .from(computers)
      .where(eq(computers.id, holder.computerId))
      .limit(1);
    if (!birthComputer || !holderComputer || birthComputer.ownerAccountId !== holderComputer.ownerAccountId) {
      return undefined;
    }
    // Signed birth identity + physical presence: the control token carries the immutable birth
    // claims, so the original ownership labels remain the strongest proof for the whole life of
    // the Instance, including after transfers. The provider read is bounded by the admin client's
    // request deadline; an unreadable provider proves nothing and keeps the runner retrying.
    const resourceName = holder.sandbox.currentResourceName;
    const resourceUid = holder.sandbox.currentResourceUid;
    if (resourceName === null || resourceUid === null) return undefined;
    let view: Awaited<ReturnType<CloudRunAdmin["getInstance"]>>;
    try {
      view = await this.#cloud.getInstance(resourceName);
    } catch {
      return undefined;
    }
    if (!view || view.uid !== resourceUid) return undefined;
    try {
      this.#cloud.verifyOwnership(view, {
        environment: this.#environment,
        sandboxId: claims.sandboxId,
        sessionId: claims.sessionId,
        environmentGeneration: claims.environmentGeneration,
      });
    } catch {
      return undefined;
    }
    // DB recheck after the provider I/O: the unique holder must still be the same row and UID.
    const current = await this.#holderByResourceName(resourceName);
    if (
      !current ||
      current.sandbox.id !== holder.sandbox.id ||
      current.sandbox.currentResourceUid !== resourceUid ||
      current.sandbox.lifecycle === "unallocated"
    ) {
      return undefined;
    }
    return {
      sandboxId: current.sandbox.id,
      sessionId: current.sandbox.sessionId,
      environmentGeneration: current.sandbox.environmentGeneration,
      resourceName: resourceName,
    };
  }

  /**
   * Renewal-only physical evidence for an expired control credential: the signature must name the
   * same birth identity, and the provider must still show the tracked binding. The returned
   * credential keeps the original birth claims; the fresh ordinary handshake resolves the current
   * holder again.
   */
  async renewExpiredControl(claims: RunnerBootstrapClaims): Promise<string | undefined> {
    const holder = await this.#holderByResourceName(claims.resourceName);
    if (!holder || holder.sandbox.lifecycle === "unallocated" || holder.sandbox.currentResourceUid === null)
      return undefined;
    let view: Awaited<ReturnType<CloudRunAdmin["getInstance"]>>;
    try {
      view = await this.#cloud.getInstance(claims.resourceName);
    } catch {
      return undefined;
    }
    if (!view || view.uid !== holder.sandbox.currentResourceUid) return undefined;
    try {
      // Birth-label ownership only: the token names the immutable physical origin, and cleanup or
      // renewal must survive a deployment image/config change.
      this.#cloud.verifyOwnership(view, {
        environment: this.#environment,
        sandboxId: claims.sandboxId,
        sessionId: claims.sessionId,
        environmentGeneration: claims.environmentGeneration,
      });
    } catch {
      return undefined;
    }
    // DB recheck after the provider read before signing a fresh control credential.
    const current = await this.#holderByResourceName(claims.resourceName);
    if (
      !current ||
      current.sandbox.id !== holder.sandbox.id ||
      current.sandbox.currentResourceUid !== holder.sandbox.currentResourceUid ||
      current.sandbox.lifecycle === "unallocated"
    ) {
      return undefined;
    }
    return this.#tokens.issueControl(claims);
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
   * An authenticated Runner reported native sandbox/tool readiness. Readiness handling is
   * database CAS/promotion ONLY, driven by the validated persisted scope and the native
   * readiness report: a Runner-originated frame must never drive cloud reconcile/create/release
   * inline in the per-connection frame chain (heartbeats queue behind it and a healthy Runner
   * could be swept mid-reconcile). Readiness is accepted only for the current allocation AND
   * the exact configured Runner version, and only once the Cloud resource for this generation
   * has been policy-verified and its UID tracked. An early Runner report is DEFERRED, not
   * rejected: the connection stays authenticated, the create caller promotes the deferred
   * report when tracking completes, and a later start reconciles the deterministic name.
   */
  async markRunnerReady(
    scope: RunnerScope,
    readiness: RunnerReadiness,
    options: { workspaceRestored?: boolean } = {},
  ): Promise<RunnerReadyOutcome> {
    if (readiness.runnerVersion !== this.#expectedRunnerVersion) return "version_mismatch";
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
    if (current.lifecycle === "ready") return "ready";
    if (current.lifecycle !== "preparing") return "stale";
    // No verified UID is tracked yet: stay deferred. Cloud I/O belongs to start/stop only.
    if (current.currentResourceUid === null) return "deferred";
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
  async #releaseCurrentAllocation(row: typeof sandboxes.$inferSelect): Promise<void> {
    try {
      if (this.#workspace) {
        await this.#releaseSavingWorkspace(row);
      } else {
        // Invalidate Runner execution immediately: a releasing environment must never accept or
        // resolve work while its Instance is being removed.
        this.#closeRunnerScope(row);
        await this.#releaseAllocation(row);
      }
    } catch (error) {
      if (error instanceof WorkspaceSaveError) {
        // The sealed archive could not be proven: keep the physical resource binding and the
        // releasing lifecycle so a later stop retries. Never erased by delete-phase writes.
        await this.#recordError(row, WORKSPACE_SAVE_FAILED, error, { preserveCreateMarkers: true });
        throw new SandboxServiceError(
          "SERVICE_UNAVAILABLE",
          "transient",
          `Failed to release the Sandbox environment: the workspace could not be saved (${error.message})`,
          503,
        );
      }
      // A delete-phase failure must never erase create-phase evidence: `cloud_create_pending`
      // is the only proof a winner may still POST, `cloud_create_rejected` /
      // `cloud_create_failed` are the only definitive markers a later stop can release from,
      // and `cloud_instance_unverified` is a diagnostic that must survive. Without this, one
      // failed `getInstance` during stop strands the row in `releasing` forever: the next
      // stop reads 404, finds no definitive marker, and can never clear.
      await this.#recordError(row, "cloud_delete_incomplete", error, { preserveCreateMarkers: true });
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
  async #releaseSavingWorkspace(row: typeof sandboxes.$inferSelect): Promise<void> {
    await this.#sealWorkspaceIfOwed(row);
    // Only now does the Runner channel close; the existing verified cloud cleanup follows.
    this.#closeRunnerScope(row);
    await this.#releaseAllocation(row);
  }

  /**
   * The seal half of E5 release, shared by explicit stop and automatic idle reclamation: a save
   * is owed exactly when the durable marker says so, and the proven archive short-circuits the
   * Runner round-trip so a crash/retry never re-extracts or re-seals. A provider-absent or
   * different-UID resource has no local copy to protect and is skipped; the caller still decides
   * whether physical cleanup is complete.
   */
  async #sealWorkspaceIfOwed(row: typeof sandboxes.$inferSelect): Promise<void> {
    if (!this.#workspace) return;
    const resourceName = row.currentResourceName;
    const resourceUid = row.currentResourceUid;
    const saveOwed = row.lastErrorCode === WORKSPACE_SAVE_REQUIRED || row.lastErrorCode === WORKSPACE_SAVE_FAILED;
    if (resourceName === null || resourceUid === null || !saveOwed) return;
    const view = await this.#cloud.getInstance(resourceName);
    if (view?.uid === resourceUid && view.workspacePersistence === false && row.idleReclaimAt !== null) {
      // An older Instance may contain the only local copy even after Server persistence is
      // enabled. Automatic cleanup cannot inherit explicit stop's legacy discard behavior.
      throw new WorkspaceSaveError("the existing Instance cannot persist its workspace automatically");
    }
    if (view !== undefined && view.uid === resourceUid && view.workspacePersistence !== false) {
      await this.#sealWorkspaceForRelease(row);
    }
  }

  /**
   * Prove the sealed archive for the exact current environment before deletion. The Runner's
   * ack alone is never proof: the object metadata read-back must show a saved, sealed archive
   * owned by this exact environment generation. A stored proof short-circuits the Runner
   * round-trip, so a retry after a dropped ack or a Server crash needs no live Runner.
   */
  async #sealWorkspaceForRelease(row: typeof sandboxes.$inferSelect): Promise<void> {
    const workspace = this.#workspace;
    if (!workspace) return;
    const scope: WorkspaceObjectScope = {
      storageUri: row.storageUri,
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
    };
    if (await this.#workspaceSealProven(scope, row.environmentGeneration)) return;
    const socket = this.#hub.currentSocket(row.id);
    const snapshot = this.#hub.describe(row.id);
    if (
      !socket ||
      !snapshot.connected ||
      snapshot.scope === null ||
      snapshot.scope.sessionId !== row.sessionId ||
      snapshot.scope.environmentGeneration !== row.environmentGeneration ||
      snapshot.scope.resourceName !== row.currentResourceName
    ) {
      throw new WorkspaceSaveError("no live Runner holds the current allocation");
    }
    let result: Awaited<ReturnType<RunnerHub["requestWorkspaceSeal"]>>;
    try {
      result = await this.#hub.requestWorkspaceSeal(row.id, { timeoutMs: workspace.sealTimeoutMs, socket });
    } catch (error) {
      throw new WorkspaceSaveError(
        error instanceof Error ? error.message : "the workspace seal could not be requested",
      );
    }
    if (!result.ok) {
      throw new WorkspaceSaveError(
        `the Runner reported a failed workspace save (${result.code ?? "workspace_save_failed"})`,
      );
    }
    if (!(await this.#workspaceSealProven(scope, row.environmentGeneration))) {
      throw new WorkspaceSaveError("the saved workspace archive could not be verified");
    }
  }

  /** The only proof bar: saved + sealed + exact current owner generation, from a fresh read. */
  async #workspaceSealProven(scope: WorkspaceObjectScope, ownerGeneration: number): Promise<boolean> {
    const workspace = this.#workspace;
    if (!workspace) return false;
    let head: Awaited<ReturnType<WorkspaceObjectStore["head"]>>;
    try {
      head = await workspace.store.head(scope);
    } catch {
      // A store read failure is not proof of anything; the caller keeps the allocation and retries.
      return false;
    }
    return (
      head !== undefined && head.saved === true && head.sealed === true && head.ownerGeneration === ownerGeneration
    );
  }

  /**
   * Stop's release half. A resource with a tracked UID is
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
   * The create result was never observed. A visible Instance is ownership-verified, tracked and
   * deleted; a completed operation proves the outcome; anything still unknown keeps `releasing`
   * plus the full reference and reports incomplete after the bounded window.
   */
  async #awaitUnknownAllocation(row: typeof sandboxes.$inferSelect, resourceName: string): Promise<void> {
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

  /**
   * One bounded automatic idle sweep, safe under restarts and concurrent Server processes:
   * - a ready environment idle past the single budget is claimed (execution authority blocked),
   *   sealed through E5, then transitioned to releasing for verified deletion;
   * - a row already claimed by an abandoned borrow is retried once its own `last_activity_at`
   *   budget has passed; the claim timestamp is ownership/intent evidence, never a second clock;
   * - an automatic row already in `releasing` resumes from the durable marker without another
   *   budget, and a provider-confirmed absent binding is cleared without a delete call;
   * - unknown reads and fail-create phases never clear a reference.
   * No transaction is held across cloud or storage I/O.
   */
  async reclaimIdleSandboxes(): Promise<{ claimed: number; released: number; recovered: number; failed: number }> {
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

    // 1) Ready rows past the single idle budget. The budget clock is ALWAYS `lastActivityAt`:
    //    `idleReclaimAt` only records who owns the reclamation intent, so an abandoned claim is
    //    retried on the next pass after the row's original budget, never after a fresh window.
    for (const candidate of await this.#idleReadyCandidates(idleCutoff)) {
      const outcome = await this.#reclaimIdleCandidate(candidate.id);
      if (outcome.claimed) claimed += 1;
      if (outcome.released) released += 1;
      if (outcome.failed) failed += 1;
    }

    // 2) Automatic rows already in `releasing`: a failed or interrupted delete resumes from the
    //    durable marker without waiting out another budget, because the budget was already spent
    //    before the transition. Explicit stop rows carry no marker and stay outside the sweep.
    for (const candidate of await this.#automaticReleasingCandidates()) {
      const [row] = await this.#rowById(candidate.id);
      if (!row || row.idleReclaimAt === null) continue;
      try {
        await this.#releaseCurrentAllocation(row);
        released += 1;
      } catch {
        // The release funnel already recorded the durable failure state for the next sweep.
        failed += 1;
      }
    }

    const recovered = await this.#recoverStalePreparingAllocations(startupCutoff);
    return { claimed, released, recovered: recovered.recovered, failed: failed + recovered.failed };
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
      .where(and(eq(sandboxes.lifecycle, "releasing"), isNotNull(sandboxes.idleReclaimAt)))
      .orderBy(asc(sandboxes.updatedAt), asc(sandboxes.id))
      .limit(IDLE_RECLAIM_BATCH);
  }

  /**
   * E7 stale-adoption recovery, bounded by create convergence plus workspace startup time (not
   * the idle budget). A `preparing` row whose tracked Instance has not produced a READY Runner
   * within that deadline would otherwise strand the borrower and its pending inputs forever. A
   * connected-but-never-ready Runner is included: restore attempts that never complete are a
   * startup failure, not disposable idle work, and the borrower's own archive is never touched.
   */
  async #recoverStalePreparingAllocations(startupCutoff: Date): Promise<{ recovered: number; failed: number }> {
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
      // A ready connection is promoted by the normal readiness path, never recycled here.
      if (this.#hub.describe(candidate.id).ready) {
        await this.#promoteReadyIfReported(candidate.id).catch(() => undefined);
        continue;
      }
      try {
        await this.#releaseStalePreparing(candidate.id);
        recovered += 1;
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
  async #releaseStalePreparing(sandboxId: string): Promise<void> {
    const [row] = await this.#rowById(sandboxId);
    if (
      row?.lifecycle !== "preparing" ||
      row.currentResourceName === null ||
      row.currentResourceUid === null ||
      row.idleReclaimAt !== null
    ) {
      return;
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
      await this.#clearReleased(row, resourceName, resourceUid, "preparing");
      return;
    }
    // Ownership only: a deployment image/config change must never block cleanup of an owned
    // legacy Instance.
    this.#cloud.verifyTrackedOwnership(view, { resourceName, resourceUid, environment: this.#environment });
    // Recheck AFTER the provider I/O: a connection that became ready while we were reading must
    // be promoted, never recycled as a failed startup; a row that moved on is left alone.
    if (this.#hub.describe(sandboxId).ready) {
      await this.#promoteReadyIfReported(sandboxId);
      return;
    }
    const [current] = await this.#rowById(sandboxId);
    if (
      current?.lifecycle !== "preparing" ||
      current.idleReclaimAt !== null ||
      current.environmentGeneration !== row.environmentGeneration ||
      current.currentResourceName !== resourceName ||
      current.currentResourceUid !== resourceUid
    ) {
      return;
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
    if (!releasing) return;
    await this.#releaseCurrentAllocation(releasing);
  }

  /** One bounded candidate: claim, prove the save, then release. Failures stay durably recorded. */
  async #reclaimIdleCandidate(sandboxId: string): Promise<{ claimed: boolean; released: boolean; failed: boolean }> {
    // Rotate every attempted candidate, including an unsupported or busy Instance. This is
    // scheduling fairness only: eligibility continues to use lastActivityAt exclusively.
    await this.#database
      .update(sandboxes)
      .set({ updatedAt: this.#now() })
      .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.lifecycle, "ready")));
    let claimed = false;
    try {
      claimed = (await this.#claimIdle(sandboxId, { automatic: true })) !== undefined;
    } catch {
      // Provider failure before the claim must not block ingress or the remainder of this pass.
      return { claimed: false, released: false, failed: true };
    }
    // The busy decision is made by `#claimIdle` UNDER the Sandbox row lock; this re-read only
    // classifies the visible state for the sweep counters.
    if (!claimed && this.#hub.isBusy(sandboxId)) return { claimed: false, released: false, failed: true };
    const [row] = await this.#rowById(sandboxId);
    if (!row || row.idleReclaimAt === null) return { claimed, released: false, failed: false };
    try {
      // Seal BEFORE leaving `ready`: a failed save keeps the resource binding and the durable
      // claim so the next sweep retries; a proven archive short-circuits the Runner round-trip.
      await this.#sealWorkspaceIfOwed(row);
      const now = this.#now();
      const [releasing] = await this.#database
        .update(sandboxes)
        .set({ lifecycle: "releasing", updatedAt: now })
        .where(
          and(
            eq(sandboxes.id, row.id),
            eq(sandboxes.lifecycle, "ready"),
            eq(sandboxes.environmentGeneration, row.environmentGeneration),
            eq(sandboxes.currentResourceName, row.currentResourceName as string),
            eq(sandboxes.currentResourceUid, row.currentResourceUid as string),
            isNotNull(sandboxes.idleReclaimAt),
          ),
        )
        .returning();
      if (!releasing) return { claimed, released: false, failed: false }; // stop or borrow won
      await this.#releaseCurrentAllocation(releasing);
      return { claimed, released: true, failed: false };
    } catch (error) {
      if (error instanceof WorkspaceSaveError) {
        await this.#recordError(row, WORKSPACE_SAVE_FAILED, error, { preserveCreateMarkers: true }).catch(
          () => undefined,
        );
      } else if (!(error instanceof SandboxServiceError)) {
        await this.#recordError(row, "cloud_delete_incomplete", error, { preserveCreateMarkers: true }).catch(
          () => undefined,
        );
      }
      return { claimed, released: false, failed: true };
    }
  }

  /**
   * Atomic idle claim under the Sandbox row lock, shared by the automatic sweep and an on-demand
   * same-account borrow. The unsettled-delivery check runs AFTER the row lock, and dispatch
   * custody takes the same row lock, so an accepted/claimed dispatch and a claim can never both
   * commit. Any unsettled work (pending/claimed dispatch, accepted/unreported) refuses the claim.
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
    if (this.#sessionWorkBusy?.(allocation.sandboxId)) return true;
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
  async #prepareIdleSiblingForReuse(
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
    return (
      snapshot.connected &&
      snapshot.ready &&
      snapshot.reuseCapable &&
      snapshot.scope !== null &&
      snapshot.scope.environmentGeneration === candidate.environmentGeneration &&
      snapshot.scope.resourceName === candidate.currentResourceName &&
      !this.#hub.isBusy(candidate.id) &&
      this.#sessionWorkBusy?.(candidate.id) !== true
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
      await this.#sealWorkspaceIfOwed(claimed);
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
      if (!(await this.#workspaceSealProven(scope, claimed.environmentGeneration))) {
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
      await this.#releaseUnusedBorrow({
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
  async #releaseUnusedBorrow(candidate: IdleSiblingSnapshot): Promise<void> {
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
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, agents.computerId))
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
   * Single-winner ownership hand-off. The claimant row is already locked by the caller and the
   * candidate is locked second here. There is no lock cycle to order around: a candidate must be
   * `ready` with a tracked binding and a claimant must be `unallocated`, so the two roles are
   * disjoint and concurrent transfers touch disjoint candidate rows. The candidate is revalidated
   * against the exact claim (`idle_reclaim_at`, same account, generation, name, UID, no pending
   * marker), cleared first so the unique indexes never see two owners, and only then assigned to
   * the claimant with generation + 1. A lost race returns undefined and leaves the candidate
   * for the caller to release through the normal verified cleanup path.
   */
  async #transferClaimedAllocation(
    transaction: DatabaseTransaction,
    claimant: typeof sandboxes.$inferSelect,
    candidate: IdleSiblingSnapshot,
    accountId: string,
  ): Promise<typeof sandboxes.$inferSelect | undefined> {
    // Lock order: `startForAccount` already holds the claimant row lock (FOR UPDATE) before this
    // call, and the candidate is locked second here. The dependency is acyclic because a row can
    // only be a candidate while it is `ready` with a tracked binding and a claimant while it is
    // `unallocated`; those states are disjoint, so no transfer ever locks another transfer's
    // claimant, and concurrent transfers touch disjoint candidate rows.
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
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, agents.computerId))
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

  /**
   * The unique current holder of one physical resource name. `current_resource_name` is a
   * partial-unique index, so at most one row can answer; the physical UID must be tracked for the
   * binding to be transferable/attachable.
   */
  async #holderByResourceName(
    resourceName: string,
  ): Promise<{ sandbox: typeof sandboxes.$inferSelect; computerId: string } | undefined> {
    const [row] = await this.#database
      .select({ sandbox: sandboxes, computerId: computers.id })
      .from(sandboxes)
      .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, agents.computerId))
      .where(and(eq(sandboxes.currentResourceName, resourceName), isNotNull(sandboxes.currentResourceUid)))
      .limit(1);
    return row;
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
    options: { preserveCreateMarkers?: boolean } = {},
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
