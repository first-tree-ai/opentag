/**
 * Probes for the review of `ff218a7` — the head that moves the Agent onto whichever machine answers.
 *
 * Rebinding is the right answer and the endpoint really is there. These are the two questions the
 * new call raises: what happens while it is failing, and what happens to a connection that was
 * true when it was made and is not any more.
 */

import type { AccountComputerSummary, AgentListItem } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const AGENT_COMPUTER = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const POLL_MS = 1_500;
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REDEEMED_AT = "2026-08-29T00:00:05.000Z";

function agentOn(computerId: string, displayName: string): AgentListItem {
  return {
    id: AGENT_ID,
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

function machine(id: string, name: string, online: boolean, ready = true): AccountComputerSummary {
  return {
    computerId: id,
    displayName: name,
    platform: "darwin",
    connectionStatus: online ? "online" : "offline",
    connectedAt: online ? "2026-08-29T00:00:20.000Z" : null,
    lastSeenAt: NOW,
    observedAt: NOW,
    createdAt: NOW,
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
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
      expiresIn: 900,
      issuedAt: NOW,
    });
    // A code the test says nothing about stays pending: the wait never concludes without a verdict.
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "pending",
      computerId: null,
      redeemedAt: null,
    });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
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

  it("stops saying so on a first run too, not only on a resumed one", async () => {
    // Same effect, reached the ordinary way: nothing demotes `connected`, so this is not specific
    // to resume — a daemon that stops while the check is still running does it as well.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    // The issued code is redeemed by this exact Computer: that is what settles the wait.
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "redeemed",
      computerId: AGENT_COMPUTER,
      redeemedAt: REDEEMED_AT,
    });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // 1 = the read the redemption verdict unlocks, 2+ = the daemon stops.
      if (call === 1) return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", true, false)] };
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
