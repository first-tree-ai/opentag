import {
  type CreateWorkspaceRequest,
  CreateWorkspaceRequestSchema,
  type CreateWorkspaceResponse,
  type ListWorkspaceAdminsConfigResponse,
  type ListWorkspaceAdminsResponse,
  type ListWorkspaceComputersConfigResponse,
  type ListWorkspaceComputersResponse,
  type UpdateWorkspaceProfileRequest,
  UpdateWorkspaceProfileRequestSchema,
  type WorkspaceComputerAdminConfig,
  type WorkspaceComputerSummary,
  type WorkspaceProfile,
} from "@opentag/shared";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, workspaceComputers, workspaces } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import {
  type ProviderReadinessSource,
  projectComputerImCliReadiness,
  projectComputerProviderReadiness,
} from "../computers/provider-readiness.js";
import { WORKSPACE_ADMIN_LIMIT, WorkspaceAdminAccess, workspaceNotFound } from "../workspace-admin-access/index.js";

export const WORKSPACE_ADMIN_GRANT_LIMIT = WORKSPACE_ADMIN_LIMIT;

function isWorkspaceNameConflict(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === "workspaces_name_unique"
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

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

  async createWorkspace(accountId: string, rawInput: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    const input = CreateWorkspaceRequestSchema.parse(rawInput);
    try {
      return await this.#workspaceAdmins.createWorkspaceWithAdmin(accountId, input);
    } catch (error) {
      if (isWorkspaceNameConflict(error)) {
        throw new AuthServiceError(
          "WORKSPACE_NAME_CONFLICT",
          "deterministic",
          "Another Workspace already uses this canonical name",
          409,
        );
      }
      throw error;
    }
  }

  async updateWorkspaceProfile(
    accountId: string,
    workspaceId: string,
    rawInput: UpdateWorkspaceProfileRequest,
  ): Promise<WorkspaceProfile> {
    const input = UpdateWorkspaceProfileRequestSchema.parse(rawInput);
    try {
      return await this.#workspaceAdmins.withAdminMutation(accountId, workspaceId, async (transaction) => {
        const [updated] = await transaction
          .update(workspaces)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
            updatedAt: this.#now(),
          })
          .where(eq(workspaces.id, workspaceId))
          .returning();
        if (!updated) throw workspaceNotFound();
        return {
          id: updated.id,
          name: updated.name,
          displayName: updated.displayName,
          setupCompletedAt: updated.setupCompletedAt?.toISOString() ?? null,
          updatedAt: updated.updatedAt.toISOString(),
        };
      });
    } catch (error) {
      if (isWorkspaceNameConflict(error)) {
        throw new AuthServiceError(
          "WORKSPACE_NAME_CONFLICT",
          "deterministic",
          "Another Workspace already uses this canonical name",
          409,
        );
      }
      throw error;
    }
  }

  async getWorkspaceProfile(accountId: string, workspaceId: string): Promise<WorkspaceProfile> {
    await this.#workspaceAdmins.requireAdmin(accountId, workspaceId);
    const [workspace] = await this.#database.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
    if (!workspace) throw workspaceNotFound();
    return {
      id: workspace.id,
      name: workspace.name,
      displayName: workspace.displayName,
      setupCompletedAt: workspace.setupCompletedAt?.toISOString() ?? null,
      updatedAt: workspace.updatedAt.toISOString(),
    };
  }

  async listAdmins(accountId: string, workspaceId: string): Promise<ListWorkspaceAdminsResponse> {
    return this.#workspaceAdmins.listAdmins(accountId, workspaceId);
  }

  async listAdminsConfig(accountId: string, workspaceId: string): Promise<ListWorkspaceAdminsConfigResponse> {
    return this.#workspaceAdmins.listAdminsConfig(accountId, workspaceId);
  }

  async revokeAdmin(accountId: string, workspaceId: string, targetAccountId: string): Promise<void> {
    await this.#workspaceAdmins.revokeAdmin(accountId, workspaceId, targetAccountId);
  }

  async listComputers(
    accountId: string,
    workspaceId: string,
    includeProviderReadiness = false,
  ): Promise<ListWorkspaceComputersResponse> {
    await this.#workspaceAdmins.requireAdmin(accountId, workspaceId);
    return { computers: await this.#projectComputers(workspaceId, includeProviderReadiness, false) };
  }

  async listComputersConfig(
    accountId: string,
    workspaceId: string,
    includeProviderReadiness = false,
  ): Promise<ListWorkspaceComputersConfigResponse> {
    await this.#workspaceAdmins.requireAdmin(accountId, workspaceId);
    return {
      computers: (await this.#projectComputers(
        workspaceId,
        includeProviderReadiness,
        true,
      )) as WorkspaceComputerAdminConfig[],
    };
  }

  async #projectComputers(
    workspaceId: string,
    includeProviderReadiness: boolean,
    includeAdminFields: boolean,
  ): Promise<(WorkspaceComputerSummary | WorkspaceComputerAdminConfig)[]> {
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
    const byId = new Map<string, WorkspaceComputerSummary | WorkspaceComputerAdminConfig>();
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
      byId.set(
        row.enrollment.id,
        includeAdminFields
          ? {
              ...base,
              arch: row.enrollment.arch,
              clientVersion: row.enrollment.clientVersion,
              enrolledByUserId: row.enrollment.enrolledByUserId,
            }
          : base,
      );
    }
    return [...byId.values()];
  }
}
