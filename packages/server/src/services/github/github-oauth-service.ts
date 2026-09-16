/*
 * GitHub App user-authorization orchestration: builds the real authorize URL with one-time state
 * and a PKCE S256 challenge, then processes the callback through the connection state machine.
 *
 * The one-time state is only ever persisted as a hash; the PKCE verifier is sealed into the
 * encrypted OAuth slot by the credential-cipher factory at flow creation and opened only inside
 * the claimed callback. The code is exchanged exactly once — the atomic state claim guarantees a
 * replayed callback never reaches the exchange — over the bounded fixed-origin transport. A
 * callback error or denial voids the claimed flow without any exchange, and no path logs or
 * redirects back the raw code, token, state, or verifier.
 */

import { createHash, randomBytes } from "node:crypto";
import type {
  GitHubOAuthFlowIntent,
  GitHubOAuthReturnSurface,
  StartGitHubAuthorizationResponse,
} from "@opentag/shared";
import type { GitHubCredentialCipher } from "../github-credential-material.js";
import type { GitHubCredentialFactory } from "./credentials.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "./errors.js";
import { GITHUB_API_CLIENT_ERROR_CODES, GitHubApiClient, GitHubApiClientError } from "./github-api-client.js";
import type { ClaimedGitHubOAuthFlow, GitHubConnectionService } from "./github-connection-service.js";
import { sha256Hex } from "./hashes.js";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const PKCE_VERIFIER_BYTES = 48; // 64 base64url characters, inside the RFC 7636 43..128 window

export interface GitHubAuthorizationStart extends StartGitHubAuthorizationResponse {
  flowId: string;
}

export interface GitHubOAuthCallbackResult {
  returnSurface: GitHubOAuthReturnSurface;
  agentId: string | null;
  connectionId: string;
  supersededConnectionId: string | null;
}

export interface GitHubOAuthServiceOptions {
  connections: GitHubConnectionService;
  cipher: GitHubCredentialCipher;
  api: GitHubApiClient;
  clientId: string;
  redirectUri: string;
}

export class GitHubOAuthService {
  readonly #connections: GitHubConnectionService;
  readonly #cipher: GitHubCredentialCipher;
  readonly #api: GitHubApiClient;
  readonly #clientId: string;
  readonly #redirectUri: string;

  constructor(options: GitHubOAuthServiceOptions) {
    this.#connections = options.connections;
    this.#cipher = options.cipher;
    this.#api = options.api;
    this.#clientId = options.clientId;
    this.#redirectUri = options.redirectUri;
  }

