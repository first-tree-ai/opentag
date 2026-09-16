import type { RuntimeCredentialProvider, RuntimeExecutionSource } from "@opentag/shared";
import type { RuntimeExecutionPurpose } from "./types.js";

export interface RuntimeTaskPolicyInput {
  accountId: string;
  agentId: string;
  sessionId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  /** The Session's own IM binding from the authoritative DB snapshot. */
  sessionBindingId: string;
  source: RuntimeExecutionSource;
  purpose: RuntimeExecutionPurpose;
}

/**
 * Authoritative task delegation port. The parent wires the real Account/owner delegation
 * configuration; there is deliberately no public allow-boolean: a deployment either injects an
 * authoritative policy or keeps the default denial for GitHub execution.
 */
export interface RuntimeTaskPolicy {
  authorize(input: RuntimeTaskPolicyInput): Promise<"permit" | "deny"> | "permit" | "deny";
}

/**
 * Default policy: IM acquires are permitted only for the Session's own active binding (the same
 * trust basis as the existing `im:credential` grant); GitHub execution is denied until explicit
 * Account/owner task delegation is configured. An IM sender is never a GitHub grant.
 */
export class DefaultRuntimeTaskPolicy implements RuntimeTaskPolicy {
  authorize(input: RuntimeTaskPolicyInput): "permit" | "deny" {
    if (input.provider === "github") return "deny";
    return input.bindingId === input.sessionBindingId ? "permit" : "deny";
  }
}
