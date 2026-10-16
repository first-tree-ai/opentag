import type { GitHubConnectionStatus } from "@opentag/shared";
import { getTableColumns } from "drizzle-orm";
import { githubConnections } from "../../db/schema/index.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";

export type GitHubConnectionRow = Omit<
  typeof githubConnections.$inferSelect,
  "repositoryBindings" | "bindingsSchemaVersion"
>;

/** Exclude retained legacy JSON even from internal credential/status reads. */
export function gitHubConnectionColumns() {
  const {
    repositoryBindings: _legacy,
    bindingsSchemaVersion: _version,
    ...columns
  } = getTableColumns(githubConnections);
  return columns;
}

/**
 * Maps a stored row to the nonsecret status DTO. Secret columns — credential ciphertext and key IDs,
 * the OAuth state hash, the encrypted OAuth slot, refresh claim internals — are never selected into
 * the DTO, so a read can never leak them by construction.
 */
export function toGitHubConnectionStatus(row: GitHubConnectionRow): GitHubConnectionStatus {
  return {
    id: row.id,
    accountId: row.accountId,
    githubHost: row.githubHost,
    appId: row.appId,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    status: row.status,
    authorizationVersion: row.authorizationVersion.toString(),
    credentialGeneration: row.credentialGeneration.toString(),
    accessExpiresAt: row.accessExpiresAt?.toISOString() ?? null,
    refreshExpiresAt: row.refreshExpiresAt?.toISOString() ?? null,
    recheckRequired: row.recheckRequired,
    nextRecheckAt: row.nextRecheckAt?.toISOString() ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastErrorCode: row.lastErrorCode,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Cross-account existence is not disclosed: a foreign row is simply "not found". */
export function requireOwnedConnection<T extends { accountId: string }>(row: T | undefined, accountId: string): T {
  if (!row || row.accountId !== accountId) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND,
      404,
      "The GitHub connection was not found",
    );
  }
  return row;
}
