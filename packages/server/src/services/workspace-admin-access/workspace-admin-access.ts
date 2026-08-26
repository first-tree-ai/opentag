import { randomUUID } from "node:crypto";
import type {
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  InvitationAcceptanceResponse,
  InvitationPreview,
  ListWorkspaceAdminsConfigResponse,
  ListWorkspaceAdminsResponse,
} from "@opentag/shared";
import { InvitationTokenSchema } from "@opentag/shared";
import { and, asc, eq, gt, isNull, ne } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  adminInvitations,
  agents,
  computerConnectCodes,
  imBindings,
  users,
  workspaceAdminGrants,
  workspaces,
} from "../../db/schema/index.js";
import { AuthServiceError, hashSecret } from "../auth/index.js";

type QueryExecutor = Pick<DatabaseClient, "select">;

export const WORKSPACE_ADMIN_LIMIT = 50;

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
    await this.lockAccountForGrantWrite(transaction, accountId);
    await this.lockWorkspace(transaction, workspaceId);
    await this.requireWorkspaceHeadroom(transaction, accountId);
    const now = this.#now();
    await transaction.insert(workspaceAdminGrants).values({
      workspaceId,
      userId: accountId,
      grantedByUserId: accountId,
      grantedAt: now,
    });
  }

  createWorkspaceWithAdmin(accountId: string, input: CreateWorkspaceRequest): Promise<CreateWorkspaceResponse> {
    return this.#database.transaction(async (transaction) => {
      await this.lockAccountForGrantWrite(transaction, accountId);
      await this.requireWorkspaceHeadroom(transaction, accountId);
      const now = this.#now();
      const [workspace] = await transaction
        .insert(workspaces)
        .values({ name: input.name, displayName: input.displayName, createdAt: now, updatedAt: now })
        .returning();
      if (!workspace) throw new Error("Workspace insert did not return a row");
      await transaction.insert(workspaceAdminGrants).values({
        workspaceId: workspace.id,
        userId: accountId,
        grantedByUserId: accountId,
        grantedAt: now,
      });
      return {
        id: workspace.id,
        name: workspace.name,
        displayName: workspace.displayName,
        setupCompletedAt: workspace.setupCompletedAt?.toISOString() ?? null,
        createdAt: workspace.createdAt.toISOString(),
        updatedAt: workspace.updatedAt.toISOString(),
        grantedAt: now.toISOString(),
      };
    });
  }

  async listAdmins(accountId: string, workspaceId: string): Promise<ListWorkspaceAdminsResponse> {
    await this.requireAdmin(accountId, workspaceId);
    const rows = await this.#database
      .select({ userId: users.id, displayName: users.displayName, grantedAt: workspaceAdminGrants.grantedAt })
      .from(workspaceAdminGrants)
      .innerJoin(users, and(eq(users.id, workspaceAdminGrants.userId), isNull(users.suspendedAt)))
      .where(and(eq(workspaceAdminGrants.workspaceId, workspaceId), isNull(workspaceAdminGrants.revokedAt)))
      .orderBy(asc(workspaceAdminGrants.grantedAt), asc(users.id));
    return { admins: rows.map((row) => ({ ...row, grantedAt: row.grantedAt.toISOString() })) };
  }

  async listAdminsConfig(accountId: string, workspaceId: string): Promise<ListWorkspaceAdminsConfigResponse> {
    await this.requireAdmin(accountId, workspaceId);
    const rows = await this.#database
      .select({ grant: workspaceAdminGrants, user: users })
      .from(workspaceAdminGrants)
      .innerJoin(users, eq(users.id, workspaceAdminGrants.userId))
      .where(and(eq(workspaceAdminGrants.workspaceId, workspaceId), isNull(workspaceAdminGrants.revokedAt)))
      .orderBy(asc(workspaceAdminGrants.grantedAt), asc(users.id));
    return {
      admins: rows.map(({ grant, user }) => ({
        workspaceId,
        userId: user.id,
        email: user.email,
        displayName: user.displayName,
        grantedByUserId: grant.grantedByUserId,
        grantedAt: grant.grantedAt.toISOString(),
      })),
    };
  }

  async previewInvitation(rawToken: string): Promise<InvitationPreview> {
    const tokenHash = hashSecret(this.#parseInvitationToken(rawToken));
    const [row] = await this.#database
      .select({ invitation: adminInvitations, workspaceDisplayName: workspaces.displayName })
      .from(adminInvitations)
      .innerJoin(workspaces, eq(workspaces.id, adminInvitations.workspaceId))
      .where(
        and(
          eq(adminInvitations.tokenHash, tokenHash),
          isNull(adminInvitations.acceptedAt),
          isNull(adminInvitations.revokedAt),
          gt(adminInvitations.expiresAt, this.#now()),
        ),
      )
      .limit(1);
    if (!row) throw this.#invalidInvitation();
    return {
      workspaceDisplayName: row.workspaceDisplayName,
      expiresAt: row.invitation.expiresAt.toISOString(),
    };
  }

  acceptInvitation(accountId: string, rawToken: string): Promise<InvitationAcceptanceResponse> {
    return this.#database.transaction(async (transaction) => {
      const tokenHash = hashSecret(this.#parseInvitationToken(rawToken));
      const [candidate] = await transaction
        .select({ workspaceId: adminInvitations.workspaceId })
        .from(adminInvitations)
        .where(eq(adminInvitations.tokenHash, tokenHash))
        .limit(1);
      if (!candidate) throw this.#invalidInvitation();

      await this.lockAccountForGrantWrite(transaction, accountId);
      await this.lockWorkspace(transaction, candidate.workspaceId);
      const [invitation] = await transaction
        .select()
        .from(adminInvitations)
        .where(eq(adminInvitations.tokenHash, tokenHash))
        .limit(1)
        .for("update");
      const now = this.#now();
      if (!invitation || invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= now) {
        throw this.#invalidInvitation();
      }
      await this.requireAdmin(invitation.createdByUserId, invitation.workspaceId, transaction);
      const [existing] = await transaction
        .select({ grantedAt: workspaceAdminGrants.grantedAt })
        .from(workspaceAdminGrants)
        .where(
          and(
            eq(workspaceAdminGrants.workspaceId, invitation.workspaceId),
            eq(workspaceAdminGrants.userId, accountId),
            isNull(workspaceAdminGrants.revokedAt),
          ),
        )
        .limit(1)
        .for("update");
      let grantedAt = existing?.grantedAt;
      if (!grantedAt) {
        await this.requireWorkspaceHeadroom(transaction, accountId);
        const [grant] = await transaction
          .insert(workspaceAdminGrants)
          .values({
            workspaceId: invitation.workspaceId,
            userId: accountId,
            grantedByUserId: invitation.createdByUserId,
            grantedAt: now,
          })
          .returning({ grantedAt: workspaceAdminGrants.grantedAt });
        if (!grant) throw new Error("Workspace Admin grant insert did not return a row");
        grantedAt = grant.grantedAt;
      }
      await transaction
        .update(adminInvitations)
        .set({ acceptedByUserId: accountId, acceptedAt: now })
        .where(eq(adminInvitations.id, invitation.id));
      const [workspace] = await transaction
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, invitation.workspaceId))
        .limit(1);
      if (!workspace) throw this.#invalidInvitation();
      return {
        workspace: {
          id: workspace.id,
          name: workspace.name,
          displayName: workspace.displayName,
          setupCompletedAt: workspace.setupCompletedAt?.toISOString() ?? null,
          grantedAt: grantedAt.toISOString(),
        },
      };
    });
  }

  async revokeAdmin(accountId: string, workspaceId: string, targetAccountId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.lockAccountForGrantWrite(transaction, targetAccountId);
      await this.requireAdminForMutation(transaction, accountId, workspaceId);
      const [target] = await transaction
        .select({ id: workspaceAdminGrants.id })
        .from(workspaceAdminGrants)
        .where(
          and(
            eq(workspaceAdminGrants.workspaceId, workspaceId),
            eq(workspaceAdminGrants.userId, targetAccountId),
            isNull(workspaceAdminGrants.revokedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!target) throw workspaceNotFound();
      await this.requireAnotherAdmin(transaction, workspaceId, targetAccountId);
      const now = this.#now();
      await transaction
        .update(workspaceAdminGrants)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(eq(workspaceAdminGrants.id, target.id));
      await transaction
        .update(adminInvitations)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(
          and(
            eq(adminInvitations.workspaceId, workspaceId),
            eq(adminInvitations.createdByUserId, targetAccountId),
            isNull(adminInvitations.acceptedAt),
            isNull(adminInvitations.revokedAt),
          ),
        );
      await transaction
        .update(computerConnectCodes)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(
          and(
            eq(computerConnectCodes.workspaceId, workspaceId),
            eq(computerConnectCodes.issuedByUserId, targetAccountId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
          ),
        );
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

  async requireAnyAdmin(accountId: string, executor: QueryExecutor = this.#database): Promise<void> {
    const [authority] = await executor
      .select({ workspaceId: workspaceAdminGrants.workspaceId })
      .from(workspaceAdminGrants)
      .innerJoin(users, and(eq(users.id, workspaceAdminGrants.userId), isNull(users.suspendedAt)))
      .where(and(eq(workspaceAdminGrants.userId, accountId), isNull(workspaceAdminGrants.revokedAt)))
      .limit(1);
    if (!authority) {
      throw new AuthServiceError(
        "AUTH_WORKSPACE_ADMIN_REQUIRED",
        "deterministic",
        "Active Workspace Admin access is required",
        403,
      );
    }
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
      .select({ workspaceId: workspaceAdminGrants.workspaceId })
      .from(workspaceAdminGrants)
      .where(and(eq(workspaceAdminGrants.userId, accountId), isNull(workspaceAdminGrants.revokedAt)));
    if (held.length >= WORKSPACE_ADMIN_LIMIT) {
      throw new AuthServiceError(
        "WORKSPACE_LIMIT_REACHED",
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
      .select({ userId: workspaceAdminGrants.userId })
      .from(workspaceAdminGrants)
      .innerJoin(users, and(eq(users.id, workspaceAdminGrants.userId), isNull(users.suspendedAt)))
      .where(
        and(
          eq(workspaceAdminGrants.workspaceId, workspaceId),
          isNull(workspaceAdminGrants.revokedAt),
          ne(workspaceAdminGrants.userId, excludedAccountId),
        ),
      )
      .limit(1);
    if (!other) {
      throw new AuthServiceError(
        "WORKSPACE_LAST_ADMIN",
        "deterministic",
        "The last active Workspace Admin cannot be removed",
        409,
      );
    }
  }

  #parseInvitationToken(value: string): string {
    const parsed = InvitationTokenSchema.safeParse(value);
    if (!parsed.success) throw this.#invalidInvitation();
    return parsed.data;
  }

  #invalidInvitation(): AuthServiceError {
    return new AuthServiceError("INVITATION_INVALID", "credential", "The invitation is invalid or expired", 404);
  }
}

export function workspaceNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
