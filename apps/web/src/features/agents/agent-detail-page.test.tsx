/**
 * The Agent home for a Cloud-bound Agent: the existing status, usage, and Task list, and nothing
 * about runtime environments. Existing diagnostics only supply user-impacting progress failures;
 * the page never renders environment boards or resource actions.
 */

import type { AccountComputerSummary, AgentDetail, CloudAvailability, MeResponse } from "@opentag/shared/browser";
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
  computer: { computerId: COMPUTER_ID, displayName: "OpenTag Cloud", platform: "linux" },
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
  displayName: "OpenTag Cloud",
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

  it("keeps status, usage, and Tasks, with no environment board or resource actions", async () => {
    stubCloudAgent();
    const overview = vi.spyOn(browserApi, "agentCloudOverview");

    await renderAgentHome();

    // The existing Agent status and Task list are the page.
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Agent status" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Usage" })).toBeTruthy();
    expect(await screen.findByRole("region", { name: "Tasks" })).toBeTruthy();

    // No environment board, no counts or capacity, and no Runner/Sandbox lifecycle controls.
    expect(screen.queryByRole("region", { name: "Cloud environments" })).toBeNull();
    expect(screen.queryByRole("button", { name: /release/ })).toBeNull();
    expect(screen.queryByText(/Agent environments/)).toBeNull();
    await waitFor(() => expect(overview).toHaveBeenCalledWith(AGENT_ID, { limit: 100 }));
  });

  it("keeps the existing Task list alongside a save failure warning without repair actions", async () => {
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
  });
});
