import {
  type ConnectCodeExchangeResponse,
  type MeResponse,
  type RefreshTokenResponse,
  type UpdateUserProfileRequest,
  UpdateUserProfileRequestSchema,
  type UserProfile,
} from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { accountCliLoginCodes, agents, users } from "../../db/schema/index.js";
import { AuthServiceError, invalidCredential } from "./errors.js";
import { hashSecret } from "./security.js";
import type { AuthTokenProvider } from "./token-provider.js";

export interface AuthServiceOptions {
  now?: () => Date;
}

export interface AuthenticatedUser {
  me: MeResponse;
  tokenExpiresAt: Date;
}

export interface SelfProfileService {
  updateSelfProfile(userId: string, input: UpdateUserProfileRequest): Promise<UserProfile>;
}

export interface UserAuthService extends SelfProfileService {
  exchangeConnectCode(code: string, expectedUserId?: string): Promise<ConnectCodeExchangeResponse>;
  getActiveUserById(userId: string): Promise<MeResponse>;
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

  /**
   * Spends a connect code, then issues the session it bought.
   *
   * The code is consumed and committed before anything is issued, which fixes both halves of a split that used to be
   * invisible: issuing first left a live session behind whenever the consume or the commit failed — with the code
   * still reusable, so one code could buy a second credential — and it held a row lock across a call that needs its
   * own connection, so enough concurrent exchanges of one code could occupy the pool waiting on each other.
   *
   * The remaining failure is a spent code with no session, and that is the right direction for a one-time credential:
   * the caller asks for another code rather than holding one that has already been redeemed.
   */
  async exchangeConnectCode(code: string, expectedUserId?: string): Promise<ConnectCodeExchangeResponse> {
    const now = this.#now();
    const codeHash = hashSecret(code);
    const userId = await this.#database.transaction(async (transaction) => {
      const [connectCode] = await transaction
        .select()
        .from(accountCliLoginCodes)
        .where(eq(accountCliLoginCodes.tokenHash, codeHash))
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
      const [issuer] = await transaction.select().from(users).where(eq(users.id, connectCode.issuedByUserId)).limit(1);
      if (!user || !issuer) {
        throw invalidCredential("AUTH_INVALID_CODE", "The connect code is invalid");
      }
      if (user.suspendedAt || issuer.suspendedAt) {
        throw invalidCredential("AUTH_USER_SUSPENDED", "The user account is suspended");
      }
      if (expectedUserId && expectedUserId !== user.id) {
        throw new AuthServiceError(
          "AUTH_USER_MISMATCH",
          "deterministic",
          "The connect code belongs to another user",
          409,
        );
      }

      // Conditional, so a code two callers reach at once is redeemed by exactly one of them.
      const [consumed] = await transaction
        .update(accountCliLoginCodes)
        .set({ consumedAt: now })
        .where(and(eq(accountCliLoginCodes.id, connectCode.id), isNull(accountCliLoginCodes.consumedAt)))
        .returning({ id: accountCliLoginCodes.id });
      if (!consumed) {
        throw invalidCredential("AUTH_CODE_CONSUMED", "The connect code has already been used");
      }
      return user.id;
    });

    // Outside the transaction: the credential store has its own connection, and nothing here holds a row lock now.
    return { ...(await this.#authTokens.issuePairForUser(userId)), tokenType: "Bearer" as const };
  }

  async refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    const identity = await this.#authTokens.verifyRefresh(refreshToken);
    await this.#resolveActiveUser(identity.userId);
    // Rotated rather than reissued, so the credential just replaced stops working instead of running to its own expiry.
    return { ...(await this.#authTokens.rotate(refreshToken, identity.userId)), tokenType: "Bearer" };
  }

  /** Shared post-identity boundary for connect codes and future OAuth/OIDC resolvers. */
  async issueTokensForUser(userId: string): Promise<RefreshTokenResponse> {
    await this.#resolveActiveUser(userId);
    return { ...(await this.#authTokens.issuePairForUser(userId)), tokenType: "Bearer" };
  }

  async getAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser> {
    const identity = await this.#authTokens.verifyAccess(accessToken);
    return { me: await this.#resolveActiveUser(identity.userId), tokenExpiresAt: identity.expiresAt };
  }

  getActiveUserById(userId: string): Promise<MeResponse> {
    return this.#resolveActiveUser(userId);
  }

  async updateSelfProfile(userId: string, rawInput: UpdateUserProfileRequest): Promise<UserProfile> {
    const input = UpdateUserProfileRequestSchema.parse(rawInput);
    const [updated] = await this.#database
      .update(users)
      .set({ displayName: input.displayName, updatedAt: this.#now() })
      .where(and(eq(users.id, userId), isNull(users.suspendedAt)))
      .returning({ id: users.id, email: users.email, displayName: users.displayName });
    if (!updated) throw invalidCredential("AUTH_INVALID_TOKEN", "The token is invalid");
    return updated;
  }

  async #resolveActiveUser(userId: string): Promise<MeResponse> {
    const [user] = await this.#database.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "The token is invalid");
    }
    if (user.suspendedAt) {
      throw new AuthServiceError("AUTH_USER_SUSPENDED", "deterministic", "The user account is suspended", 403);
    }

    const [ownedAgent] = await this.#database
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.createdByUserId, user.id), eq(agents.status, "active")))
      .limit(1);

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      hasActiveAgent: ownedAgent !== undefined,
    };
  }
}
