import type { ListWorkspaceComputersResponse, WorkspaceComputerSummary } from "@opentag/shared";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, workspaceComputers } from "../../db/schema/index.js";
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
    return { computers: await this.#projectComputers(workspaceId, includeProviderReadiness) };
  }

  async #projectComputers(workspaceId: string, includeProviderReadiness: boolean): Promise<WorkspaceComputerSummary[]> {
    const rows = await this.#database
      .select({ enrollment: workspaceComputers, agentId: agents.id })
      .from(workspaceComputers)
      .leftJoin(
        agents,
        and(
          eq(agents.workspaceId, workspaceComputers.workspaceId),
          eq(agents.workspaceComputerId, workspaceComputers.id),
          ne(agents.status, "deleted"),
        ),
      )
      .where(and(eq(workspaceComputers.workspaceId, workspaceId), isNull(workspaceComputers.revokedAt)))
      .orderBy(asc(workspaceComputers.displayName), asc(workspaceComputers.computerId), asc(agents.id));
    const observedAt = this.#now();
    const cutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, WorkspaceComputerSummary>();
    for (const row of rows) {
      const existing = byId.get(row.enrollment.id);
      if (existing) {
        if (row.agentId) existing.agentIds.push(row.agentId);
        continue;
      }
      const connectionStatus =
        row.enrollment.currentInstanceId !== null && (row.enrollment.lastSeenAt?.getTime() ?? 0) >= cutoff
          ? "online"
          : "offline";
      const base: WorkspaceComputerSummary = {
        computerId: row.enrollment.computerId,
        displayName: row.enrollment.displayName,
        platform: row.enrollment.platform,
        connectionStatus,
        ...(includeProviderReadiness
          ? {
              providerReadiness: projectComputerProviderReadiness(
                row.enrollment.id,
                connectionStatus,
                observedAt,
                this.#providerReadiness,
              ),
              imCliReadiness: projectComputerImCliReadiness(
                row.enrollment.id,
                connectionStatus,
                observedAt,
                this.#providerReadiness,
              ),
            }
          : {}),
        connectedAt: row.enrollment.connectedAt?.toISOString() ?? null,
        lastSeenAt: row.enrollment.lastSeenAt?.toISOString() ?? null,
        observedAt: observedAt.toISOString(),
        enrolledAt: row.enrollment.enrolledAt.toISOString(),
        agentIds: row.agentId ? [row.agentId] : [],
      };
      byId.set(row.enrollment.id, base);
    }
    return [...byId.values()];
  }
}
