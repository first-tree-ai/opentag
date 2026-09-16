import type { GitHubOAuthSecretBinding, GitHubUserCredentialBinding } from "../github-credential-material.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import type { GitHubConnectionRow } from "./rows.js";

export const GITHUB_CIPHERTEXT_MAX_LENGTH = 16 * 1024;
export const GITHUB_KEY_ID_MAX_LENGTH = 255;

/**
 * GitHub token material always enters persistence as ciphertext produced by the platform cipher,
 * with the key ID and the GitHub-returned expiries. This service never decrypts it and never logs it.
 */
export interface GitHubConnectionCredentialMaterial {
  ciphertext: string;
  keyId: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

/** The encrypted PKCE slot for one OAuth flow; the verifier is never persisted in plaintext. */
export interface GitHubOAuthSecretSlot {
  ciphertext: string;
  keyId: string;
}

/** Pure, synchronous encryption after the destination identity is fixed; no network I/O in this callback. */
export type GitHubCredentialFactory = (binding: GitHubUserCredentialBinding) => GitHubConnectionCredentialMaterial;
export type GitHubOAuthSecretFactory = (binding: GitHubOAuthSecretBinding) => GitHubOAuthSecretSlot;

export function sealOAuthSecret(
  factory: GitHubOAuthSecretFactory | undefined,
  binding: { connectionId: string; accountId: string; appId: string; githubHost: string; flowId: string },
): GitHubOAuthSecretSlot | null {
  if (!factory) return null;
  const slot = factory({ ...binding, githubHost: supportedHost(binding.githubHost) });
  assertGitHubOAuthSecretSlot(slot);
  return slot;
}

export function sealUserCredential(
  factory: GitHubCredentialFactory,
  row: GitHubConnectionRow,
  connectionId: string,
  githubUserId: string,
  now: Date,
): GitHubConnectionCredentialMaterial {
  const material = factory({
    connectionId,
    accountId: row.accountId,
    appId: row.appId,
    githubHost: supportedHost(row.githubHost),
    githubUserId,
  });
  assertGitHubCredentialMaterial(material, now);
  return material;
}

function supportedHost(host: string): "github.com" {
  if (host !== "github.com") {
    throw new GitHubConnectionServiceError(GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID, 400, "Unsupported GitHub host");
  }
  return host;
}

function assertBoundedSecret(ciphertext: string, keyId: string, description: string): void {
  if (
    typeof ciphertext !== "string" ||
    ciphertext.length === 0 ||
    ciphertext.length > GITHUB_CIPHERTEXT_MAX_LENGTH ||
    typeof keyId !== "string" ||
    keyId.length === 0 ||
    keyId.length > GITHUB_KEY_ID_MAX_LENGTH
  ) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CREDENTIAL_INPUT_INVALID,
      400,
      `${description} carries bounded ciphertext and a key ID`,
    );
  }
}

export function assertGitHubOAuthSecretSlot(slot: GitHubOAuthSecretSlot | null | undefined): void {
  if (slot == null) return;
  assertBoundedSecret(slot.ciphertext, slot.keyId, "The OAuth secret slot");
}

/** Token payload validation at the persistence boundary: ciphertext, key ID, and valid expiries. */
export function assertGitHubCredentialMaterial(input: GitHubConnectionCredentialMaterial, now: Date): void {
  assertBoundedSecret(input.ciphertext, input.keyId, "GitHub token material");
  if (
    !(input.accessExpiresAt instanceof Date) ||
    Number.isNaN(input.accessExpiresAt.getTime()) ||
    !(input.refreshExpiresAt instanceof Date) ||
    Number.isNaN(input.refreshExpiresAt.getTime())
  ) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CREDENTIAL_INPUT_INVALID,
      400,
      "GitHub token expiries must be valid dates",
    );
  }
  if (input.accessExpiresAt.getTime() <= now.getTime()) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CREDENTIAL_INPUT_INVALID,
      400,
      "The GitHub access token expiry must be in the future",
    );
  }
  if (input.refreshExpiresAt.getTime() <= input.accessExpiresAt.getTime()) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.CREDENTIAL_INPUT_INVALID,
      400,
      "The GitHub refresh token expiry must outlive the access token expiry",
    );
  }
}
