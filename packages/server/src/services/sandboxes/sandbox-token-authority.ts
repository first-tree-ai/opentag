import { and, eq, isNotNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { computers, sandboxes, sessionPlacements, sessions } from "../../db/schema/index.js";
import type { CloudRunAdmin } from "../cloud-run/index.js";
import { loadManagedSandboxById, loadSandboxOwnerById, loadSandboxRecordById } from "./owned-sandbox.js";
import type { RunnerBootstrapClaims, RunnerBootstrapTokenService } from "./runner-bootstrap-token.js";
import type { RunnerScope } from "./runner-hub.js";
import { isDefinitiveNoResourceMarker } from "./sandbox-runner-state.js";

interface SandboxTokenAuthorityOptions {
  database: DatabaseClient;
  cloud: CloudRunAdmin;
  tokens: RunnerBootstrapTokenService;
  environment: "dev" | "staging" | "prod";
  workspacePersistenceEnabled: boolean;
}

export class SandboxTokenAuthority {
  readonly #database: DatabaseClient;
  readonly #cloud: CloudRunAdmin;
  readonly #tokens: RunnerBootstrapTokenService;
  readonly #environment: "dev" | "staging" | "prod";
  readonly #workspacePersistenceEnabled: boolean;

  constructor(options: SandboxTokenAuthorityOptions) {
    this.#database = options.database;
    this.#cloud = options.cloud;
    this.#tokens = options.tokens;
    this.#environment = options.environment;
    this.#workspacePersistenceEnabled = options.workspacePersistenceEnabled;
  }

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

  async renewExpiredBootstrap(claims: RunnerBootstrapClaims): Promise<string | undefined> {
    if (!this.#workspacePersistenceEnabled || !(await this.validateRunnerChannelScope(claims))) return undefined;
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

  async #holderByResourceName(
    resourceName: string,
  ): Promise<{ sandbox: typeof sandboxes.$inferSelect; computerId: string } | undefined> {
    const [row] = await this.#database
      .select({ sandbox: sandboxes, computerId: computers.id })
      .from(sandboxes)
      .innerJoin(sessions, eq(sessions.id, sandboxes.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(and(eq(sandboxes.currentResourceName, resourceName), isNotNull(sandboxes.currentResourceUid)))
      .limit(1);
    return row;
  }
}
