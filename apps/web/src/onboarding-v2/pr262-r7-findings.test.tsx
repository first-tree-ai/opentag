/**
 * Probe for the review of `06a8d62` — the head that moved the rebind into `moveAgent` and let a
 * refused move be resent directly.
 *
 * Both are right. What went with the move is the attempt guard the old inline version had: the
 * poll checked `attempt.current !== mine` before touching state, and `moveAgent` checks only that
 * the component is still mounted.
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe("moveAgent at 06a8d62", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("discards a move that lands after Start over", async () => {
    // `reset()` bumps `attempt` and returns the connection to idle, but `moveAgent` never reads
    // `attempt` — so a move still in flight when the reader restarts reports a connection for the
    // abandoned run. The restarted flow then opens its Computer step already "connected", which
    // suppresses the connect command (`issueConnectCode` only acts on an idle connection) and
    // leaves `computerId` pointing at a machine this run never enrolled.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "sh install",
      expiresIn: 900,
      issuedAt: NOW,
    });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
      if (call <= 2) return { computers: [departed] };
      return { computers: [departed, machine(OTHER_COMPUTER, "Ada's new Mac", true)] };
    });
    const pending = deferred<AgentAdminConfig>();
    vi.spyOn(browserApi, "rebindAgentComputer").mockReturnValue(pending.promise);

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 2);

    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    await settle();
    await act(async () => {
      pending.resolve({} as AgentAdminConfig);
      await Promise.resolve();
    });

    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();

    // Walk the restarted run back to the step that needs a connect code.
    const issue = vi.mocked(browserApi.issueComputerConnectCode);
    const before = issue.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();

    // A restarted run has to ask for its own code; it cannot inherit a connection from the one the
    // reader abandoned.
    expect(issue.mock.calls.length).toBeGreaterThan(before);
    expect(screen.queryByText("Your computer is connected.")).toBeNull();
  });
});
