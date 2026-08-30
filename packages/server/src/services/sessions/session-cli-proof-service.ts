import { createHash, createHmac, randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type SessionReconcileRequest } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  accountComputers,
  agents,
  imBindings,
  sessionCliProofs,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { schemaRequiredComputerProjection } from "../../db/schema-required-legacy.js";
import type { ConnectionRegistry } from "../../runtime/connection-registry.js";
import { projectedComputerId } from "../computers/ownership-projections.js";

export interface SessionCliSourceContext {
  agentId: string;
  computerId: string;
  connectionInstanceId: string;
  creatorSessionId?: string;
  placementGeneration: number;
  sessionId: string;
  sessionKind: "channel" | "thread" | "internal";
  workspaceComputerId: string;
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
  readonly #tokenKey: Buffer;
  readonly #now: () => Date;

  constructor(
    database: DatabaseClient,
    registry: Pick<ConnectionRegistry, "currentInstanceId" | "supportsCapability">,
    tokenKey: Uint8Array,
    options: { now?: () => Date } = {},
  ) {
    if (tokenKey.byteLength !== 32) throw new Error("The Session CLI proof key must contain exactly 32 bytes");
    this.#database = database;
    this.#registry = registry;
    this.#tokenKey = createHmac("sha256", tokenKey).update("opentag/session-cli-proof/v1", "utf8").digest();
    this.#now = options.now ?? (() => new Date());
  }

  async mint(input: {
    sessionId: string;
    workspaceComputerId: string;
    placementGeneration: number;
    connectionInstanceId: string;
  }): Promise<{ proofId: string; token: string }> {
    this.#assertRuntimeBinding(input);
    return this.#database.transaction(async (transaction) => {
      const [placement] = await transaction
        .select({
          generation: sessionPlacements.generation,
          workspaceComputerId: sessionPlacements.computerId,
        })
        .from(sessionPlacements)
        .innerJoin(sessions, eq(sessions.id, sessionPlacements.sessionId))
        .where(and(eq(sessionPlacements.sessionId, input.sessionId), isNull(sessions.endedAt)))
        .limit(1)
        .for("update", { of: sessionPlacements });
      if (
        placement?.workspaceComputerId !== input.workspaceComputerId ||
        placement.generation !== input.placementGeneration
      ) {
        throw new SessionCliProofError("runtime_unavailable", "The Session placement is unavailable");
      }
      this.#assertRuntimeBinding(input);
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
        existing?.computerId === input.workspaceComputerId &&
        existing.placementGeneration === input.placementGeneration &&
        existing.connectionInstanceId === input.connectionInstanceId
      ) {
        return {
          proofId: existing.proofId,
          token: this.#deriveToken({ ...existing, workspaceComputerId: existing.computerId }),
        };
      }

