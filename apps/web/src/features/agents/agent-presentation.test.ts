import type { AgentDetail } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import type { AgentDetailView } from "./agent-model.js";
import { projectAgentAvailability } from "./agent-model.js";
import {
  agentAvailabilityRecovery,
  agentComputerStatus,
  agentStatusPresentation,
  computerRecoveryMessage,
} from "./agent-presentation.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";

function unbound(): AgentDetailView {
  const agent: AgentDetail = {
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
    // The Computer panel says the same thing without naming a machine, because there is none to name.
    expect(computerRecoveryMessage(agent)).toBe(
      "This Agent is not connected to a Computer yet. Connect one to give it somewhere to run.",
    );
  });
});
