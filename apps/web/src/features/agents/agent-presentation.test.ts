import type { AccountComputerSummary, AgentDetail, ImBindingSummary } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import type { AgentAvailability, AgentDetailView } from "./agent-model.js";
import { projectAgentAvailability } from "./agent-model.js";
import {
  agentAvailabilityRecovery,
  agentComputerStatus,
  agentRecoveryMessage,
  agentSetupContinuation,
  agentStatusPresentation,
  computerRecoveryMessage,
} from "./agent-presentation.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";

function agentWithoutComputer(): AgentDetail {
  return {
    id: agentId,
    name: "reviewer",
    displayName: "Reviewer",
    createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
    computer: null,
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    activity: { state: "idle" },
  };
}

function unbound(): AgentDetailView {
  const agent = agentWithoutComputer();
  return {
    ...agent,
    availability: projectAgentAvailability(agent, undefined, undefined, undefined, true, true),
    messaging: { kind: "ready", value: undefined },
  };
}

describe("An Agent with no Computer, as the viewer reads it", () => {
  it("names the state and gives its status row one canonical setup exit", () => {
    const agent = unbound();

    expect(agentStatusPresentation(agent)).toEqual({ label: "No Computer", tone: "warning" });
    expect(agentComputerStatus(agent)).toEqual({
      action: {
        label: "Continue setup",
        link: { search: { agentId }, to: "/agents/setup" },
      },
      label: "No Computer",
      tone: "warning",
    });
    // The broader recovery helper still names the Settings operation; the detail status row owns
    // the one user-facing setup entry.
    expect(agentAvailabilityRecovery(agent)).toEqual({
      label: "Connect a Computer",
      link: { params: { agentId, section: "computer" }, to: "/agents/$agentId/settings/$section" },
    });
    expect(agentRecoveryMessage(agent)).toBe("This Agent has no Computer. Connect one to give it somewhere to run.");
    // The Computer panel says the same thing without naming a machine, because there is none to name.
    expect(computerRecoveryMessage(agent)).toBe(
      "This Agent is not connected to a Computer yet. Connect one to give it somewhere to run.",
    );
  });
});

const computerId = "b71f9c2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c";

function boundAgent(): AgentDetail {
  return { ...agentWithoutComputer(), computer: { computerId, displayName: "Studio", platform: "darwin" } };
}

function onlineComputer(runtimeStatus: "ready" | "install"): AccountComputerSummary {
  return {
    computerId,
    displayName: "Studio",
    platform: "darwin",
    connectionStatus: "online",
    providerReadiness: [{ provider: "codex", status: runtimeStatus, observedAt: "2026-08-20T00:00:00.000Z" }],
    connectedAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T00:00:00.000Z",
    observedAt: "2026-08-20T00:00:00.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    agentIds: [agentId],
  };
}

function messagingBinding(bindingState: ImBindingSummary["bindingState"]): ImBindingSummary {
  return {
    id: "6a2a3f0e-7c1b-4a9d-9f2e-1b3c4d5e6f70",
    agentId,
    provider: "feishu",
    bindingState,
    bot: { displayName: "Reviewer", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: "2026-08-20T00:00:00.000Z",
    lastRuntimeObservationAt: null,
  };
}

function bound(connectionStatus: "online" | "offline", runtimeStatus: "ready" | "install"): AgentAvailability {
  const computer: AccountComputerSummary = { ...onlineComputer(runtimeStatus), connectionStatus };
  return projectAgentAvailability(boundAgent(), computer, undefined, undefined, true, true);
}

describe("Finishing setup, offered from the Agent list", () => {
  const setupLink = { label: "Continue setup", link: { search: { agentId }, to: "/agents/setup" } };

  it("offers the setup page for every reason setup still owns", () => {
    expect(agentSetupContinuation(unbound())).toEqual(setupLink);
    expect(agentSetupContinuation({ availability: bound("online", "install"), id: agentId })).toEqual(setupLink);
    expect(agentSetupContinuation({ availability: bound("online", "ready"), id: agentId })).toEqual(setupLink);
  });

  it("covers the same reasons the Agent page sends to setup rather than to Settings", () => {
    /*
     * A messaging connect left mid-scan, and a connected channel whose Computer has not made the
     * provider CLI ready, are both the messaging step unfinished. The Agent page already routes
     * them to setup; a list that stayed narrower would hide the same exit from the same state.
     */
    const provisioning = projectAgentAvailability(
      boundAgent(),
      onlineComputer("ready"),
      messagingBinding("provisioning"),
      undefined,
      true,
      true,
    );
    const handoffUnavailable = projectAgentAvailability(
      boundAgent(),
      onlineComputer("ready"),
      messagingBinding("active"),
      { bindingState: "active", handoffReady: false },
      true,
      true,
    );

    expect(provisioning.reason).toBe("im_provisioning");
    expect(handoffUnavailable.reason).toBe("handoff_unavailable");
    expect(agentSetupContinuation({ availability: provisioning, id: agentId })).toEqual(setupLink);
    expect(agentSetupContinuation({ availability: handoffUnavailable, id: agentId })).toEqual(setupLink);
  });

  it("stays silent when setup finished and a dependency broke afterwards", () => {
    // An unreachable machine is not an unfinished setup: the answer is that Agent's own page, where
    // the dependency that broke is named. Sending this reader back to setup would restate a flow
    // they have already been through, for a problem it does not describe.
    expect(agentSetupContinuation({ availability: bound("offline", "ready"), id: agentId })).toBeUndefined();
  });
});
