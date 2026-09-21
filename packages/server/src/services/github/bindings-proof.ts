import { canonicalizeGitHubRepositoryBindings, type GitHubRepositoryBinding } from "@opentag/shared";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import { sha256Hex } from "./hashes.js";

/** Repository admission proofs are trusted for at most five minutes after authoritative verification. */
export const GITHUB_ADMISSION_PROOF_MAX_AGE_MS = 5 * 60 * 1000;
const ADMISSION_PROOF_MAX_FUTURE_SKEW_MS = 60 * 1000;

/** The canonical bindings hash a proof binds to: SHA-256 over schema-normalized JSON. */
export function hashGitHubRepositoryBindings(bindings: GitHubRepositoryBinding[]): string {
  return sha256Hex(canonicalizeGitHubRepositoryBindings(bindings));
}

/**
 * A typed attestation — created only by the internal GitHub verification stage — that the connected
 * GitHub user holds admission to the exact requested bindings. It is bound to the connection, the
 * observed authorization version, the attested GitHub user, and the canonical bindings hash. It is
 * never an arbitrary boolean "allow".
 */
export interface GitHubRepositoryAdmissionProof {
  connectionId: string;
  authorizationVersion: bigint;
  githubUserId: string;
  bindingsHash: string;
  verifiedAt: Date;
}

export function createGitHubRepositoryAdmissionProof(input: {
  connectionId: string;
  authorizationVersion: bigint;
  githubUserId: string;
  bindings: GitHubRepositoryBinding[];
  verifiedAt: Date;
}): GitHubRepositoryAdmissionProof {
  return {
    connectionId: input.connectionId,
    authorizationVersion: input.authorizationVersion,
    githubUserId: input.githubUserId,
    bindingsHash: hashGitHubRepositoryBindings(input.bindings),
    verifiedAt: input.verifiedAt,
  };
}

export function verifyGitHubRepositoryAdmissionProof(
  proof: GitHubRepositoryAdmissionProof,
  observed: { connectionId: string; authorizationVersion: bigint; githubUserId: string | null },
  bindingsHash: string,
  now: Date,
  maxAgeMs: number = GITHUB_ADMISSION_PROOF_MAX_AGE_MS,
): void {
  if (
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs <= 0 ||
    maxAgeMs > GITHUB_ADMISSION_PROOF_MAX_AGE_MS ||
    !Number.isFinite(now.getTime())
  ) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PROOF_INVALID,
      409,
      "Invalid admission proof freshness policy",
    );
  }
  if (
    proof.connectionId !== observed.connectionId ||
    proof.authorizationVersion !== observed.authorizationVersion ||
    proof.githubUserId !== observed.githubUserId
  ) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PROOF_INVALID,
      409,
      "The repository admission proof is not bound to this connection and authorization version",
    );
  }
  if (proof.bindingsHash !== bindingsHash) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PROOF_INVALID,
      409,
      "The repository admission proof does not cover the requested bindings",
    );
  }
  if (!(proof.verifiedAt instanceof Date) || Number.isNaN(proof.verifiedAt.getTime())) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PROOF_INVALID,
      409,
      "The repository admission proof has no valid verification time",
    );
  }
  const ageMs = now.getTime() - proof.verifiedAt.getTime();
  if (ageMs > maxAgeMs || ageMs < -ADMISSION_PROOF_MAX_FUTURE_SKEW_MS) {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PROOF_STALE,
      409,
      "The repository admission proof is outside its freshness window",
    );
  }
}
