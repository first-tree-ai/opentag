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
import { accountCliLoginCodes, users } from "../../db/schema/index.js";
import { WorkspaceAdminAccess } from "../workspace-admin-access/index.js";
import { AuthServiceError, invalidCredential } from "./errors.js";
import { hashSecret } from "./security.js";
import type { AuthTokenProvider } from "./tokens.js";

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
  readonly #workspaceAdmins: WorkspaceAdminAccess;

  constructor(
    database: DatabaseClient,
    authTokens: AuthTokenProvider,
    options: AuthServiceOptions & { workspaceAdmins?: WorkspaceAdminAccess } = {},
  ) {
    this.#database = database;
    this.#authTokens = authTokens;
    this.#now = options.now ?? (() => new Date());
    this.#workspaceAdmins = options.workspaceAdmins ?? new WorkspaceAdminAccess(database, { now: options.now });
  }

  async exchangeConnectCode(code: string, expectedUserId?: string): Promise<ConnectCodeExchangeResponse> {
    const now = this.#now();
    const codeHash = hashSecret(code);
    return this.#database.transaction(async (transaction) => {
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

      const tokenPair = await this.#authTokens.issuePairForUser(user.id);
      const [consumed] = await transaction
        .update(accountCliLoginCodes)
        .set({ consumedAt: now })
        .where(and(eq(accountCliLoginCodes.id, connectCode.id), isNull(accountCliLoginCodes.consumedAt)))
        .returning({ id: accountCliLoginCodes.id });
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

    /**
     * Authentication proves the Account identity, not ownership of every stored resource. A legacy or revoked
     * Account may have no active Workspace grant, and resource-scoped authority is always checked separately.
     */
    const activeWorkspaces = await this.#workspaceAdmins.listActiveAdminWorkspaces(userId);

    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      workspaces: activeWorkspaces.map((workspace) => ({
        id: workspace.workspaceId,
        name: workspace.workspaceName,
        displayName: workspace.workspaceDisplayName,
        setupCompletedAt: workspace.setupCompletedAt?.toISOString() ?? null,
        grantedAt: workspace.grantedAt.toISOString(),
      })),
    };
  }
}
