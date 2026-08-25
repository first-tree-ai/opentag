import type { Computer, ComputerRegisterFrame, ListComputersResponse, MeResponse } from "@opentag/shared";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { teams, workspaceComputerCredentials, workspaceComputers } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";
import type { ComputerAuthContext } from "./machine-auth-service.js";
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
  presenceTimeoutMs?: number;
  providerReadiness?: ProviderReadinessSource;
  workspaceAdmins?: WorkspaceAdminAccess;
}

export class ComputerService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(database: DatabaseClient, _auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  async register(context: ComputerAuthContext, frame: ComputerRegisterFrame): Promise<void> {
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
      const updated = await transaction
        .update(workspaceComputers)
        .set({
          displayName: frame.displayName,
          platform: frame.platform,
          arch: frame.arch,
          clientVersion: frame.clientVersion,
          currentInstanceId: frame.instanceId,
          connectedAt: now,
          lastSeenAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(workspaceComputers.id, context.workspaceComputerId),
            eq(workspaceComputers.workspaceId, context.workspaceId),
            eq(workspaceComputers.computerId, context.computerId),
            isNull(workspaceComputers.revokedAt),
          ),
        )
        .returning({ id: workspaceComputers.id });
      if (updated.length !== 1) throw unavailableEnrollment();
    });
  }

  async heartbeat(context: ComputerAuthContext, instanceId: string): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const updated = await transaction
        .update(workspaceComputers)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(
          and(
            eq(workspaceComputers.id, context.workspaceComputerId),
            eq(workspaceComputers.workspaceId, context.workspaceId),
            eq(workspaceComputers.computerId, context.computerId),
            eq(workspaceComputers.currentInstanceId, instanceId),
            isNull(workspaceComputers.revokedAt),
          ),
        )
        .returning({ id: workspaceComputers.id });
      return updated.length === 1;
    });
  }

  async assertActiveCredential(context: ComputerAuthContext): Promise<void> {
    await this.#database.transaction((transaction) => this.#lockActiveCredential(transaction, context));
  }

  async disconnect(workspaceComputerId: string, instanceId: string): Promise<boolean> {
    const now = this.#now();
    const updated = await this.#database
      .update(workspaceComputers)
      .set({ currentInstanceId: null, connectedAt: null, lastSeenAt: now, updatedAt: now })
      .where(and(eq(workspaceComputers.id, workspaceComputerId), eq(workspaceComputers.currentInstanceId, instanceId)))
      .returning({ id: workspaceComputers.id });
    return updated.length === 1;
  }

  async listForUser(userId: string, includeProviderReadiness = false): Promise<ListComputersResponse> {
    await this.#workspaceAdmins.requireAnyAdmin(userId);
    const workspaces = await this.#workspaceAdmins.listActiveAdminWorkspaces(userId);
    const rows = await this.#database
      .select({ enrollment: workspaceComputers })
      .from(workspaceComputers)
      .where(
        and(
          inArray(
            workspaceComputers.workspaceId,
            workspaces.map(({ teamId }) => teamId),
          ),
          isNull(workspaceComputers.revokedAt),
        ),
      );
    const observedAt = this.#now();
    const freshnessCutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    return {
      computers: rows.map(({ enrollment: row }): Computer => {
        const connectionStatus =
          row.currentInstanceId !== null && (row.lastSeenAt?.getTime() ?? 0) >= freshnessCutoff ? "online" : "offline";
        return {
          id: row.computerId,
          ownerUserId: row.enrolledByUserId,
          displayName: row.displayName,
          platform: row.platform,
          arch: row.arch,
          clientVersion: row.clientVersion,
          connectionStatus,
          ...(includeProviderReadiness
            ? {
                providerReadiness: projectComputerProviderReadiness(
                  row.id,
                  connectionStatus,
                  observedAt,
                  this.#providerReadiness,
                ),
                imCliReadiness: projectComputerImCliReadiness(
                  row.id,
                  connectionStatus,
                  observedAt,
                  this.#providerReadiness,
                ),
              }
            : {}),
          connectedAt: row.connectedAt?.toISOString() ?? null,
          lastSeenAt: (row.lastSeenAt ?? row.enrolledAt).toISOString(),
        };
      }),
    };
  }

  async #lockActiveCredential(transaction: DatabaseTransaction, context: ComputerAuthContext): Promise<void> {
    const [workspace] = await transaction
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, context.workspaceId))
      .limit(1)
      .for("update");
    if (!workspace) throw unavailableEnrollment();
    const [active] = await transaction
      .select({ id: workspaceComputerCredentials.id })
      .from(workspaceComputerCredentials)
      .innerJoin(workspaceComputers, eq(workspaceComputers.id, workspaceComputerCredentials.workspaceComputerId))
      .where(
        and(
          eq(workspaceComputerCredentials.id, context.credentialId),
          eq(workspaceComputers.id, context.workspaceComputerId),
          eq(workspaceComputers.workspaceId, context.workspaceId),
          eq(workspaceComputers.computerId, context.computerId),
          isNull(workspaceComputerCredentials.revokedAt),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .limit(1);
    if (!active) throw unavailableEnrollment();
  }
}

function unavailableEnrollment(): AuthServiceError {
  return new AuthServiceError(
    "COMPUTER_NOT_REGISTERED",
    "deterministic",
    "The Computer enrollment credential is unavailable",
    409,
  );
}
