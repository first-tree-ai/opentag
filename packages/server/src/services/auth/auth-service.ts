import type { ConnectCodeExchangeResponse, MeResponse, RefreshTokenResponse } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { connectCodes, memberships, teams, users } from "../../db/schema/index.js";
import { AuthServiceError, invalidCredential } from "./errors.js";
import { hashSecret } from "./security.js";
import type { AuthTokenProvider } from "./tokens.js";

export interface AuthServiceOptions {
  now?: () => Date;
}

export interface AuthenticatedUser {
  me: MeResponse;
}

export interface UserAuthService {
  exchangeConnectCode(code: string): Promise<ConnectCodeExchangeResponse>;
  getAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser>;
  refresh(refreshToken: string): Promise<RefreshTokenResponse>;
}

/** Issues OpenTag credentials after any login provider has resolved and verified a stable user id. */
export interface ResolvedUserTokenIssuer {
  issueTokensForUser(userId: string): Promise<RefreshTokenResponse>;
}

export class AuthService implements ResolvedUserTokenIssuer, UserAuthService {
  readonly #authTokens: AuthTokenProvider;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;

  constructor(database: DatabaseClient, authTokens: AuthTokenProvider, options: AuthServiceOptions = {}) {
    this.#database = database;
    this.#authTokens = authTokens;
    this.#now = options.now ?? (() => new Date());
  }

  async exchangeConnectCode(code: string): Promise<ConnectCodeExchangeResponse> {
    const now = this.#now();
    const codeHash = hashSecret(code);
    return this.#database.transaction(async (transaction) => {
      const [connectCode] = await transaction
        .select()
        .from(connectCodes)
        .where(eq(connectCodes.codeHash, codeHash))
        .for("update");
      if (!connectCode) {
        throw invalidCredential("AUTH_INVALID_CODE", "The connect code is invalid");
      }
      if (connectCode.consumedAt) {
        throw invalidCredential("AUTH_CODE_CONSUMED", "The connect code has already been used");
      }
      if (connectCode.expiresAt <= now) {
        throw invalidCredential("AUTH_CODE_EXPIRED", "The connect code has expired");
      }

      const [user] = await transaction.select().from(users).where(eq(users.id, connectCode.userId)).limit(1);
      const [issuer] = await transaction.select().from(users).where(eq(users.id, connectCode.issuerUserId)).limit(1);
      if (!user || !issuer) {
        throw invalidCredential("AUTH_INVALID_CODE", "The connect code is invalid");
      }
      if (user.suspendedAt || issuer.suspendedAt) {
        throw invalidCredential("AUTH_USER_SUSPENDED", "The user account is suspended");
      }

      const [membership] = await transaction
        .select({ teamId: memberships.teamId })
        .from(memberships)
        .where(and(eq(memberships.userId, user.id), isNull(memberships.leftAt)))
        .limit(1);
      if (!membership) {
        throw new AuthServiceError(
          "AUTH_MEMBERSHIP_REQUIRED",
          "deterministic",
          "An active team membership is required",
          403,
        );
      }

      const tokenPair = await this.#authTokens.issuePairForUser(user.id);
      const [consumed] = await transaction
        .update(connectCodes)
        .set({ consumedAt: now })
        .where(and(eq(connectCodes.id, connectCode.id), isNull(connectCodes.consumedAt)))
        .returning({ id: connectCodes.id });
      if (!consumed) {
        throw invalidCredential("AUTH_CODE_CONSUMED", "The connect code has already been used");
      }
      return { ...tokenPair, tokenType: "Bearer" as const };
    });
  }

  async refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    const identity = await this.#authTokens.verifyRefresh(refreshToken);
    return this.issueTokensForUser(identity.userId);
  }

  /** Shared post-identity boundary for connect codes and future OAuth/OIDC resolvers. */
  async issueTokensForUser(userId: string): Promise<RefreshTokenResponse> {
    await this.#resolveActiveUser(userId);
    return { ...(await this.#authTokens.issuePairForUser(userId)), tokenType: "Bearer" };
  }

  async getAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser> {
    const identity = await this.#authTokens.verifyAccess(accessToken);
    return { me: await this.#resolveActiveUser(identity.userId) };
  }

  async #resolveActiveUser(userId: string): Promise<MeResponse> {
    const [user] = await this.#database.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "The token is invalid");
    }
    if (user.suspendedAt) {
      throw invalidCredential("AUTH_USER_SUSPENDED", "The user account is suspended");
    }

    const activeMemberships = await this.#database
      .select({
        role: memberships.role,
        teamDisplayName: teams.displayName,
        teamId: teams.id,
        teamName: teams.name,
      })
      .from(memberships)
      .innerJoin(teams, eq(memberships.teamId, teams.id))
      .where(and(eq(memberships.userId, userId), isNull(memberships.leftAt)));
    if (activeMemberships.length === 0) {
      throw new AuthServiceError(
        "AUTH_MEMBERSHIP_REQUIRED",
        "deterministic",
        "An active team membership is required",
        403,
      );
    }

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      memberships: activeMemberships,
    };
  }
}
