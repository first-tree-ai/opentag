import type { WorkspaceSetupCompletion } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, users, workspaces } from "../../db/schema/index.js";
import type { ImBindingService } from "../im-bindings/index.js";

export class WorkspaceSetupServiceError extends Error {
  readonly category = "deterministic" as const;

  constructor(
    readonly code: "WORKSPACE_SETUP_AGENT_NOT_FOUND" | "WORKSPACE_SETUP_NOT_READY",
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceSetupServiceError";
  }
}

/** Owns the one-way transition from first-time setup into normal operations. */
export class WorkspaceSetupService {
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, imBindings: ImBindingService, options: { now?: () => Date } = {}) {
    this.#database = database;
    this.#imBindings = imBindings;
    this.#now = options.now ?? (() => new Date());
  }

  async completeForAccount(callerUserId: string, agentId: string): Promise<WorkspaceSetupCompletion> {
    return this.#complete(callerUserId, agentId);
  }

  async complete(callerUserId: string, workspaceId: string, agentId: string): Promise<WorkspaceSetupCompletion> {
    return this.#complete(callerUserId, agentId, workspaceId);
  }

  /**
   * Completes Account onboarding from an Agent this Account created. Canonical state is
   * `users.setup_completed_at`. The selected creator-Agent's Workspace is dual-written for rollback.
   * Workspace administrator grants never contribute.
   */
  async #complete(callerUserId: string, agentId: string, workspaceId?: string): Promise<WorkspaceSetupCompletion> {
    const current = await this.#existingCompletion(callerUserId);
    if (current) return current;
    await this.#ownedActiveAgent(callerUserId, agentId, workspaceId);

    const handoff = await this.#imBindings.getHandoffForAgent(callerUserId, agentId);
    if (!handoff?.handoffReady) {
      throw new WorkspaceSetupServiceError(
        "WORKSPACE_SETUP_NOT_READY",
        409,
        "The Agent handoff is not ready to complete Account setup",
      );
    }

    return this.#database.transaction(async (transaction) => {
      const [lockedUser] = await transaction
        .select({ setupCompletedAt: users.setupCompletedAt })
        .from(users)
        .where(eq(users.id, callerUserId))
        .limit(1)
        .for("update");
      if (!lockedUser) {
        throw new WorkspaceSetupServiceError(
          "WORKSPACE_SETUP_AGENT_NOT_FOUND",
          404,
          "The active setup Agent was not found",
        );
      }
      if (lockedUser.setupCompletedAt) return this.#projection(lockedUser.setupCompletedAt);

      const [lockedAgent] = await transaction
        .select({ id: agents.id, workspaceId: agents.workspaceId })
        .from(agents)
        .where(
          and(
            eq(agents.id, agentId),
            eq(agents.createdByUserId, callerUserId),
            eq(agents.status, "active"),
            ...(workspaceId === undefined ? [] : [eq(agents.workspaceId, workspaceId)]),
          ),
        )
        .limit(1)
        .for("update");
      if (!lockedAgent) {
        throw new WorkspaceSetupServiceError(
          "WORKSPACE_SETUP_AGENT_NOT_FOUND",
          404,
          "The active setup Agent was not found",
        );
      }

      const [lockedWorkspace] = await transaction
        .select({ setupCompletedAt: workspaces.setupCompletedAt })
        .from(workspaces)
        .where(eq(workspaces.id, lockedAgent.workspaceId))
        .limit(1)
        .for("update");
      const completedAt = lockedWorkspace?.setupCompletedAt ?? this.#now();
      const [completed] = await transaction
        .update(users)
        .set({ setupCompletedAt: completedAt, updatedAt: completedAt })
        .where(eq(users.id, callerUserId))
        .returning({ setupCompletedAt: users.setupCompletedAt });
      if (!completed?.setupCompletedAt) throw new Error("Account setup completion did not return a timestamp");
      if (!lockedWorkspace?.setupCompletedAt) {
        await transaction
          .update(workspaces)
          .set({ setupCompletedAt: completedAt, updatedAt: completedAt })
          .where(eq(workspaces.id, lockedAgent.workspaceId));
      }
      return this.#projection(completed.setupCompletedAt);
    });
  }

  async #existingCompletion(callerUserId: string): Promise<WorkspaceSetupCompletion | undefined> {
    const [row] = await this.#database
      .select({ setupCompletedAt: users.setupCompletedAt })
      .from(users)
      .where(eq(users.id, callerUserId))
      .limit(1);
    return row?.setupCompletedAt ? this.#projection(row.setupCompletedAt) : undefined;
  }

  async #ownedActiveAgent(
    callerUserId: string,
    agentId: string,
    workspaceId?: string,
  ): Promise<{ id: string; workspaceId: string }> {
    const [agent] = await this.#database
      .select({ id: agents.id, workspaceId: agents.workspaceId })
      .from(agents)
      .where(
        and(
          eq(agents.id, agentId),
          eq(agents.createdByUserId, callerUserId),
          eq(agents.status, "active"),
          ...(workspaceId === undefined ? [] : [eq(agents.workspaceId, workspaceId)]),
        ),
      )
      .limit(1);
    if (!agent) {
      throw new WorkspaceSetupServiceError(
        "WORKSPACE_SETUP_AGENT_NOT_FOUND",
        404,
        "The active setup Agent was not found",
      );
    }
    return agent;
  }

  #projection(setupCompletedAt: Date): WorkspaceSetupCompletion {
    return { setupCompletedAt: setupCompletedAt.toISOString() };
  }
}
