import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../../__tests__/support/router.js";
import { browserApi } from "../../../api.js";
import type { AgentDetailView } from "../agent-model.js";
import { useComputersQuery } from "../agent-queries.js";
import { AgentComputerSettings } from "./agent-computer-settings.js";

const COMPUTER_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
function agent(computerId: string, computerState: "ready" | "action_required" | "unconfirmed"): AgentDetailView {
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

afterEach(() => vi.restoreAllMocks());

describe("Agent Computer settings", () => {
  it("separates machine connectivity from a paused Agent's runtime problem", async () => {
    const value = agent(COMPUTER_ID, "ready");
    value.status = "suspended";
    value.availability.reason = "agent_suspended";
    value.availability.dependencies.runtime.status = "sign-in";
    await renderInRouter(<AgentComputerSettings agent={value} onAgentChanged={vi.fn()} />);
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
    expect(screen.getByRole("link", { name: "Manage computer" }).getAttribute("href")).toContain(COMPUTER_ID);
    expect(screen.queryByText("Not ready")).toBeNull();
  });

  it("routes offline recovery to the exact Account Computer without issuing a command", async () => {
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode");
    const cloudOverview = vi.spyOn(browserApi, "agentCloudOverview");
    const value = agent(COMPUTER_ID, "action_required");
    await renderInRouter(<AgentComputerSettings agent={value} onAgentChanged={vi.fn()} />);
    const href = screen.getByRole("link", { name: "Restore connection" }).getAttribute("href");
    expect(href).toContain(`/agents/computers?computerId=${COMPUTER_ID}`);
    expect(href).toContain(`fromAgent=${value.id}`);
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(issue).not.toHaveBeenCalled();
    expect(cloudOverview).not.toHaveBeenCalled();
  });

  it("re-reads inventory without offering repair when the bound Computer kind is unknown", async () => {
    const value = agent(COMPUTER_ID, "unconfirmed");
    const retry = vi.fn();
    const connect = vi.spyOn(browserApi, "issueComputerConnectCode");
    function ComputersObserver() {
      useComputersQuery();
      return null;
    }
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    await renderInRouter(
      <>
        <ComputersObserver />
        <AgentComputerSettings agent={value} onAgentChanged={retry} />
      </>,
    );
    expect(screen.queryByRole("button", { name: "Repair connection" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Restore connection" })).toBeNull();
    await waitFor(() => expect(computers).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(computers).toHaveBeenCalledTimes(2));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(connect).not.toHaveBeenCalled();
  });

  it("requires an explicit choice when Settings finds the Account's sole Computer", async () => {
    const value = agent(COMPUTER_ID, "ready");
    value.computer = null;
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [
        {
          computerId: COMPUTER_ID,
          displayName: "Ada's Mac",
          platform: "darwin",
          connectionStatus: "online",
          connectedAt: null,
          lastSeenAt: null,
          observedAt: "2026-08-20T00:00:00.000Z",
          createdAt: "2026-08-20T00:00:00.000Z",
          agentIds: [],
        },
      ],
    });
    const bind = vi.spyOn(browserApi, "rebindAgentComputer").mockRejectedValue(new Error("Bind refused"));
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode");
    await renderInRouter(<AgentComputerSettings agent={value} onAgentChanged={vi.fn()} />);
    const use = await screen.findByRole("button", { name: "Use this computer: Ada's Mac" });
    expect(bind).not.toHaveBeenCalled();
    expect(issue).not.toHaveBeenCalled();
    fireEvent.click(use);
    await waitFor(() => expect(bind).toHaveBeenCalledWith(value.id, COMPUTER_ID));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("A Cloud Computer's settings", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("states only that the platform manages it — no status light, no environment list, no repair", async () => {
    const base = agent(COMPUTER_ID, "unconfirmed");
    const cloudAgent: AgentDetailView = {
      ...base,
      computer: { computerId: COMPUTER_ID, displayName: "OpenTag Cloud", platform: "linux" },
      computerKind: "cloud",
    };
    const overview = vi.spyOn(browserApi, "agentCloudOverview");
    const connect = vi.spyOn(browserApi, "issueComputerConnectCode");

    await renderInRouter(<AgentComputerSettings agent={cloudAgent} onAgentChanged={vi.fn()} />);

    // The normal heading, and the one managed-platform sentence. Nothing else.
    expect(screen.getByRole("heading", { name: "Computer" })).toBeTruthy();
    expect(screen.getByText("Runs on OpenTag Cloud, managed by the platform")).toBeTruthy();
    expect(screen.queryByText("Online")).toBeNull();
    expect(screen.queryByText("Hosted by OpenTag")).toBeNull();
    expect(screen.queryByRole("region", { name: "Cloud environments" })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(overview).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });
});
