import { randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { AuthServiceError } from "../errors.js";
import { generateSecret } from "../security.js";

const StatePayloadSchema = z.object({
  flowNonce: z.string().min(1),
  provider: z.literal("google"),
});
const ContextPayloadSchema = z.object({
  flowNonce: z.string().min(1),
  next: z.string().min(1),
  oidcNonce: z.string().min(1),
  provider: z.literal("google"),
});

export interface OAuthFlowStart {
  context: string;
  next: string;
  oidcNonce: string;
  state: string;
}

export class OAuthFlowService {
  readonly #key: Uint8Array;
  readonly #now: () => Date;
  readonly #ttlSeconds: number;

  constructor(secret: string, options: { now?: () => Date; ttlSeconds?: number } = {}) {
    this.#key = new TextEncoder().encode(secret);
    this.#now = options.now ?? (() => new Date());
    this.#ttlSeconds = options.ttlSeconds ?? 10 * 60;
  }

  async start(rawNext?: string): Promise<OAuthFlowStart> {
    const next = validateOAuthNext(rawNext);
    const flowNonce = generateSecret(24);
    const oidcNonce = generateSecret(24);
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const common = (jwt: SignJWT, audience: string) =>
      jwt
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("opentag")
        .setAudience(audience)
        .setIssuedAt(issuedAt)
        .setExpirationTime(issuedAt + this.#ttlSeconds)
        .setJti(randomUUID())
        .sign(this.#key);
    const [state, context] = await Promise.all([
      common(new SignJWT({ flowNonce, provider: "google" }), "opentag-oauth-state"),
      common(new SignJWT({ flowNonce, next, oidcNonce, provider: "google" }), "opentag-oauth-context"),
    ]);
    return { context, next, oidcNonce, state };
  }

  async verify(state: string, context: string): Promise<Omit<OAuthFlowStart, "context" | "state">> {
    try {
      const [stateResult, contextResult] = await Promise.all([
        jwtVerify(state, this.#key, {
          algorithms: ["HS256"],
          audience: "opentag-oauth-state",
          currentDate: this.#now(),
          issuer: "opentag",
        }),
        jwtVerify(context, this.#key, {
          algorithms: ["HS256"],
          audience: "opentag-oauth-context",
          currentDate: this.#now(),
          issuer: "opentag",
        }),
      ]);
      const parsedState = StatePayloadSchema.parse(stateResult.payload);
      const parsedContext = ContextPayloadSchema.parse(contextResult.payload);
      if (parsedState.provider !== parsedContext.provider || parsedState.flowNonce !== parsedContext.flowNonce) {
        throw new Error("OAuth flow mismatch");
      }
      const next = validateOAuthNext(parsedContext.next);
      return { next, oidcNonce: parsedContext.oidcNonce };
    } catch {
      throw new AuthServiceError(
        "AUTH_OAUTH_FAILED",
        "credential",
        "The browser sign-in flow is invalid or expired",
        401,
      );
    }
  }
}

export function validateOAuthNext(value?: string): string {
  const next = value ?? "/agents";
  if (
    next.length > 1024 ||
    next.includes("\\") ||
    next.includes("#") ||
    next.startsWith("//") ||
    Array.from(next).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    throw new AuthServiceError("AUTH_OAUTH_FAILED", "validation", "The sign-in destination is invalid", 400);
  }
  // OAuth contexts issued before self-serve Workspace creation was retired remain valid for ten minutes.
  // Send those callbacks to the normal authenticated landing page instead of a removed creation route.
  if (/^\/workspaces\/new(?:\?[^#]*)?$/.test(next)) return "/agents";
  if (/^\/(?:agents(?:\/[^?#]*)?|settings(?:\/[^?#]*)?|onboarding|login)(?:\?[^#]*)?$/.test(next)) {
    return next;
  }
  throw new AuthServiceError("AUTH_OAUTH_FAILED", "validation", "The sign-in destination is invalid", 400);
}
