import type { WorkspaceSetupCompletion } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, workspaces } from "../../db/schema/index.js";
import type { ImBindingService } from "../im-bindings/index.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";

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
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(
    database: DatabaseClient,
    imBindings: ImBindingService,
    options: { now?: () => Date; workspaceAdmins?: WorkspaceAdminAccess } = {},
  ) {
    this.#database = database;
    this.#imBindings = imBindings;
    this.#now = options.now ?? (() => new Date());
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  async complete(callerUserId: string, workspaceId: string, agentId: string): Promise<WorkspaceSetupCompletion> {
    await this.#workspaceAdmins.requireAdmin(callerUserId, workspaceId);
    const [current] = await this.#database
      .select({ setupCompletedAt: workspaces.setupCompletedAt })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (current?.setupCompletedAt) return this.#projection(current.setupCompletedAt);

    const [agent] = await this.#database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId), eq(agents.status, "active")))
      .limit(1);
    if (!agent) {
      throw new WorkspaceSetupServiceError(
        "WORKSPACE_SETUP_AGENT_NOT_FOUND",
        404,
        "The active setup Agent was not found in this Workspace",
      );
    }

    const handoff = await this.#imBindings.getHandoffForAgent(callerUserId, agentId);
    if (!handoff?.handoffReady) {
      throw new WorkspaceSetupServiceError(
        "WORKSPACE_SETUP_NOT_READY",
        409,
        "The Agent handoff is not ready to complete Workspace setup",
      );
    }

    return this.#database.transaction(async (transaction) => {
      await this.#workspaceAdmins.requireAdminForMutation(transaction, callerUserId, workspaceId);
      const [lockedWorkspace] = await transaction
        .select({ setupCompletedAt: workspaces.setupCompletedAt })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (lockedWorkspace?.setupCompletedAt) return this.#projection(lockedWorkspace.setupCompletedAt);

      const [lockedAgent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId), eq(agents.status, "active")))
        .limit(1)
        .for("update");
      if (!lockedAgent) {
        throw new WorkspaceSetupServiceError(
          "WORKSPACE_SETUP_AGENT_NOT_FOUND",
          404,
          "The active setup Agent was not found in this Workspace",
        );
      }

      const completedAt = this.#now();
      const [completed] = await transaction
        .update(workspaces)
        .set({ setupCompletedAt: completedAt, updatedAt: completedAt })
        .where(eq(workspaces.id, workspaceId))
        .returning({ setupCompletedAt: workspaces.setupCompletedAt });
      if (!completed?.setupCompletedAt) throw new Error("Workspace setup completion did not return a timestamp");
      return this.#projection(completed.setupCompletedAt);
    });
  }

  #projection(setupCompletedAt: Date): WorkspaceSetupCompletion {
    return { setupCompletedAt: setupCompletedAt.toISOString() };
  }
}
