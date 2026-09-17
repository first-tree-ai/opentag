/*
 * The Account-facing GitHub management facade and the Server-internal credential broker.
 *
 * HTTP surface (via api/github-integrations.ts): overview, authorization start/callback, paginated
 * repository discovery, bindings update with a fresh authoritative admission proof, disconnect.
 * Nothing client-supplied is ever trusted as proof — discovery and admission always go to GitHub
 * with the connected user's UAT, and the configured deployment App is the only App a flow uses.
 *
 * Server-internal surface (for the runtime workstream, never exposed over HTTP):
 *   - getCurrentUserCredential(connectionId): the decrypted current UAT pair with its fencing
 *     versions, for Server-side verification and token maintenance. Returns null unless the row is
 *     active; the caller must re-check fencing before relying on it.
 *   - verifyCurrentRepositoryAdmission(...): live re-verification that the connected user still
 *     holds the requested access to one exact repository through one installation.
 * Both return raw credential material or throw controlled errors; neither logs secrets.
 */

import type {
  GitHubAgentScope,
  GitHubConnectionStatus,
  GitHubIntegrationOverview,
  GitHubOAuthFlowIntent,
  GitHubOAuthReturnSurface,
  GitHubRepositoryBinding,
  GitHubRepositoryDiscoveryPage,
  UpdateGitHubConnectionBindingsRequest,
} from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { githubConnections } from "../../db/schema/index.js";
import type { GitHubCredentialCipher } from "../github-credential-material.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import { GITHUB_API_CLIENT_ERROR_CODES, GitHubApiClientError } from "./github-api-client.js";
import type { GitHubBindingsService } from "./github-bindings-service.js";
import type { GitHubConnectionService } from "./github-connection-service.js";
import type { GitHubOAuthCallbackResult, GitHubOAuthService } from "./github-oauth-service.js";
import type { GitHubRepositoryAdmissionService } from "./repository-admission.js";

export interface GitHubManagementServiceOptions {
  database: DatabaseClient;
  appId: string;
  connections: GitHubConnectionService;
  bindings: GitHubBindingsService;
  oauth: GitHubOAuthService;
  admission: GitHubRepositoryAdmissionService;
  cipher: GitHubCredentialCipher;
  now?: () => Date;
}

/** The decrypted current user credential with its fencing versions. Server-side only; never logged. */
export interface GitHubRuntimeUserCredential {
  connectionId: string;
  accountId: string;
  githubUserId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  authorizationVersion: bigint;
  credentialGeneration: bigint;
}

/** One Agent's repository scopes on an active connection, for Server-side runtime policy. */
export interface GitHubRuntimeAgentRepositoryScope {
  bindingId: string;
  installationId: string;
  repositoryId: string;
  fullNameDisplay: string;
  scopes: GitHubAgentScope[];
}

/**
 * Server-internal: an Agent's exact active repository scopes plus the row's fencing versions. The
 * runtime resolves the owner's `taskDelegation` and the repo/role/ref policy from this and must
 * re-check the versions before relying on it. Returns null unless the row is active; an Agent with
 * no scope on the connection yields an empty list, never a fabricated one.
 */
export interface GitHubRuntimeAgentBindings {
  connectionId: string;
  accountId: string;
  githubUserId: string;
  authorizationVersion: bigint;
  credentialGeneration: bigint;
  repositories: GitHubRuntimeAgentRepositoryScope[];
}

/** Internal: the sealed current credential plus identity, read for decryption or exchange. */
interface ActiveCredentialRow {
  connectionId: string;
  accountId: string;
  githubHost: string;
  appId: string;
  githubUserId: string;
  bindings: GitHubRepositoryBinding[];
  authorizationVersion: bigint;
  credentialGeneration: bigint;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  credential: { ciphertext: string; keyId: string };
}

