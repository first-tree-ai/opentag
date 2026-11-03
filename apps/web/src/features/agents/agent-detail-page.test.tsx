/**
 * Cloud Agent home retains status, usage and Tasks; workspace recovery stays collapsed until
 * explicitly requested. Opening the page never releases or discards an environment.
 */

import type { AccountComputerSummary, AgentDetail, CloudAvailability, MeResponse } from "@opentag/shared/browser";
import { QueryClient } from "@tanstack/react-query";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../../__tests__/support/router.js";
import { browserApi } from "../../api.js";
import { AccountContext } from "../session/session-context.js";
import { AgentDetailPage } from "./agent-detail-page.js";

const AGENT_ID = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const ACCOUNT_ID = "0b9c8d7e-6f50-4a1b-8c2d-3e4f50617283";
const COMPUTER_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const TIME = "2026-09-20T00:00:00.000Z";

const me = {
  user: { id: ACCOUNT_ID, displayName: "Ada" },
} as unknown as MeResponse;

const agent: AgentDetail = {
  id: AGENT_ID,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId: ACCOUNT_ID, displayName: "Ada" },
  computer: { computerId: COMPUTER_ID, displayName: "openTag Cloud", platform: "linux" },
  runtimeProvider: "pi",
  receiveMode: "mention_only",
  status: "active",
  createdAt: TIME,
  updatedAt: TIME,
  activity: { state: "idle" },
};

const cloudComputer: AccountComputerSummary = {
  computerId: COMPUTER_ID,
  kind: "cloud",
  displayName: "openTag Cloud",
  platform: "linux",
  connectionStatus: "online",
  providerReadiness: [{ provider: "pi", status: "ready", observedAt: TIME }],
  connectedAt: TIME,
  lastSeenAt: TIME,
  observedAt: TIME,
  createdAt: "2026-08-19T00:00:00.000Z",
  agentIds: [AGENT_ID],
};

const availability: CloudAvailability = { enabled: true, available: true, reason: null, observedAt: TIME };

const progressDiagnostics = {
  agentId: AGENT_ID,
  observedAt: TIME,
  capacity: { accountUsed: 0, accountLimit: 3 },
  counts: { allocated: 0, queued: 0, running: 0, attention: 0 },
  sessions: [],
  nextCursor: null,
};

function stubCloudAgent() {
  vi.spyOn(browserApi, "agentCloudOverview").mockResolvedValue(progressDiagnostics);
  vi.spyOn(browserApi, "agents").mockResolvedValue({
    agents: [{ ...agent, usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 } }],
  });
  vi.spyOn(browserApi, "agent").mockResolvedValue(agent);
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [cloudComputer] });
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "cloudAvailability").mockResolvedValue(availability);
  vi.spyOn(browserApi, "agentUsage").mockResolvedValue({
    windowDays: 30,
    startedAt: "2026-08-22T00:00:00.000Z",
    endedAt: TIME,
    tasks: 0,
    measuredTasks: 0,
    failed: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    tokens: 0,
    daily: [],
  });
  vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [], nextCursor: null });
}

async function renderAgentHome() {
  return renderInRouter(
    <AccountContext value={{ me, endSession: vi.fn(), refreshMe: vi.fn().mockResolvedValue(me), reloadMe: vi.fn() }}>
      <AgentDetailPage agentId={AGENT_ID} />
    </AccountContext>,
    { path: `/agents/${AGENT_ID}` },
  );
}

