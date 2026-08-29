/**
 * Probes for the review of `ff218a7` — the head that moves the Agent onto whichever machine answers.
 *
 * Rebinding is the right answer and the endpoint really is there. These are the two questions the
 * new call raises: what happens while it is failing, and what happens to a connection that was
 * true when it was made and is not any more.
 */

import type { AgentAdminConfig, AgentListItem, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const AGENT_COMPUTER = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const OTHER_COMPUTER = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const WORKSPACE_ID = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const POLL_MS = 1_500;

function agentOn(computerId: string, displayName: string): AgentListItem {
  return {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
    name: "opentag",
    displayName: "opentag",
    createdBy: { userId: USER_ID, displayName: "Ada" },
    computer: { computerId, displayName, platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    activity: { state: "idle" },
    usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function machine(id: string, name: string, online: boolean, ready = true): WorkspaceComputerSummary {
  return {
    computerId: id,
    displayName: name,
    platform: "darwin",
    connectionStatus: online ? "online" : "offline",
    connectedAt: online ? "2026-08-29T00:00:20.000Z" : null,
    lastSeenAt: NOW,
    observedAt: NOW,
    enrolledAt: NOW,
    agentIds: [],
    providerReadiness: ready ? [{ provider: "codex", status: "ready", observedAt: NOW }] : undefined,
  };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("rebind at ff218a7", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
      expiresIn: 900,
      issuedAt: NOW,
    });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("asks to move the Agent once, not on every poll while the move is refused", async () => {
    // The rebind is fired from inside the poll that found the machine, and nothing about a refusal
    // changes what that poll sees: the same machine is still there, the connection is still
    // `issued`, and the bound Computer is still the old one. So the next tick asks again.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
      if (call <= 2) return { computers: [departed] };
      return { computers: [departed, machine(OTHER_COMPUTER, "Ada's new Mac", true)] };
    });
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValue(new Error("An Agent with work in flight cannot be moved"));

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 6);

    expect(rebind).toHaveBeenCalledTimes(1);
  });

  it("stops saying the Computer is connected once the Server says it went away", async () => {
    // `connectionStatus` is read at resume and never again. The readiness poll keeps reading the
    // same Computer, so a machine that goes offline mid-flow leaves "Your computer is connected."
    // on screen — and the command block only renders while *not* connected, so there is again
    // nothing on the page that could bring it back.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's Mac")] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // Online for the resume read, then the daemon stops.
      if (call === 1) return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", true, false)] };
      return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", false, false)] };
    });

    render(<OnboardingV2Page />);
    await settle();
    expect(screen.queryByText("Your computer is connected.")).not.toBeNull();
    await tick(POLL_MS * 4);

    expect(screen.queryByText("Your computer is connected.")).toBeNull();
  });

  it("lets the reader try the move again after it is refused", async () => {
    // A refusal reports and stops. `AGENT_REBIND_BLOCKED` clears on its own once the in-flight work
    // reports, so the reader needs a way to ask again that is not "wait for the code to expire".
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
      if (call <= 2) return { computers: [departed] };
      return { computers: [departed, machine(OTHER_COMPUTER, "Ada's new Mac", true)] };
    });
    vi.spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValueOnce(new Error("blocked"))
      .mockResolvedValue({} as AgentAdminConfig);

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 2);
    // The Server's own message is surfaced, which is right — `errorMessage` prefers it over the
    // fallback copy. What is missing is anything the reader can press.
    expect(screen.getByRole("alert")).toBeTruthy();

    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeNull();
  });
  it("stops saying so on a first run too, not only on a resumed one", async () => {
    // Same effect, reached the ordinary way: nothing demotes `connected`, so this is not specific
    // to resume — a daemon that stops while the check is still running does it as well.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // An empty Account returns before reading Computers, so 1 = baseline, 2 = the arrival,
      // 3+ = the daemon stops.
      if (call === 1) return { computers: [] };
      if (call === 2) return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", true, false)] };
      return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", false, false)] };
    });

    render(<OnboardingV2Page />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    await tick(POLL_MS);
    expect(screen.queryByText("Your computer is connected.")).not.toBeNull();

    await tick(POLL_MS * 4);

    expect(screen.queryByText("Your computer is connected.")).toBeNull();
  });
});
