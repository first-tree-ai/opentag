import { randomUUID } from "node:crypto";
import type { AccountSandboxEnsureRequest, AccountSandboxResponse } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import { agents, computers, imBindings, sandboxes, sessionPlacements, sessions } from "../../db/schema/index.js";
import { type SessionService, SessionServiceError } from "../sessions/index.js";
import { sandboxNotFound, sandboxScopeInvalid } from "./errors.js";
import { loadOwnedSandbox, type OwnedSandboxRow } from "./owned-sandbox.js";
import { sandboxStorageUri } from "./storage-uri.js";

export type { OwnedSandboxRow } from "./owned-sandbox.js";

export interface SandboxServiceOptions {
  now?: () => Date;
  cloudIdentities: { enabled: boolean; storageBase?: string };
  afterSessionEnsured?: () => Promise<void>;
}

export class SandboxService {
  readonly #database: DatabaseClient;
  readonly #sessions: SessionService;
  readonly #now: () => Date;
  readonly #cloudIdentities: { enabled: boolean; storageBase?: string };
  readonly #afterSessionEnsured?: () => Promise<void>;

  constructor(database: DatabaseClient, sessions: SessionService, options: SandboxServiceOptions) {
    this.#database = database;
    this.#sessions = sessions;
    this.#now = options.now ?? (() => new Date());
    this.#cloudIdentities = options.cloudIdentities;
    this.#afterSessionEnsured = options.afterSessionEnsured;
  }

