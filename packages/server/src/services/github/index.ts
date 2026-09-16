export {
  createGitHubRepositoryAdmissionProof,
  GITHUB_ADMISSION_PROOF_MAX_AGE_MS,
  type GitHubRepositoryAdmissionProof,
  hashGitHubRepositoryBindings,
  verifyGitHubRepositoryAdmissionProof,
} from "./bindings-proof.js";
export type {
  GitHubConnectionCredentialMaterial,
  GitHubCredentialFactory,
  GitHubOAuthSecretFactory,
  GitHubOAuthSecretSlot,
} from "./credentials.js";
export {
  boundedGitHubErrorCode,
  GITHUB_CONNECTION_ERROR_CODES,
  type GitHubConnectionErrorCode,
  GitHubConnectionServiceError,
  isGitHubConnectionUniqueViolation,
} from "./errors.js";
export { GitHubBindingsService, type GitHubBindingsServiceOptions } from "./github-bindings-service.js";
export {
  type ClaimedGitHubOAuthFlow,
  type GitHubAuthorizationCompletion,
  type GitHubAuthorizationFlowHandle,
  GitHubConnectionService,
  type GitHubConnectionServiceOptions,
  type GitHubOAuthCompletionProof,
} from "./github-connection-service.js";
export {
  GitHubConnectionRecheckStore,
  type GitHubRecheckCommitResult,
  type GitHubRecheckDueConnection,
  type GitHubRecheckOutcome,
} from "./github-recheck-store.js";
export {
  type ClaimedGitHubRefresh,
  GitHubCredentialRefreshStore,
  type GitHubRefreshCandidate,
  type GitHubRefreshClaimResult,
  type GitHubRefreshWriteResult,
} from "./github-refresh-store.js";
export { generateOAuthState, sha256Hex } from "./hashes.js";
export { type GitHubConnectionRow, toGitHubConnectionStatus } from "./rows.js";
export {
  GITHUB_OAUTH_FLOW_TTL_MS,
  GITHUB_RECHECK_INTERVAL_MS,
  GITHUB_RECHECK_RETRY_DELAY_MS,
  GITHUB_REFRESH_CLAIM_TTL_MS,
} from "./timing.js";
