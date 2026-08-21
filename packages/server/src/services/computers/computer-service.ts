import type { Computer, ComputerRegisterFrame, ListComputersResponse, MeResponse } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
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
}

export class ComputerService {
  readonly #auth: ActiveUserResolver;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;

  constructor(database: DatabaseClient, auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#auth = auth;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
  }

  /**
   * A Computer is only meaningful inside a Team. A session can legitimately hold no membership while the
   * user has yet to create or join one, so membership is asserted here instead of inferred from the session.
   */
  async #requireTeamMember(userId: string): Promise<void> {
    const me = await this.#auth.getActiveUserById(userId);
    if (me.memberships.length === 0) {
      throw new AuthServiceError(
        "AUTH_MEMBERSHIP_REQUIRED",
        "deterministic",
        "An active team membership is required",
        403,
      );
    }
  }

  async register(userId: string, frame: ComputerRegisterFrame): Promise<void> {
    await this.#requireTeamMember(userId);
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      await transaction
        .insert(computers)
        .values({
          id: frame.computerId,
          ownerUserId: userId,
          displayName: frame.displayName,
          platform: frame.platform,
          arch: frame.arch,
          clientVersion: frame.clientVersion,
          currentInstanceId: frame.instanceId,
          connectedAt: now,
          lastSeenAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: computers.id });

      const [existing] = await transaction.select().from(computers).where(eq(computers.id, frame.computerId)).limit(1);
      if (!existing || existing.ownerUserId !== userId) {
        throw new AuthServiceError(
          "COMPUTER_IDENTITY_CONFLICT",
          "deterministic",
          "The Computer identity belongs to another user",
          409,
        );
      }

      await transaction
        .update(computers)
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
        .where(and(eq(computers.id, frame.computerId), eq(computers.ownerUserId, userId)));
    });
  }

  async heartbeat(userId: string, computerId: string, instanceId: string): Promise<boolean> {
    await this.#requireTeamMember(userId);
    const now = this.#now();
    const updated = await this.#database
      .update(computers)
      .set({ lastSeenAt: now, updatedAt: now })
      .where(
        and(
          eq(computers.id, computerId),
          eq(computers.ownerUserId, userId),
          eq(computers.currentInstanceId, instanceId),
        ),
      )
      .returning({ id: computers.id });
    return updated.length === 1;
  }

  async disconnect(computerId: string, instanceId: string): Promise<boolean> {
    const now = this.#now();
    const updated = await this.#database
      .update(computers)
      .set({ currentInstanceId: null, connectedAt: null, lastSeenAt: now, updatedAt: now })
      .where(and(eq(computers.id, computerId), eq(computers.currentInstanceId, instanceId)))
      .returning({ id: computers.id });
    return updated.length === 1;
  }

  async listForUser(userId: string, includeProviderReadiness = false): Promise<ListComputersResponse> {
    await this.#requireTeamMember(userId);
    const rows = await this.#database.select().from(computers).where(eq(computers.ownerUserId, userId));
    const observedAt = this.#now();
    const freshnessCutoff = observedAt.getTime() - this.#presenceTimeoutMs;
    return {
      computers: rows.map((row): Computer => {
        const connectionStatus =
          row.currentInstanceId !== null && row.lastSeenAt.getTime() >= freshnessCutoff ? "online" : "offline";
        return {
          id: row.id,
          ownerUserId: row.ownerUserId,
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
          lastSeenAt: row.lastSeenAt.toISOString(),
        };
      }),
    };
  }
}
