import { invalidCredential } from "../services/auth/errors.js";
import type { AuthTokenIdentity, AuthTokenPair, AuthTokenProvider } from "../services/auth/tokens.js";
import type { OpenTagBetterAuth } from "./better-auth.js";

/**
 * Issues Better Auth sessions through the interface the stateless JWTs used.
 *
 * Every caller — connect-code exchange, refresh, and request authentication — already speaks {@link AuthTokenProvider},
 * so swapping the implementation moves the CLI onto revocable server-side sessions without changing any of them, and
 * without changing the four-field response the CLI stores. `accessToken` and `refreshToken` carry the same session
 * token because a session is not a pair: it is one credential the server can revoke, and re-presenting it is what
 * extends it.
 */
export class BetterAuthSessionTokens implements AuthTokenProvider {
  readonly #auth: OpenTagBetterAuth;
  readonly #now: () => Date;

  constructor(auth: OpenTagBetterAuth, options: { now?: () => Date } = {}) {
    this.#auth = auth;
    this.#now = options.now ?? (() => new Date());
  }

  async issuePairForUser(userId: string): Promise<AuthTokenPair> {
    const context = await this.#auth.$context;
    const session = await context.internalAdapter.createSession(userId);
    if (!session) throw invalidCredential("AUTH_INVALID_TOKEN", "A session could not be issued");
    return {
      accessToken: session.token,
      refreshToken: session.token,
      expiresIn: this.#secondsUntil(session.expiresAt),
    };
  }

  verifyAccess(token: string): Promise<AuthTokenIdentity> {
    return this.#verify(token);
  }

  verifyRefresh(token: string): Promise<AuthTokenIdentity> {
    return this.#verify(token);
  }

  async #verify(token: string): Promise<AuthTokenIdentity> {
    const context = await this.#auth.$context;
    const found = await context.internalAdapter.findSession(token);
    if (!found || found.session.expiresAt.getTime() <= this.#now().getTime()) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "The token is invalid");
    }
    return { expiresAt: found.session.expiresAt, userId: found.session.userId };
  }

  #secondsUntil(expiresAt: Date): number {
    return Math.max(1, Math.floor((expiresAt.getTime() - this.#now().getTime()) / 1000));
  }
}

/**
 * Accepts credentials the previous revision issued while every new one is a Better Auth session.
 *
 * Verification tries the session first and falls back to the legacy signature, so a CLI that has not been near the
 * server since the cutover keeps working. Issuance only ever produces a session — including on the refresh path, which
 * is therefore what quietly upgrades a legacy credential the first time it is presented.
 */
export class BridgedSessionTokens implements AuthTokenProvider {
  readonly #legacy: AuthTokenProvider;
  readonly #sessions: AuthTokenProvider;

  constructor(sessions: AuthTokenProvider, legacy: AuthTokenProvider) {
    this.#sessions = sessions;
    this.#legacy = legacy;
  }

  issuePairForUser(userId: string): Promise<AuthTokenPair> {
    return this.#sessions.issuePairForUser(userId);
  }

  verifyAccess(token: string): Promise<AuthTokenIdentity> {
    return this.#either((provider) => provider.verifyAccess(token));
  }

  verifyRefresh(token: string): Promise<AuthTokenIdentity> {
    return this.#either((provider) => provider.verifyRefresh(token));
  }

  async #either(verify: (provider: AuthTokenProvider) => Promise<AuthTokenIdentity>): Promise<AuthTokenIdentity> {
    try {
      return await verify(this.#sessions);
    } catch {
      // A credential the session store does not know is either legacy or invalid; the legacy check decides which.
      return verify(this.#legacy);
    }
  }
}
