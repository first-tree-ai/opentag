import { describe, expect, it } from "vitest";
import {
  AGENT_CREATION_RECOVERY_ACTIONS,
  AGENT_SETUP_ACTION_KINDS,
  AgentCreationRecoveryActionSchema,
  AgentSetupSlackOAuthContextSchema,
  AgentSetupSnapshotSchema,
} from "../agent-setup.js";
import { AGENT_SETUP_TEMPLATE, agentSetupPath } from "../http-paths.js";

const agentId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const computerId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";
const observedAt = "2026-09-01T10:00:00.000Z";

const computerIdentity = {
  computerId,
  displayName: "Review Mac",
  platform: "darwin" as const,
};

function agent(computer: typeof computerIdentity | null, requiresComputerRebind?: boolean) {
  return {
    id: agentId,
    name: "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex" as const,
    receiveMode: "mention_only" as const,
    status: "active" as const,
    createdAt: observedAt,
    updatedAt: observedAt,
    createdBy: { userId, displayName: "Owner" },
    computer,
    ...(requiresComputerRebind === undefined ? {} : { requiresComputerRebind }),
  };
}

function boundComputer(connectionStatus: "online" | "offline" = "online") {
  return {
    kind: "bound" as const,
    ...computerIdentity,
    connectionStatus,
    lastSeenAt: observedAt,
    observedAt,
  };
}

describe("Agent setup contracts", () => {
  it("defines one exact-Agent setup route", () => {
    expect(AGENT_SETUP_TEMPLATE).toBe("/api/v1/agents/:agentId/setup");
    expect(agentSetupPath("agent/one")).toBe("/api/v1/agents/agent%2Fone/setup");
  });

  it("freezes explicit actions without a direct Provider switch", () => {
    expect(AGENT_SETUP_ACTION_KINDS).toEqual([
      "refresh",
      "bind-computer",
      "repair-computer",
      "start-messaging",
      "cancel-messaging-attempt",
      "reauthorize-messaging",
      "replace-messaging",
      "unbind-messaging",
    ]);
    expect(AGENT_SETUP_ACTION_KINDS).not.toContain("switch-messaging");
  });

  it("freezes explicit creation-intent recovery", () => {
    expect(AGENT_CREATION_RECOVERY_ACTIONS).toEqual(["check-result", "retry", "discard"]);
    for (const action of AGENT_CREATION_RECOVERY_ACTIONS) {
      expect(AgentCreationRecoveryActionSchema.parse(action)).toBe(action);
    }
    expect(() => AgentCreationRecoveryActionSchema.parse("resume")).toThrow();
  });

  it("accepts the canonical setup stage matrix", () => {
    const scenarios = [
      {
        name: "unbound Computer",
        snapshot: {
          agent: agent(null),
          stage: "needs-computer",
          computer: { kind: "not-bound" },
          runtime: { kind: "unavailable", provider: "codex", reason: "computer-not-bound" },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "computer-not-bound" }],
          actions: [{ kind: "bind-computer" }],
          observedAt,
        },
      },
      {
        name: "runtime install required",
        snapshot: {
          agent: agent(computerIdentity),
          stage: "needs-runtime",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "install", observedAt },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "runtime-not-ready", provider: "codex", status: "install" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        },
      },
      {
        name: "Messaging not configured",
        snapshot: {
          agent: agent(computerIdentity),
          stage: "needs-messaging",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "messaging-not-configured" }],
          actions: [
            { kind: "start-messaging", provider: "feishu" },
            { kind: "start-messaging", provider: "slack" },
          ],
          observedAt,
        },
      },
      {
        name: "ready Slack binding",
        snapshot: {
          agent: agent(computerIdentity),
          stage: "ready",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "ready", provider: "slack", bindingId },
          blockers: [],
          actions: [
            { kind: "reauthorize-messaging", provider: "slack", bindingId },
            { kind: "unbind-messaging", provider: "slack", bindingId },
          ],
          observedAt,
        },
      },
      {
        name: "Feishu authorization in progress",
        snapshot: {
          agent: agent(computerIdentity),
          stage: "needs-messaging",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: {
            kind: "authorizing",
            provider: "feishu",
            attemptId,
            qrUrl: "https://accounts.feishu.cn/device",
            expiresAt: "2026-09-01T10:10:00.000Z",
          },
          blockers: [{ code: "messaging-not-ready", provider: "feishu", state: "authorizing" }],
          actions: [{ kind: "cancel-messaging-attempt", provider: "feishu", attemptId }],
          observedAt,
        },
      },
    ] as const;

    for (const scenario of scenarios) {
      expect(AgentSetupSnapshotSchema.parse(scenario.snapshot), scenario.name).toEqual(scenario.snapshot);
    }
  });

  it("rejects a direct cross-Provider start while a binding is current", () => {
    const snapshot = {
      agent: agent(computerIdentity),
      stage: "ready",
      computer: boundComputer(),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "ready", provider: "slack", bindingId },
      blockers: [],
      actions: [{ kind: "start-messaging", provider: "feishu" }],
      observedAt,
    };
    expect(() => AgentSetupSnapshotSchema.parse(snapshot)).toThrow(
      "A Provider can be started only after canonical state is not-configured",
    );
  });

  it("rejects stale binding actions and mismatched Agent facts", () => {
    const staleBindingId = "66666666-6666-4666-8666-666666666666";
    const ready = {
      agent: agent(computerIdentity),
      stage: "ready",
      computer: boundComputer(),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "ready", provider: "slack", bindingId },
      blockers: [],
      actions: [{ kind: "unbind-messaging", provider: "slack", bindingId: staleBindingId }],
      observedAt,
    };
    expect(() => AgentSetupSnapshotSchema.parse(ready)).toThrow(
      "Binding actions must name the current Provider and binding identity",
    );
    expect(() =>
      AgentSetupSnapshotSchema.parse({
        ...ready,
        actions: [],
        computer: { ...boundComputer(), computerId: staleBindingId },
      }),
    ).toThrow("The setup Computer must match the exact Agent binding");
  });

  it("fences Slack OAuth to an exact Agent, intent, return surface, and expected binding state", () => {
    const create = {
      agentId,
      intent: "create",
      returnSurface: "agent-setup",
      expectedMessaging: { kind: "unbound" },
    };
    expect(AgentSetupSlackOAuthContextSchema.parse(create)).toEqual(create);

    const reauthorize = {
      agentId,
      intent: "reauthorize",
      returnSurface: "agent-messaging-settings",
      expectedMessaging: { kind: "bound", provider: "slack", bindingId, credentialGeneration: 3 },
    };
    expect(AgentSetupSlackOAuthContextSchema.parse(reauthorize)).toEqual(reauthorize);

    expect(() =>
      AgentSetupSlackOAuthContextSchema.parse({
        ...create,
        expectedMessaging: { kind: "bound", provider: "feishu", bindingId, credentialGeneration: 1 },
      }),
    ).toThrow("Slack create requires the Agent to remain unbound");
    expect(() => AgentSetupSlackOAuthContextSchema.parse({ ...create, returnUrl: "https://example.com" })).toThrow();
    expect(() => AgentSetupSlackOAuthContextSchema.parse({ ...create, setupSessionId: crypto.randomUUID() })).toThrow();
  });
});
