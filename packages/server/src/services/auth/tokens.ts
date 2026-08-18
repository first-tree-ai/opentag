import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { AuthServiceError, invalidCredential } from "./errors.js";

export interface AuthTokenIdentity {
  expiresAt: Date;
  userId: string;
}

export interface AuthTokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
}

export interface AuthTokenProvider {
  issuePairForUser(userId: string): Promise<AuthTokenPair>;
  verifyAccess(token: string): Promise<AuthTokenIdentity>;
  verifyRefresh(token: string): Promise<AuthTokenIdentity>;
}

type AuthTokenType = "access" | "refresh";

const TOKEN_AUDIENCES = {
  access: "opentag-api",
  refresh: "opentag-auth",
} as const satisfies Record<AuthTokenType, string>;

/** Provider-neutral token boundary used after any login method resolves a stable user id. */
export class AuthTokenService implements AuthTokenProvider {
  readonly #key: Uint8Array;
  readonly #now: () => Date;

  constructor(
    secret: string,
    readonly accessTtlSeconds: number,
    readonly refreshTtlSeconds: number,
    options: { now?: () => Date } = {},
  ) {
    this.#key = new TextEncoder().encode(secret);
    this.#now = options.now ?? (() => new Date());
  }

  async issuePairForUser(userId: string): Promise<AuthTokenPair> {
    const [accessToken, refreshToken] = await Promise.all([
      this.#issue("access", userId, this.accessTtlSeconds),
      this.#issue("refresh", userId, this.refreshTtlSeconds),
    ]);
    return { accessToken, refreshToken, expiresIn: this.accessTtlSeconds };
  }

  async verifyAccess(token: string): Promise<AuthTokenIdentity> {
    return this.#verify(token, "access");
  }

  async verifyRefresh(token: string): Promise<AuthTokenIdentity> {
    return this.#verify(token, "refresh");
  }

  async #issue(type: AuthTokenType, userId: string, ttlSeconds: number): Promise<string> {
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    return new SignJWT({ type })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(userId)
      .setIssuer("opentag")
      .setAudience(TOKEN_AUDIENCES[type])
      .setJti(randomUUID())
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .sign(this.#key);
  }

  async #verify(token: string, expectedType: AuthTokenType): Promise<AuthTokenIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ["HS256"],
        audience: TOKEN_AUDIENCES[expectedType],
        currentDate: this.#now(),
        issuer: "opentag",
      });
      if (payload.type !== expectedType || typeof payload.sub !== "string" || typeof payload.exp !== "number") {
        throw invalidCredential("AUTH_INVALID_TOKEN", `The ${expectedType} token is invalid`);
      }
      return { expiresAt: new Date(payload.exp * 1000), userId: payload.sub };
    } catch (error) {
      if (error instanceof AuthServiceError) {
        throw error;
      }
      throw invalidCredential("AUTH_INVALID_TOKEN", `The ${expectedType} token is invalid`);
    }
  }
}
