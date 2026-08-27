import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";
import { z } from "zod";
import { AuthServiceError } from "../errors.js";
import type { ExternalIdentity } from "../identity-service.js";

const GOOGLE_ISSUER = "https://accounts.google.com";
const TokenResponseSchema = z.object({ id_token: z.string().min(1) }).passthrough();

export interface GoogleIdentityClient {
  authorizationUrl(input: { nonce: string; redirectUri: string; state: string }): string;
  exchangeCode(input: { code: string; nonce: string; redirectUri: string }): Promise<ExternalIdentity>;
}

export class DefaultGoogleIdentityClient implements GoogleIdentityClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #fetch: typeof fetch;
  readonly #verifyIdToken: (token: string) => Promise<JWTPayload>;

  constructor(
    clientId: string,
    clientSecret: string,
    options: { fetch?: typeof fetch; verifyIdToken?: (token: string) => Promise<JWTPayload> } = {},
  ) {
    this.#clientId = clientId;
    this.#clientSecret = clientSecret;
    this.#fetch = options.fetch ?? fetch;
    const jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
    this.#verifyIdToken =
      options.verifyIdToken ??
      (async (token) =>
        (
          await jwtVerify(token, jwks, {
            algorithms: ["RS256"],
            audience: this.#clientId,
            issuer: [GOOGLE_ISSUER, "accounts.google.com"],
          })
        ).payload);
  }

  authorizationUrl(input: { nonce: string; redirectUri: string; state: string }): string {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", input.state);
    url.searchParams.set("nonce", input.nonce);
    return url.toString();
  }

  async exchangeCode(input: { code: string; nonce: string; redirectUri: string }): Promise<ExternalIdentity> {
    try {
      const response = await this.#fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.#clientId,
          client_secret: this.#clientSecret,
          code: input.code,
          grant_type: "authorization_code",
          redirect_uri: input.redirectUri,
        }),
      });
      if (!response.ok) throw new Error("Google token exchange failed");
      const body = await response.text();
      if (body.length > 64 * 1024) throw new Error("Google token response is too large");
      const tokenResponse = TokenResponseSchema.parse(JSON.parse(body));
      const payload = await this.#verifyIdToken(tokenResponse.id_token);
      if (
        payload.nonce !== input.nonce ||
        typeof payload.sub !== "string" ||
        !payload.sub ||
        typeof payload.email !== "string" ||
        payload.email_verified !== true
      ) {
        throw new Error("Google ID token claims are invalid");
      }
      const displayName = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : payload.email;
      return {
        provider: "google",
        issuer: GOOGLE_ISSUER,
        subject: payload.sub,
        email: payload.email,
        // The claim check above rejects anything Google has not verified, so reaching here proves verification.
        emailVerified: true,
        displayName,
      };
    } catch {
      throw new AuthServiceError("AUTH_OAUTH_FAILED", "credential", "Google sign-in could not be verified", 401);
    }
  }
}
