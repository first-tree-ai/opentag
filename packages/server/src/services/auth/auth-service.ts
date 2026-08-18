import type { ConnectCodeExchangeResponse, MeResponse, RefreshTokenResponse } from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { authSessions, connectCodes, memberships, tenants, users } from "../../db/schema/index.js";
import { AuthServiceError, invalidCredential } from "./errors.js";
import { generateSecret, hashSecret } from "./security.js";
import type { AccessTokenService } from "./tokens.js";

export interface AuthServiceOptions {
  now?: () => Date;
  refreshTokenTtlSeconds: number;
}

export interface AuthenticatedUser {
  me: MeResponse;
  sessionId: string;
}

export interface UserAuthService {
  exchangeConnectCode(code: string): Promise<ConnectCodeExchangeResponse>;
  getAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser>;
  refresh(refreshToken: string): Promise<RefreshTokenResponse>;
}

export class AuthService implements UserAuthService {
  readonly #accessTokens: AccessTokenService;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #options: AuthServiceOptions;

  constructor(database: DatabaseClient, accessTokens: AccessTokenService, options: AuthServiceOptions) {
    this.#database = database;
    this.#accessTokens = accessTokens;
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  async exchangeConnectCode(code: string): Promise<ConnectCodeExchangeResponse> {
    const now = this.#now();
    const codeHash = hashSecret(code);
    const refreshToken = generateSecret();
    const refreshTokenHash = hashSecret(refreshToken);
    const session = await this.#database.transaction(async (transaction) => {
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
        .select({ tenantId: memberships.tenantId })
        .from(memberships)
        .where(and(eq(memberships.userId, user.id), isNull(memberships.leftAt)))
        .limit(1);
      if (!membership) {
        throw new AuthServiceError(
          "AUTH_MEMBERSHIP_REQUIRED",
          "deterministic",
          "An active tenant membership is required",
          403,
        );
      }

      const [createdSession] = await transaction
        .insert(authSessions)
        .values({
          userId: user.id,
          refreshTokenHash,
          expiresAt: new Date(now.getTime() + this.#options.refreshTokenTtlSeconds * 1000),
        })
        .returning({ id: authSessions.id, userId: authSessions.userId });
      if (!createdSession) {
        throw new Error("Failed to create an authentication session");
      }

      await transaction
        .update(connectCodes)
        .set({ consumedAt: now })
        .where(and(eq(connectCodes.id, connectCode.id), isNull(connectCodes.consumedAt)));
      return createdSession;
    });

    return this.#createTokenResponse(session.userId, session.id, refreshToken);
  }

  async refresh(refreshToken: string): Promise<RefreshTokenResponse> {
    const now = this.#now();
    const currentHash = hashSecret(refreshToken);
    const nextRefreshToken = generateSecret();
    const nextHash = hashSecret(nextRefreshToken);
    const session = await this.#database.transaction(async (transaction) => {
      const [current] = await transaction
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, currentHash))
        .for("update");
      if (!current) {
        throw invalidCredential("AUTH_INVALID_TOKEN", "The refresh token is invalid");
      }
      if (current.revokedAt) {
        throw invalidCredential("AUTH_SESSION_REVOKED", "The authentication session has been revoked");
      }
      if (current.expiresAt <= now) {
        throw invalidCredential("AUTH_INVALID_TOKEN", "The refresh token has expired");
      }

      const [user] = await transaction.select().from(users).where(eq(users.id, current.userId)).limit(1);
      if (!user) {
        throw invalidCredential("AUTH_INVALID_TOKEN", "The refresh token is invalid");
      }
      if (user.suspendedAt) {
        throw invalidCredential("AUTH_USER_SUSPENDED", "The user account is suspended");
      }

      const [rotated] = await transaction
        .update(authSessions)
        .set({
          lastUsedAt: now,
          refreshTokenHash: nextHash,
          updatedAt: now,
        })
        .where(and(eq(authSessions.id, current.id), isNull(authSessions.revokedAt)))
        .returning({ id: authSessions.id, userId: authSessions.userId });
      if (!rotated) {
        throw new Error("Failed to rotate the authentication session");
      }
      return rotated;
    });

    return this.#createTokenResponse(session.userId, session.id, nextRefreshToken);
  }

  async getAuthenticatedUser(accessToken: string): Promise<AuthenticatedUser> {
    const identity = await this.#accessTokens.verify(accessToken);
    const [session] = await this.#database
      .select({ expiresAt: authSessions.expiresAt, revokedAt: authSessions.revokedAt, userId: authSessions.userId })
      .from(authSessions)
      .where(eq(authSessions.id, identity.sessionId))
      .limit(1);
    if (!session || session.userId !== identity.userId || session.revokedAt || session.expiresAt <= this.#now()) {
      throw invalidCredential("AUTH_SESSION_REVOKED", "The authentication session has been revoked");
    }

    const [user] = await this.#database.select().from(users).where(eq(users.id, identity.userId)).limit(1);
    if (!user) {
      throw invalidCredential("AUTH_INVALID_TOKEN", "The access token is invalid");
    }
    if (user.suspendedAt) {
      throw invalidCredential("AUTH_USER_SUSPENDED", "The user account is suspended");
    }

    const activeMemberships = await this.#database
      .select({
        role: memberships.role,
        tenantDisplayName: tenants.displayName,
        tenantId: tenants.id,
        tenantSlug: tenants.slug,
      })
      .from(memberships)
      .innerJoin(tenants, eq(memberships.tenantId, tenants.id))
      .where(and(eq(memberships.userId, user.id), isNull(memberships.leftAt)));
    if (activeMemberships.length === 0) {
      throw new AuthServiceError(
        "AUTH_MEMBERSHIP_REQUIRED",
        "deterministic",
        "An active tenant membership is required",
        403,
      );
    }

    return {
      sessionId: identity.sessionId,
      me: {
        user: { id: user.id, email: user.email, displayName: user.displayName },
        memberships: activeMemberships,
      },
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    const now = this.#now();
    await this.#database
      .update(authSessions)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
  }

  async #createTokenResponse(userId: string, sessionId: string, refreshToken: string) {
    return {
      accessToken: await this.#accessTokens.issue({ userId, sessionId }),
      refreshToken,
      tokenType: "Bearer" as const,
      expiresIn: this.#accessTokens.ttlSeconds,
    };
  }
}
