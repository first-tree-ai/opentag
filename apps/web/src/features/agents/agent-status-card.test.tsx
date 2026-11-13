import type { AgentDetail, AgentStatusSnapshot } from "@opentag/shared/browser";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { applyAgentStatus } from "./agent-model.js";
import { AgentStatusCard } from "./agent-status-card.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const computerId = "b71f9c2a-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
const updatedAt = "2026-08-20T00:00:00.000Z";

const agent: AgentDetail = {
  id: agentId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
  computer: { computerId, displayName: "Studio", platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: updatedAt,
  updatedAt,
  activity: { state: "idle" },
};

function rateLimited(): AgentStatusSnapshot {
  return {
    agentId,
    agentRevision: 1,
    agentUpdatedAt: updatedAt,
    agentStatus: "active",
    observedAt: updatedAt,
    checkedAt: updatedAt,
    state: "problem",
    reason: "credential_rate_limited",
    computer: {
      computerId,
      kind: "local",
      displayName: "Studio",
      platform: "darwin",
      online: true,
      lastSeenAt: updatedAt,
    },
    runtimeProvider: "codex",
    runtimeStatus: "ready",
    messaging: {
      id: "6a2a3f0e-7c1b-4a9d-9f2e-1b3c4d5e6f70",
      agentId,
      provider: "feishu",
      bindingState: "active",
      bot: { displayName: "Reviewer", avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: updatedAt,
      lastRuntimeObservationAt: null,
    },
  };
}

describe("AgentStatusCard", () => {
  /*
   * jsdom has no layout, so this pins the classes that keep the longest messaging verdict inside the
   * card at 320px: the status may shrink and its label may wrap. A headless Chromium check at
   * 320/390/768/1440px showed the label overflowing the card without them.
   */
  it("lets a long messaging verdict wrap inside a narrow card", () => {
    render(<AgentStatusCard agent={applyAgentStatus(agent, rateLimited())} />);
    const label = screen.getByText("Messaging credential check rate limited");
    expect(label.getAttribute("data-ui")).toBe("agent-status-label");
    expect(label.className).not.toContain("whitespace-nowrap");
    expect(label.className).toContain("[overflow-wrap:anywhere]");
    const status = label.parentElement;
    expect(status?.className).toContain("min-w-0");
    expect(status?.className).not.toContain("shrink-0");
  });
});
