import type { GitHubOAuthContext } from "@opentag/shared";
import { eq } from "drizzle-orm";
import type { DatabaseTransaction } from "../../db/client.js";
import { githubConnections } from "../../db/schema/index.js";
import { sealUserCredential } from "./credentials.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import type { GitHubAuthorizationCompletion, GitHubOAuthCompletionProof } from "./github-connection-service.js";
import { oauthFlowIsExpired, parseOAuthFlowContext } from "./oauth-flow.js";
import { type GitHubConnectionRow, toGitHubConnectionStatus } from "./rows.js";

const CLEARED_OAUTH_SLOT = {
  oauthStateHash: null,
  oauthContext: null,
  oauthContextCiphertext: null,
  oauthContextKeyId: null,
} as const;

/**
 * Applies a verified claimed flow: a create flow activates the pending row; a reauthorization must
 * return the same GitHub user (a same-user replace is one); an explicit replace with a new user
 * atomically supersedes the old row and creates a fresh connection without inherited bindings.
 */
export async function completeClaimedFlow(
  transaction: DatabaseTransaction,
  row: GitHubConnectionRow,
  context: GitHubOAuthContext,
  proof: GitHubOAuthCompletionProof,
  githubUserId: string,
  now: Date,
  recheckIntervalMs: number,
): Promise<GitHubAuthorizationCompletion> {
  if (context.intent === "create") {
    if (row.status !== "pending") {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID,
        409,
        "A create flow cannot complete while the connection is not pending",
      );
    }
    const activated = await activateConnectionRow(transaction, row, proof, now, recheckIntervalMs);
    return { connection: toGitHubConnectionStatus(activated), supersededConnectionId: null };
  }
  if (row.status !== "active" && row.status !== "reauthorization_required") {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID,
      409,
      "The connection is no longer current",
    );
  }
  const sameUser = row.githubUserId === githubUserId;
  if (context.intent === "reauthorize" || sameUser) {
    if (!sameUser) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.IDENTITY_MISMATCH,
        409,
        "Reauthorization returned a different GitHub user; begin an explicit replace flow",
      );
    }
    const activated = await activateConnectionRow(transaction, row, proof, now, recheckIntervalMs);
    return { connection: toGitHubConnectionStatus(activated), supersededConnectionId: null };
  }
  const connectionId = randomUUID();
  const credential = sealUserCredential(proof.credential, row, connectionId, githubUserId, now);
  await transaction
    .update(githubConnections)
    .set(terminalClearingFields(row, now, "superseded"))
    .where(eq(githubConnections.id, row.id));
  const [created] = await transaction
    .insert(githubConnections)
    .values({
      id: connectionId,
      accountId: row.accountId,
      githubHost: row.githubHost,
      appId: row.appId,
      status: "active",
      githubUserId,
      githubLogin: proof.githubLogin,
      repositoryBindings: [],
      credentialCiphertext: credential.ciphertext,
      credentialKeyId: credential.keyId,
      accessExpiresAt: credential.accessExpiresAt,
      refreshExpiresAt: credential.refreshExpiresAt,
      authorizationVersion: 1n,
      credentialGeneration: 1n,
      nextRecheckAt: new Date(now.getTime() + recheckIntervalMs),
      lastVerifiedAt: now,
    })
    .returning();
  if (!created) throw new Error("The replacement GitHub connection insert returned no row");
  return { connection: toGitHubConnectionStatus(created), supersededConnectionId: row.id };
}

/** All guards binding a completion to the exact claimed flow, session, and observed version. */
export function requireClaimedFlow(
  row: GitHubConnectionRow,
  proof: GitHubOAuthCompletionProof,
  now: Date,
): GitHubOAuthContext {
  if (row.oauthStateHash !== proof.stateHash) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
      409,
      "The OAuth flow is no longer current on this connection",
    );
  }
  const context = parseOAuthFlowContext(row.oauthContext);
  if (!context || context.flowId !== proof.flowId) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
      409,
      "The OAuth flow does not match",
    );
  }
  if (oauthFlowIsExpired(context, now)) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_EXPIRED,
      410,
      "The OAuth flow expired",
    );
  }
  if (context.loginSessionHash !== proof.loginSessionHash) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.OAUTH_SESSION_MISMATCH,
      403,
      "The OAuth completion does not belong to the login session that started it",
    );
  }
  if (context.phase !== "claimed") {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
      409,
      "The OAuth flow was not claimed for completion",
    );
  }
  if (row.authorizationVersion !== proof.expectedAuthorizationVersion) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT,
      409,
      "The connection changed while authorization was in flight",
    );
  }
  return context;
}

async function activateConnectionRow(
  transaction: DatabaseTransaction,
  row: GitHubConnectionRow,
  proof: GitHubOAuthCompletionProof,
  now: Date,
  recheckIntervalMs: number,
): Promise<GitHubConnectionRow> {
  const credential = sealUserCredential(proof.credential, row, row.id, proof.githubUserId, now);
  const [updated] = await transaction
    .update(githubConnections)
    .set({
      status: "active",
      githubUserId: proof.githubUserId,
      githubLogin: proof.githubLogin,
      credentialCiphertext: credential.ciphertext,
      credentialKeyId: credential.keyId,
      accessExpiresAt: credential.accessExpiresAt,
      refreshExpiresAt: credential.refreshExpiresAt,
      authorizationVersion: row.authorizationVersion + 1n,
      credentialGeneration: row.credentialGeneration + 1n,
      ...CLEARED_OAUTH_SLOT,
      refreshAttemptId: null,
      refreshClaimUntil: null,
      refreshStatus: "idle",
      recheckRequired: false,
      nextRecheckAt: new Date(now.getTime() + recheckIntervalMs),
      lastVerifiedAt: now,
      lastErrorCode: null,
      updatedAt: now,
    })
    .where(eq(githubConnections.id, row.id))
    .returning();
  if (!updated) throw new Error("The GitHub connection disappeared during activation");
  return updated;
}

/** Terminal states clear credentials, token expiries, the OAuth slot, and any refresh claim. */
export function terminalClearingFields(row: GitHubConnectionRow, now: Date, status: "revoked" | "superseded") {
  return {
    status,
    authorizationVersion: row.authorizationVersion + 1n,
    credentialCiphertext: null,
    credentialKeyId: null,
    accessExpiresAt: null,
    refreshExpiresAt: null,
    ...CLEARED_OAUTH_SLOT,
    refreshAttemptId: null,
    refreshClaimUntil: null,
    refreshStatus: "idle" as const,
    nextRecheckAt: null,
    recheckRequired: false,
    updatedAt: now,
  };
}

import { randomUUID } from "node:crypto";
