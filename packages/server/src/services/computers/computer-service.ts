import type { ComputerRegisterFrame, ListWorkspaceComputersResponse, MeResponse } from "@opentag/shared";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { accountComputers, agents, computerConnectCodes, computerCredentials } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
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
  ): Promise<ListWorkspaceComputersResponse> {
    const rows = await this.#database
      .select({ computer: accountComputers, agentId: agents.id })
      .from(accountComputers)
      .innerJoin(
        computerCredentials,
        and(eq(computerCredentials.computerId, accountComputers.id), isNull(computerCredentials.revokedAt)),
      )
      .leftJoin(
        agents,
        and(
          eq(agents.computerId, accountComputers.id),
          eq(agents.createdByUserId, accountId),
          ne(agents.status, "deleted"),
        ),
      )
      .where(eq(accountComputers.ownerAccountId, accountId))
      .orderBy(asc(accountComputers.displayName), asc(accountComputers.id), asc(agents.id));
    const observedAt = this.#now();
    const cutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, ListWorkspaceComputersResponse["computers"][number]>();
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
        enrolledAt: row.computer.createdAt.toISOString(),
        agentIds: row.agentId ? [row.agentId] : [],
      });
    }
    return { computers: [...byId.values()] };
  }

  /**
   * Removes an Account-owned Computer without erasing history that already refers to it. Active
   * credentials and pending repair codes are revoked, while Agents are unbound so every reader sees
   * that they need another Computer instead of retaining a dangling assignment.
   *
   * Repeating an owned removal succeeds. Besides making DELETE idempotent, this lets a caller retry
   * if closing the live connection failed after the database transaction committed.
   */
  async removeFromAccount(accountId: string, computerId: string): Promise<void> {
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      const [owned] = await transaction
        .select({ id: accountComputers.id })
        .from(accountComputers)
        .where(and(eq(accountComputers.id, computerId), eq(accountComputers.ownerAccountId, accountId)))
        .limit(1)
        .for("update");
      if (!owned) throw computerNotFound();

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
        .set({
          computerId: null,
          workspaceComputerId: null,
          revision: sql`${agents.revision} + 1`,
          updatedAt: now,
        })
        .where(and(eq(agents.computerId, computerId), ne(agents.status, "deleted")));
      await transaction
        .update(accountComputers)
        .set({ currentInstanceId: null, connectedAt: null, updatedAt: now })
        .where(eq(accountComputers.id, computerId));
    });
    await this.#onEnrollmentRemoved?.(computerId);
  }

  async register(context: ComputerAuthContext, frame: ComputerRegisterFrame): Promise<void> {
    rejectUnsupportedClientVersion(frame.clientVersion);
    if (frame.computerId !== context.computerId) {
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
        .update(accountComputers)
        .set(observation)
        .where(
          and(
            eq(accountComputers.id, context.workspaceComputerId),
            eq(accountComputers.currentInstallationId, context.computerId),
          ),
        )
        .returning({ id: accountComputers.id });
      if (updated.length !== 1) throw unavailableComputer();
    });
  }

  async heartbeat(context: ComputerAuthContext, instanceId: string): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const updated = await transaction
        .update(accountComputers)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(
          and(
            eq(accountComputers.id, context.workspaceComputerId),
            eq(accountComputers.currentInstallationId, context.computerId),
            eq(accountComputers.currentInstanceId, instanceId),
          ),
        )
        .returning({ id: accountComputers.id });
      return updated.length === 1;
    });
  }

  async assertActiveCredential(context: ComputerAuthContext): Promise<void> {
    await this.#database.transaction((transaction) => this.#lockActiveCredential(transaction, context));
  }

  async disconnect(workspaceComputerId: string, instanceId: string): Promise<boolean> {
    const now = this.#now();
    const updated = await this.#database
      .update(accountComputers)
      .set({
        currentInstanceId: null,
        connectedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(and(eq(accountComputers.id, workspaceComputerId), eq(accountComputers.currentInstanceId, instanceId)))
      .returning({ id: accountComputers.id });
    return updated.length === 1;
  }

  async #lockActiveCredential(transaction: DatabaseTransaction, context: ComputerAuthContext): Promise<void> {
    const [accountComputer] = await transaction
      .select({ id: accountComputers.id })
      .from(accountComputers)
      .where(eq(accountComputers.id, context.workspaceComputerId))
      .limit(1)
      .for("update");
    if (!accountComputer) throw unavailableComputer();
    const [active] = await transaction
      .select({ id: computerCredentials.id })
      .from(computerCredentials)
      .innerJoin(accountComputers, eq(accountComputers.id, computerCredentials.computerId))
      .where(
        and(
          eq(computerCredentials.id, context.credentialId),
          eq(accountComputers.id, context.workspaceComputerId),
          eq(accountComputers.currentInstallationId, context.computerId),
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
    "The Computer enrollment credential is unavailable",
    409,
  );
}

function computerNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
}
