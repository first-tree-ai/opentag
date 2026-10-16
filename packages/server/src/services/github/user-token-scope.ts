import { GitPublicationError } from "../github-proxy/git-packets.js";
import { GITHUB_API_CLIENT_ERROR_CODES, GitHubApiClientError } from "./github-api-client.js";
import type { GitHubExecutionUserCredential, GitHubUserTokenInput } from "./user-token-types.js";

const LEVELS = new Set<unknown>(["read", "write"]);
const KEYS = new Set(["contents", "pull_requests", "checks", "actions", "statuses"]);
const TOKEN = /^ghu_[A-Za-z0-9_]{1,4092}$/;
const CLEANUP_TOKEN = /^[-A-Za-z0-9._~+/]+=*$/;
// Expiring GitHub App user tokens have an eight-hour lifetime. Allow bounded clock skew;
// a derived credential's expiry is distinct from its parent's refresh schedule.
const MAX_LIFETIME_MS = 8 * 60 * 60 * 1_000 + 60_000;

export function tokenRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitPublicationError("scope_denied");
  return value as Record<string, unknown>;
}

export function validateUserTokenInput(input: GitHubUserTokenInput): number {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.fullName) ||
    input.fullName.includes("..") ||
    !/^[1-9]\d{0,18}$/.test(input.repositoryId) ||
    !/^[1-9]\d{0,18}$/.test(input.installationId) ||
    !/^github:[1-9]\d*$/.test(input.authorizationRevision) ||
    !input.accountId ||
    !input.connectionId
  )
    throw new GitPublicationError("invalid_request");
  const id = Number(input.repositoryId);
  if (!Number.isSafeInteger(id)) throw new GitPublicationError("invalid_request");
  const permissions = tokenRecord(input.permissions);
  if (!LEVELS.has(permissions.contents)) throw new GitPublicationError("invalid_request");
  for (const [key, value] of Object.entries(permissions)) {
    if (!KEYS.has(key) || !LEVELS.has(value) || (["checks", "actions", "statuses"].includes(key) && value !== "read"))
      throw new GitPublicationError("invalid_request");
  }
  return id;
}

/** A bounded token from the fixed scoped-token endpoint can be cleaned even if attestation fails. */
export function scopedTokenCandidate(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const token = (payload as Record<string, unknown>).token;
  return typeof token === "string" && token.length <= 4096 && CLEANUP_TOKEN.test(token) ? token : undefined;
}

/** Execution still requires an attested user token for this exact App/user. */
export function ownedScopedToken(payload: unknown, parent: GitHubExecutionUserCredential, clientId: string): string {
  const record = tokenRecord(payload);
  const user = tokenRecord(record.user);
  const app = tokenRecord(record.app);
  if (
    app.client_id !== clientId ||
    user.type !== "User" ||
    String(user.id) !== parent.githubUserId ||
    typeof record.token !== "string" ||
    !TOKEN.test(record.token) ||
    record.token === parent.accessToken
  )
    throw new GitPublicationError("scope_denied");
  return record.token;
}

export function validateScopedToken(payload: unknown, input: GitHubUserTokenInput, now: number): Date {
  const record = tokenRecord(payload);
  const installation = tokenRecord(record.installation);
  const account = tokenRecord(installation.account);
  const permissions = tokenRecord(installation.permissions);
  if (
    typeof account.login !== "string" ||
    account.login.toLowerCase() !== input.fullName.split("/")[0]?.toLowerCase() ||
    (installation.repository_selection !== "selected" && installation.repository_selection !== "all")
  )
    throw new GitPublicationError("scope_denied");
  // Scope is the exact repository_ids request to the fixed, App-authenticated scoped-token endpoint.
  // The installation selection label and repository catalog do not describe a child token's scope.
  for (const [key, level] of Object.entries(input.permissions)) {
    if (permissions[key] !== level) throw new GitPublicationError("scope_denied");
  }
  for (const [key, level] of Object.entries(permissions)) {
    if (key === "metadata" && level === "read") continue;
    if (!Object.hasOwn(input.permissions, key) || level !== input.permissions[key as keyof typeof input.permissions])
      throw new GitPublicationError("scope_denied");
  }
  return parseScopedTokenExpiry(record.expires_at, now);
}

function parseScopedTokenExpiry(value: unknown, now: number): Date {
  if (value == null)
    throw new GitHubApiClientError(
      GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED,
      "The derived GitHub user token must have a finite expiry",
    );
  const expiry = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now + 5_000 || expiry - now > MAX_LIFETIME_MS)
    throw new GitPublicationError("scope_denied");
  return new Date(expiry);
}
