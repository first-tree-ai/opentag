import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { authSessions } from "../db/schema/index.js";
import { AuthServiceError, invalidCredential } from "../services/auth/errors.js";
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
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(auth: OpenTagBetterAuth, database: DatabaseClient, options: { now?: () => Date } = {}) {
    this.#auth = auth;
    this.#database = database;
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

  /**
   * Withdraws the presented session and issues its replacement, in that order.
   *
   * The delete is the gate, and it is what makes this safe to race: exactly one caller can remove a given row, so two
   * refreshes of the same credential cannot both go on to mint a session, and a revocation that lands first means the
   * delete finds nothing and no replacement is created. Verifying and then deleting would decide both of those on
   * stale information — two live sessions from one credential, or access restored after it was revoked.
   *
   * Withdrawing first does mean a failure before the replacement exists signs the client out. That is the direction to
   * fail in: the alternative keeps a credential alive that something already decided to end.
   */
  async rotate(token: string, userId: string): Promise<AuthTokenPair> {
    const [withdrawn] = await this.#database
      .delete(authSessions)
      .where(and(eq(authSessions.token, token), eq(authSessions.userId, userId)))
      .returning({ userId: authSessions.userId });
    if (!withdrawn) throw invalidCredential("AUTH_INVALID_TOKEN", "The token is invalid");
    return this.issuePairForUser(withdrawn.userId);
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

  /**
   * Always produces a session, and withdraws the presented credential when the session store is the one holding it.
   *
   * A credential the session store rejects is only rotated into a new session once the legacy provider vouches for it.
   * Issuing on any rejection would resurrect a session that was revoked between verification and withdrawal — the
   * legacy check is what separates "this was never a session" from "this session is gone".
   */
  async rotate(token: string, userId: string): Promise<AuthTokenPair> {
    try {
      return await this.#sessions.rotate(token, userId);
    } catch (cause) {
      if (!(cause instanceof AuthServiceError) || cause.code !== "AUTH_INVALID_TOKEN") throw cause;
      await this.#legacy.verifyRefresh(token);
      // Nothing to withdraw: a signature cannot be taken back, so it simply runs out on its own schedule.
      return this.#sessions.issuePairForUser(userId);
    }
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
    } catch (cause) {
      /*
       * Only an explicit "this store does not know that token" means the credential might be a legacy one. A session
       * store that is failing must not be reported as an invalid credential, and must not get a legacy credential
       * admitted behind its back: an outage would silently widen what the server accepts.
       */
      if (!(cause instanceof AuthServiceError) || cause.code !== "AUTH_INVALID_TOKEN") throw cause;
      return verify(this.#legacy);
    }
  }
}
