import { randomUUID } from "node:crypto";
import {
  type GitHubOAuthContext,
  GitHubOAuthContextSchema,
  type GitHubOAuthFlowIntent,
  type GitHubOAuthReturnSurface,
} from "@opentag/shared";

export interface BeginOAuthFlowInput {
  intent: GitHubOAuthFlowIntent;
  loginSessionHash: string;
  returnSurface: GitHubOAuthReturnSurface;
  expiresAt: Date;
}

export function newOAuthFlowContext(input: BeginOAuthFlowInput): GitHubOAuthContext {
  return {
    flowId: randomUUID(),
    intent: input.intent,
    phase: "awaiting_callback",
    loginSessionHash: input.loginSessionHash,
    returnSurface: input.returnSurface,
    expiresAt: input.expiresAt.toISOString(),
    claimedAt: null,
  };
}

/** Parses the stored nonsecret flow context; any shape drift voids the flow rather than guessing. */
export function parseOAuthFlowContext(raw: unknown): GitHubOAuthContext | null {
  const parsed = GitHubOAuthContextSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export function claimOAuthFlowContext(context: GitHubOAuthContext, claimedAt: Date): GitHubOAuthContext {
  return { ...context, phase: "claimed", claimedAt: claimedAt.toISOString() };
}

export function oauthFlowIsExpired(context: GitHubOAuthContext, now: Date): boolean {
  return Date.parse(context.expiresAt) <= now.getTime();
}
