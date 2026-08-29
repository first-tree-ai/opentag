/**
 * Probe for the review of `a669488` — the head that releases a superseded run's rebind state
 * inside `issue()`.
 *
 * The release is right, and it is in the right place. It just does not take the *visible* half of
 * that state with it: the refusal banner and its button belong to the same superseded move.
 */

import type { AgentListItem, WorkspaceComputerSummary } from "@opentag/shared/browser";
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

describe("the refusal banner at a669488", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not leave a Try again that has nothing left to try", async () => {
    // `issue()` releases `rebindState` and `rebindTarget`, which is what unwedged the gate. It does
    // not release `rebindRefused` or the error that came with it — so the banner and its button
    // survive the run they belonged to, and the button now returns immediately because the target
    // it would have retried was just cleared.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => ({
      bootstrapCommand: "sh install",
      expiresIn: 3,
      issuedAt: new Date(Date.now()).toISOString(),
    }));
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
      if (call <= 2) return { computers: [departed] };
      return { computers: [departed, machine(OTHER_COMPUTER, "Ada's new Mac", true)] };
    });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockRejectedValue(new Error("delivery in flight"));

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS);
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    // The code lapses and the reader asks for a fresh one, which supersedes that move.
    await tick(POLL_MS * 2);
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await settle();

    // The refusal belonged to the move the fresh code superseded, and `issue()` has already decided
    // that run's state goes with it — `rebindTarget` is cleared there, which is exactly what makes
    // the surviving button inert. So the banner and its control go too.
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
