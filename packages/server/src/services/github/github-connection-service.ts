import {
  CreateGitHubConnectionRequestSchema,
  type GitHubConnectionStatus,
  GitHubDecimalIdSchema,
  GitHubLoginSessionHashSchema,
  type GitHubOAuthContext,
  type GitHubOAuthFlowIntent,
  GitHubOAuthFlowIntentSchema,
  GitHubOAuthReturnSurfaceSchema,
} from "@opentag/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { githubConnections } from "../../db/schema/index.js";
import {
  type GitHubCredentialFactory,
  type GitHubOAuthSecretFactory,
  type GitHubOAuthSecretSlot,
  sealOAuthSecret,
} from "./credentials.js";
import {
  GITHUB_CONNECTION_ERROR_CODES,
  GitHubConnectionServiceError,
  isGitHubConnectionUniqueViolation,
} from "./errors.js";
import { generateOAuthState } from "./hashes.js";
import { completeClaimedFlow, requireClaimedFlow, terminalClearingFields } from "./oauth-completion.js";
import { claimOAuthFlowContext, newOAuthFlowContext, oauthFlowIsExpired, parseOAuthFlowContext } from "./oauth-flow.js";
import { type GitHubConnectionRow, requireOwnedConnection, toGitHubConnectionStatus } from "./rows.js";
import { GITHUB_OAUTH_FLOW_TTL_MS, GITHUB_RECHECK_INTERVAL_MS } from "./timing.js";

const CURRENT_CONNECTION_STATES = ["pending", "active", "reauthorization_required"] as const;

export interface GitHubConnectionServiceOptions {
  now?: () => Date;
  oauthFlowTtlMs?: number;
  recheckIntervalMs?: number;
}

export interface GitHubAuthorizationFlowHandle {
  connectionId: string;
  flowId: string;
  /** The one-time OAuth state value. Returned exactly once; only its hash is persisted. */
  state: string;
  expiresAt: Date;
}

/** Internal: a claimed OAuth flow, including the encrypted PKCE slot for the callback processor. */
export interface ClaimedGitHubOAuthFlow {
  connectionId: string;
  accountId: string;
  flowId: string;
  intent: GitHubOAuthFlowIntent;
  expectedAuthorizationVersion: bigint;
  oauthSecret: GitHubOAuthSecretSlot | null;
}

/**
 * The proof the internal OAuth transport brings back after claiming a callback: the flow identity it
 * claimed, the login session binding, the authorization version it observed, the GitHub-attested user
 * identity, and the encrypted token payload. Nothing here is accepted from an unauthenticated caller.
 */
export interface GitHubOAuthCompletionProof {
  connectionId: string;
  flowId: string;
  stateHash: string;
  loginSessionHash: string;
  expectedAuthorizationVersion: bigint;
  githubUserId: string;
  githubLogin: string;
  credential: GitHubCredentialFactory;
}

export interface GitHubAuthorizationCompletion {
  connection: GitHubConnectionStatus;
  supersededConnectionId: string | null;
}

/**
 * The database-backed connection state machine: create/begin/claim/complete of OAuth flows and
 * disconnect. There is deliberately no generic row update; every transition is one guarded method.
 */
export class GitHubConnectionService {
  private readonly now: () => Date;
  private readonly oauthFlowTtlMs: number;
  private readonly recheckIntervalMs: number;

  constructor(
    private readonly database: DatabaseClient,
    options: GitHubConnectionServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.oauthFlowTtlMs = options.oauthFlowTtlMs ?? GITHUB_OAUTH_FLOW_TTL_MS;
    this.recheckIntervalMs = options.recheckIntervalMs ?? GITHUB_RECHECK_INTERVAL_MS;
  }

  async getConnectionStatus(accountId: string, connectionId: string): Promise<GitHubConnectionStatus> {
    const [row] = await this.database
      .select()
      .from(githubConnections)
      .where(eq(githubConnections.id, connectionId))
      .limit(1);
    return toGitHubConnectionStatus(requireOwnedConnection(row, accountId));
  }

  async getCurrentConnection(
    accountId: string,
    githubHost: string,
    appId: string,
  ): Promise<GitHubConnectionStatus | null> {
    const [row] = await this.database
      .select()
      .from(githubConnections)
      .where(
        and(
          eq(githubConnections.accountId, accountId),
          eq(githubConnections.githubHost, githubHost),
          eq(githubConnections.appId, appId),
          inArray(githubConnections.status, CURRENT_CONNECTION_STATES),
        ),
      )
      .limit(1);
    return row ? toGitHubConnectionStatus(row) : null;
  }