  async ensureForAccount(accountId: string, input: AccountSandboxEnsureRequest): Promise<AccountSandboxResponse> {
    if (!this.#cloudIdentities.enabled) throw sandboxNotFound();
    const storageBase = this.#cloudIdentities.storageBase;
    if (!storageBase) throw new Error("Cloud identities are enabled without a storage base");
    return this.#database.transaction(async (transaction) => {
      const owned = await this.#lockOwnedCloudBinding(transaction, accountId, input.imBindingId);
      const ensured = await this.#ensureOwnedSession(transaction, input, owned.computerId);
      if (ensured.placement.computerId !== owned.computerId) throw sandboxNotFound();
      if (ensured.session.conversationKind !== input.conversationKind) throw sandboxScopeInvalid();
      await this.#afterSessionEnsured?.();
      const existing = await this.#sandboxBySession(transaction, ensured.session.id);
      if (existing) return toAccountSandbox(existing, owned.computerId);
      return this.#insertSandbox(transaction, ensured.session.id, owned.computerId, storageBase);
    });
  }

  /**
   * E8 collaboration ingress: the Sandbox row for an EXISTING internal Session (created through
   * SessionService.createInternalSessionWithMessage, never through the account-facing ensure).
   * The same ownership/authority chain as `ensureForAccount` applies; the Session must be an
   * active internal child of the Account's own Cloud Agent.
   */
  async ensureForInternalSession(accountId: string, sessionId: string): Promise<AccountSandboxResponse> {
    if (!this.#cloudIdentities.enabled) throw sandboxNotFound();
    const storageBase = this.#cloudIdentities.storageBase;
    if (!storageBase) throw new Error("Cloud identities are enabled without a storage base");
    return this.#database.transaction(async (transaction) => {
      const [session] = await transaction
        .select({ id: sessions.id, imBindingId: sessions.imBindingId, kind: sessions.kind })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), isNull(sessions.endedAt)))
        .limit(1);
      if (!session || session.kind !== "internal") throw sandboxNotFound();
      const owned = await this.#lockOwnedCloudBinding(transaction, accountId, session.imBindingId);
      const [placement] = await transaction
        .select({ computerId: sessionPlacements.computerId })
        .from(sessionPlacements)
        .where(eq(sessionPlacements.sessionId, session.id))
        .limit(1);
      if (placement?.computerId !== owned.computerId) throw sandboxNotFound();
      await this.#afterSessionEnsured?.();
      const existing = await this.#sandboxBySession(transaction, session.id);
      if (existing) return toAccountSandbox(existing, owned.computerId);
      return this.#insertSandbox(transaction, session.id, owned.computerId, storageBase);
    });
  }

  async getForAccount(accountId: string, sandboxId: string): Promise<AccountSandboxResponse> {
    const row = await this.#ownedSandbox(this.#database, accountId, sandboxId);
    if (!row) throw sandboxNotFound();
    return toAccountSandbox(row.sandbox, row.computerId);
  }

  async #lockOwnedCloudBinding(
    transaction: DatabaseTransaction,
    accountId: string,
    imBindingId: string,
  ): Promise<{ agentId: string; computerId: string }> {
    const [candidate] = await transaction
      .select({ agentId: agents.id })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(eq(imBindings.id, imBindingId))
      .limit(1);
    if (!candidate) throw sandboxNotFound();
    const [agent] = await transaction
      .select({
        id: agents.id,
        computerId: agents.computerId,
        createdByUserId: agents.createdByUserId,
        runtimeProvider: agents.runtimeProvider,
        status: agents.status,
      })
      .from(agents)
      .where(eq(agents.id, candidate.agentId))
      .limit(1)
      .for("update");
    if (!agent || agent.createdByUserId !== accountId || agent.status !== "active" || agent.runtimeProvider !== "pi") {
      throw sandboxNotFound();
    }
    // Lock order stays Agent -> binding -> Computer. Provider-driven disable never takes the Agent lock, so
    // without this FOR UPDATE it could commit between our Agent lock and Session insert and miss the still
    // uncommitted newly created Session, leaving it live behind a disabled binding.
    const [binding] = await transaction
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(and(eq(imBindings.id, imBindingId), eq(imBindings.agentId, agent.id), eq(imBindings.status, "active")))
      .limit(1)
      .for("update");
    if (!binding || !agent.computerId) throw sandboxNotFound();
    const [computer] = await transaction
      .select({ id: computers.id })
      .from(computers)
      .where(
        and(eq(computers.id, agent.computerId), eq(computers.ownerAccountId, accountId), eq(computers.kind, "cloud")),
      )
      .limit(1)
      .for("update");
    if (!computer) throw sandboxNotFound();
    return { agentId: agent.id, computerId: computer.id };
  }

  async #ensureOwnedSession(transaction: DatabaseTransaction, input: AccountSandboxEnsureRequest, computerId: string) {
    try {
      return await this.#sessions.ensureChatSessionInTransaction(transaction, {
        imBindingId: input.imBindingId,
        channelId: input.channelId,
        conversationKind: input.conversationKind,
        kind: input.kind,
        ...(input.kind === "thread" ? { threadKey: input.threadKey } : {}),
        computerId,
        now: this.#now(),
      });
    } catch (error) {
      throw mapSessionError(error);
    }
  }

  async #insertSandbox(
    transaction: DatabaseTransaction,
    sessionId: string,
    computerId: string,
    storageBase: string,
  ): Promise<AccountSandboxResponse> {
    const sandboxId = randomUUID();
    const now = this.#now();
    const [created] = await transaction
      .insert(sandboxes)
      .values({
        id: sandboxId,
        sessionId,
        storageUri: sandboxStorageUri(storageBase, sandboxId),
        lifecycle: "unallocated",
        lastActivityAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: sandboxes.sessionId })
      .returning();
    const converged = created ?? (await this.#sandboxBySession(transaction, sessionId));
    if (!converged) throw new Error("Sandbox ensure did not converge");
    return toAccountSandbox(converged, computerId);
  }

  async #sandboxBySession(executor: DatabaseTransaction | DatabaseClient, sessionId: string) {
    const [row] = await executor.select().from(sandboxes).where(eq(sandboxes.sessionId, sessionId)).limit(1);
    return row;
  }

  async #ownedSandbox(
    executor: DatabaseTransaction | DatabaseClient,
    accountId: string,
    sandboxId: string,
  ): Promise<OwnedSandboxRow | undefined> {
    return loadOwnedSandbox(executor, accountId, sandboxId);
  }
}

function toAccountSandbox(row: typeof sandboxes.$inferSelect, computerId: string): AccountSandboxResponse {
  return {
    sandboxId: row.id,
    sessionId: row.sessionId,
    computerId,
    storageUri: row.storageUri,
    lifecycle: row.lifecycle,
    environmentGeneration: row.environmentGeneration,
    currentResourceName: row.currentResourceName,
    currentResourceUid: row.currentResourceUid,
    currentOperationName: row.currentOperationName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapSessionError(error: unknown): unknown {
  if (!(error instanceof SessionServiceError)) return error;
  if (error.code === "SESSION_SCOPE_INVALID") return sandboxScopeInvalid();
  return sandboxNotFound();
}
