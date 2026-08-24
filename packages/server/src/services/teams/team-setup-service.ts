import type { TeamSetupCompletion } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, teams } from "../../db/schema/index.js";
import type { ImBindingService } from "../im-bindings/index.js";
import type { TeamMembershipService } from "./team-membership-service.js";

export class TeamSetupServiceError extends Error {
  readonly category = "deterministic" as const;

  constructor(
    readonly code: "TEAM_SETUP_AGENT_NOT_FOUND" | "TEAM_SETUP_NOT_READY",
    readonly statusCode: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "TeamSetupServiceError";
  }
}

/** Owns the one-way transition from first-time setup into normal operations. */
export class TeamSetupService {
  readonly #database: DatabaseClient;
  readonly #imBindings: ImBindingService;
  readonly #memberships: TeamMembershipService;
  readonly #now: () => Date;

  constructor(
    database: DatabaseClient,
    memberships: TeamMembershipService,
    imBindings: ImBindingService,
    options: { now?: () => Date } = {},
  ) {
    this.#database = database;
    this.#memberships = memberships;
    this.#imBindings = imBindings;
    this.#now = options.now ?? (() => new Date());
  }

  async complete(callerUserId: string, teamId: string, agentId: string): Promise<TeamSetupCompletion> {
    await this.#memberships.requireActiveMembership(this.#database, callerUserId, teamId, "admin");
    const [current] = await this.#database
      .select({ setupCompletedAt: teams.setupCompletedAt })
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);
    if (current?.setupCompletedAt) return this.#projection(current.setupCompletedAt);

    const [agent] = await this.#database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.teamId, teamId), eq(agents.status, "active")))
      .limit(1);
    if (!agent) {
      throw new TeamSetupServiceError(
        "TEAM_SETUP_AGENT_NOT_FOUND",
        404,
        "The active setup Agent was not found in this Team",
      );
    }

    const handoff = await this.#imBindings.getHandoffForAgent(callerUserId, agentId);
    if (!handoff?.handoffReady) {
      throw new TeamSetupServiceError(
        "TEAM_SETUP_NOT_READY",
        409,
        "The Agent handoff is not ready to complete Team setup",
      );
    }

    return this.#database.transaction(async (transaction) => {
      await this.#memberships.requireActiveMembershipForMutation(transaction, callerUserId, teamId, "admin");
      const [lockedTeam] = await transaction
        .select({ setupCompletedAt: teams.setupCompletedAt })
        .from(teams)
        .where(eq(teams.id, teamId))
        .limit(1);
      if (lockedTeam?.setupCompletedAt) return this.#projection(lockedTeam.setupCompletedAt);

      const [lockedAgent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.teamId, teamId), eq(agents.status, "active")))
        .limit(1)
        .for("update");
      if (!lockedAgent) {
        throw new TeamSetupServiceError(
          "TEAM_SETUP_AGENT_NOT_FOUND",
          404,
          "The active setup Agent was not found in this Team",
        );
      }

      const completedAt = this.#now();
      const [completed] = await transaction
        .update(teams)
        .set({ setupCompletedAt: completedAt, updatedAt: completedAt })
        .where(eq(teams.id, teamId))
        .returning({ setupCompletedAt: teams.setupCompletedAt });
      if (!completed?.setupCompletedAt) throw new Error("Team setup completion did not return a timestamp");
      return this.#projection(completed.setupCompletedAt);
    });
  }

  #projection(setupCompletedAt: Date): TeamSetupCompletion {
    return { setupCompletedAt: setupCompletedAt.toISOString() };
  }
}
