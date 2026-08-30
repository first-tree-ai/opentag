import type { ListWorkspaceComputersResponse, WorkspaceComputerSummary } from "@opentag/shared";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { accountComputers, agents, workspaceComputers } from "../../db/schema/index.js";
import {
  type ProviderReadinessSource,
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "../computers/provider-readiness.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

export class WorkspaceAdminService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(
    database: DatabaseClient,
    options: {
      now?: () => Date;
      presenceTimeoutMs?: number;
      providerReadiness?: ProviderReadinessSource;
      workspaceAdmins?: WorkspaceAdminAccess;
    } = {},
  ) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  async bootstrapAdminInTransaction(
    transaction: DatabaseTransaction,
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.#workspaceAdmins.bootstrapAdminInTransaction(transaction, userId, workspaceId);
  }

  async listComputers(
    accountId: string,
    workspaceId: string,
    includeProviderReadiness = false,
  ): Promise<ListWorkspaceComputersResponse> {
    await this.#workspaceAdmins.requireAdmin(accountId, workspaceId);
    return { computers: await this.#projectComputers(accountId, workspaceId, includeProviderReadiness) };
  }

  async listAccountComputers(
    accountId: string,
    includeProviderReadiness = false,
  ): Promise<ListWorkspaceComputersResponse> {
    return { computers: await this.#projectComputers(accountId, undefined, includeProviderReadiness) };
  }

  async #projectComputers(
    accountId: string,
    workspaceId: string | undefined,
    includeProviderReadiness: boolean,
  ): Promise<WorkspaceComputerSummary[]> {
    const rows = await this.#database
      .select({ computer: accountComputers, enrollment: workspaceComputers, agentId: agents.id })
      .from(accountComputers)
      .innerJoin(workspaceComputers, eq(workspaceComputers.id, accountComputers.id))
      .leftJoin(
        agents,
        and(
          eq(agents.workspaceComputerId, workspaceComputers.id),
          eq(agents.createdByUserId, accountId),
          ne(agents.status, "deleted"),
        ),
      )
      .where(
        and(
          workspaceId === undefined ? undefined : eq(workspaceComputers.workspaceId, workspaceId),
          eq(accountComputers.ownerAccountId, accountId),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .orderBy(asc(accountComputers.displayName), asc(accountComputers.id), asc(agents.id));
    const observedAt = this.#now();
    const cutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, WorkspaceComputerSummary>();
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
      const base: WorkspaceComputerSummary = {
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
      };
      byId.set(row.computer.id, base);
    }
    return [...byId.values()];
  }
}
