import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { authSessions } from "../db/schema/index.js";
import { invalidCredential } from "../services/auth/errors.js";
import type { AuthTokenIdentity, AuthTokenPair, AuthTokenProvider } from "../services/auth/token-provider.js";
import type { OpenTagBetterAuth } from "./better-auth.js";

/**
 * Issues Better Auth sessions through the interface the stateless JWTs used.
 *
 * Every caller — connect-code exchange, refresh, and request authentication — speaks {@link AuthTokenProvider}, so the
 * implementation could be replaced without changing any of them, and without changing the four-field response the CLI
 * stores. `accessToken` and `refreshToken` carry the same session
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
