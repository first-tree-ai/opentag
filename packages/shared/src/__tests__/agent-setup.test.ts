import { describe, expect, it } from "vitest";
import {
  AGENT_CREATION_RECOVERY_ACTIONS,
  AGENT_SETUP_ACTION_KINDS,
  AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS,
  AgentCreationRecoveryActionSchema,
  AgentSetupSlackOAuthContextSchema,
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  projectAgentSetupComponents,
} from "../agent-setup.js";
import {
  AGENT_SETUP_REFRESH_TEMPLATE,
  AGENT_SETUP_TEMPLATE,
  agentSetupPath,
  agentSetupRefreshPath,
} from "../http-paths.js";

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

type CliReadinessEntry = {
  provider: "feishu" | "slack";
  status: "checking" | "install" | "ready" | "unavailable";
  observedAt: string | null;
};

const bothCliReady: CliReadinessEntry[] = [
  { provider: "feishu", status: "ready", observedAt },
  { provider: "slack", status: "ready", observedAt },
];

function boundComputer(
  connectionStatus: "online" | "offline" = "online",
  imCliReadiness: CliReadinessEntry[] = bothCliReady,
) {
  return {
    kind: "bound" as const,
    ...computerIdentity,
    connectionStatus,
    imCliReadiness,
    lastSeenAt: observedAt,
    observedAt,
  };
}

/** Completes an otherwise canonical snapshot with the required Providers and derived components. */
function canonical(snapshot: Omit<AgentSetupSnapshot, "requiredImCliProviders" | "components">): AgentSetupSnapshot {
  const requiredImCliProviders = [...AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS];
  return {
    ...snapshot,
    requiredImCliProviders,
    components: projectAgentSetupComponents({
      computer: snapshot.computer,
      runtime: snapshot.runtime,
      messaging: snapshot.messaging,
      requiredImCliProviders,
    }),
  };
}

