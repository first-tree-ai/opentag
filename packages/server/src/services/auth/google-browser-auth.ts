import type { RefreshTokenResponse } from "@opentag/shared";
import type { DatabaseClient } from "../../db/client.js";
import type { InvitationAuditContext } from "../invitations/index.js";
import type { ResolvedUserTokenIssuer } from "./auth-service.js";
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
  tokens: RefreshTokenResponse;
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
    code: string,
    state: string,
    context: string,
    audit: InvitationAuditContext = {},
  ): Promise<GoogleAuthCallbackResult> {
    const flow = await this.#flow.verify(state, context);
    const identity = await this.#google.exchangeCode({ code, nonce: flow.oidcNonce, redirectUri: this.#redirectUri });
    const userId = await this.#database.transaction(async (transaction) => {
      const resolvedUserId = await this.#identities.resolveOrCreateInTransaction(transaction, identity);
      await this.#postAuthentication.completeInTransaction(
        transaction,
        resolvedUserId,
        invitationTokenFromNext(flow.next),
        audit,
      );
      return resolvedUserId;
    });
    return { next: flow.next, tokens: await this.#tokenIssuer.issueTokensForUser(userId) };
  }
}
