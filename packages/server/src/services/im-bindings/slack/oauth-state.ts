import { randomUUID } from "node:crypto";
import { type AgentSetupSlackOAuthContext, AgentSetupSlackOAuthContextSchema } from "@opentag/shared";
import { jwtVerify, SignJWT } from "jose";
import { z } from "zod";
import { generateSecret, hashSecret } from "../../auth/security.js";
import { SlackConfigurationServiceError } from "./configuration-service.js";

/**
 * The signed state carries the exact F0 Agent setup OAuth context: the exact Agent, the fixed return
 * surface, the intent, and the expected unbound or exact binding generation. Anything the Account did
 * not see signed cannot be substituted without failing verification, and the payload never holds a
 * return URL — the redirect target is derived from the fixed surface after verification.
 */
const SlackOAuthStatePayloadSchema = z.object({
  nonce: z.string().min(1),
  userId: z.string().uuid(),
  sessionBindingHash: z.string().min(1),
  context: AgentSetupSlackOAuthContextSchema,
});

export type SlackOAuthStatePayload = z.infer<typeof SlackOAuthStatePayloadSchema>;

export interface SlackOAuthIssuedState {
  expiresAt: Date;
  nonceHash: string;
  payload: SlackOAuthStatePayload;
  sessionBinding: string;
  state: string;
}

const STATE_AUDIENCE = "opentag-slack-oauth-state";

export class SlackOAuthStateService {
  readonly #key: Uint8Array;
  readonly #now: () => Date;
  readonly #ttlSeconds: number;

  constructor(secret: string, options: { now?: () => Date; ttlSeconds?: number } = {}) {
    this.#key = new TextEncoder().encode(secret);
    this.#now = options.now ?? (() => new Date());
    this.#ttlSeconds = options.ttlSeconds ?? 10 * 60;
  }

  get ttlSeconds(): number {
    return this.#ttlSeconds;
  }

  async issue(input: { userId: string; context: AgentSetupSlackOAuthContext }): Promise<SlackOAuthIssuedState> {
    const context = AgentSetupSlackOAuthContextSchema.parse(input.context);
    const nonce = generateSecret(24);
    const sessionBinding = generateSecret(24);
    const issuedAt = Math.floor(this.#now().getTime() / 1000);
    const payload: SlackOAuthStatePayload = {
      nonce,
      userId: input.userId,
      sessionBindingHash: hashSecret(sessionBinding),
      context,
    };
    const state = await new SignJWT(payload)
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("opentag")
      .setAudience(STATE_AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + this.#ttlSeconds)
      .setJti(randomUUID())
      .sign(this.#key);
    return {
      expiresAt: new Date((issuedAt + this.#ttlSeconds) * 1000),
      nonceHash: hashSecret(nonce),
      payload,
      sessionBinding,
      state,
    };
  }

  async verify(state: string, sessionBinding: string | undefined): Promise<SlackOAuthStatePayload> {
    if (!sessionBinding) {
      throw new SlackConfigurationServiceError(
        "SLACK_OAUTH_FAILED",
        401,
        "The Slack authorization flow is invalid or expired",
        "credential",
      );
    }
    try {
      const verified = await jwtVerify(state, this.#key, {
        algorithms: ["HS256"],
        audience: STATE_AUDIENCE,
        currentDate: this.#now(),
        issuer: "opentag",
      });
      const payload = SlackOAuthStatePayloadSchema.parse(verified.payload);
      if (hashSecret(sessionBinding) !== payload.sessionBindingHash) {
        throw new Error("Slack OAuth session mismatch");
      }
      return payload;
    } catch {
      throw new SlackConfigurationServiceError(
        "SLACK_OAUTH_FAILED",
        401,
        "The Slack authorization flow is invalid or expired",
        "credential",
      );
    }
  }
}