describe("Agent setup contracts", () => {
  it("defines one exact-Agent setup route", () => {
    expect(AGENT_SETUP_TEMPLATE).toBe("/api/v1/agents/:agentId/setup");
    expect(agentSetupPath("agent/one")).toBe("/api/v1/agents/agent%2Fone/setup");
    expect(AGENT_SETUP_REFRESH_TEMPLATE).toBe("/api/v1/agents/:agentId/setup/refresh");
    expect(agentSetupRefreshPath("agent/one")).toBe("/api/v1/agents/agent%2Fone/setup/refresh");
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
        snapshot: canonical({
          agent: agent(null),
          stage: "needs-computer",
          computer: { kind: "not-bound" },
          runtime: { kind: "unavailable", provider: "codex", reason: "computer-not-bound" },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "computer-not-bound" }],
          actions: [{ kind: "bind-computer" }],
          observedAt,
        }),
      },
      {
        name: "runtime install required",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-runtime",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "install", observedAt },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "runtime-not-ready", provider: "codex", status: "install" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "runtime report missing",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-runtime",
          computer: boundComputer(),
          runtime: { kind: "waiting", provider: "codex" },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "runtime-not-ready", provider: "codex", status: "waiting" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "Computer observation failed",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-computer",
          computer: { kind: "observation-failed", ...computerIdentity },
          runtime: { kind: "unavailable", provider: "codex", reason: "computer-observation-failed" },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "resource-observation-failed", resource: "computer" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "runtime observation failed",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-runtime",
          computer: boundComputer(),
          runtime: { kind: "observation-failed", provider: "codex" },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "resource-observation-failed", resource: "runtime" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "both required Provider CLIs missing",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-provider-clis",
          computer: boundComputer("online", []),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "not-configured" },
          blockers: [
            { code: "provider-cli-not-ready", provider: "feishu", status: "waiting" },
            { code: "provider-cli-not-ready", provider: "slack", status: "waiting" },
          ],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "required Slack CLI still installing",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-provider-clis",
          computer: boundComputer("online", [
            { provider: "feishu", status: "ready", observedAt },
            { provider: "slack", status: "install", observedAt },
          ]),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "not-configured" },
          blockers: [{ code: "provider-cli-not-ready", provider: "slack", status: "install" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "evidence-less CLI reports read as missing",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-provider-clis",
          computer: boundComputer("online", [
            { provider: "feishu", status: "ready", observedAt: null },
            { provider: "slack", status: "checking", observedAt: null },
          ]),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "not-configured" },
          blockers: [
            { code: "provider-cli-not-ready", provider: "feishu", status: "waiting" },
            { code: "provider-cli-not-ready", provider: "slack", status: "waiting" },
          ],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "Messaging not configured",
        snapshot: canonical({
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
        }),
      },
      {
        name: "ready Slack binding",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "ready",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "ready", provider: "slack", bindingId, credentialGeneration: 3 },
          blockers: [],
          actions: [
            { kind: "reauthorize-messaging", provider: "slack", bindingId, credentialGeneration: 3 },
            { kind: "unbind-messaging", provider: "slack", bindingId },
          ],
          observedAt,
        }),
      },
      {
        name: "ready Messaging with an unselected CLI report missing",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "ready",
          computer: boundComputer("online", [{ provider: "slack", status: "ready", observedAt }]),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "ready", provider: "slack", bindingId, credentialGeneration: 3 },
          blockers: [],
          actions: [
            { kind: "reauthorize-messaging", provider: "slack", bindingId, credentialGeneration: 3 },
            { kind: "unbind-messaging", provider: "slack", bindingId },
          ],
          observedAt,
        }),
      },
      {
        name: "Messaging observation failed",
        snapshot: canonical({
          agent: agent(computerIdentity),
          stage: "needs-messaging",
          computer: boundComputer(),
          runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
          messaging: { kind: "observation-failed" },
          blockers: [{ code: "resource-observation-failed", resource: "messaging" }],
          actions: [{ kind: "refresh" }],
          observedAt,
        }),
      },
      {
        name: "Feishu authorization in progress",
        snapshot: canonical({
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
        }),
      },
    ] as const;

    for (const scenario of scenarios) {
      expect(AgentSetupSnapshotSchema.parse(scenario.snapshot), scenario.name).toEqual(scenario.snapshot);
    }
  });

  it("rejects a direct cross-Provider start while a binding is current", () => {
    const snapshot = canonical({
      agent: agent(computerIdentity),
      stage: "ready",
      computer: boundComputer(),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "ready", provider: "slack", bindingId, credentialGeneration: 3 },
      blockers: [],
      actions: [{ kind: "start-messaging", provider: "feishu" }],
      observedAt,
    });
    expect(() => AgentSetupSnapshotSchema.parse(snapshot)).toThrow(
      "A Provider can be started only after canonical state is not-configured",
    );
  });

  it("rejects a start before the required IM CLI preparation gate has passed", () => {
    const snapshot = canonical({
      agent: agent(computerIdentity),
      stage: "needs-provider-clis",
      computer: boundComputer("online", []),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "not-configured" },
      blockers: [
        { code: "provider-cli-not-ready", provider: "feishu", status: "waiting" },
        { code: "provider-cli-not-ready", provider: "slack", status: "waiting" },
      ],
      actions: [{ kind: "start-messaging", provider: "feishu" }],
      observedAt,
    });
    expect(() => AgentSetupSnapshotSchema.parse(snapshot)).toThrow(
      "A Provider can be started only after the required IM CLI preparation gate has passed",
    );
  });

  it("rejects unknown, duplicate, or wrongly ordered required IM CLI Providers", () => {
    const base = canonical({
      agent: agent(computerIdentity),
      stage: "needs-messaging",
      computer: boundComputer(),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "not-configured" },
      blockers: [{ code: "messaging-not-configured" }],
      actions: [{ kind: "start-messaging", provider: "feishu" }],
      observedAt,
    });
    expect(() => AgentSetupSnapshotSchema.parse({ ...base, requiredImCliProviders: ["feishu", "teams"] })).toThrow(
      /Invalid option/,
    );
    expect(() => AgentSetupSnapshotSchema.parse({ ...base, requiredImCliProviders: ["feishu", "feishu"] })).toThrow(
      "Required IM CLI Providers must be exactly the canonical set in canonical order, without duplicates",
    );
    expect(() => AgentSetupSnapshotSchema.parse({ ...base, requiredImCliProviders: ["slack", "feishu"] })).toThrow(
      "Required IM CLI Providers must be exactly the canonical set in canonical order, without duplicates",
    );
  });

  it("rejects component projections that drift from Computer, runtime, or Messaging facts", () => {
    const base = canonical({
      agent: agent(computerIdentity),
      stage: "needs-provider-clis",
      computer: boundComputer("online", []),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "not-configured" },
      blockers: [
        { code: "provider-cli-not-ready", provider: "feishu", status: "waiting" },
        { code: "provider-cli-not-ready", provider: "slack", status: "waiting" },
      ],
      actions: [{ kind: "refresh" }],
      observedAt,
    });
    const driftingComponents = base.components.map((component) =>
      component.kind === "im-cli" && component.provider === "feishu"
        ? { ...component, status: "checking" as const, blocking: false }
        : component,
    );
    expect(() =>
      AgentSetupSnapshotSchema.parse({
        ...base,
        components: driftingComponents,
        blockers: [{ code: "provider-cli-not-ready", provider: "feishu", status: "checking" }],
      }),
    ).toThrow(
      "Components must project the exact Computer, runtime Provider, and required IM CLI readiness in canonical order",
    );
  });

  it("rejects a Messaging snapshot that falsely advanced on evidence-less ready CLI reports", () => {
    // Both CLI rows claim ready without an observation time: the gate must read them as missing,
    // so a needs-messaging stage with start actions is not a legal snapshot.
    const base = canonical({
      agent: agent(computerIdentity),
      stage: "needs-messaging",
      computer: boundComputer("online", [
        { provider: "feishu", status: "ready", observedAt: null },
        { provider: "slack", status: "ready", observedAt: null },
      ]),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "not-configured" },
      blockers: [{ code: "messaging-not-configured" }],
      actions: [
        { kind: "start-messaging", provider: "feishu" },
        { kind: "start-messaging", provider: "slack" },
      ],
      observedAt,
    });
    expect(() => AgentSetupSnapshotSchema.parse(base)).toThrow(/Stage must be derived/);
    expect(() => AgentSetupSnapshotSchema.parse(base)).toThrow(/required IM CLI preparation gate has passed/);
  });

  it("rejects Provider CLI blockers outside the needs-provider-clis stage", () => {
    const base = canonical({
      agent: agent(computerIdentity),
      stage: "needs-messaging",
      computer: boundComputer(),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "not-configured" },
      blockers: [{ code: "messaging-not-configured" }],
      actions: [{ kind: "start-messaging", provider: "feishu" }],
      observedAt,
    });
    expect(() =>
      AgentSetupSnapshotSchema.parse({
        ...base,
        blockers: [
          { code: "messaging-not-configured" },
          { code: "provider-cli-not-ready", provider: "slack", status: "waiting" },
        ],
      }),
    ).toThrow("Provider CLI blockers apply only while the setup waits on required IM CLI readiness");
  });

  it("rejects stale binding actions and mismatched Agent facts", () => {
    const staleBindingId = "66666666-6666-4666-8666-666666666666";
    const ready = canonical({
      agent: agent(computerIdentity),
      stage: "ready",
      computer: boundComputer(),
      runtime: { kind: "observed", provider: "codex", status: "ready", observedAt },
      messaging: { kind: "ready", provider: "slack", bindingId, credentialGeneration: 3 },
      blockers: [],
      actions: [{ kind: "unbind-messaging", provider: "slack", bindingId: staleBindingId }],
      observedAt,
    });
    expect(() => AgentSetupSnapshotSchema.parse(ready)).toThrow(
      "Binding actions must name the current Provider and binding identity",
    );
    expect(() =>
      AgentSetupSnapshotSchema.parse({
        ...ready,
        actions: [{ kind: "reauthorize-messaging", provider: "slack", bindingId, credentialGeneration: 2 }],
      }),
    ).toThrow("Binding authorization actions must name the current credential generation");
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
