import { jwtVerify, SignJWT } from "jose";
import { AuthServiceError, invalidCredential } from "./errors.js";

export interface AccessTokenIdentity {
  sessionId: string;
  userId: string;
}

export class AccessTokenService {
  readonly #key: Uint8Array;

  constructor(
    secret: string,
    readonly ttlSeconds: number,
  ) {
    this.#key = new TextEncoder().encode(secret);
  }

  async issue(identity: AccessTokenIdentity): Promise<string> {
    return new SignJWT({ sid: identity.sessionId, type: "access" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(identity.userId)
      .setIssuer("opentag")
      .setAudience("opentag-api")
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.#key);
  }

  async verify(token: string): Promise<AccessTokenIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ["HS256"],
        audience: "opentag-api",
        issuer: "opentag",
      });
      if (payload.type !== "access" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
        throw invalidCredential("AUTH_INVALID_TOKEN", "The access token is invalid");
      }
      return { sessionId: payload.sid, userId: payload.sub };
    } catch (error) {
      if (error instanceof AuthServiceError) {
        throw error;
      }
      throw invalidCredential("AUTH_INVALID_TOKEN", "The access token is invalid");
    }
  }
}
