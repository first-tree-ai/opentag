import { randomUUID } from "node:crypto";
import type {
  AccountCloudComputerEnsureResponse,
  ComputerRegisterFrame,
  ListAccountComputersResponse,
  MeResponse,
} from "@opentag/shared";
import { and, asc, eq, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computerCredentials, computers, imBindings } from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import { lockActiveAccount } from "./account-lock.js";
import {
  CLOUD_COMPUTER_ARCH,
  CLOUD_COMPUTER_DISPLAY_NAME,
  CLOUD_COMPUTER_PLATFORM,
  projectAccountComputerSummary,
  projectCloudComputerEnsure,
} from "./cloud-computer.js";
import type { ComputerAuthContext } from "./machine-auth-service.js";
import { rejectUnsupportedClientVersion } from "./machine-auth-service.js";
import type { ProviderReadinessSource } from "./provider-readiness.js";

export interface ActiveUserResolver {
  getActiveUserById(userId: string): Promise<MeResponse>;
}

export interface ComputerServiceOptions {
  now?: () => Date;
  presenceTimeoutMs?: number;
  providerReadiness?: ProviderReadinessSource;
  cloudIdentities?: { enabled: boolean; runnerVersion?: string };
}

export class ComputerService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;
  readonly #cloudIdentities: { enabled: boolean; runnerVersion?: string };

  constructor(database: DatabaseClient, _auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
    this.#cloudIdentities = options.cloudIdentities ?? { enabled: false };
  }

  /**
   * First-setup Provider CLI prewarm eligibility for one exact Computer: at least one active Agent
   * bound to this Computer has no current messaging setup. Every im_bindings row whose status is
   * not "disabled" - provisioning, active, reauthorization_required, or error - is a current
   * messaging setup, while a disabled row is history and never gates a fresh setup. The Account's
   * setup_completed_at says nothing about this Computer's Agents, so it is not consulted here.
   */
  async hasActiveAgentWithoutMessagingSetup(computerId: string): Promise<boolean> {
    const [row] = await this.#database
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.computerId, computerId),
          eq(agents.status, "active"),
          notExists(
            this.#database
              .select({ id: imBindings.id })
              .from(imBindings)
              .where(and(eq(imBindings.agentId, agents.id), ne(imBindings.status, "disabled"))),
          ),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  async listAccountComputers(
    accountId: string,
    includeProviderReadiness = false,
    includeCloudIdentities = false,
  ): Promise<ListAccountComputersResponse> {
    const rows = await this.#database
      .select({ computer: computers, agentId: agents.id })
      .from(computers)
      .leftJoin(
        computerCredentials,
        and(eq(computerCredentials.computerId, computers.id), isNull(computerCredentials.revokedAt)),
      )
      .leftJoin(
        agents,
        and(eq(agents.computerId, computers.id), eq(agents.createdByUserId, accountId), ne(agents.status, "deleted")),
      )
      .where(and(eq(computers.ownerAccountId, accountId), visibleAccountComputer(includeCloudIdentities)))
      .orderBy(asc(computers.displayName), asc(computers.id), asc(agents.id));
    const observedAt = this.#now();
    const presenceCutoffMs = observedAt.getTime() - this.#presenceTimeoutMs;
    const byId = new Map<string, ListAccountComputersResponse["computers"][number]>();
    for (const row of rows) {
      const existing = byId.get(row.computer.id);
      if (existing) {
        if (row.agentId) existing.agentIds.push(row.agentId);
        continue;
      }
      byId.set(
        row.computer.id,
        projectAccountComputerSummary({
          computer: row.computer,
          agentIds: row.agentId ? [row.agentId] : [],
          includeCloudIdentities,
          includeProviderReadiness,
          observedAt,
          presenceCutoffMs,
          providerReadiness: this.#providerReadiness,
        }),
      );
    }
    return { computers: [...byId.values()] };
  }

  async ensureCloudComputerForAccount(accountId: string): Promise<AccountCloudComputerEnsureResponse> {
    if (!this.#cloudIdentities.enabled) throw cloudIdentitiesNotOffered();
    const runnerVersion = this.#cloudIdentities.runnerVersion;
    if (!runnerVersion) throw new Error("Cloud identities are enabled without a Runner version");
    return this.#database.transaction(async (transaction) => {
      await lockActiveAccount(transaction, accountId);
      const existing = await this.#findOwnedCloudComputer(transaction, accountId);
      if (existing) return projectCloudComputerEnsure(existing);
      const now = this.#now();
      const [created] = await transaction
        .insert(computers)
        .values({
          ownerAccountId: accountId,
          kind: "cloud",
          currentInstallationId: randomUUID(),
          displayName: CLOUD_COMPUTER_DISPLAY_NAME,
          platform: CLOUD_COMPUTER_PLATFORM,
          arch: CLOUD_COMPUTER_ARCH,
          clientVersion: runnerVersion,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: computers.ownerAccountId, where: sql`${computers.kind} = 'cloud'` })
        .returning();
      const converged = created ?? (await this.#findOwnedCloudComputer(transaction, accountId));
      if (!converged) throw new Error("Cloud Computer ensure did not converge");
      return projectCloudComputerEnsure(converged);
    });
  }

  async #findOwnedCloudComputer(executor: DatabaseTransaction | DatabaseClient, accountId: string) {
    const [row] = await executor
      .select()
      .from(computers)
      .where(and(eq(computers.ownerAccountId, accountId), eq(computers.kind, "cloud")))
      .limit(1);
    return row;
  }

  async register(context: ComputerAuthContext, frame: ComputerRegisterFrame): Promise<void> {
    rejectUnsupportedClientVersion(frame.clientVersion);
    if (frame.installationId !== context.installationId) {
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
        .update(computers)
        .set(observation)
        .where(
          and(
            eq(computers.id, context.computerId),
            eq(computers.currentInstallationId, context.installationId),
            eq(computers.kind, "local"),
          ),
        )
        .returning({ id: computers.id });
      if (updated.length !== 1) throw unavailableComputer();
    });
  }

  async heartbeat(context: ComputerAuthContext, instanceId: string): Promise<boolean> {
    const now = this.#now();
    return this.#database.transaction(async (transaction) => {
      await this.#lockActiveCredential(transaction, context);
      const updated = await transaction
        .update(computers)
        .set({ lastSeenAt: now, updatedAt: now })
        .where(
          and(
            eq(computers.id, context.computerId),
            eq(computers.currentInstallationId, context.installationId),
            eq(computers.currentInstanceId, instanceId),
            eq(computers.kind, "local"),
          ),
        )
        .returning({ id: computers.id });
      return updated.length === 1;
    });
  }

  async assertActiveCredential(context: ComputerAuthContext): Promise<void> {
    await this.#database.transaction((transaction) => this.#lockActiveCredential(transaction, context));
  }

  async disconnect(computerId: string, instanceId: string): Promise<boolean> {
    const now = this.#now();
    const updated = await this.#database
      .update(computers)
      .set({
        currentInstanceId: null,
        connectedAt: null,
        lastSeenAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(computers.id, computerId), eq(computers.currentInstanceId, instanceId), eq(computers.kind, "local")),
      )
      .returning({ id: computers.id });
    return updated.length === 1;
  }

  async #lockActiveCredential(transaction: DatabaseTransaction, context: ComputerAuthContext): Promise<void> {
    const [computer] = await transaction
      .select({ id: computers.id })
      .from(computers)
      .where(and(eq(computers.id, context.computerId), eq(computers.kind, "local")))
      .limit(1)
      .for("update");
    if (!computer) throw unavailableComputer();
    const [active] = await transaction
      .select({ id: computerCredentials.id })
      .from(computerCredentials)
      .innerJoin(computers, eq(computers.id, computerCredentials.computerId))
      .where(
        and(
          eq(computerCredentials.id, context.credentialId),
          eq(computers.id, context.computerId),
          eq(computers.currentInstallationId, context.installationId),
          eq(computers.kind, "local"),
          isNull(computerCredentials.revokedAt),
        ),
      )
      .limit(1);
    if (!active) throw unavailableComputer();
  }
}

function visibleAccountComputer(includeCloudIdentities: boolean) {
  const localWithCredential = and(eq(computers.kind, "local"), isNotNull(computerCredentials.id));
  return includeCloudIdentities ? or(localWithCredential, eq(computers.kind, "cloud")) : localWithCredential;
}

function unavailableComputer(): AuthServiceError {
  return new AuthServiceError(
    "COMPUTER_NOT_REGISTERED",
    "deterministic",
    "The Computer credential is no longer active",
    409,
  );
}

function cloudIdentitiesNotOffered(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
