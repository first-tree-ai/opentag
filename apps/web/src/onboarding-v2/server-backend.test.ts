import type { AgentAdminConfig, AgentListItem, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import type { AgentDraft } from "./flow.js";
import { useServerBackend } from "./server-backend.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const POLL_MS = 1_500;

const draft: AgentDraft = {
  destination: "local",
  name: "opentag",
  runtime: "codex",
  cloudRuntime: undefined,
  tokenSource: undefined,
};

function computer(overrides: Partial<WorkspaceComputerSummary> = {}): WorkspaceComputerSummary {
  return {
    computerId: COMPUTER_ID,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "online",
    connectedAt: NOW,
    lastSeenAt: NOW,
    observedAt: NOW,
    enrolledAt: NOW,
    agentIds: [AGENT_ID],
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }],
    ...overrides,
  };
}

function existingAgent(): AgentListItem {
  return {
    id: AGENT_ID,
    name: "opentag",
    displayName: "OpenTag",
    createdBy: { userId: USER_ID, displayName: "Ada" },
    computer: { computerId: COMPUTER_ID, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    activity: { state: "idle" },
    usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function createdAgent(): AgentAdminConfig {
  return {
    id: AGENT_ID,
    name: "opentag",
    displayName: "OpenTag",
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    createdByUserId: USER_ID,
    computerId: COMPUTER_ID,
    revision: 1,
    runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useServerBackend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps an existing offline Computer separate from any repair attempt", async () => {
    const offline = computer({ connectionStatus: "offline", connectedAt: null, lastSeenAt: NOW });
    vi.mocked(browserApi.agents).mockResolvedValue({ agents: [existingAgent()] });
    vi.mocked(browserApi.computers).mockResolvedValue({ computers: [offline] });
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode");
    const view = renderHook(() => useServerBackend(draft));
    await settle();

    expect(view.result.current.knownComputers).toEqual([
      expect.objectContaining({ id: COMPUTER_ID, displayName: "Ada's Mac", availability: "offline" }),
    ]);
    expect(view.result.current.computerOnline).toBe(false);
    expect(view.result.current.selectedComputerId).toBe(COMPUTER_ID);
    expect(issue).not.toHaveBeenCalled();
  });

  it("resumes a redeemed Computer when refreshed before its Agent is created", async () => {
    vi.mocked(browserApi.computers).mockResolvedValue({ computers: [computer({ agentIds: [] })] });
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode");
    const view = renderHook(() => useServerBackend(draft));
    await settle();

    expect(view.result.current.knownComputers).toEqual([
      expect.objectContaining({ id: COMPUTER_ID, displayName: "Ada's Mac", availability: "online" }),
    ]);
    expect(view.result.current.selectedComputerId).toBe(COMPUTER_ID);
    expect(view.result.current.computerOnline).toBe(true);
    expect(view.result.current.readiness?.runtime).toBe("ready");
    expect(issue).not.toHaveBeenCalled();
  });

  it("observes the exact Computer naturally reconnecting without a repair lifecycle", async () => {
    const offline = computer({ connectionStatus: "offline", connectedAt: null });
    vi.mocked(browserApi.agents).mockResolvedValue({ agents: [existingAgent()] });
    vi.mocked(browserApi.computers)
      .mockResolvedValueOnce({ computers: [offline] })
      .mockResolvedValue({ computers: [computer()] });
    const view = renderHook(() => useServerBackend(draft));
    await settle();
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS));

    expect(view.result.current.knownComputers?.[0]).toMatchObject({ id: COMPUTER_ID, availability: "online" });
    expect(view.result.current.computerOnline).toBe(true);
    expect(view.result.current.readiness?.runtime).toBe("ready");
  });

  it("adopts a Computer verified by ComputerConnect and creates the Agent on that exact id", async () => {
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(createdAgent());
    const view = renderHook(() => useServerBackend(draft));
    await settle();
    act(() => view.result.current.computerConnected(computer()));
    act(() => view.result.current.createAgent(draft));
    await settle();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ computerId: COMPUTER_ID, name: "opentag", runtimeProvider: "codex" }),
    );
    expect(view.result.current.creation).toBe("created");
  });

  it("preserves the durable selected Computer on Start over", async () => {
    const view = renderHook(() => useServerBackend(draft));
    await settle();
    act(() => view.result.current.computerConnected(computer()));
    act(() => view.result.current.reset());

    expect(view.result.current.selectedComputerId).toBe(COMPUTER_ID);
    expect(view.result.current.knownComputers).toEqual([
      expect.objectContaining({ id: COMPUTER_ID, availability: "online" }),
    ]);

    vi.mocked(browserApi.computers)
      .mockResolvedValueOnce({ computers: [computer({ connectionStatus: "offline", connectedAt: null })] })
      .mockResolvedValue({ computers: [computer()] });
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(view.result.current.computerOnline).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(POLL_MS));
    expect(view.result.current.computerOnline).toBe(true);
  });
});
