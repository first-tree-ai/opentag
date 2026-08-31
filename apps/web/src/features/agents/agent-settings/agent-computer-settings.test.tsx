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
const secondAgentId = "5c4b3a2d-1e0f-4998-8877-66554433221a";

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
  it("gives the Agent the Computer this Account has, without asking which", async () => {
    // An Account has one Computer, so there is nothing to disambiguate and nothing to click: the
    // read that finds it is the whole decision.
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);
    const onAgentChanged = vi.fn();

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={onAgentChanged} />,
    );

    expect(await screen.findByRole("heading", { name: "No Computer connected" })).toBeTruthy();
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(agentId, computerId));
    await waitFor(() => expect(onAgentChanged).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Use / })).toBeNull();
  });

  it("reports a failed binding instead of leaving the Agent looking connected", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValue(new Error("The requested Computer was not found"));
    const onAgentChanged = vi.fn();

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={onAgentChanged} />,
    );

    expect(await screen.findByText("The requested Computer was not found")).toBeTruthy();
    expect(onAgentChanged).not.toHaveBeenCalled();
    // The failure is reported once and waits for the reader. An automatic bind that re-ran on the
    // render its own failure caused would spin here instead of being readable.
    expect(rebind).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rebind).toHaveBeenCalledTimes(2));
  });

  it("says the Computer read failed instead of reporting an Account with no Computer", async () => {
    // The two look identical if the panel reads `data?.computers ?? []`, and the reader whose read
    // is failing is the one told to go and enrol a machine they already have.
    vi.spyOn(browserApi, "computers").mockRejectedValue(new Error("Service unavailable"));

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={() => undefined} />,
    );

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(/couldn't read this Account's Computer/)).toBeTruthy();
    expect(screen.queryByText("Connect a Computer")).toBeNull();
  });

  it("offers enrolment only when the Account genuinely has none", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={() => undefined} />,
    );

    expect(await screen.findByText("Connect a Computer")).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("refuses to pick when an Account still holds more than one Computer", async () => {
    // Enrolments made before the one-Computer rule can still reach this client. Binding the first
    // of them would hand the Agent a durable home on the strength of list order.
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [computer, { ...computer, computerId: "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9", displayName: "Spare" }],
    });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={() => undefined} />,
    );

    expect(await screen.findByText(/more than one Computer/)).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("binds a second unbound Agent when the same surface is reused for one", async () => {
    // This surface outlives any one Agent: same route, next Agent, no unmount. Keying the attempted
    // bind by Computer alone let the first Agent's attempt answer for the second, which then sat on
    // "Connecting this Agent to ..." forever waiting on a bind that never ran.
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    const { rerender } = await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={() => undefined} />,
    );
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(agentId, computerId));

    rerender(
      <AgentComputerSettings
        agent={view({ ...unboundAgent, id: secondAgentId }, undefined)}
        onAgentChanged={() => undefined}
      />,
    );

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(secondAgentId, computerId));
    // Exactly once each: keying by Agent must not cost the guard that stops a bind repeating on the
    // renders it causes itself.
    expect(rebind.mock.calls.filter(([id]) => id === agentId)).toHaveLength(1);
    expect(rebind.mock.calls.filter(([id]) => id === secondAgentId)).toHaveLength(1);
  });

  it("does not show one Agent's bind failure against the next one", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValueOnce(new Error("The requested Computer was not found"))
      .mockResolvedValue(boundConfig);

    const { rerender } = await renderInRouter(
      <AgentComputerSettings agent={view(unboundAgent, undefined)} onAgentChanged={() => undefined} />,
    );
    expect(await screen.findByText("The requested Computer was not found")).toBeTruthy();

    rerender(
      <AgentComputerSettings
        agent={view({ ...unboundAgent, id: secondAgentId }, undefined)}
        onAgentChanged={() => undefined}
      />,
    );

    // The second Agent has not been tried yet, so the first one's failure cannot stand as its result.
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(secondAgentId, computerId));
    await waitFor(() => expect(screen.queryByText("The requested Computer was not found")).toBeNull());
  });

  it("keeps showing the bound Computer's own panel once one is connected", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const bound: AgentDetail = {
      ...unboundAgent,
      computer: { computerId, displayName: computer.displayName, platform: computer.platform },
    };

    await renderInRouter(<AgentComputerSettings agent={view(bound, computer)} onAgentChanged={() => undefined} />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac \u00b7 macOS" })).toBeTruthy();
    expect(screen.queryByText(/Connecting this Agent to/)).toBeNull();
  });
});
