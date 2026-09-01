import type { AgentAdminConfig, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import type { AgentDetailView } from "../agent-model.js";
import { AgentComputerSettings } from "./agent-computer-settings.js";

const COMPUTER_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const OTHER_COMPUTER_ID = "9d3c2e5f-6b7a-4c8d-9e0f-1a2b3c4d5e6f";

function agent(computerId: string, computerState: "action_required" | "unconfirmed"): AgentDetailView {
  const displayName = computerId === COMPUTER_ID ? "Ada's Mac" : "Work iMac";
  return {
    id: "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b",
    name: "reviewer",
    displayName: "Reviewer",
    createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
    computer: { computerId, displayName, platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    activity: { state: "idle" },
    availability: {
      state: computerState === "action_required" ? "action_required" : "unconfirmed",
      reason: computerState === "action_required" ? "computer_offline" : "computer_unconfirmed",
      lastConfirmedAt: null,
      dependencies: {
        computer: { state: computerState, lastConfirmedAt: null },
        runtime: { provider: "codex", status: "ready" },
        handoff: { state: "ready", lastConfirmedAt: null },
        channel: { state: "connected", provider: "feishu", botDisplayName: "Reviewer" },
      },
    },
    messaging: { kind: "ready", value: undefined },
  };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AgentComputerSettings repair disclosure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "opentag computer connect -- code",
      connectCodeId: "connect-code",
      expiresIn: 900,
      issuedAt: "2026-08-20T00:00:00.000Z",
    });
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      computerId: null,
      connectCodeId: "connect-code",
      redeemedAt: null,
      state: "pending",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("requires a fresh repair action after evidence becomes unconfirmed or the Computer changes", async () => {
    const view = render(
      <AgentComputerSettings agent={agent(COMPUTER_ID, "action_required")} onAgentChanged={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." }));
    await flushAsync();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledTimes(1);

    view.rerender(<AgentComputerSettings agent={agent(COMPUTER_ID, "unconfirmed")} onAgentChanged={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /repair command/i })).toBeNull();

    view.rerender(<AgentComputerSettings agent={agent(COMPUTER_ID, "action_required")} onAgentChanged={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." })).toBeTruthy();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." }));
    await flushAsync();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledTimes(2);

    view.rerender(
      <AgentComputerSettings agent={agent(OTHER_COMPUTER_ID, "action_required")} onAgentChanged={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." })).toBeTruthy();
    expect(browserApi.issueComputerConnectCode).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." }));
    await flushAsync();
    expect(browserApi.issueComputerConnectCode).toHaveBeenLastCalledWith({
      mode: "repair",
      targetComputerId: OTHER_COMPUTER_ID,
    });
  });
});

const UNBOUND_AGENT_ID = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const SECOND_AGENT_ID = "5c4b3a2d-1e0f-4998-8877-66554433221a";

const accountComputer: WorkspaceComputerSummary = {
  computerId: COMPUTER_ID,
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

const boundConfig: AgentAdminConfig = {
  id: UNBOUND_AGENT_ID,
  createdByUserId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d",
  computerId: COMPUTER_ID,
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 2,
  runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

/** The same Agent as `agent()`, but with the Computer the Server says it does not have. */
function unbound(id = UNBOUND_AGENT_ID): AgentDetailView {
  const base = agent(COMPUTER_ID, "unconfirmed");
  return {
    ...base,
    id,
    computer: null,
    availability: {
      ...base.availability,
      reason: "computer_not_bound",
      dependencies: { ...base.availability.dependencies, computer: { state: "not_bound", lastConfirmedAt: null } },
    },
  };
}

describe("An Agent with no Computer", () => {
  beforeEach(() => vi.useRealTimers());

  it("gives the Agent the Computer this Account has, without asking which", async () => {
    // An Account has one Computer, so there is nothing to disambiguate and nothing to click: the
    // read that finds it is the whole decision.
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [accountComputer] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);
    const onAgentChanged = vi.fn();

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={onAgentChanged} />);

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(UNBOUND_AGENT_ID, COMPUTER_ID));
    await waitFor(() => expect(onAgentChanged).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Use / })).toBeNull();
  });

  it("reports a failed binding instead of leaving the Agent looking connected", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [accountComputer] });
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValue(new Error("The requested Computer was not found"));
    const onAgentChanged = vi.fn();

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={onAgentChanged} />);

    expect(await screen.findByText("The requested Computer was not found")).toBeTruthy();
    expect(onAgentChanged).not.toHaveBeenCalled();
    // Reported once and left for the reader: an automatic bind that re-ran on the render its own
    // failure caused would spin here instead of being readable.
    expect(rebind).toHaveBeenCalledTimes(1);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(rebind).toHaveBeenCalledTimes(2));
  });

  it("says the Computer read failed instead of reporting an Account with no Computer", async () => {
    // The two look identical if the panel reads `data?.computers ?? []`, and the reader whose read
    // is failing is the one told to go and enrol a machine they already have.
    vi.spyOn(browserApi, "computers").mockRejectedValue(new Error("Service unavailable"));

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={() => undefined} />);

    expect(await screen.findByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.getByText(/couldn't read this Account's Computer/)).toBeTruthy();
    expect(screen.queryByText("Connect a Computer")).toBeNull();
    expect(screen.queryByRole("button", { name: /Use / })).toBeNull();
  });

  it("offers enrolment only when the Account genuinely has none", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={() => undefined} />);

    expect(await screen.findByText("Connect a Computer")).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
    // Nothing to choose between, so no list is offered either.
    expect(screen.queryByRole("button", { name: /Use / })).toBeNull();
  });

  it("asks which Computer when the Account has several, and binds exactly the one chosen", async () => {
    // Which machine an Agent runs on is the reader's to say when there is more than one. Binding the
    // first would hand it a durable home on the strength of an array index.
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [accountComputer, { ...accountComputer, computerId: OTHER_COMPUTER_ID, displayName: "Spare" }],
    });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);
    const onAgentChanged = vi.fn();

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={onAgentChanged} />);

    expect(await screen.findByRole("heading", { name: "Choose the Computer this Agent should run on" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect another Computer" })).toBeTruthy();
    // Nothing is decided for the reader while the question is open.
    expect(rebind).not.toHaveBeenCalled();

    // The second row, so a pass cannot come from binding whatever happens to be first.
    fireEvent.click(screen.getByRole("button", { name: "Use Spare" }));

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(UNBOUND_AGENT_ID, OTHER_COMPUTER_ID));
    await waitFor(() => expect(onAgentChanged).toHaveBeenCalled());
  });

  it("does not bind by itself while several Computers are enrolled", async () => {
    // The automatic bind belongs to the unambiguous case only.
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [accountComputer, { ...accountComputer, computerId: OTHER_COMPUTER_ID, displayName: "Spare" }],
    });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={() => undefined} />);

    expect(await screen.findByRole("button", { name: "Use Ada's Mac" })).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("binds a second unbound Agent when the same surface is reused for one", async () => {
    // The surface outlives any one Agent: same route, next Agent, no unmount. Keying the attempted
    // bind by Computer alone let the first Agent's attempt answer for the second.
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [accountComputer] });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    const { rerender } = await renderInRouter(
      <AgentComputerSettings agent={unbound()} onAgentChanged={() => undefined} />,
    );
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(UNBOUND_AGENT_ID, COMPUTER_ID));

    rerender(<AgentComputerSettings agent={unbound(SECOND_AGENT_ID)} onAgentChanged={() => undefined} />);

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(SECOND_AGENT_ID, COMPUTER_ID));
    expect(rebind.mock.calls.filter(([id]) => id === UNBOUND_AGENT_ID)).toHaveLength(1);
    expect(rebind.mock.calls.filter(([id]) => id === SECOND_AGENT_ID)).toHaveLength(1);
  });

  it("keeps a newly connected Computer's bind failure visible and retryable", async () => {
    /*
     * The Computer that just enrolled is known to the connect step and not to the shared inventory
     * query -- the connect step reads through its own adapter and never refills that cache. A bind
     * target derived from the inventory therefore does not exist for a Computer that has only just
     * arrived, which used to hide the failure entirely and leave the reader on "Connect a Computer"
     * with an Agent that never got one. Inside the setup gate that is terminal.
     */
    const redeemedAt = "2026-08-20T00:05:00.000Z";
    const fresh: WorkspaceComputerSummary = {
      ...accountComputer,
      connectionStatus: "online",
      connectedAt: "2026-08-20T00:05:01.000Z",
    };
    let inventoryReads = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      inventoryReads += 1;
      // First read is the surface's own query, on an Account that genuinely has none.
      return { computers: inventoryReads === 1 ? [] : [fresh] };
    });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "opentag computer connect -- code",
      connectCodeId: "6f0f6b1e-9d2c-4a3b-8c1d-0e9f8a7b6c5d",
      expiresIn: 900,
      issuedAt: "2026-08-20T00:04:00.000Z",
    });
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      connectCodeId: "6f0f6b1e-9d2c-4a3b-8c1d-0e9f8a7b6c5d",
      state: "redeemed",
      computerId: COMPUTER_ID,
      redeemedAt,
    });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockRejectedValue(new Error("Bind refused"));
    const onAgentChanged = vi.fn();

    await renderInRouter(<AgentComputerSettings agent={unbound()} onAgentChanged={onAgentChanged} />);

    // The connect step polls, reports the exact Computer its code redeemed, and the bind fails.
    expect(await screen.findByText("Bind refused", undefined, { timeout: 8_000 })).toBeTruthy();
    expect(rebind).toHaveBeenCalledWith(UNBOUND_AGENT_ID, COMPUTER_ID);
    expect(onAgentChanged).not.toHaveBeenCalled();

    const issued = vi.mocked(browserApi.issueComputerConnectCode).mock.calls.length;
    rebind.mockResolvedValue(boundConfig);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(onAgentChanged).toHaveBeenCalled());
    // Retrying the bind must not start the enrolment over: the machine is already here.
    expect(vi.mocked(browserApi.issueComputerConnectCode).mock.calls).toHaveLength(issued);
  }, 15_000);

  it("does not let a superseded bind overwrite the current Agent's result", async () => {
    /*
     * Reused for a second Agent while the first bind is still in flight, the two can settle in
     * either order. The attempted key stops the wrong bind from starting; it does nothing about a
     * late reply writing over a newer one, which would show the previous Agent's error against this
     * one and clear a `binding` that is still true -- an invitation to start a second bind for it.
     */
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [accountComputer] });
    const rejectors = new Map<string, (cause: Error) => void>();
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockImplementation(
        (agentId: string) => new Promise<AgentAdminConfig>((_resolve, reject) => rejectors.set(agentId, reject)),
      );

    const { rerender } = await renderInRouter(
      <AgentComputerSettings agent={unbound()} onAgentChanged={() => undefined} />,
    );
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(UNBOUND_AGENT_ID, COMPUTER_ID));

    rerender(<AgentComputerSettings agent={unbound(SECOND_AGENT_ID)} onAgentChanged={() => undefined} />);
    await waitFor(() => expect(rebind).toHaveBeenCalledWith(SECOND_AGENT_ID, COMPUTER_ID));

    await act(async () => {
      rejectors.get(SECOND_AGENT_ID)?.(new Error("Second Agent failed"));
    });
    expect(await screen.findByText("Second Agent failed")).toBeTruthy();

    await act(async () => {
      rejectors.get(UNBOUND_AGENT_ID)?.(new Error("First Agent failed late"));
    });

    expect(screen.getByText("Second Agent failed")).toBeTruthy();
    expect(screen.queryByText("First Agent failed late")).toBeNull();
  });

  it("does not show one Agent's bind failure against the next one", async () => {
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [accountComputer] });
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValueOnce(new Error("The requested Computer was not found"))
      .mockResolvedValue(boundConfig);

    const { rerender } = await renderInRouter(
      <AgentComputerSettings agent={unbound()} onAgentChanged={() => undefined} />,
    );
    expect(await screen.findByText("The requested Computer was not found")).toBeTruthy();

    rerender(<AgentComputerSettings agent={unbound(SECOND_AGENT_ID)} onAgentChanged={() => undefined} />);

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(SECOND_AGENT_ID, COMPUTER_ID));
    await waitFor(() => expect(screen.queryByText("The requested Computer was not found")).toBeNull());
  });
});
