import { randomUUID } from "node:crypto";
import type {
  AccountCloudComputerEnsureResponse,
  ComputerRegisterFrame,
  ListAccountComputersResponse,
  MeResponse,
} from "@opentag/shared";
import { and, asc, eq, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computerConnectCodes, computerCredentials, computers, imBindings } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
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
  /**
   * Deployment-injected Cloud control validity hook, invoked for every Cloud credential use.
   * It must re-verify the authenticated control credential (`isActive`) against the deployment
   * authority. Cloud registration/heartbeat fails closed when the hook is missing or rejects.
   */
  assertCloudControlCredential?: (context: ComputerAuthContext) => Promise<void> | void;
  /**
   * Runs after a Computer deletion commits, so a live runtime connection can be closed. The service
   * treats it as best-effort: the deletion is already durable, so a failing hook is logged and never
   * turns a committed deletion into an error.
   */
  onComputerDeleted?: (computerId: string) => Promise<void> | void;
  logger?: ServiceLogger;
}

export interface DeletedComputer {
  computerId: string;
  revokedCredentialCount: number;
}

export class ComputerService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #presenceTimeoutMs: number;
  readonly #providerReadiness?: ProviderReadinessSource;
  readonly #cloudIdentities: { enabled: boolean; runnerVersion?: string };
  readonly #assertCloudControlCredential?: (context: ComputerAuthContext) => Promise<void> | void;
  readonly #onComputerDeleted?: (computerId: string) => Promise<void> | void;
  readonly #logger?: ServiceLogger;

  constructor(database: DatabaseClient, _auth: ActiveUserResolver, options: ComputerServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#presenceTimeoutMs = options.presenceTimeoutMs ?? 90_000;
    this.#providerReadiness = options.providerReadiness;
    this.#cloudIdentities = options.cloudIdentities ?? { enabled: false };
    this.#assertCloudControlCredential = options.assertCloudControlCredential;
    this.#onComputerDeleted = options.onComputerDeleted;
    this.#logger = options.logger;
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

  /**
   * Retires one Local Computer the Account owns. The row is kept (Agents, Session placements and credential
   * history reference it), but every active credential and pending repair code is revoked, so any later
   * request signed with the old machine token fails authentication with 401. A Computer that still hosts
   * Agents is refused: those Agents must be moved or deleted first, never silently unbound.
   */
  async deleteComputer(accountId: string, computerId: string): Promise<DeletedComputer> {
    const now = this.#now();
    const deleted = await this.#database.transaction(async (transaction) => {
      await lockActiveAccount(transaction, accountId);
      const [computer] = await transaction
        .select({ id: computers.id, kind: computers.kind })
        .from(computers)
        .where(and(eq(computers.id, computerId), eq(computers.ownerAccountId, accountId), isNull(computers.deletedAt)))
        .limit(1)
        .for("update");
      if (!computer) throw computerNotFound();
      if (computer.kind !== "local") {
        throw new AuthServiceError(
          "COMPUTER_NOT_DELETABLE",
          "deterministic",
          "Only a Local Computer can be deleted",
          409,
        );
      }
      const bound = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.computerId, computerId), ne(agents.status, "deleted")));
      if (bound.length > 0) {
        throw new AuthServiceError(
          "COMPUTER_IN_USE",
          "deterministic",
          `This Computer still hosts ${bound.length} Agent(s); move or delete them before deleting the Computer`,
          409,
        );
      }
      const revoked = await transaction
        .update(computerCredentials)
        .set({ revokedByUserId: accountId, revokedAt: now })
        .where(and(eq(computerCredentials.computerId, computerId), isNull(computerCredentials.revokedAt)))
        .returning({ id: computerCredentials.id });
      /*
       * Redemption locks its connect-code row before the Account (exchangeConnectCode), while this
       * transaction already holds the Account. Waiting on a code row here would close that cycle into a
       * deadlock, so only codes nobody holds are revoked. A skipped code belongs to an in-flight
       * redemption, which queues on the Account and then finds this Computer deleted: it fails with
       * AUTH_INVALID_CODE and can never revive it.
       */
      const idleCodes = await transaction
        .select({ id: computerConnectCodes.id })
        .from(computerConnectCodes)
        .where(
          and(
            eq(computerConnectCodes.targetComputerId, computerId),
            isNull(computerConnectCodes.consumedAt),
            isNull(computerConnectCodes.revokedAt),
          ),
        )
        .for("update", { skipLocked: true });
      if (idleCodes.length > 0) {
        await transaction
          .update(computerConnectCodes)
          .set({ revokedByUserId: accountId, revokedAt: now })
          .where(
            inArray(
              computerConnectCodes.id,
              idleCodes.map((code) => code.id),
            ),
          );
      }
      await transaction
        .update(computers)
        .set({ deletedAt: now, currentInstanceId: null, connectedAt: null, updatedAt: now })
        .where(eq(computers.id, computerId));
      return { computerId, revokedCredentialCount: revoked.length };
    });
    this.#logger?.info({ accountId, ...deleted }, "Computer deleted");
    try {
      await this.#onComputerDeleted?.(computerId);
    } catch (error) {
      this.#logger?.warn({ computerId, err: error }, "Post-deletion hook failed; the Computer stays deleted");
    }
    return deleted;
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
            eq(computers.kind, context.kind ?? "local"),
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
            eq(computers.kind, context.kind ?? "local"),
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
      .where(and(eq(computers.id, computerId), eq(computers.currentInstanceId, instanceId)))
      .returning({ id: computers.id });
    return updated.length === 1;
  }

  async #lockActiveCredential(transaction: DatabaseTransaction, context: ComputerAuthContext): Promise<void> {
    const kind = context.kind ?? "local";
    const [computer] = await transaction
      .select({ id: computers.id })
      .from(computers)
      .where(and(eq(computers.id, context.computerId), eq(computers.kind, kind), isNull(computers.deletedAt)))
      .limit(1)
      .for("update");
    if (!computer) throw unavailableComputer();
    if (kind === "cloud") {
      /*
       * Cloud control connections have no `computer_credentials` row: their credential is the
       * deployment-issued control secret verified at auth time. The row lock plus installation
       * match below fences the logical Cloud Computer; rotation is deployment-side and a replaced
       * control connection loses every execution through the registry fence.
       */
      const [cloudComputer] = await transaction
        .select({ id: computers.id })
        .from(computers)
        .where(and(eq(computers.id, context.computerId), eq(computers.currentInstallationId, context.installationId)))
        .limit(1);
      if (!cloudComputer) throw unavailableComputer();
      if (!this.#assertCloudControlCredential) throw unavailableComputer();
      await this.#assertCloudControlCredential(context);
      return;
    }
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
  const visibleKind = includeCloudIdentities
    ? or(localWithCredential, eq(computers.kind, "cloud"))
    : localWithCredential;
  return and(isNull(computers.deletedAt), visibleKind);
}

function computerNotFound(): AuthServiceError {
  return new AuthServiceError("COMPUTER_NOT_FOUND", "deterministic", "The requested Computer was not found", 404);
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
