import { createHash, createHmac, randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionReconcileRequest } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  sandboxes,
  sessionCliProofs,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { cloudInstanceIdFor } from "../sandboxes/cloud-runtime-fence.js";

export interface SessionCliSourceContext {
  agentId: string;
  computerId: string;
  connectionInstanceId: string;
  creatorSessionId?: string;
  installationId: string;
  placementGeneration: number;
  sessionId: string;
  sessionKind: "channel" | "thread" | "internal";
}

/**
 * The runtime credential execution facts the Cloud proof authority needs, structurally satisfied
 * by the existing `RuntimeExecutionRegistry`. Proofs never own execution lifetime: they only ask
 * this registry whether the correlated execution is still open on the same connection, and drop
 * their correlation when the registry reports the execution closed.
 */
export interface RuntimeExecutionRegistryPort {
  get(executionId: string):
    | {
        computerId: string;
        connectionId: string;
        instanceId: string;
        placementGeneration: number;
        sessionId: string;
      }
    | undefined;
  onClose(listener: (event: { executionId: string }) => void): () => void;
}

/**
 * The Cloud slice of Session-CLI proof authority. A Cloud Computer is a logical identity that is
 * always "online", so it can never prove actual execution capacity; the only honest Cloud binding
 * is the exact active Sandbox allocation, its exact current execution-eligible Runner connection,
 * and the actual credential execution opened by the managed worker. Proof liveness is therefore
 * derived from the existing Runtime execution registry, never from a timer: a proof dies when its
 * execution closes, is swept, or its connection is lost.
 */
export interface SessionCliCloudProofConnection {
  readonly computerId: string;
  readonly connectionId: string;
  /** Deterministic per-allocation identity (`cloudInstanceIdFor`) of the connection's scope. */
  readonly instanceId: string;
  readonly sandboxId: string;
  readonly sessionId: string;
  readonly executionEligible: boolean;
  readonly sessionCollaborationEligible: boolean;
}

export interface SessionCliCloudProofAuthority {
  /** The exact current attach record for one connection id, or undefined once detached. */
  connection(connectionId: string): SessionCliCloudProofConnection | undefined;
  /**
   * True only while at least one actual credential execution correlated with this exact proof is
   * still open on this connection. Execution close/sweep/connection loss and a Server restart all
   * answer false, so a Cloud proof fails closed outside its own running work.
   */
  isProofLive(input: { sessionId: string; connectionId: string; proofId: string }): boolean;
  /**
   * Correlate one proof with the actual credential execution that opened it. Several concurrently
   * open executions of one Session may share a proof (a queued Turn never rotates an active
   * Turn's proof); a superseding proof replaces only the previous proof's correlation.
   */
  registerExecution(input: { connectionId: string; executionId: string; proofId: string; sessionId: string }): void;
  /** Drop a Session's proof correlation (explicit revocation); live executions keep running. */
  dropExecution(input: { sessionId: string; proofId?: string }): void;
}

export class SessionCliProofError extends Error {
  constructor(
    readonly code: "invalid_proof" | "runtime_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "SessionCliProofError";
  }
}

export class SessionCliProofService {
  readonly #database: DatabaseClient;
  readonly #registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability">;
  readonly #cloud: SessionCliCloudProofAuthority | undefined;
  readonly #tokenKey: Buffer;
  readonly #now: () => Date;

  constructor(
    database: DatabaseClient,
    registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability">,
    tokenKey: Uint8Array,
    options: { now?: () => Date; cloud?: SessionCliCloudProofAuthority } = {},
  ) {
    if (tokenKey.byteLength !== 32) throw new Error("The Session CLI proof key must contain exactly 32 bytes");
    this.#database = database;
    this.#registry = registry;
    this.#cloud = options.cloud;
    this.#tokenKey = createHmac("sha256", tokenKey).update("opentag/session-cli-proof/v1", "utf8").digest();
    this.#now = options.now ?? (() => new Date());
  }

