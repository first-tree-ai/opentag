import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
