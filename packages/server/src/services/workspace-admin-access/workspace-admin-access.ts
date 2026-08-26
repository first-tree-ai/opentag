import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, imBindings, users, workspaceAdminGrants, workspaces } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";

type QueryExecutor = Pick<DatabaseClient, "select">;

export interface AdminWorkspace {
  grantedAt: Date;
  workspaceDisplayName: string;
  workspaceId: string;
  workspaceName: string;
  setupCompletedAt: Date | null;
}

export interface AuthorizedAgentScope {
  agentId: string;
  workspaceId: string;
}

export interface AuthorizedImBindingScope extends AuthorizedAgentScope {
  imBindingId: string;
}

/** The only service allowed to interpret Workspace Admin grants as management authority. */
export class WorkspaceAdminAccess {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async bootstrapAdminInTransaction(
    transaction: DatabaseTransaction,
    accountId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.lockWorkspace(transaction, workspaceId);
    const now = this.#now();
    await transaction.insert(workspaceAdminGrants).values({
      workspaceId,
      userId: accountId,
      grantedByUserId: accountId,
      grantedAt: now,
    });
  }

  async requireAdmin(accountId: string, workspaceId: string, executor: QueryExecutor = this.#database): Promise<void> {
    const [authority] = await executor
      .select({ id: workspaces.id })
      .from(workspaces)
      .innerJoin(
        workspaceAdminGrants,
        and(
          eq(workspaceAdminGrants.workspaceId, workspaces.id),
          eq(workspaceAdminGrants.userId, accountId),
          isNull(workspaceAdminGrants.revokedAt),
        ),
      )
      .innerJoin(users, and(eq(users.id, workspaceAdminGrants.userId), isNull(users.suspendedAt)))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!authority) throw workspaceNotFound();
  }

  async requireAdminForMutation(
    transaction: DatabaseTransaction,
    accountId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.lockWorkspace(transaction, workspaceId);
    const [authority] = await transaction
      .select({ userId: workspaceAdminGrants.userId })
      .from(workspaceAdminGrants)
      .innerJoin(users, and(eq(users.id, workspaceAdminGrants.userId), isNull(users.suspendedAt)))
      .where(
        and(
          eq(workspaceAdminGrants.workspaceId, workspaceId),
          eq(workspaceAdminGrants.userId, accountId),
          isNull(workspaceAdminGrants.revokedAt),
        ),
      )
      .limit(1)
      .for("update");
    if (!authority) throw workspaceNotFound();
  }

  async requireAdminForAgent(
    accountId: string,
    agentId: string,
    executor: QueryExecutor = this.#database,
  ): Promise<AuthorizedAgentScope> {
    const [agent] = await executor
      .select({ agentId: agents.id, workspaceId: agents.workspaceId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw workspaceNotFound();
    await this.requireAdmin(accountId, agent.workspaceId, executor);
    return agent;
  }

  async requireAdminForAgentMutation(
    transaction: DatabaseTransaction,
    accountId: string,
    agentId: string,
  ): Promise<AuthorizedAgentScope> {
    const [agent] = await transaction
      .select({ agentId: agents.id, workspaceId: agents.workspaceId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw workspaceNotFound();
    await this.requireAdminForMutation(transaction, accountId, agent.workspaceId);
    return agent;
  }

  async requireAdminForImBinding(
    accountId: string,
    imBindingId: string,
    executor: QueryExecutor = this.#database,
  ): Promise<AuthorizedImBindingScope> {
    const [scope] = await executor
      .select({ agentId: agents.id, imBindingId: imBindings.id, workspaceId: agents.workspaceId })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(and(eq(imBindings.id, imBindingId), ne(imBindings.status, "disabled"), ne(agents.status, "deleted")))
      .limit(1);
    if (!scope) throw workspaceNotFound();
    await this.requireAdmin(accountId, scope.workspaceId, executor);
    return scope;
  }

  listActiveAdminWorkspaces(accountId: string): Promise<AdminWorkspace[]> {
    return this.#database
      .select({
        grantedAt: workspaceAdminGrants.grantedAt,
        workspaceDisplayName: workspaces.displayName,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
        setupCompletedAt: workspaces.setupCompletedAt,
      })
      .from(workspaceAdminGrants)
      .innerJoin(workspaces, eq(workspaceAdminGrants.workspaceId, workspaces.id))
      .innerJoin(users, and(eq(users.id, workspaceAdminGrants.userId), isNull(users.suspendedAt)))
      .where(and(eq(workspaceAdminGrants.userId, accountId), isNull(workspaceAdminGrants.revokedAt)))
      .orderBy(
        asc(isNull(workspaces.setupCompletedAt)),
        asc(workspaceAdminGrants.grantedAt),
        asc(workspaces.id),
      ) as Promise<AdminWorkspace[]>;
  }

  async establishDefaultWorkspaceForNewAccount(
    transaction: DatabaseTransaction,
    account: { displayName: string; id: string },
    accountWasCreated: boolean,
  ): Promise<string | undefined> {
    if (!accountWasCreated) return undefined;
    const [existingGrant] = await transaction
      .select({ workspaceId: workspaceAdminGrants.workspaceId })
      .from(workspaceAdminGrants)
      .where(and(eq(workspaceAdminGrants.userId, account.id), isNull(workspaceAdminGrants.revokedAt)))
      .limit(1);
    if (existingGrant) {
      throw new Error("A newly created Account must not already have an active Workspace grant");
    }
    const now = this.#now();
    const workspaceId = randomUUID();
    await transaction.insert(workspaces).values({
      id: workspaceId,
      name: `workspace-${workspaceId}`,
      displayName: `${account.displayName}'s Workspace`.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(workspaceAdminGrants).values({
      workspaceId: workspaceId,
      userId: account.id,
      grantedByUserId: account.id,
      grantedAt: now,
    });
    return workspaceId;
  }

  async lockWorkspace(transaction: DatabaseTransaction, workspaceId: string): Promise<void> {
    const [workspace] = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for("update");
    if (!workspace) throw workspaceNotFound();
  }
}

export function workspaceNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