  /**
   * Starts a flow: `create` opens a fresh pending connection or restarts the in-flight flow of a
   * still-pending one; `reauthorize`/`replace` begin on the current connection. The PKCE verifier
   * is sealed by the cipher factory against the exact flow identity before this returns.
   */
  async startAuthorization(
    accountId: string,
    input: {
      intent: GitHubOAuthFlowIntent;
      returnSurface: GitHubOAuthReturnSurface;
      agentId: string | null;
      loginSessionHash: string;
      appId: string;
    },
  ): Promise<GitHubAuthorizationStart> {
    const pkceVerifier = randomBytes(PKCE_VERIFIER_BYTES).toString("base64url");
    const sealVerifier = (binding: Parameters<GitHubCredentialCipher["encryptOAuthSecret"]>[0]) =>
      this.#cipher.encryptOAuthSecret(binding, pkceVerifier);
    let flow: { connectionId: string; flowId: string; state: string; expiresAt: Date };
    if (input.intent === "create") {
      const current = await this.#connections.getCurrentConnection(accountId, "github.com", input.appId);
      if (current === null) {
        const created = await this.#connections.createConnection(accountId, {
          appId: input.appId,
          returnSurface: input.returnSurface,
          agentId: input.agentId,
          loginSessionHash: input.loginSessionHash,
          oauthSecret: sealVerifier,
        });
        flow = created.flow;
      } else if (current.status === "pending") {
        flow = await this.#connections.beginAuthorizationFlow(accountId, current.id, {
          intent: "create",
          returnSurface: input.returnSurface,
          agentId: input.agentId,
          loginSessionHash: input.loginSessionHash,
          oauthSecret: sealVerifier,
        });
      } else {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.CONNECTION_CONFLICT,
          409,
          "A current GitHub connection already exists; reauthorize or replace it instead",
        );
      }
    } else {
      const current = await this.#connections.getCurrentConnection(accountId, "github.com", input.appId);
      if (current === null) {
        throw new GitHubConnectionServiceError(
          GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND,
          404,
          "There is no current GitHub connection to authorize",
        );
      }
      flow = await this.#connections.beginAuthorizationFlow(accountId, current.id, {
        intent: input.intent,
        returnSurface: input.returnSurface,
        agentId: input.agentId,
        loginSessionHash: input.loginSessionHash,
        oauthSecret: sealVerifier,
      });
    }
    const authorizationUrl = new URL(GITHUB_AUTHORIZE_URL);
    authorizationUrl.searchParams.set("client_id", this.#clientId);
    authorizationUrl.searchParams.set("redirect_uri", this.#redirectUri);
    authorizationUrl.searchParams.set("state", flow.state);
    authorizationUrl.searchParams.set(
      "code_challenge",
      createHash("sha256").update(pkceVerifier, "utf8").digest("base64url"),
    );
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    return {
      connectionId: flow.connectionId,
      flowId: flow.flowId,
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: flow.expiresAt.toISOString(),
    };
  }

  /**
   * Completes a callback: claims the one-time flow atomically, exchanges the code exactly once,
   * reads the GitHub-attested user identity, and activates/reauthorizes/replaces through the
   * connection state machine. Any failure after the claim voids the flow — a half-completed
   * authorization can never be resumed or replayed.
   */
  async completeCallback(
    accountId: string,
    input: { state: string; code: string; loginSessionHash: string },
  ): Promise<GitHubOAuthCallbackResult> {
    const claimed = await this.#connections.claimOAuthCallback({
      stateHash: sha256Hex(input.state),
      loginSessionHash: input.loginSessionHash,
    });
    if (claimed.accountId !== accountId) {
      // The authenticated Account is not the one that started the flow. Void nothing — the owning
      // session may still complete it — and disclose nothing about whose flow it is.
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.OAUTH_SESSION_MISMATCH,
        403,
        "The OAuth callback does not belong to the Account that started it",
      );
    }
    try {
      const pkceVerifier = this.#openPkceVerifier(claimed);
      const tokens = await this.#api.exchangeCodeForUserToken({ code: input.code, codeVerifier: pkceVerifier });
      const user = await this.#api.getAuthenticatedUser({ accessToken: tokens.accessToken });
      const sealCredential: GitHubCredentialFactory = (binding) => {
        const material = this.#cipher.encryptUserCredential(binding, {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
        });
        return {
          ciphertext: material.ciphertext,
          keyId: material.keyId,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
        };
      };
      const completion = await this.#connections.completeAuthorization(accountId, {
        connectionId: claimed.connectionId,
        flowId: claimed.flowId,
        stateHash: sha256Hex(input.state),
        loginSessionHash: input.loginSessionHash,
        expectedAuthorizationVersion: claimed.expectedAuthorizationVersion,
        githubUserId: user.id,
        githubLogin: user.login,
        credential: sealCredential,
      });
      return {
        returnSurface: claimed.returnSurface,
        agentId: claimed.agentId,
        connectionId: completion.connection.id,
        supersededConnectionId: completion.supersededConnectionId,
      };
    } catch (error) {
      await this.#connections
        .voidOAuthFlow(accountId, {
          connectionId: claimed.connectionId,
          flowId: claimed.flowId,
          stateHash: sha256Hex(input.state),
          loginSessionHash: input.loginSessionHash,
          expectedAuthorizationVersion: claimed.expectedAuthorizationVersion,
        })
        .catch(() => undefined);
      throw mapCallbackFailure(error);
    }
  }

  /**
   * Voids the flow behind a callback that carries a GitHub denial instead of a code. Returns the
   * flow's fixed return surface so the caller can still redirect somewhere meaningful; an unknown
   * or mismatched flow yields null and the caller falls back to the default surface.
   */
  async abortCallback(
    accountId: string,
    input: { state: string; loginSessionHash: string },
  ): Promise<{ returnSurface: GitHubOAuthReturnSurface; agentId: string | null } | null> {
    try {
      const claimed = await this.#connections.claimOAuthCallback({
        stateHash: sha256Hex(input.state),
        loginSessionHash: input.loginSessionHash,
      });
      if (claimed.accountId !== accountId) return null;
      await this.#connections.voidOAuthFlow(accountId, {
        connectionId: claimed.connectionId,
        flowId: claimed.flowId,
        stateHash: sha256Hex(input.state),
        loginSessionHash: input.loginSessionHash,
        expectedAuthorizationVersion: claimed.expectedAuthorizationVersion,
      });
      return { returnSurface: claimed.returnSurface, agentId: claimed.agentId };
    } catch {
      return null;
    }
  }

  #openPkceVerifier(claimed: ClaimedGitHubOAuthFlow): string {
    if (!claimed.oauthSecret) {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
        409,
        "The OAuth flow carries no PKCE secret to exchange with",
      );
    }
    try {
      return this.#cipher.decryptOAuthSecret(
        {
          connectionId: claimed.connectionId,
          accountId: claimed.accountId,
          appId: claimed.appId,
          githubHost: "github.com",
          flowId: claimed.flowId,
        },
        claimed.oauthSecret,
      );
    } catch {
      throw new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
        409,
        "The OAuth flow PKCE secret could not be authenticated",
      );
    }
  }
}

/**
 * Maps every post-claim failure to a bounded controlled error. Upstream classifications become the
 * public management codes; the original error — which may carry upstream detail — is dropped.
 */
function mapCallbackFailure(error: unknown): GitHubConnectionServiceError {
  if (error instanceof GitHubConnectionServiceError) return error;
  if (error instanceof GitHubApiClientError) {
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
        "GitHub rate-limited the authorization; retry shortly",
        "rate_limit",
      );
    }
    if (
      error.code === GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE ||
      error.code === GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR
    ) {
      return new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_UNAVAILABLE,
        503,
        "GitHub could not complete the authorization; retry",
        "transient",
      );
    }
    if (error.code === GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED) {
      return new GitHubConnectionServiceError(
        GITHUB_CONNECTION_ERROR_CODES.OAUTH_FLOW_INVALID,
        409,
        "GitHub rejected the authorization exchange; begin a new flow",
        "deterministic",
      );
    }
  }
  return new GitHubConnectionServiceError(
    GITHUB_CONNECTION_ERROR_CODES.UPSTREAM_ERROR,
    502,
    "The GitHub authorization could not be completed",
    "transient",
  );
}

export { GitHubApiClient };
