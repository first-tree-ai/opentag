/**
 * Shared fixtures for the Agent Setup tests: one exact Agent in each Computer shape, and the small
 * promise latch the stale-fencing tests drive. Kept out of the test files so the three suites that
 * need them read the same identities.
 */

import type { AgentSummary, SlackConfigurationView } from "@opentag/shared/browser";

export const SETUP_AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
export const SETUP_OTHER_AGENT_ID = "7b0e2c44-3d2a-4c9e-9f6a-2f2d5a2b9c10";
export const SETUP_COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
export const SETUP_USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
export const SETUP_NOW = "2026-09-01T10:00:00.000Z";

export const SETUP_COMPUTER_IDENTITY = {
  computerId: SETUP_COMPUTER_ID,
  displayName: "Review Mac",
  platform: "darwin" as const,
};

export function setupAgent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: SETUP_AGENT_ID,
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: SETUP_NOW,
    updatedAt: SETUP_NOW,
    createdBy: { userId: SETUP_USER_ID, displayName: "Owner" },
    computer: SETUP_COMPUTER_IDENTITY,
    ...overrides,
  };
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function setupSlackConfiguration(
  bindingId?: string,
  preferredRecovery: "credentials" | "oauth" = "credentials",
): SlackConfigurationView {
  return {
    agentDisplayName: "Reviewer",
    eventsUrl: `https://qa.example/api/v1/agents/${SETUP_AGENT_ID}/im-binding/slack/events`,
    allowedIntent: bindingId ? "reauthorize" : "create",
    blockedReason: null,
    expectedMessaging: bindingId
      ? { kind: "bound", provider: "slack", bindingId, credentialGeneration: 1 }
      : { kind: "unbound" },
    preferredRecovery,
    binding: bindingId
      ? {
          id: bindingId,
          agentId: SETUP_AGENT_ID,
          provider: "slack",
          bindingState: "reauthorization_required",
          bot: { displayName: "Reviewer", avatarUrl: null },
          receiveMode: "mention_only",
          lastInboundAt: null,
          lastValidatedAt: null,
          lastRuntimeObservationAt: null,
          identity: {
            provider: "slack",
            appId: "A1",
            teamId: "T1",
            botUserId: "U1",
            enterpriseId: null,
            appIdEvidence: "configured",
          },
          credentialGeneration: 1,
          grantedCapabilities: [],
          reauthorizationRequired: true,
          lastErrorCode: null,
        }
      : null,
    identityClosure: bindingId ? { status: "pending", verifiedAt: null } : null,
    handoff: bindingId ? { bindingState: "reauthorization_required", handoffReady: false } : null,
  };
}

export function pendingSlackConfiguration(bindingId = SETUP_AGENT_ID): SlackConfigurationView {
  const view = setupSlackConfiguration(bindingId);
  if (!view.binding) throw new Error("Missing configuration fixture");
  return {
    ...view,
    binding: { ...view.binding, bindingState: "active", reauthorizationRequired: false },
    handoff: { bindingState: "active", handoffReady: false },
  };
}
