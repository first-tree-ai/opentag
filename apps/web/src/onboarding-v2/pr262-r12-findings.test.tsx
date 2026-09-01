/**
 * Probes for the review of `cabaf79` — the head that replaced the move with a repair code and
 * gated completion on the Server's own handoff observation.
 *
 * Both are the right shape. The handoff wait, though, treats every not-ready answer as "not yet",
 * including the ones the Server uses to say a binding is finished in the other sense.
 */

import type { AccountComputerSummary, AgentListItem } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const AGENT_COMPUTER = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const OTHER_COMPUTER = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const POLL_MS = 1_500;
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REDEEMED_AT = "2026-08-29T00:05:00.000Z";

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

function machine(id: string, name: string, online: boolean, connectedAt = "2026-08-29T00:00:20.000Z") {
  return {
    computerId: id,
    displayName: name,
    platform: "darwin" as const,
    connectionStatus: online ? ("online" as const) : ("offline" as const),
    connectedAt: online ? connectedAt : null,
    lastSeenAt: NOW,
    observedAt: NOW,
    createdAt: NOW,
    agentIds: [],
    providerReadiness: [{ provider: "codex" as const, status: "ready" as const, observedAt: NOW }],
  } satisfies AccountComputerSummary;
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

describe("repair and handoff at cabaf79", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => ({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: "sh install",
      expiresIn: 900,
      issuedAt: new Date(Date.now()).toISOString(),
    }));
    // A code the test says nothing about stays pending: the wait never concludes without a verdict.
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "pending",
      computerId: null,
      redeemedAt: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("lets the reader connect a messaging app again when the binding is broken", async () => {
    // `handoffReady: false` is the Server's answer for both "not observed yet" and "this binding is
    // in error / disabled / needs reauthorising". The first clears on its own; the others do not.
    // Waiting on them leaves the reader on a spinner nothing will ever settle, where the previous
    // shape correctly returned them to the step that can connect a messaging app.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's Mac")] });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [machine(AGENT_COMPUTER, "Ada's Mac", true)] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue({ bindingState: "error", handoffReady: false });
    const attempt = vi.spyOn(browserApi, "createFeishuSetupAttempt");

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 6);
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();

    // Picking a messaging app has to start one. The step only starts an attempt from `idle`, and a
    // broken binding has parked the flow in `waiting-handoff` instead.
    fireEvent.click(screen.getByRole("button", { name: /Feishu/ }));
    await settle();

    expect(attempt).toHaveBeenCalled();
  });

  it("does not accept another machine against a repair code", async () => {
    // Lock-in for the repair correlation: the code names its target, and the Server's verdict is
    // the only thing that can settle the wait — a different Computer connecting during the wait
    // cannot satisfy it, here or on any path that mutates ownership.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // 1 = the resume read; the verdict stays pending, so nothing later is even consulted.
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false);
      if (call <= 1) return { computers: [departed] };
      return { computers: [departed, machine(OTHER_COMPUTER, "Someone else's Mac", true)] };
    });

    render(<OnboardingV2Page />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." }));
    await settle();
    await tick(POLL_MS * 4);

    expect(screen.queryByText("Your computer is connected.")).toBeNull();
    expect(screen.getByText("Waiting for Ada's old Mac to connect…")).toBeTruthy();
  });

  it("accepts the named machine coming back", async () => {
    // The other half of the same lock-in: the Server reports the repair code redeemed by its
    // target, and the target back online on a fresh connection settles it.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's Mac")] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "redeemed",
      computerId: AGENT_COMPUTER,
      redeemedAt: REDEEMED_AT,
    });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // 1 = the resume read; the verdict's redemption read finds the machine back.
      if (call <= 1) return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", false)] };
      return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", true, "2026-08-29T00:09:00.000Z")] };
    });

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 4);

    // Ready as soon as it is back, so the flow leaves the connect step for the messaging one.
    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).not.toBeNull();
  });
});
