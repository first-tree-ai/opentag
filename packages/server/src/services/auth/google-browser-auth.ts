import type { RefreshTokenResponse } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import type { InvitationAuditContext } from "../invitations/index.js";
import type { ResolvedUserTokenIssuer } from "./auth-service.js";
import { AuthServiceError } from "./errors.js";
import type { AuthIdentityService } from "./identity-service.js";
import type { GoogleIdentityClient } from "./oauth/google.js";
import { invitationTokenFromNext, type OAuthFlowService } from "./oauth/state.js";
import type { PostAuthenticationService } from "./post-authentication.js";

export interface GoogleAuthStartResult {
  authorizationUrl: string;
  context: string;
}

export interface GoogleAuthCallbackResult {
  next: string;
  selectedTeamId?: string;
  tokens: RefreshTokenResponse;
}

export interface GoogleAuthCallbackInput {
  code?: string;
  error?: string;
  state: string;
}

export interface GoogleAuthCallbackOptions {
  audit?: InvitationAuditContext;
  onVerified(): void;
}

export class GoogleBrowserAuthService {
  readonly #database: DatabaseClient;
  readonly #flow: OAuthFlowService;
  readonly #google: GoogleIdentityClient;
  readonly #identities: AuthIdentityService;
  readonly #postAuthentication: PostAuthenticationService;
  readonly #redirectUri: string;
  readonly #tokenIssuer: ResolvedUserTokenIssuer;

  constructor(options: {
    database: DatabaseClient;
    flow: OAuthFlowService;
    google: GoogleIdentityClient;
    identities: AuthIdentityService;
    postAuthentication: PostAuthenticationService;
    publicUrl: string;
    tokenIssuer: ResolvedUserTokenIssuer;
  }) {
    this.#database = options.database;
    this.#flow = options.flow;
    this.#google = options.google;
    this.#identities = options.identities;
    this.#postAuthentication = options.postAuthentication;
    this.#redirectUri = new URL("/api/v1/auth/google/callback", options.publicUrl).toString();
    this.#tokenIssuer = options.tokenIssuer;
  }

  async start(next?: string): Promise<GoogleAuthStartResult> {
    const flow = await this.#flow.start(next);
    return {
      authorizationUrl: this.#google.authorizationUrl({
        nonce: flow.oidcNonce,
        redirectUri: this.#redirectUri,
        state: flow.state,
      }),
      context: flow.context,
    };
  }

  async callback(
    input: GoogleAuthCallbackInput,
    context: string,
    options: GoogleAuthCallbackOptions,
  ): Promise<GoogleAuthCallbackResult> {
    const flow = await this.#flow.verify(input.state, context);
    options.onVerified();
    if (input.error) {
      throw new AuthServiceError(
        "AUTH_OAUTH_FAILED",
        "credential",
        input.error === "access_denied" ? "Google sign-in was cancelled" : "Google sign-in failed",
        401,
      );
    }
    if (!input.code) {
      throw new AuthServiceError("AUTH_OAUTH_FAILED", "credential", "Google sign-in failed", 401);
    }
    const identity = await this.#google.exchangeCode({
      code: input.code,
      nonce: flow.oidcNonce,
      redirectUri: this.#redirectUri,
    });
    const invitationToken = invitationTokenFromNext(flow.next);
    const completion = await this.#database.transaction(async (transaction) => {
      const resolved = await this.#identities.resolveOrCreateInTransaction(transaction, identity);
      const result = await this.#postAuthentication.completeInTransaction(
        transaction,
        resolved.userId,
        resolved.accountWasCreated,
        invitationToken,
        options.audit ?? {},
      );
      return { selectedTeamId: result.selectedTeamId, userId: resolved.userId };
    });
    return {
      next: flow.next,
      ...(completion.selectedTeamId ? { selectedTeamId: completion.selectedTeamId } : {}),
      tokens: await this.#tokenIssuer.issueTokensForUser(completion.userId),
    };
  }
}