      const proofId = randomUUID();
      const token = this.#deriveToken({ ...input, proofId });
      const now = this.#now();
      const computerId = await projectedComputerId(transaction, input.workspaceComputerId);
      await transaction
        .insert(sessionCliProofs)
        .values({
          sessionId: input.sessionId,
          proofId,
          tokenHash: hashToken(token),
          ...schemaRequiredComputerProjection(input.workspaceComputerId),
          computerId,
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
            ...schemaRequiredComputerProjection(input.workspaceComputerId),
            computerId,
            placementGeneration: input.placementGeneration,
            connectionInstanceId: input.connectionInstanceId,
            updatedAt: now,
          },
        });
      return { proofId, token };
    });
  }

  async prepareReconcile(
    workspaceComputerId: string,
    connectionInstanceId: string,
    request: SessionReconcileRequest,
  ): Promise<SessionReconcileRequest> {
    if (request.desired === "stopped") {
      await this.revoke({
        sessionId: request.sessionId,
        workspaceComputerId,
        placementGeneration: request.placementGeneration,
        connectionInstanceId,
      });
      return request;
    }
    if (
      !this.#registry.supportsCapability(
        workspaceComputerId,
        connectionInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      return request;
    }
    const sessionCliProof = await this.mint({
      sessionId: request.sessionId,
      workspaceComputerId,
      placementGeneration: request.placementGeneration,
      connectionInstanceId,
    });
    return { ...request, sessionCliProof };
  }

  async revoke(input: {
    sessionId: string;
    workspaceComputerId: string;
    placementGeneration: number;
    connectionInstanceId: string;
  }): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const [placement] = await transaction
        .select({
          generation: sessionPlacements.generation,
          workspaceComputerId: sessionPlacements.computerId,
        })
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, input.sessionId))
        .limit(1)
        .for("update");
      if (
        placement?.workspaceComputerId !== input.workspaceComputerId ||
        placement.generation !== input.placementGeneration
      ) {
        return;
      }
      await transaction
        .delete(sessionCliProofs)
        .where(
          and(
            eq(sessionCliProofs.sessionId, input.sessionId),
            eq(sessionCliProofs.computerId, input.workspaceComputerId),
            eq(sessionCliProofs.placementGeneration, input.placementGeneration),
            eq(sessionCliProofs.connectionInstanceId, input.connectionInstanceId),
          ),
        );
    });
  }

  async authenticate(token: string): Promise<SessionCliSourceContext> {
    if (!token || token.length > 4096) throw invalidProof();
    const [row] = await this.#database
      .select({
        agentId: imBindings.agentId,
        agentStatus: agents.status,
        bindingStatus: imBindings.status,
        computerId: accountComputers.currentInstallationId,
        connectionInstanceId: sessionCliProofs.connectionInstanceId,
        creatorSessionId: sessions.createdBySessionId,
        currentInstanceId: accountComputers.currentInstanceId,
        placementGeneration: sessionCliProofs.placementGeneration,
        placementGenerationCurrent: sessionPlacements.generation,
        proofWorkspaceComputerId: sessionCliProofs.computerId,
        sessionId: sessions.id,
        sessionKind: sessions.kind,
        workspaceComputerId: sessionPlacements.computerId,
      })
      .from(sessionCliProofs)
      .innerJoin(sessions, eq(sessions.id, sessionCliProofs.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(accountComputers, eq(accountComputers.id, sessionPlacements.computerId))
      .where(and(eq(sessionCliProofs.tokenHash, hashToken(token)), isNull(sessions.endedAt)))
      .limit(1);
    if (
      row?.agentStatus !== "active" ||
      row.bindingStatus !== "active" ||
      row.proofWorkspaceComputerId !== row.workspaceComputerId ||
      row.placementGeneration !== row.placementGenerationCurrent ||
      row.currentInstanceId !== row.connectionInstanceId ||
      this.#registry.currentInstanceId(row.workspaceComputerId) !== row.connectionInstanceId ||
      !this.#registry.supportsCapability(
        row.workspaceComputerId,
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
      placementGeneration: row.placementGeneration,
      sessionId: row.sessionId,
      sessionKind: row.sessionKind,
      workspaceComputerId: row.workspaceComputerId,
    };
  }

  #deriveToken(input: {
    proofId: string;
    sessionId: string;
    workspaceComputerId: string;
    placementGeneration: number;
    connectionInstanceId: string;
  }): string {
    return createHmac("sha256", this.#tokenKey)
      .update(input.proofId, "utf8")
      .update("\0")
      .update(input.sessionId, "utf8")
      .update("\0")
      .update(input.workspaceComputerId, "utf8")
      .update("\0")
      .update(String(input.placementGeneration), "utf8")
      .update("\0")
      .update(input.connectionInstanceId, "utf8")
      .digest("base64url");
  }

  #assertRuntimeBinding(input: { workspaceComputerId: string; connectionInstanceId: string }): void {
    if (
      this.#registry.currentInstanceId(input.workspaceComputerId) !== input.connectionInstanceId ||
      !this.#registry.supportsCapability(
        input.workspaceComputerId,
        input.connectionInstanceId,
        RUNTIME_CAPABILITY.sessionCollaboration,
      )
    ) {
      throw new SessionCliProofError("runtime_unavailable", "The Session runtime connection is unavailable");
    }
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function invalidProof(): SessionCliProofError {
  return new SessionCliProofError("invalid_proof", "The Session CLI proof is invalid or stale");
}
