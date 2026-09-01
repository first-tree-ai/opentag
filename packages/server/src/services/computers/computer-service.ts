import type { ComputerRegisterFrame, ListAccountComputersResponse, MeResponse } from "@opentag/shared";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  computerConnectCodes,
  computerCredentials,
  computers,
  imBindings,
  imMessageDeliveries,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { unresolvedSessionCustody } from "../sessions/session-custody.js";
import type { ComputerAuthContext } from "./machine-auth-service.js";
import { rejectUnsupportedClientVersion } from "./machine-auth-service.js";
import {
  type ProviderReadinessSource,
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "./provider-readiness.js";

export interface ActiveUserResolver {
  getActiveUserById(userId: string): Promise<MeResponse>;
}

export interface ComputerServiceOptions {
  now?: () => Date;
  onEnrollmentRemoved?: (computerId: string) => Promise<void>;
  presenceTimeoutMs?: number;
  providerReadiness?: ProviderReadinessSource;
}

export class ComputerService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #onEnrollmentRemoved?: (computerId: string) => Promise<void>;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;

  constructor(database: DatabaseClient, _auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#onEnrollmentRemoved = options.onEnrollmentRemoved;
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
  }

  async listAccountComputers(
    accountId: string,
    includeProviderReadiness = false,
  ): Promise<ListAccountComputersResponse> {
    const rows = await this.#database
      .select({ computer: computers, agentId: agents.id })
      .from(computers)
      .innerJoin(
        computerCredentials,
        and(eq(computerCredentials.computerId, computers.id), isNull(computerCredentials.revokedAt)),
      )
      .leftJoin(
        agents,
        and(eq(agents.computerId, computers.id), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")),
      )
      .where(eq(computers.ownerAccountId, accountId))
      .orderBy(asc(computers.displayName), asc(computers.id), asc(agents.id));
    const observedAt = this.#now();
    const cutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, ListAccountComputersResponse["computers"][number]>();
    for (const row of rows) {
      const existing = byId.get(row.computer.id);
      if (existing) {
        if (row.agentId) existing.agentIds.push(row.agentId);
        continue;
      }
      const connectionStatus =
        row.computer.currentInstanceId !== null && (row.computer.lastSeenAt?.getTime() ?? 0) >= cutoff
          ? "online"
          : "offline";
      byId.set(row.computer.id, {
        computerId: row.computer.id,
        displayName: row.computer.displayName,
        platform: row.computer.platform,
        connectionStatus,
        ...(includeProviderReadiness
          ? {
              providerReadiness: projectComputerProviderReadiness(
                row.computer.id,
                connectionStatus,
                observedAt,
                this.#providerReadiness,
              ),
              imCliReadiness: projectComputerImCliReadiness(
                row.computer.id,
                connectionStatus,
                observedAt,
                this.#providerReadiness,
              ),
            }
          : {}),
        connectedAt: row.computer.connectedAt?.toISOString() ?? null,
        lastSeenAt: row.computer.lastSeenAt?.toISOString() ?? null,
        observedAt: observedAt.toISOString(),
        createdAt: row.computer.createdAt.toISOString(),
        agentIds: row.agentId ? [row.agentId] : [],
      });
    }
    return { computers: [...byId.values()] };
  }

  /**
   * Removes an Account-owned Computer without erasing history that already refers to it. Active
   * credentials and pending repair codes are revoked, while Agents are unbound so every reader sees
   * that they need another Computer instead of retaining a dangling assignment. Removal waits until
   * active Sessions no longer hold unresolved delivery custody.
   *
   * Repeating an owned removal succeeds. Besides making DELETE idempotent, this lets a caller retry
   * if closing the live connection failed after the database transaction committed.
   */
  async removeFromAccount(accountId: string, computerId: string): Promise<void> {
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ id: computers.id })
        .from(computers)
        .where(and(eq(computers.id, computerId), eq(computers.ownerAccountId, accountId)))
        .limit(1);
      if (!candidate) throw computerNotFound();

      // Agent mutations lock Agent before Computer. Use the same order so an exact-target rebind
      // cannot form a cross-table deadlock with removal.
      await this.#lockBoundAgents(transaction, computerId);
      const [owned] = await transaction
        .select({ id: computers.id })
        .from(computers)
        .where(and(eq(computers.id, computerId), eq(computers.ownerAccountId, accountId)))
        .limit(1)
        .for("update");
      if (!owned) throw computerNotFound();
      // A rebind that committed before the Computer lock may have added another Agent after the
      // initial scan. Revalidate the complete locked set before checking custody or mutating state.
      const boundAgents = await this.#lockBoundAgents(transaction, computerId);
      await this.#assertRemovalSafe(transaction, boundAgents);

      await transaction
        .update(computerConnectCodes)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(
          and(
            eq(computerConnectCodes.issuedByAccountId, accountId),
            eq(computerConnectCodes.targetComputerId, computerId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
          ),
        );
      await transaction
        .update(computerCredentials)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(and(eq(computerCredentials.computerId, computerId), isNull(computerCredentials.revokedAt)));
      await transaction
        .update(agents)
        .set({ computerId: null, revision: sql`${agents.revision} + 1`, updatedAt: now })
        .where(and(eq(agents.computerId, computerId), ne(agents.status, "deleted")));
      await transaction
        .update(computers)
        .set({ currentInstanceId: null, connectedAt: null, updatedAt: now })
        .where(eq(computers.id, computerId));
    });
    await this.#onEnrollmentRemoved?.(computerId);
  }

  async #lockBoundAgents(transaction: DatabaseTransaction, computerId: string): Promise<{ id: string }[]> {
    return transaction
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.computerId, computerId), ne(agents.status, "deleted")))
      .orderBy(asc(agents.id))
      .for("update");
  }

  async #assertRemovalSafe(transaction: DatabaseTransaction, boundAgents: readonly { id: string }[]): Promise<void> {
    if (boundAgents.length === 0) return;

    const activeSessions = await transaction
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .where(
        and(
          inArray(
            imBindings.agentId,
            boundAgents.map(({ id }) => id),
          ),
          isNull(sessions.endedAt),
        ),
      )
      .orderBy(asc(sessions.id))
      .for("update", { of: sessionPlacements });
    if (activeSessions.length === 0) return;

    const [blocked] = await transaction
      .select({ id: imMessageDeliveries.id })
      .from(imMessageDeliveries)
      .where(
        and(
          inArray(
            imMessageDeliveries.sessionId,
            activeSessions.map(({ id }) => id),
          ),
          unresolvedSessionCustody(),
        ),
      )
      .limit(1);
    if (blocked) throw computerRemovalBlocked();
  }

  async register(context: ComputerAuthContext, frame: ComputerRegisterFrame): Promise<void> {
    rejectUnsupportedClientVersion(frame.clientVersion);
    if (frame.installationId !== context.installationId) {
      throw new AuthServiceError(
        "COMPUTER_IDENTITY_CONFLICT",
        "deterministic",
        "The Computer identity does not match the machine credential",
        409,
      );
    }
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const observation = {
        displayName: frame.displayName,
        platform: frame.platform,
        arch: frame.arch,
        clientVersion: frame.clientVersion,
        currentInstanceId: frame.instanceId,
        connectedAt: now,
        lastSeenAt: now,
        updatedAt: now,
      };
      const updated = await transaction
        .update(computers)
        .set(observation)
        .where(and(eq(computers.id, context.computerId), eq(computers.currentInstallationId, context.installationId)))
        .returning({ id: computers.id });
      if (updated.length !== 1) throw unavailableComputer();
    });
  }

  async heartbeat(context: ComputerAuthContext, instanceId: string): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const updated = await transaction
        .update(computers)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(
          and(
            eq(computers.id, context.computerId),
            eq(computers.currentInstallationId, context.installationId),
            eq(computers.currentInstanceId, instanceId),
          ),
        )
        .returning({ id: computers.id });
      return updated.length === 1;
    });
  }

  async assertActiveCredential(context: ComputerAuthContext): Promise<void> {
    await this.#database.transaction((transaction) => this.#lockActiveCredential(transaction, context));
  }

  async disconnect(computerId: string, instanceId: string): Promise<boolean> {
    const now = this.#now();
    const updated = await this.#database
      .update(computers)
      .set({
        currentInstanceId: null,
        connectedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(and(eq(computers.id, computerId), eq(computers.currentInstanceId, instanceId)))
      .returning({ id: computers.id });
    return updated.length === 1;
  }

  async #lockActiveCredential(transaction: DatabaseTransaction, context: ComputerAuthContext): Promise<void> {
    const [computer] = await transaction
      .select({ id: computers.id })
      .from(computers)
      .where(eq(computers.id, context.computerId))
      .limit(1)
      .for("update");
    if (!computer) throw unavailableComputer();
    const [active] = await transaction
      .select({ id: computerCredentials.id })
      .from(computerCredentials)
      .innerJoin(computers, eq(computers.id, computerCredentials.computerId))
      .where(
        and(
          eq(computerCredentials.id, context.credentialId),
          eq(computers.id, context.computerId),
          eq(computers.currentInstallationId, context.installationId),
          isNull(computerCredentials.revokedAt),
        ),
      )
      .limit(1);
    if (!active) throw unavailableComputer();
  }
}

function unavailableComputer(): AuthServiceError {
  return new AuthServiceError(
    "COMPUTER_NOT_REGISTERED",
    "deterministic",
    "The Computer credential is no longer active",
    409,
  );
}

function computerNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
}

function computerRemovalBlocked(): AuthServiceError {
  return new AuthServiceError(
    "COMPUTER_REMOVAL_BLOCKED",
    "deterministic",
    "The Computer cannot be removed while Agents have pending delivery, unreported Turns, or uncertain custody",
    409,
  );
}
