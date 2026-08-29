/**
 * Probes for the review of `7967e49` — the head that demotes a Computer that went away, and gates
 * the move behind a control the reader can press.
 *
 * The gate works. What the demotion is guarded by does not match what it was meant to protect.
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

/** An Account resumed onto an offline Agent Computer, with a different machine about to answer. */
function replacementArrives(expiresIn = 900) {
  vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
  vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
    expiresIn,
    issuedAt: NOW,
  });
  let call = 0;
  vi.spyOn(browserApi, "computers").mockImplementation(async () => {
    call += 1;
    const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
    if (call <= 2) return { computers: [departed] };
    return { computers: [departed, machine(OTHER_COMPUTER, "Ada's new Mac", true)] };
  });
}

describe("demotion and the rebind gate at 7967e49", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not pull the reader off the messaging step before they have picked an app", async () => {
    // The hold-back is `messaging.kind !== "idle"`, but the messaging step *starts* idle: Lark only
    // leaves idle once it is picked, and Slack stays idle until the reader leaves for Slack. So the
    // whole time someone is reading "Pick the app your team already works in", a lid closing throws
    // them back to a connect step they had already finished.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's Mac")] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "sh install",
      expiresIn: 900,
      issuedAt: NOW,
    });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      if (call === 1) return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", true)] };
      return { computers: [machine(AGENT_COMPUTER, "Ada's Mac", false)] };
    });

    render(<OnboardingV2Page />);
    await settle();
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();

    await tick(POLL_MS * 3);

    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).not.toBeNull();
  });

  it("still lets a refused move be retried after the connect code has expired", async () => {
    // The refusal rests, which is right. But the retry re-enters through the arrival branch, and
    // that branch only runs while the connection is `issued` — so once the code lapses, the button
    // is still on screen and no longer does anything.
    replacementArrives(3);
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockRejectedValue(new Error("delivery in flight"));

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 2);
    expect(rebind).toHaveBeenCalledTimes(1);

    // The code lapses while the reader reads the failure.
    await tick(POLL_MS * 2);
    rebind.mockResolvedValue({} as AgentAdminConfig);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    await tick(POLL_MS * 3);

    expect(rebind).toHaveBeenCalledTimes(2);
  });

  it("moves the Agent when a refused move is retried in time", async () => {
    // The path liuchao-staff asked about, end to end: refused, retried by hand, then accepted.
    replacementArrives();
    const rebind = vi
      .spyOn(browserApi, "rebindAgentComputer")
      .mockRejectedValueOnce(new Error("delivery in flight"))
      .mockResolvedValue({} as AgentAdminConfig);

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 2);
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Your computer is connected.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    await tick(POLL_MS * 2);

    expect(rebind).toHaveBeenCalledTimes(2);
    // The move lands, the machine is ready, and the flow goes on to the step after it.
    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).not.toBeNull();
  });
});