describe("Agent home for a Cloud-bound Agent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps status, usage, and Tasks with workspace recovery initially collapsed", async () => {
    stubCloudAgent();
    const overview = vi.spyOn(browserApi, "agentCloudOverview");

    await renderAgentHome();

    // The existing Agent status and Task list are the page.
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Agent status" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Usage" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Tasks" })).toBeTruthy();

    expect(screen.getByRole("button", { name: "Recover workspace" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Cloud environments" })).toBeNull();
    expect(screen.queryByRole("button", { name: /release/ })).toBeNull();
    expect(screen.queryByText(/Agent environments/)).toBeNull();
    await waitFor(() => expect(overview).toHaveBeenCalledWith(AGENT_ID, { limit: 100 }));
  });

  it("keeps Tasks alongside a save failure warning and an explicit recovery entry", async () => {
    stubCloudAgent();
    vi.mocked(browserApi.agentCloudOverview).mockResolvedValue({
      ...progressDiagnostics,
      counts: { ...progressDiagnostics.counts, attention: 1 },
      sessions: [
        {
          sessionId: "11111111-1111-4111-8111-111111111111",
          sandboxId: "22222222-2222-4222-8222-222222222222",
          kind: "internal",
          lifecycle: "ready",
          environmentGeneration: 1,
          runnerConnected: true,
          runnerReady: false,
          taskState: "idle",
          lastErrorCode: "workspace_save_failed",
          lastErrorAt: TIME,
          updatedAt: TIME,
          canRelease: true,
          canDiscard: false,
        },
      ],
    });

    await renderAgentHome();

    await waitFor(() => expect(browserApi.tasks).toHaveBeenCalled());
    expect(await screen.findByText(/Some execution progress could not be saved/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Cloud environments" })).toBeNull();
    expect(screen.queryByRole("button", { name: /release|discard|retry save/i })).toBeNull();
    expect(screen.getAllByRole("button", { name: "Recover workspace" })).not.toHaveLength(0);
  });
});

describe("Agent home for a Local Agent", () => {
  afterEach(() => vi.restoreAllMocks());

  function stubLocalAgent(runtimeStatus: "ready" | "install", activity: AgentDetail["activity"] = { state: "idle" }) {
    stubCloudAgent();
    const local = { ...agent, runtimeProvider: "codex" as const, activity };
    vi.mocked(browserApi.agent).mockResolvedValue(local);
    vi.mocked(browserApi.agents).mockResolvedValue({
      agents: [{ ...local, usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 } }],
    });
    vi.mocked(browserApi.computers).mockResolvedValue({
      computers: [
        {
          ...cloudComputer,
          kind: "local",
          displayName: "Review Mac",
          platform: "darwin",
          providerReadiness: [{ provider: "codex", status: runtimeStatus, observedAt: TIME }],
        } as AccountComputerSummary,
      ],
    });
    return vi.spyOn(browserApi, "refreshAgentSetup").mockResolvedValue(undefined);
  }

  it("asks the online Computer to check again once on entry when the runtime is not ready", async () => {
    const refresh = stubLocalAgent("install");
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    const first = await renderAgentHome();
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(refresh).toHaveBeenCalledWith(AGENT_ID);
    // The Computer and every Agent-scoped read, the handoff with its Provider CLI readiness
    // included, are read again right away.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["agents", AGENT_ID] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["computers"] });
    first.unmount();

    // A second entry inside the one-minute window does not ask again.
    await renderAgentHome();
    expect(await screen.findByRole("region", { name: "Agent status" })).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not ask a ready Agent's Computer to check again", async () => {
    const refresh = stubLocalAgent("ready");
    await renderAgentHome();
    expect(await screen.findByRole("region", { name: "Agent status" })).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("shows the running-Task line the Agent list shows", async () => {
    stubLocalAgent("ready", { state: "working", startedAt: TIME, runningTaskCount: 2 });
    await renderAgentHome();
    const status = await screen.findByRole("region", { name: "Agent status" });
    await waitFor(() =>
      expect(status.querySelector('[data-ui="agent-status-activity"]')?.textContent).toBe("2 tasks running"),
    );
    // Its own row, ahead of the Computer and messaging rows.
    const rows = [...status.querySelectorAll("li")].map((row) => row.getAttribute("data-ui"));
    expect(rows[0]).toBe("agent-status-work");
    expect(status.querySelector('[data-ui="agent-status-work"]')?.textContent).toContain("Work");
  });
});
