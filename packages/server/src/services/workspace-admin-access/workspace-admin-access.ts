import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, imBindings, memberships, teams, users } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";

type QueryExecutor = Pick<DatabaseClient, "select">;

export const WORKSPACE_ADMIN_LIMIT = 50;

export interface LegacyAdminWorkspace {
  role: "admin";
  teamDisplayName: string;
  teamId: string;
  teamName: string;
  setupCompletedAt: Date | null;
}

export interface AuthorizedAgentScope {
  agentId: string;
  workspaceId: string;
}

export interface AuthorizedImBindingScope extends AuthorizedAgentScope {
  imBindingId: string;
}

/**
 * The only service that interprets legacy membership rows as Workspace Admin authority.
 * PR C swaps its storage adapter to roleless grants without changing business services.
 */
export class WorkspaceAdminAccess {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async requireAdmin(accountId: string, workspaceId: string, executor: QueryExecutor = this.#database): Promise<void> {
    const [authority] = await executor
      .select({ id: teams.id })
      .from(teams)
      .innerJoin(
        memberships,
        and(
          eq(memberships.teamId, teams.id),
          eq(memberships.userId, accountId),
          eq(memberships.status, "active"),
          eq(memberships.role, "admin"),
        ),
      )
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(eq(teams.id, workspaceId))
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
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(
        and(
          eq(memberships.teamId, workspaceId),
          eq(memberships.userId, accountId),
          eq(memberships.status, "active"),
          eq(memberships.role, "admin"),
        ),
      )
      .limit(1)
      .for("update");
    if (!authority) throw workspaceNotFound();
  }

  async withAdminMutation<T>(
    accountId: string,
    workspaceId: string,
    mutate: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return this.#database.transaction(async (transaction) => {
      await this.requireAdminForMutation(transaction, accountId, workspaceId);
      return mutate(transaction);
    });
  }

  async requireAdminForAgent(
    accountId: string,
    agentId: string,
    executor: QueryExecutor = this.#database,
  ): Promise<AuthorizedAgentScope> {
    const [agent] = await executor
      .select({ agentId: agents.id, workspaceId: agents.teamId })
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
      .select({ agentId: agents.id, workspaceId: agents.teamId })
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
      .select({ agentId: agents.id, imBindingId: imBindings.id, workspaceId: agents.teamId })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(and(eq(imBindings.id, imBindingId), ne(imBindings.status, "disabled"), ne(agents.status, "deleted")))
      .limit(1);
    if (!scope) throw workspaceNotFound();
    await this.requireAdmin(accountId, scope.workspaceId, executor);
    return scope;
  }

  async requireAnyAdmin(accountId: string, executor: QueryExecutor = this.#database): Promise<void> {
    const [authority] = await executor
      .select({ workspaceId: memberships.teamId })
      .from(memberships)
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(and(eq(memberships.userId, accountId), eq(memberships.status, "active"), eq(memberships.role, "admin")))
      .limit(1);
    if (!authority) {
      throw new AuthServiceError(
        "AUTH_MEMBERSHIP_REQUIRED",
        "deterministic",
        "Active Workspace Admin access is required",
        403,
      );
    }
  }

  listActiveAdminWorkspaces(accountId: string): Promise<LegacyAdminWorkspace[]> {
    return this.#database
      .select({
        role: memberships.role,
        teamDisplayName: teams.displayName,
        teamId: teams.id,
        teamName: teams.name,
        setupCompletedAt: teams.setupCompletedAt,
      })
      .from(memberships)
      .innerJoin(teams, eq(memberships.teamId, teams.id))
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(and(eq(memberships.userId, accountId), eq(memberships.status, "active"), eq(memberships.role, "admin")))
      .orderBy(asc(isNull(teams.setupCompletedAt)), asc(memberships.createdAt), asc(teams.id)) as Promise<
      LegacyAdminWorkspace[]
    >;
  }

  async establishDefaultWorkspaceForNewAccount(
    transaction: DatabaseTransaction,
    account: { displayName: string; id: string },
    accountWasCreated: boolean,
  ): Promise<string | undefined> {
    if (!accountWasCreated) return undefined;
    const now = this.#now();
    const workspaceId = randomUUID();
    await transaction.insert(teams).values({
      id: workspaceId,
      name: `team-${workspaceId}`,
      displayName: `${account.displayName}'s Workspace`.slice(0, 120),
      createdAt: now,
      updatedAt: now,
    });
    await transaction.insert(memberships).values({
      teamId: workspaceId,
      userId: account.id,
      role: "admin",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return workspaceId;
  }

  async lockWorkspace(transaction: DatabaseTransaction, workspaceId: string): Promise<void> {
    const [workspace] = await transaction
      .select({ id: teams.id })
      .from(teams)
      .where(eq(teams.id, workspaceId))
      .limit(1)
      .for("update");
    if (!workspace) throw workspaceNotFound();
  }

  async lockAccountForGrantWrite(transaction: DatabaseTransaction, accountId: string): Promise<void> {
    const [account] = await transaction
      .select({ id: users.id, suspendedAt: users.suspendedAt })
      .from(users)
      .where(eq(users.id, accountId))
      .limit(1)
      .for("update");
    if (!account || account.suspendedAt) throw workspaceNotFound();
  }

  async requireWorkspaceHeadroom(transaction: DatabaseTransaction, accountId: string): Promise<void> {
    const held = await transaction
      .select({ workspaceId: memberships.teamId })
      .from(memberships)
      .where(and(eq(memberships.userId, accountId), eq(memberships.status, "active"), eq(memberships.role, "admin")));
    if (held.length >= WORKSPACE_ADMIN_LIMIT) {
      throw new AuthServiceError(
        "TEAM_LIMIT_REACHED",
        "deterministic",
        `An Account can administer at most ${WORKSPACE_ADMIN_LIMIT} active Workspaces`,
        409,
      );
    }
  }

  async requireAnotherAdmin(
    transaction: DatabaseTransaction,
    workspaceId: string,
    excludedAccountId: string,
  ): Promise<void> {
    const [other] = await transaction
      .select({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(
        and(
          eq(memberships.teamId, workspaceId),
          eq(memberships.status, "active"),
          eq(memberships.role, "admin"),
          ne(memberships.userId, excludedAccountId),
        ),
      )
      .limit(1);
    if (!other) {
      throw new AuthServiceError(
        "MEMBERSHIP_LAST_ADMIN",
        "deterministic",
        "The last active Workspace Admin cannot be removed",
        409,
      );
    }
  }
}

export function workspaceNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
