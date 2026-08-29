/**
 * Probe for the review of `3f46728` — the head that gave `moveAgent` its run guard back.
 *
 * The guard is right. What it does not do is release the in-flight marker it is guarding: a reply
 * discarded because its run was superseded returns before `rebindState` goes back to `idle`, and
 * `issue()` — unlike `reset()` — does not clear it either.
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

describe("the in-flight marker at 3f46728", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("can still move the Agent after a fresh code superseded a move in flight", async () => {
    // A move is still in flight when the code lapses and the reader asks for a new one. `issue()`
    // bumps the run, so the reply is correctly discarded — but it returns before releasing
    // `rebindState`, and `issue()` does not clear it. The marker stays `moving` for the rest of the
    // session, so every later arrival takes the `!== "idle"` early return and no move is ever tried
    // again: the machine is online, the page keeps waiting, and nothing else happens.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    // Issued at the moment it is asked for; a fixed `issuedAt` would make the reissued code be
    // born already expired and the poll would never run.
    vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => ({
      bootstrapCommand: "sh install",
      expiresIn: 3,
      issuedAt: new Date(Date.now()).toISOString(),
    }));
    let call = 0;
    // The machine re-enrols after the reader runs the fresh command, so its `connectedAt` moves and
    // it is a genuine arrival again — otherwise the new baseline would swallow it and this test
    // would be measuring that instead.
    let reEnrolled = false;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
      if (call <= 2) return { computers: [departed] };
      const replacement = machine(OTHER_COMPUTER, "Ada's new Mac", true);
      return {
        computers: [departed, reEnrolled ? { ...replacement, connectedAt: "2026-08-29T00:05:00.000Z" } : replacement],
      };
    });
    const pending = deferred<AgentAdminConfig>();
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockReturnValueOnce(pending.promise);

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS);
    expect(rebind).toHaveBeenCalledTimes(1);

    // The code lapses while the move hangs, and the reader asks for another one.
    await tick(POLL_MS * 2);
    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await settle();
    reEnrolled = true;
    await act(async () => {
      pending.resolve({} as AgentAdminConfig);
      await Promise.resolve();
    });
    rebind.mockResolvedValue({} as AgentAdminConfig);

    // The machine is still there, and the fresh code's poll finds it again.
    await tick(POLL_MS * 4);

    expect(rebind).toHaveBeenCalledTimes(2);
  });
  it("control: a re-enrolled machine after a fresh code is moved when nothing is in flight", async () => {
    // The same shape with no move left hanging. It passes, which is what isolates the marker as
    // the reason the test above cannot reach a second move — not the fresh baseline.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    // Issued at the moment it is asked for; a fixed `issuedAt` would make the reissued code be
    // born already expired and the poll would never run.
    vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(async () => ({
      bootstrapCommand: "sh install",
      expiresIn: 3,
      issuedAt: new Date(Date.now()).toISOString(),
    }));
    let reEnrolled = false;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false, false);
      if (!reEnrolled) return { computers: [departed] };
      return {
        computers: [
          departed,
          { ...machine(OTHER_COMPUTER, "Ada's new Mac", true), connectedAt: "2026-08-29T00:05:00.000Z" },
        ],
      };
    });
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue({} as AgentAdminConfig);

    render(<OnboardingV2Page />);
    await settle();
    await tick(POLL_MS * 3);
    expect(rebind).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Get a new command" }));
    await settle();
    reEnrolled = true;
    await tick(POLL_MS * 4);

    expect(rebind).toHaveBeenCalledTimes(1);
  });
});