export class GitHubManagementService {
  readonly #database: DatabaseClient;
  readonly #appId: string;
  readonly #connections: GitHubConnectionService;
  readonly #bindings: GitHubBindingsService;
  readonly #oauth: GitHubOAuthService;
  readonly #admission: GitHubRepositoryAdmissionService;
  readonly #cipher: GitHubCredentialCipher;

  constructor(options: GitHubManagementServiceOptions) {
    this.#database = options.database;
    this.#appId = options.appId;
    this.#connections = options.connections;
    this.#bindings = options.bindings;
    this.#oauth = options.oauth;
    this.#admission = options.admission;
    this.#cipher = options.cipher;
  }

  /** The Account's overview: the current connection for the configured App, or null. */
  async getOverview(accountId: string): Promise<GitHubIntegrationOverview> {
    const connection = await this.#connections.getCurrentConnection(accountId, "github.com", this.#appId);
    return {
      availability: { available: true, githubHost: "github.com", appId: this.#appId },
      connection,
    };
  }

  /** Starts a connect/reauthorize/replace flow; the response carries the exact authorize URL. */
  async startAuthorization(
    accountId: string,
    input: {
      intent: GitHubOAuthFlowIntent;
      returnSurface: GitHubOAuthReturnSurface;
      agentId: string | null;
      loginSessionHash: string;
    },
  ): Promise<{ connectionId: string; authorizationUrl: string; expiresAt: string }> {
    const started = await this.#oauth.startAuthorization(accountId, { ...input, appId: this.#appId });
    return {
      connectionId: started.connectionId,
      authorizationUrl: started.authorizationUrl,
      expiresAt: started.expiresAt,
    };
  }

  /** Completes the OAuth callback; see GitHubOAuthService.completeCallback. */
  completeOAuthCallback(
    accountId: string,
    input: { state: string; code: string; loginSessionHash: string },
  ): Promise<GitHubOAuthCallbackResult> {
    return this.#oauth.completeCallback(accountId, input);
  }

  /** Voids the flow behind a denied callback; see GitHubOAuthService.abortCallback. */
  abortOAuthCallback(
    accountId: string,
    input: { state: string; loginSessionHash: string },
  ): Promise<{ returnSurface: GitHubOAuthReturnSurface; agentId: string | null } | null> {
    return this.#oauth.abortCallback(accountId, input);
  }

  /**
   * One page of repository discovery with the connected user's live credential. Requires an active
   * connection; pending and reauthorization_required rows must finish authorization first.
   */
  async discoverRepositories(accountId: string, cursor?: string): Promise<GitHubRepositoryDiscoveryPage> {
    const current = await this.#requireActiveConnection(accountId);
    const credential = await this.#openUserCredential(current.id);
    try {
      return await this.#admission.discoverRepositories({
        accessToken: credential.accessToken,
        ...(cursor !== undefined ? { cursor } : {}),
      });
    } catch (error) {
      throw mapManagementApiFailure(error);
    }
  }

  /**
   * Updates the binding configuration: re-checks the observed authorization version, proves live
   * admission for the exact requested bindings with the current UAT, then runs the guarded CAS
   * write. The proof is minted here — a client can never supply or reuse one.
   */
  async updateBindings(
    accountId: string,
    input: UpdateGitHubConnectionBindingsRequest,
  ): Promise<GitHubConnectionStatus> {
    const current = await this.#requireActiveConnection(accountId);
    const expected = parseVersion(input.expectedAuthorizationVersion);
    if (current.authorizationVersion !== expected) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT,
        409,
        "The connection's authorization version no longer matches; re-read and retry",
      );
    }
    const credential = await this.#openUserCredential(current.id);
    const admissionProof = await this.#admission
      .verifyAdmission({
        accessToken: credential.accessToken,
        connectionId: current.id,
        authorizationVersion: expected,
        githubUserId: current.githubUserId,
        bindings: input.bindings,
      })
      .catch((error: unknown) => {
        throw mapManagementApiFailure(error);
      });
    return this.#bindings.updateBindings(accountId, current.id, {
      expectedAuthorizationVersion: expected,
      bindings: input.bindings,
      admissionProof,
    });
  }

  /** Revokes the current connection; returns its final status, or null when there is none. */
  async disconnect(accountId: string): Promise<GitHubConnectionStatus | null> {
    const current = await this.#connections.getCurrentConnection(accountId, "github.com", this.#appId);
    if (current === null) return null;
    return this.#connections.disconnect(accountId, current.id);
  }

  /*
   * Server-internal runtime API. Neither method is reachable over HTTP; both require the exact
   * connection ID and return or verify raw credential material strictly inside the Server.
   */

  /**
   * The current decrypted user credential for one active connection, or null when the row is not
   * active. Runtime callers must treat the fencing versions as the decision point: a credential
   * whose authorizationVersion no longer matches the row is already dead.
   */
  async getCurrentUserCredential(connectionId: string): Promise<GitHubRuntimeUserCredential | null> {
    const row = await this.#readActiveCredentialRow(connectionId);
    if (row === null) return null;
    const credential = this.#decrypt(row);
    return {
      connectionId: row.connectionId,
      accountId: row.accountId,
      githubUserId: row.githubUserId,
      accessToken: credential.accessToken,
      refreshToken: credential.refreshToken,
      accessExpiresAt: row.accessExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      authorizationVersion: row.authorizationVersion,
      credentialGeneration: row.credentialGeneration,
    };
  }

  /**
   * Server-internal: one Agent's exact repository scopes on an active connection. Runtime policy
   * reads the owner's task delegation and the repo/role/ref scope from here and re-checks the
   * fencing versions before every use; null means the connection is not active.
   */
  async getAgentBindings(connectionId: string, agentId: string): Promise<GitHubRuntimeAgentBindings | null> {
    const row = await this.#readActiveCredentialRow(connectionId);
    if (row === null) return null;
    const repositories: GitHubRuntimeAgentRepositoryScope[] = [];
    for (const binding of row.bindings) {
      const scopes = binding.agentScopes.filter((scope) => scope.agentId === agentId.toLowerCase());
      if (scopes.length === 0) continue;
      repositories.push({
        bindingId: binding.bindingId,
        installationId: binding.installationId,
        repositoryId: binding.repositoryId,
        fullNameDisplay: binding.fullNameDisplay,
        scopes,
      });
    }
    return {
      connectionId: row.connectionId,
      accountId: row.accountId,
      githubUserId: row.githubUserId,
      authorizationVersion: row.authorizationVersion,
      credentialGeneration: row.credentialGeneration,
      repositories,
    };
  }

  /**
   * Live re-verification that the connected user still holds `access` to one exact repository
   * through one installation, with the current credential. Throws a controlled error when
   * admission fails or the connection is no longer active; returns the fencing versions observed
   * alongside the successful verification so the caller can detect a concurrent change.
   */
  async verifyCurrentRepositoryAdmission(input: {
    connectionId: string;
    installationId: string;
    repositoryId: string;
    access: "read" | "write";
    publish?: "direct" | "pull_request";
  }): Promise<{ authorizationVersion: bigint; credentialGeneration: bigint }> {
    const row = await this.#readActiveCredentialRow(input.connectionId);
    if (row === null) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND,
        404,
        "The GitHub connection was not found",
      );
    }
    const credential = this.#decrypt(row);
    await this.#admission.verifyCurrentRepositoryAdmission({
      accessToken: credential.accessToken,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      access: input.access,
      ...(input.publish !== undefined ? { publish: input.publish } : {}),
    });
    return { authorizationVersion: row.authorizationVersion, credentialGeneration: row.credentialGeneration };
  }

  async #requireActiveConnection(accountId: string): Promise<{
    id: string;
    githubUserId: string;
    authorizationVersion: bigint;
  }> {
    const current = await this.#connections.getCurrentConnection(accountId, "github.com", this.#appId);
    if (current === null) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND,
        404,
        "There is no current GitHub connection; connect GitHub first",
      );
    }
    if (current.status !== "active" || current.githubUserId === null) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID,
        409,
        "The GitHub connection must finish authorization before repositories can be used",
      );
    }
    return {
      id: current.id,
      githubUserId: current.githubUserId,
      authorizationVersion: parseVersion(current.authorizationVersion),
    };
  }

  /** Opens the current UAT for one active connection of this Account. Never logged. */
  async #openUserCredential(connectionId: string): Promise<{ accessToken: string }> {
    const row = await this.#readActiveCredentialRow(connectionId);
    if (row === null) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID,
        409,
        "The GitHub connection is no longer active",
      );
    }
    return { accessToken: this.#decrypt(row).accessToken };
  }

  async #readActiveCredentialRow(connectionId: string): Promise<ActiveCredentialRow | null> {
    const [row] = await this.#database
      .select()
      .from(githubConnections)
      .where(and(eq(githubConnections.id, connectionId), eq(githubConnections.status, "active")))
      .limit(1);
    if (!row) return null;
    if (
      row.githubUserId === null ||
      row.credentialCiphertext === null ||
      row.credentialKeyId === null ||
      row.accessExpiresAt === null ||
      row.refreshExpiresAt === null
    ) {
      throw new Error("An active GitHub connection is missing its credential identity");
    }
    return {
      connectionId: row.id,
      accountId: row.accountId,
      githubHost: row.githubHost,
      appId: row.appId,
      githubUserId: row.githubUserId,
      bindings: row.repositoryBindings,
      authorizationVersion: row.authorizationVersion,
      credentialGeneration: row.credentialGeneration,
      accessExpiresAt: row.accessExpiresAt,
      refreshExpiresAt: row.refreshExpiresAt,
      credential: { ciphertext: row.credentialCiphertext, keyId: row.credentialKeyId },
    };
  }

  #decrypt(row: ActiveCredentialRow): { accessToken: string; refreshToken: string } {
    try {
      if (row.githubHost !== "github.com") throw new Error("unsupported host");
      return this.#cipher.decryptUserCredential(
        {
          connectionId: row.connectionId,
          accountId: row.accountId,
          githubHost: "github.com",
          appId: row.appId,
          githubUserId: row.githubUserId,
        },
        row.credential,
      );
    } catch {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_ERROR,
        500,
        "The GitHub credential could not be authenticated",
        "transient",
      );
    }
  }
}

