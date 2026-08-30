import type {
  AccountComputerSummary,
  AgentSummary,
  ImBindingHandoffStatus,
  ImBindingState,
  ImBindingSummary,
  ProviderReadinessStatus,
} from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import type { AgentDetailView, AgentListItem } from "./agent-model.js";
import { markAgentDetailUnconfirmed, markAgentListUnconfirmed, projectAgentAvailability } from "./agent-model.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const computerId = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const bindingId = "c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f";

function agent(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: agentId,
    name: "reviewer",
    displayName: "Reviewer",
    createdBy: { userId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d", displayName: "Ada" },
    computer: { computerId, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

function computer(overrides: Partial<AccountComputerSummary> = {}): AccountComputerSummary {
  return {
    computerId,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "online",
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
    connectedAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T00:01:00.000Z",
    observedAt: "2026-08-20T00:01:00.000Z",
    createdAt: "2026-08-19T00:00:00.000Z",
    agentIds: [agentId],
    ...overrides,
  };
}

function binding(bindingState: ImBindingState = "active"): ImBindingSummary {
  return {
    id: bindingId,
    agentId,
    provider: "feishu",
    bindingState,
    bot: { displayName: "Reviewer", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: "2026-08-20T00:00:30.000Z",
    lastRuntimeObservationAt: "2026-08-20T00:00:45.000Z",
  };
}

const handoffReady: ImBindingHandoffStatus = { bindingState: "active", handoffReady: true };
const handoffNotReady: ImBindingHandoffStatus = { bindingState: "active", handoffReady: false };

/** Every argument set to the values that reach the `ready` outcome, so a case varies only what it tests. */
function ready(): Parameters<typeof projectAgentAvailability> {
  return [agent(), computer(), binding(), handoffReady, true, true];
}

describe("projectAgentAvailability", () => {
  it("reports ready once the Computer, runtime, binding and handoff all confirm", () => {
    const availability = projectAgentAvailability(...ready());
    expect(availability.state).toBe("ready");
    expect(availability.reason).toBeNull();
    expect(availability.lastConfirmedAt).toBe("2026-08-20T00:00:45.000Z");
    expect(availability.dependencies).toEqual({
      computer: { state: "ready", lastConfirmedAt: "2026-08-20T00:01:00.000Z" },
      runtime: { provider: "codex", status: "ready" },
      handoff: { state: "ready", lastConfirmedAt: "2026-08-20T00:00:45.000Z" },
      channel: { state: "connected", provider: "feishu", botDisplayName: "Reviewer" },
    });
  });

  it("reports a suspended Agent before reading any dependency", () => {
    // Suspension outranks every other signal: the arguments below would otherwise be `computer_unconfirmed`.
    const availability = projectAgentAvailability(
      agent({ status: "suspended", updatedAt: "2026-08-21T00:00:00.000Z" }),
      undefined,
      undefined,
      undefined,
      false,
      false,
    );
    expect(availability).toMatchObject({
      state: "suspended",
      reason: "agent_suspended",
      lastConfirmedAt: "2026-08-21T00:00:00.000Z",
    });
  });

  it("cannot confirm anything without the Computer", () => {
    const [, , summary, handoff] = ready();
    const availability = projectAgentAvailability(agent(), undefined, summary, handoff, true, true);
    expect(availability).toMatchObject({ state: "unconfirmed", reason: "computer_unconfirmed", lastConfirmedAt: null });
    expect(availability.dependencies.computer).toEqual({ state: "unconfirmed", lastConfirmedAt: null });
  });

  it("asks for action while the Computer is offline, and dates it from the last sighting", () => {
    const [, , summary, handoff] = ready();
    const availability = projectAgentAvailability(
      agent(),
      computer({ connectionStatus: "offline" }),
      summary,
      handoff,
      true,
      true,
    );
    expect(availability).toMatchObject({
      state: "action_required",
      reason: "computer_offline",
      lastConfirmedAt: "2026-08-20T00:01:00.000Z",
    });
    expect(availability.dependencies.computer.state).toBe("action_required");
  });

  it("cannot confirm the runtime when the Computer reports no readiness for the Agent's Provider", () => {
    const [, , summary, handoff] = ready();
    const availability = projectAgentAvailability(
      agent(),
      computer({ providerReadiness: [{ provider: "claude-code", status: "ready", observedAt: null }] }),
      summary,
      handoff,
      true,
      true,
    );
    expect(availability).toMatchObject({ state: "unconfirmed", reason: "runtime_unconfirmed" });
    expect(availability.dependencies.runtime).toEqual({ provider: "codex", status: null });
  });

  it.each<ProviderReadinessStatus>(["checking", "install", "sign-in", "unavailable"])(
    "asks for action while the Provider reports %s",
    (status) => {
      const [, , summary, handoff] = ready();
      const availability = projectAgentAvailability(
        agent(),
        computer({ providerReadiness: [{ provider: "codex", status, observedAt: null }] }),
        summary,
        handoff,
        true,
        true,
      );
      expect(availability).toMatchObject({ state: "action_required", reason: "runtime_unavailable" });
      expect(availability.dependencies.runtime).toEqual({ provider: "codex", status });
    },
  );

  it.each([
    ["the binding read failed", false, true],
    ["the handoff read failed", true, false],
    ["both reads failed", false, false],
  ])("cannot confirm the handoff when %s", (_label, bindingConfirmed, handoffConfirmed) => {
    const availability = projectAgentAvailability(
      agent(),
      computer(),
      binding(),
      handoffReady,
      bindingConfirmed,
      handoffConfirmed,
    );
    expect(availability).toMatchObject({ state: "unconfirmed", reason: "handoff_unconfirmed" });
    expect(availability.dependencies.handoff.state).toBe("unconfirmed");
  });

  it("keeps the channel confirmed when only the handoff read failed", () => {
    // Channel state answers a narrower question than handoff state, so one failing read does not blank both.
    const availability = projectAgentAvailability(agent(), computer(), binding(), undefined, true, false);
    expect(availability.dependencies.channel).toEqual({
      state: "connected",
      provider: "feishu",
      botDisplayName: "Reviewer",
    });
  });

  it("reports no messaging when the reads succeeded and found no binding", () => {
    const availability = projectAgentAvailability(agent(), computer(), undefined, undefined, true, true);
    expect(availability).toMatchObject({ state: "not_connected", reason: "im_not_connected", lastConfirmedAt: null });
    expect(availability.dependencies.handoff.state).toBe("not_connected");
    expect(availability.dependencies.channel).toEqual({
      state: "not_connected",
      provider: null,
      botDisplayName: null,
    });
  });

  it("reports setting up while the binding is provisioning", () => {
    const availability = projectAgentAvailability(
      agent(),
      computer(),
      binding("provisioning"),
      { bindingState: "provisioning", handoffReady: false },
      true,
      true,
    );
    expect(availability).toMatchObject({
      state: "setting_up",
      reason: "im_provisioning",
      lastConfirmedAt: "2026-08-20T00:00:45.000Z",
    });
    expect(availability.dependencies.handoff.state).toBe("setting_up");
  });

  it("asks for action when the binding needs reauthorization", () => {
    const availability = projectAgentAvailability(
      agent(),
      computer(),
      binding("reauthorization_required"),
      { bindingState: "reauthorization_required", handoffReady: false },
      true,
      true,
    );
    expect(availability).toMatchObject({ state: "action_required", reason: "im_reauthorization_required" });
  });

  // Both ask for action, but only one of them has a connection failure to name.
  it.each([
    { bindingState: "error", reason: "im_error" },
    { bindingState: "disabled", reason: "im_disabled" },
  ] as const)("asks for action when the binding is $bindingState", ({ bindingState, reason }) => {
    const availability = projectAgentAvailability(
      agent(),
      computer(),
      binding(bindingState),
      { bindingState, handoffReady: false },
      true,
      true,
    );
    expect(availability).toMatchObject({ state: "action_required", reason });
  });

  it.each([
    ["the handoff reports it is not ready", handoffNotReady],
    ["the handoff is absent", undefined],
  ])("asks for action when %s on an active binding", (_label, handoff) => {
    const availability = projectAgentAvailability(agent(), computer(), binding(), handoff, true, true);
    expect(availability).toMatchObject({ state: "action_required", reason: "handoff_unavailable" });
    expect(availability.dependencies.handoff.state).toBe("action_required");
  });

  it("falls back to the last validation when no runtime observation was recorded", () => {
    const availability = projectAgentAvailability(
      agent(),
      computer(),
      { ...binding(), lastRuntimeObservationAt: null },
      handoffReady,
      true,
      true,
    );
    expect(availability.lastConfirmedAt).toBe("2026-08-20T00:00:30.000Z");
  });
});

describe("markAgentListUnconfirmed", () => {
  it("keeps the Agents but withdraws the claim that their state was observed", () => {
    const listItem: AgentListItem = {
      ...agent(),
      activity: { state: "idle" },
      usage: { windowDays: 30, tasks: 32, failed: 0, tokens: 428_000 },
      availability: projectAgentAvailability(...ready()),
      evidenceConfirmed: true,
    };

    const marked = markAgentListUnconfirmed({ agents: [listItem] });

    expect(marked.agents).toHaveLength(1);
    expect(marked.agents[0]).toMatchObject({
      id: agentId,
      displayName: "Reviewer",
      evidenceConfirmed: false,
      availability: { state: "unconfirmed", reason: "agent_unconfirmed", lastConfirmedAt: null },
    });
    // The dependency detail is left as last seen; only the top-level claim is withdrawn.
    expect(marked.agents[0]?.availability.dependencies).toEqual(listItem.availability.dependencies);
  });
});

describe("markAgentDetailUnconfirmed", () => {
  it("withdraws the messaging evidence and every dependency the Server had to confirm", () => {
    const detail: AgentDetailView = {
      ...agent(),
      activity: { state: "idle" },
      messaging: { kind: "ready", value: binding() },
      availability: projectAgentAvailability(...ready()),
    };

    const marked = markAgentDetailUnconfirmed(detail);

    expect(marked.messaging).toEqual({ kind: "unconfirmed" });
    expect(marked.availability).toMatchObject({
      state: "unconfirmed",
      reason: "agent_unconfirmed",
      lastConfirmedAt: null,
    });
    expect(marked.availability.dependencies).toEqual({
      computer: { state: "unconfirmed", lastConfirmedAt: null },
      // The Provider observation is a fact the Computer reported, not a claim about right now.
      runtime: { provider: "codex", status: "ready" },
      handoff: { state: "unconfirmed", lastConfirmedAt: null },
      channel: { state: "unconfirmed", provider: "feishu", botDisplayName: "Reviewer" },
    });
  });
});
