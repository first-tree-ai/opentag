import { GitPublicationError } from "../github-proxy/git-packets.js";
import type { GitHubExecutionUserCredential, GitHubUserTokenInput } from "./user-token-types.js";

const LEVELS = new Set<unknown>(["read", "write"]);
const KEYS = new Set(["contents", "pull_requests", "checks", "actions"]);
const TOKEN = /^ghu_[A-Za-z0-9_]{1,4092}$/;

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
    if (!KEYS.has(key) || !LEVELS.has(value) || ((key === "checks" || key === "actions") && value !== "read"))
      throw new GitPublicationError("invalid_request");
  }
  return id;
}

/** Only an attested token for this exact App/user may enter cleanup; never revoke the parent. */
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

export function validateScopedToken(
  payload: unknown,
  input: GitHubUserTokenInput,
  parent: GitHubExecutionUserCredential,
  now: number,
): Date {
  const record = tokenRecord(payload);
  const installation = tokenRecord(record.installation);
  const account = tokenRecord(installation.account);
  const permissions = tokenRecord(installation.permissions);
  if (
    typeof account.login !== "string" ||
    account.login.toLowerCase() !== input.fullName.split("/")[0]?.toLowerCase() ||
    installation.repository_selection !== "selected"
  )
    throw new GitPublicationError("scope_denied");
  for (const [key, level] of Object.entries(input.permissions)) {
    if (permissions[key] !== level) throw new GitPublicationError("scope_denied");
  }
  for (const [key, level] of Object.entries(permissions)) {
    if (key === "metadata" && level === "read") continue;
    if (!Object.hasOwn(input.permissions, key) || level !== input.permissions[key as keyof typeof input.permissions])
      throw new GitPublicationError("scope_denied");
  }
  const expiry = typeof record.expires_at === "string" ? Date.parse(record.expires_at) : NaN;
  if (!Number.isFinite(expiry) || expiry <= now + 5_000 || expiry > parent.accessExpiresAt.getTime())
    throw new GitPublicationError("scope_denied");
  return new Date(expiry);
}