function parseVersion(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    throw new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.INPUT_INVALID,
      400,
      "A row version is a nonnegative decimal string",
    );
  }
}

/**
 * Maps an upstream transport failure from discovery/admission to the bounded public management
 * codes, mirroring the OAuth callback mapping. Controlled connection errors pass through; unknown
 * errors rethrow unchanged so programming faults stay 500s; upstream detail never crosses.
 */
function mapManagementApiFailure(error: unknown): unknown {
  if (!(error instanceof GitHubApiClientError)) return error;
  if (error.code === GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED) {
    return new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED,
      502,
      "The GitHub App does not issue expiring user access tokens; enable them on the App and retry",
      "deterministic",
    );
  }
  if (error.code === GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED) {
    return new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.RATE_LIMITED,
      429,
      "GitHub rate-limited the request; retry shortly",
      "rate_limit",
    );
  }
  if (error.code === GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE) {
    return new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
      503,
      "GitHub is unavailable; retry shortly",
      "transient",
    );
  }
  if (error.code === GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID) {
    // The current credential was rejected: token maintenance or the recheck worker converges the
    // row; the caller only ever learns a bounded transient code, never provider detail.
    return new GitHubConnectionServiceError(
      GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_ERROR,
      502,
      "GitHub rejected the current credential; retry shortly or reauthorize the connection",
      "transient",
    );
  }
  return new GitHubConnectionServiceError(
    GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_ERROR,
    502,
    "The GitHub request could not be completed",
    "transient",
  );
}