  async mint(input: {
    sessionId: string;
    computerId: string;
    placementGeneration: number;
    connectionInstanceId: string;
  }): Promise<{ proofId: string; token: string }> {
    this.#assertRuntimeBinding(input);
    return this.#database.transaction(async (transaction) => {
      await this.#lockCurrentPlacement(transaction, input);
      this.#assertRuntimeBinding(input);
      return this.#upsertProof(transaction, input);
    });
  }

  /**
   * Cloud variant: the proof binds to the exact active Sandbox allocation AND the exact attach
   * connection id, and is correlated with the actual credential execution that just opened. A
   * mint reuses the live proof while any earlier execution on the same binding is still open, so a
   * queued Turn can never invalidate the active Turn's proof; once every correlated execution has
   * ended, the next mint rotates the proof so the old token can never revive.
   */
  async mintCloud(input: {
    sessionId: string;
    computerId: string;
    placementGeneration: number;
    connectionId: string;
    sandboxId: string;
    /** The actual Runtime credential execution id the proof is being minted for. */
    executionId: string;
  }): Promise<{ proofId: string; token: string }> {
    this.#assertCloudBinding(input);
    return this.#database.transaction(async (transaction) => {
      await this.#lockCurrentPlacement(transaction, input);
      const [sandbox] = await transaction
        .select({
          id: sandboxes.id,
          lifecycle: sandboxes.lifecycle,
          idleReclaimAt: sandboxes.idleReclaimAt,
          environmentGeneration: sandboxes.environmentGeneration,
          currentResourceName: sandboxes.currentResourceName,
        })
        .from(sandboxes)
        .where(eq(sandboxes.sessionId, input.sessionId))
        .limit(1);
      if (
        !sandbox ||
        sandbox.id !== input.sandboxId ||
        sandbox.lifecycle !== "ready" ||
        sandbox.idleReclaimAt !== null ||
        sandbox.currentResourceName === null
      ) {
        throw new SessionCliProofError("runtime_unavailable", "The Session Sandbox allocation is unavailable");
      }
      const connection = this.#assertCloudBinding(input);
      if (
        connection.instanceId !==
        cloudInstanceIdFor({
          sandboxId: sandbox.id,
          sessionId: input.sessionId,
          environmentGeneration: sandbox.environmentGeneration,
          resourceName: sandbox.currentResourceName,
        })
      ) {
        throw new SessionCliProofError("runtime_unavailable", "The Session Sandbox allocation is unavailable");
      }
      this.#assertCloudBinding(input);
      const proof = await this.#upsertProof(
        transaction,
        { ...input, connectionInstanceId: input.connectionId },
        (existing) =>
          this.#cloud?.isProofLive({
            connectionId: existing.connectionInstanceId,
            proofId: existing.proofId,
            sessionId: input.sessionId,
          }) === true,
      );
      this.#cloud?.registerExecution({
        connectionId: input.connectionId,
        executionId: input.executionId,
        proofId: proof.proofId,
        sessionId: input.sessionId,
      });
      return proof;
    });
  }

  async #lockCurrentPlacement(
    transaction: DatabaseTransaction,
    input: { sessionId: string; computerId: string; placementGeneration: number },
  ): Promise<void> {
    const [placement] = await transaction
      .select({
        generation: sessionPlacements.generation,
        computerId: sessionPlacements.computerId,
      })
      .from(sessionPlacements)
      .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
      .where(and(eq(sessionPlacements.sessionId, input.sessionId), isNull(sessions.endedAt)))
      .limit(1)
      .for("update", { of: sessionPlacements });
    if (placement?.computerId !== input.computerId || placement.generation !== input.placementGeneration) {
      throw new SessionCliProofError("runtime_unavailable", "The Session placement is unavailable");
    }
  }

  async #upsertProof(
    transaction: DatabaseTransaction,
    input: {
      sessionId: string;
      computerId: string;
      placementGeneration: number;
      connectionInstanceId: string;
    },
    reuseWhen: (existing: { computerId: string; connectionInstanceId: string; proofId: string }) => boolean = () =>
      true,
  ): Promise<{ proofId: string; token: string }> {
    const [existing] = await transaction
      .select({
        computerId: sessionCliProofs.computerId,
        connectionInstanceId: sessionCliProofs.connectionInstanceId,
        placementGeneration: sessionCliProofs.placementGeneration,
        proofId: sessionCliProofs.proofId,
        sessionId: sessionCliProofs.sessionId,
      })
      .from(sessionCliProofs)
      .where(eq(sessionCliProofs.sessionId, input.sessionId))
      .limit(1)
      .for("update");
    if (
      existing?.computerId === input.computerId &&
      existing.placementGeneration === input.placementGeneration &&
      existing.connectionInstanceId === input.connectionInstanceId &&
      reuseWhen(existing)
    ) {
      return {
        proofId: existing.proofId,
        token: this.#deriveToken(existing),
      };
    }

    const proofId = randomUUID();
    const token = this.#deriveToken({ ...input, proofId });
    const now = this.#now();
    await transaction
      .insert(sessionCliProofs)
      .values({
        sessionId: input.sessionId,
        proofId,
        tokenHash: hashToken(token),
        computerId: input.computerId,
        placementGeneration: input.placementGeneration,
        connectionInstanceId: input.connectionInstanceId,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sessionCliProofs.sessionId,
        set: {
          proofId,
          tokenHash: hashToken(token),
          computerId: input.computerId,
          placementGeneration: input.placementGeneration,
          connectionInstanceId: input.connectionInstanceId,
          updatedAt: now,
        },
      });
    return { proofId, token };
  }

  async prepareReconcile(
    computerId: string,
    connectionInstanceId: string,
    request: SessionReconcileRequest,
  ): Promise<SessionReconcileRequest> {
    if (request.desired === "stopped") {
      await this.revoke({
        sessionId: request.sessionId,
        computerId,
        placementGeneration: request.placementGeneration,
        connectionInstanceId,
      });
      return request;
    }
    if (!this.#registry.supportsCapability(computerId, connectionInstanceId, RUNTIME_CAPABILITY.sessionCollaboration)) {
      return request;
    }
    const sessionCliProof = await this.mint({
      sessionId: request.sessionId,
      computerId,
      placementGeneration: request.placementGeneration,
      connectionInstanceId,
    });
    return { ...request, sessionCliProof };
  }

  async revoke(input: {
    sessionId: string;
    computerId: string;
    placementGeneration: number;
    connectionInstanceId: string;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [placement] = await transaction
        .select({
          generation: sessionPlacements.generation,
          computerId: sessionPlacements.computerId,
        })
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, input.sessionId))
        .limit(1)
        .for("update");
      if (placement?.computerId !== input.computerId || placement.generation !== input.placementGeneration) {
        return;
      }
      await transaction
        .delete(sessionCliProofs)
        .where(
          and(
            eq(sessionCliProofs.sessionId, input.sessionId),
            eq(sessionCliProofs.computerId, input.computerId),
            eq(sessionCliProofs.placementGeneration, input.placementGeneration),
            eq(sessionCliProofs.connectionInstanceId, input.connectionInstanceId),
          ),
        );
    });
  }

  /**
   * Session-scoped revocation for the Cloud stop path: a proof row is single per Session and a
   * fresh one can only be minted against a live allocation, so deleting by Session is exact. The
   * in-memory execution correlation is dropped synchronously; live credential executions keep
   * running but can no longer authenticate the revoked token.
   */
  async revokeForSession(sessionId: string): Promise<void> {
    await this.#database.delete(sessionCliProofs).where(eq(sessionCliProofs.sessionId, sessionId));
    this.#cloud?.dropExecution({ sessionId });
  }

  /**
   * Exact-connection revocation for the disconnect path: only rows bound to this attach are
   * deleted, so a replacement connection's fresh proof is never collateral damage.
   */
  async revokeForConnection(connectionId: string): Promise<void> {
    await this.#database.delete(sessionCliProofs).where(eq(sessionCliProofs.connectionInstanceId, connectionId));
  }

  async authenticate(token: string): Promise<SessionCliSourceContext> {
    if (!token || token.length > 4096) throw invalidProof();
    const [row] = await this.#database
      .select({
        agentId: imBindings.agentId,
        agentStatus: agents.status,
        bindingStatus: imBindings.status,
        computerKind: computers.kind,
        installationId: computers.currentInstallationId,
        connectionInstanceId: sessionCliProofs.connectionInstanceId,
        creatorSessionId: sessions.createdBySessionId,
        currentInstanceId: computers.currentInstanceId,
        placementGeneration: sessionCliProofs.placementGeneration,
        placementGenerationCurrent: sessionPlacements.generation,
        proofComputerId: sessionCliProofs.computerId,
        proofId: sessionCliProofs.proofId,
        sessionId: sessions.id,
        sessionKind: sessions.kind,
        computerId: sessionPlacements.computerId,
      })
      .from(sessionCliProofs)
      .innerJoin(sessions, eq(sessions.id, sessionCliProofs.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(and(eq(sessionCliProofs.tokenHash, hashToken(token)), isNull(sessions.endedAt)))
      .limit(1);
    const sharedAuthorityInvalid =
      row?.agentStatus !== "active" ||
      row.bindingStatus !== "active" ||
      row.proofComputerId !== row.computerId ||
      row.placementGeneration !== row.placementGenerationCurrent;
    if (!row || sharedAuthorityInvalid) {
      throw invalidProof();
    }
    if (row.computerKind === "cloud") {
      await this.#authenticateCloudBinding(row);
    } else if (
      row.currentInstanceId !== row.connectionInstanceId ||
      this.#registry.currentInstanceId(row.computerId) !== row.connectionInstanceId ||
      !this.#registry.supportsCapability(
        row.computerId,
        row.connectionInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      throw invalidProof();
    }
    return {
      agentId: row.agentId,
      computerId: row.computerId,
      connectionInstanceId: row.connectionInstanceId,
      ...(row.creatorSessionId ? { creatorSessionId: row.creatorSessionId } : {}),
      installationId: row.installationId,
      placementGeneration: row.placementGeneration,
      sessionId: row.sessionId,
      sessionKind: row.sessionKind,
    };
  }

  /**
   * Cloud proof authentication: the proof's exact attach connection must still be the live
   * execution-eligible, collaboration-capable connection for the current allocation of exactly
   * this Session, and the live-execution index must still name this exact proof. The logical
   * Cloud Computer's own liveness columns are never consulted as execution evidence.
   */
  async #authenticateCloudBinding(row: {
    computerId: string;
    connectionInstanceId: string;
    proofId: string;
    sessionId: string;
  }): Promise<void> {
    const cloud = this.#cloud;
    if (!cloud) throw invalidProof();
    const [sandbox] = await this.#database
      .select({
        id: sandboxes.id,
        lifecycle: sandboxes.lifecycle,
        idleReclaimAt: sandboxes.idleReclaimAt,
        environmentGeneration: sandboxes.environmentGeneration,
        currentResourceName: sandboxes.currentResourceName,
      })
      .from(sandboxes)
      .where(eq(sandboxes.sessionId, row.sessionId))
      .limit(1);
    if (
      !sandbox ||
      sandbox.lifecycle !== "ready" ||
      sandbox.idleReclaimAt !== null ||
      sandbox.currentResourceName === null
    ) {
      throw invalidProof();
    }
    const connection = cloud.connection(row.connectionInstanceId);
    if (
      !connection ||
      !connection.executionEligible ||
      !connection.sessionCollaborationEligible ||
      connection.computerId !== row.computerId ||
      connection.sessionId !== row.sessionId ||
      connection.sandboxId !== sandbox.id ||
      connection.instanceId !==
        cloudInstanceIdFor({
          sandboxId: sandbox.id,
          sessionId: row.sessionId,
          environmentGeneration: sandbox.environmentGeneration,
          resourceName: sandbox.currentResourceName,
        })
    ) {
      throw invalidProof();
    }
    if (
      !cloud.isProofLive({ connectionId: row.connectionInstanceId, proofId: row.proofId, sessionId: row.sessionId })
    ) {
      throw invalidProof();
    }
  }

  #deriveToken(input: {
    proofId: string;
    sessionId: string;
    computerId: string;
    placementGeneration: number;
    connectionInstanceId: string;
  }): string {
    return createHmac("sha256", this.#tokenKey)
      .update(input.proofId, "utf8")
      .update("\0")
      .update(input.sessionId, "utf8")
      .update("\0")
      .update(input.computerId, "utf8")
      .update("\0")
      .update(String(input.placementGeneration), "utf8")
      .update("\0")
      .update(input.connectionInstanceId, "utf8")
      .digest("base64url");
  }

  #assertRuntimeBinding(input: { computerId: string; connectionInstanceId: string }): void {
    if (
      this.#registry.currentInstanceId(input.computerId) !== input.connectionInstanceId ||
      !this.#registry.supportsCapability(
        input.computerId,
        input.connectionInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      throw new SessionCliProofError("runtime_unavailable", "The Session runtime connection is unavailable");
    }
  }

  #assertCloudBinding(input: {
    computerId: string;
    connectionId: string;
    sessionId: string;
    sandboxId: string;
  }): SessionCliCloudProofConnection {
    const cloud = this.#cloud;
    const connection = cloud?.connection(input.connectionId);
    if (
      !connection ||
      !connection.executionEligible ||
      !connection.sessionCollaborationEligible ||
      connection.computerId !== input.computerId ||
      connection.sessionId !== input.sessionId ||
      connection.sandboxId !== input.sandboxId
    ) {
      throw new SessionCliProofError("runtime_unavailable", "The Session Cloud runtime connection is unavailable");
    }
    return connection;
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function invalidProof(): SessionCliProofError {
  return new SessionCliProofError("invalid_proof", "The Session CLI proof is invalid or stale");
}
