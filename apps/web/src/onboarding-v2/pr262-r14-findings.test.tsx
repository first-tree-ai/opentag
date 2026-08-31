/**
 * Probe for the review of `28892f1`, which found three faults in what this flow does with an
 * Account it did not create.
 *
 * The one covered here is the Slack return trip. Installing sends the browser to Slack's own pages,
 * so the page that held the reader's choice is gone by the time they come back: the flow remounts
 * and rebuilds itself from the Server. It could already tell that a binding was waiting to be
 * observed. It could not tell *which app* was waiting, because that lived only in page state — so
 * the step rendered its heading over nothing until readiness happened to flip.
 */

import type { AgentListItem, ImBindingSummary, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const BINDING_ID = "9f2f2b47-1f0e-4a1a-9a1b-0f2c3d4e5f60";

function existingAgent(): AgentListItem {
  return {
    id: AGENT_ID,
    name: "opentag",
    displayName: "opentag",
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

function machine(): WorkspaceComputerSummary {
  return {
    computerId: COMPUTER_ID,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "online",
    connectedAt: "2026-08-29T00:00:20.000Z",
    lastSeenAt: NOW,
    observedAt: NOW,
    enrolledAt: NOW,
    agentIds: [AGENT_ID],
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }],
    imCliReadiness: [{ provider: "slack", status: "ready", observedAt: NOW }],
  };
}

function slackBinding(): ImBindingSummary {
  return {
    id: BINDING_ID,
    agentId: AGENT_ID,
    provider: "slack",
    bindingState: "active",
    bot: { displayName: "opentag", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: null,
    lastRuntimeObservationAt: null,
  };
}

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

describe("coming back from Slack before the Server has observed the Agent", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [existingAgent()] });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [machine()] });
    // The install landed, so the binding is active — but the identity has not been observed yet,
    // which is the normal window a real callback returns in.
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue({ bindingState: "active", handoffReady: false });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(slackBinding());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shows the Slack wait rather than an empty step", async () => {
    render(<OnboardingV2Page />);
    await settle();

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    // The reader is owed the app they are waiting on, not a heading with nothing under it.
    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();
  });

  it("still resumes when the binding cannot be read", async () => {
    // Restoring the branch is a nicety; a returning Account must not be stranded on an error
    // because this one extra call happened to fail.
    vi.mocked(browserApi.imBinding).mockRejectedValue(new Error("Service unavailable"));

    render(<OnboardingV2Page />);
    await settle();

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("asks the binding which app is waiting", async () => {
    render(<OnboardingV2Page />);
    await settle();

    expect(browserApi.imBinding).toHaveBeenCalledWith(AGENT_ID);
  });
});
