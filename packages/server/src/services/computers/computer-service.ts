import type { ComputerRegisterFrame, MeResponse } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  accountComputers,
  workspaceComputerCredentials,
  workspaceComputers,
  workspaces,
} from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import type { ComputerAuthContext } from "./machine-auth-service.js";

export interface ActiveUserResolver {
  getActiveUserById(userId: string): Promise<MeResponse>;
}

export interface ComputerServiceOptions {
  now?: () => Date;
}

export class ComputerService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, _auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
  }

  async register(context: ComputerAuthContext, frame: ComputerRegisterFrame): Promise<void> {
    if (frame.computerId !== context.computerId) {
      throw new AuthServiceError(
        "COMPUTER_IDENTITY_CONFLICT",
        "deterministic",
        "The Computer identity does not match the machine credential",
        409,
      );
    }
    const now = this.#now();
    await this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const observation = {
        displayName: frame.displayName,
        platform: frame.platform,
        arch: frame.arch,
        clientVersion: frame.clientVersion,
        currentInstanceId: frame.instanceId,
        connectedAt: now,
        lastSeenAt: now,
        updatedAt: now,
      };
      const updated = await transaction
        .update(workspaceComputers)
        .set(observation)
        .where(
          and(
            eq(workspaceComputers.id, context.workspaceComputerId),
            eq(workspaceComputers.workspaceId, context.workspaceId),
            eq(workspaceComputers.computerId, context.computerId),
            isNull(workspaceComputers.revokedAt),
          ),
        )
        .returning({ id: workspaceComputers.id });
      if (updated.length !== 1) throw unavailableEnrollment();
      await transaction
        .update(accountComputers)
        .set(observation)
        .where(eq(accountComputers.id, context.workspaceComputerId));
    });
  }

  async heartbeat(context: ComputerAuthContext, instanceId: string): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const heartbeat = { lastSeenAt: now, updatedAt: now };
      const updated = await transaction
        .update(workspaceComputers)
        .set(heartbeat)
        .where(
          and(
            eq(workspaceComputers.id, context.workspaceComputerId),
            eq(workspaceComputers.workspaceId, context.workspaceId),
            eq(workspaceComputers.computerId, context.computerId),
            eq(workspaceComputers.currentInstanceId, instanceId),
            isNull(workspaceComputers.revokedAt),
          ),
        )
        .returning({ id: workspaceComputers.id });
      if (updated.length !== 1) return false;
      await transaction
        .update(accountComputers)
        .set(heartbeat)
        .where(eq(accountComputers.id, context.workspaceComputerId));
      return true;
    });
  }

  async assertActiveCredential(context: ComputerAuthContext): Promise<void> {
    await this.#database.transaction((transaction) => this.#lockActiveCredential(transaction, context));
  }

  async disconnect(workspaceComputerId: string, instanceId: string): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      const disconnection = {
        currentInstanceId: null,
        connectedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      };
      const updated = await transaction
        .update(workspaceComputers)
        .set(disconnection)
        .where(
          and(eq(workspaceComputers.id, workspaceComputerId), eq(workspaceComputers.currentInstanceId, instanceId)),
        )
        .returning({ id: workspaceComputers.id });
      if (updated.length !== 1) return false;
      await transaction.update(accountComputers).set(disconnection).where(eq(accountComputers.id, workspaceComputerId));
      return true;
    });
  }

  async #lockActiveCredential(transaction: DatabaseTransaction, context: ComputerAuthContext): Promise<void> {
    const [workspace] = await transaction
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, context.workspaceId))
      .limit(1)
      .for("update");
    if (!workspace) throw unavailableEnrollment();
    const [active] = await transaction
      .select({ id: workspaceComputerCredentials.id })
      .from(workspaceComputerCredentials)
      .innerJoin(workspaceComputers, eq(workspaceComputers.id, workspaceComputerCredentials.workspaceComputerId))
      .where(
        and(
          eq(workspaceComputerCredentials.id, context.credentialId),
          eq(workspaceComputers.id, context.workspaceComputerId),
          eq(workspaceComputers.workspaceId, context.workspaceId),
          eq(workspaceComputers.computerId, context.computerId),
          isNull(workspaceComputerCredentials.revokedAt),
          isNull(workspaceComputers.revokedAt),
        ),
      )
      .limit(1);
    if (!active) throw unavailableEnrollment();
  }
}

function unavailableEnrollment(): AuthServiceError {
  return new AuthServiceError(
    "COMPUTER_NOT_REGISTERED",
    "deterministic",
    "The Computer enrollment credential is unavailable",
    409,
  );
}
