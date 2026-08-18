import type { Computer, ComputerRegisterFrame, ListComputersResponse, MeResponse } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { computers } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";

export interface ActiveUserResolver {
  getActiveUserById(userId: string): Promise<MeResponse>;
}

export interface ComputerServiceOptions {
  now?: () => Date;
  presenceTimeoutMs?: number;
}

export class ComputerService {
  readonly #auth: ActiveUserResolver;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;

  constructor(database: DatabaseClient, auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#auth = auth;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
  }

  async register(userId: string, frame: ComputerRegisterFrame): Promise<void> {
    await this.#auth.getActiveUserById(userId);
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
    await this.#auth.getActiveUserById(userId);
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

  async listForUser(userId: string): Promise<ListComputersResponse> {
    await this.#auth.getActiveUserById(userId);
    const rows = await this.#database.select().from(computers).where(eq(computers.ownerUserId, userId));
    const freshnessCutoff = this.#now().getTime() - this.#presenceTimeoutMs;
    return {
      computers: rows.map(
        (row): Computer => ({
          id: row.id,
          ownerUserId: row.ownerUserId,
          displayName: row.displayName,
          platform: row.platform,
          arch: row.arch,
          clientVersion: row.clientVersion,
          connectionStatus:
            row.currentInstanceId !== null && row.lastSeenAt.getTime() >= freshnessCutoff ? "online" : "offline",
          connectedAt: row.connectedAt?.toISOString() ?? null,
          lastSeenAt: row.lastSeenAt.toISOString(),
        }),
      ),
    };
  }
}
