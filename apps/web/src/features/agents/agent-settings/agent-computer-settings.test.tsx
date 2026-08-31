import type { AgentAdminConfig, AgentDetail, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import type { AgentDetailView } from "../agent-model.js";
import { projectAgentAvailability } from "../agent-model.js";
import { AgentComputerSettings } from "./agent-computer-settings.js";

const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const computerId = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";

const computer: WorkspaceComputerSummary = {
  computerId,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:01:00.000Z",
  observedAt: "2026-08-20T00:01:00.000Z",
  enrolledAt: "2026-08-19T00:00:00.000Z",
  agentIds: [],
};

const unboundAgent: AgentDetail = {
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

const boundConfig: AgentAdminConfig = {
  id: agentId,
  createdByUserId: unboundAgent.createdBy.userId,
  computerId,
  name: unboundAgent.name,
  displayName: unboundAgent.displayName,
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 2,
  runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  createdAt: unboundAgent.createdAt,
  updatedAt: unboundAgent.updatedAt,
};

function view(agent: AgentDetail, evidence: WorkspaceComputerSummary | undefined): AgentDetailView {
  return {
    ...agent,
    availability: projectAgentAvailability(agent, evidence, undefined, undefined, true, true),
    messaging: { kind: "ready", value: undefined },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("An Agent with no Computer", () => {
  it("offers a Computer the Account already connected and binds the Agent to the chosen one", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);
    const onAgentChanged = vi.fn();

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={onAgentChanged} />,
    );

    expect(await screen.findByRole("heading", { name: "No Computer connected" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Use Ada's Mac" }));

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(agentId, computerId));
    await waitFor(() => expect(onAgentChanged).toHaveBeenCalled());
  });

  it("reports a failed binding instead of leaving the Agent looking connected", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    vi.spyOn(browserApi, "rebindAgentComputer").mockRejectedValue(new Error("The requested Computer was not found"));
    const onAgentChanged = vi.fn();

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={onAgentChanged} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Use Ada's Mac" }));

    expect(await screen.findByText("The requested Computer was not found")).toBeTruthy();
    expect(onAgentChanged).not.toHaveBeenCalled();
  });

  it("keeps showing the bound Computer's own panel once one is connected", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const bound: AgentDetail = {
      ...unboundAgent,
      computer: { computerId, displayName: computer.displayName, platform: computer.platform },
    };

    await renderInRouter(<AgentComputerSettings agent={view(bound, computer)} onAgentChanged={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use Ada's Mac" })).toBeNull();
  });
});