  /** Creates the pending row together with its one-time OAuth flow; the unique index arbitrates races. */
  async createConnection(
    accountId: string,
    input: {
      githubHost?: string;
      appId: string;
      returnSurface?: string;
      loginSessionHash: string;
      oauthSecret?: GitHubOAuthSecretFactory;
    },
  ): Promise<{ connection: GitHubConnectionStatus; flow: GitHubAuthorizationFlowHandle }> {
    const request = CreateGitHubConnectionRequestSchema.parse({
      githubHost: input.githubHost,
      appId: input.appId,
      returnSurface: input.returnSurface,
    });
    const loginSessionHash = GitHubLoginSessionHashSchema.parse(input.loginSessionHash);
    const connectionId = randomUUID();
    const now = this.now();
    const { state, stateHash } = generateOAuthState();
    const context = newOAuthFlowContext({
      intent: "create",
      loginSessionHash,
      returnSurface: request.returnSurface,
      expiresAt: new Date(now.getTime() + this.oauthFlowTtlMs),
    });
    const oauthSecret = sealOAuthSecret(input.oauthSecret, {
      connectionId,
      accountId,
      appId: request.appId,
      githubHost: request.githubHost,
      flowId: context.flowId,
    });
    try {
      const [row] = await this.database
        .insert(githubConnections)
        .values({
          id: connectionId,
          accountId,
          githubHost: request.githubHost,
          appId: request.appId,
          status: "pending",
          oauthStateHash: stateHash,
          oauthContext: context,
          oauthContextCiphertext: oauthSecret?.ciphertext ?? null,
          oauthContextKeyId: oauthSecret?.keyId ?? null,
        })
        .returning();
      if (!row) throw new Error("The GitHub connection insert returned no row");
      return { connection: toGitHubConnectionStatus(row), flow: flowHandle(row.id, context, state) };
    } catch (error) {
      if (isGitHubConnectionUniqueViolation(error, "github_connections_current_unique")) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.CONNECTION_CONFLICT,
          409,
          "A current GitHub connection already exists for this Account and GitHub App",
        );
      }
      throw error;
    }
  }

  /**
   * Begins a new flow on an existing row, explicitly voiding the previous OAuth flow. A live refresh
   * claim is left untouched: it remains single-consumption, and a late refresh write still fails its
   * attempt/generation CAS once activation rotates the credential generation.
   */
  async beginAuthorizationFlow(
    accountId: string,
    connectionId: string,
    input: {
      intent: GitHubOAuthFlowIntent;
      returnSurface?: string;
      loginSessionHash: string;
      oauthSecret?: GitHubOAuthSecretFactory;
    },
  ): Promise<GitHubAuthorizationFlowHandle> {
    const intent = GitHubOAuthFlowIntentSchema.parse(input.intent);
    const returnSurface = GitHubOAuthReturnSurfaceSchema.parse(input.returnSurface ?? "account-integrations");
    const loginSessionHash = GitHubLoginSessionHashSchema.parse(input.loginSessionHash);
    const now = this.now();
    const { state, stateHash } = generateOAuthState();
    const context = newOAuthFlowContext({
      intent,
      loginSessionHash,
      returnSurface,
      expiresAt: new Date(now.getTime() + this.oauthFlowTtlMs),
    });
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.id, connectionId))
        .for("update");
      const ownedRow = requireOwnedConnection(row, accountId);
      assertFlowIntentAllowed(intent, ownedRow);
      const oauthSecret = sealOAuthSecret(input.oauthSecret, {
        connectionId: ownedRow.id,
        accountId: ownedRow.accountId,
        appId: ownedRow.appId,
        githubHost: ownedRow.githubHost,
        flowId: context.flowId,
      });
      const [updated] = await transaction
        .update(githubConnections)
        .set({
          oauthStateHash: stateHash,
          oauthContext: context,
          oauthContextCiphertext: oauthSecret?.ciphertext ?? null,
          oauthContextKeyId: oauthSecret?.keyId ?? null,
          updatedAt: now,
        })
        .where(eq(githubConnections.id, ownedRow.id))
        .returning({ id: githubConnections.id });
      if (!updated) throw new Error("The GitHub connection disappeared while beginning a flow");
      return flowHandle(ownedRow.id, context, state);
    });
  }

  /**
   * Claims an OAuth callback against the persisted flow: state hash, login session, phase, and expiry
   * are all verified before the single in-flight flow moves to the claimed phase.
   */
  async claimOAuthCallback(input: { stateHash: string; loginSessionHash: string }): Promise<ClaimedGitHubOAuthFlow> {
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.oauthStateHash, input.stateHash))
        .for("update");
      if (!row) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
          409,
          "The OAuth flow is unknown or was already consumed",
        );
      }
      const now = this.now();
      const context = parseOAuthFlowContext(row.oauthContext);
      if (!context) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
          409,
          "The stored OAuth flow context is unreadable",
        );
      }
      if (oauthFlowIsExpired(context, now)) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_EXPIRED,
          410,
          "The OAuth flow expired",
        );
      }
      if (context.loginSessionHash !== input.loginSessionHash) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.OAUTH_SESSION_MISMATCH,
          403,
          "The OAuth callback does not belong to the login session that started it",
        );
      }
      if (context.phase !== "awaiting_callback") {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
          409,
          "The OAuth flow was already claimed",
        );
      }
      const [updated] = await transaction
        .update(githubConnections)
        .set({ oauthContext: claimOAuthFlowContext(context, now), updatedAt: now })
        .where(and(eq(githubConnections.id, row.id), eq(githubConnections.oauthStateHash, input.stateHash)))
        .returning({ id: githubConnections.id });
      if (!updated) throw new Error("The GitHub connection disappeared while claiming a flow");
      return {
        connectionId: row.id,
        accountId: row.accountId,
        flowId: context.flowId,
        intent: context.intent,
        expectedAuthorizationVersion: row.authorizationVersion,
        oauthSecret:
          row.oauthContextCiphertext !== null && row.oauthContextKeyId !== null
            ? { ciphertext: row.oauthContextCiphertext, keyId: row.oauthContextKeyId }
            : null,
      };
    });
  }

  /**
   * Consumes a claimed flow exactly once. A create flow activates the pending row; a reauthorization
   * must return the same GitHub user; an explicit replace with a new user atomically supersedes the
   * old row and creates a fresh connection without inherited bindings. A late callback after
   * disconnect or a concurrent change never resurrects the row.
   */
  async completeAuthorization(
    accountId: string,
    proof: GitHubOAuthCompletionProof,
  ): Promise<GitHubAuthorizationCompletion> {
    const githubUserId = GitHubDecimalIdSchema.parse(proof.githubUserId);
    if (typeof proof.githubLogin !== "string" || proof.githubLogin.length === 0 || proof.githubLogin.length > 100) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
        400,
        "The GitHub login is invalid",
      );
    }
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.id, proof.connectionId))
        .for("update");
      const ownedRow = requireOwnedConnection(row, accountId);
      const now = this.now();
      const context = requireClaimedFlow(ownedRow, proof, now);
      return completeClaimedFlow(transaction, ownedRow, context, proof, githubUserId, now, this.recheckIntervalMs);
    });
  }

  /**
   * Revokes a current connection: authorization version bumps, every secret/flow/claim clears, and
   * the local state fails closed. Repeated terminal disconnects are idempotent.
   */
  async disconnect(accountId: string, connectionId: string): Promise<GitHubConnectionStatus> {
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(githubConnections)
        .where(eq(githubConnections.id, connectionId))
        .for("update");
      const ownedRow = requireOwnedConnection(row, accountId);
      if (ownedRow.status === "revoked" || ownedRow.status === "superseded") {
        return toGitHubConnectionStatus(ownedRow);
      }
      const [updated] = await transaction
        .update(githubConnections)
        .set(terminalClearingFields(ownedRow, now, "revoked"))
        .where(eq(githubConnections.id, ownedRow.id))
        .returning();
      if (!updated) throw new Error("The GitHub connection disappeared during disconnect");
      return toGitHubConnectionStatus(updated);
    });
  }
}

function flowHandle(connectionId: string, context: GitHubOAuthContext, state: string): GitHubAuthorizationFlowHandle {
  return { connectionId, flowId: context.flowId, state, expiresAt: new Date(context.expiresAt) };
}

function assertFlowIntentAllowed(intent: GitHubOAuthFlowIntent, row: GitHubConnectionRow): void {
  const allowed =
    (intent === "create" && row.status === "pending") ||
    ((intent === "reauthorize" || intent === "replace") &&
      (row.status === "active" || row.status === "reauthorization_required"));
  if (!allowed) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID,
      409,
      `A ${intent} flow cannot begin while the connection is ${row.status}`,
    );
  }
}

import { randomUUID } from "node:crypto";
