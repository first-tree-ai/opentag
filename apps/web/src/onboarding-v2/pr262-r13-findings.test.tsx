/**
 * Probe for the review of `0bbac07` — the head that split the handoff answers apart and gave the
 * wait its reason.
 *
 * Both are right. What has changed underneath them is the round-6 trade-off: holding the reader on
 * the messaging step while their Computer goes offline was harmless when finishing did not depend
 * on that machine. Completing now requires live runtime readiness, so it is not harmless any more.
 */

import type {
  AgentAdminConfig,
  AgentListItem,
  FeishuSetupAttempt,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const WORKSPACE_ID = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ATTEMPT_ID = "2b73a21e-f6c7-4474-91ea-4dabf0566a24";
const POLL_MS = 1_500;

function existingAgent(): AgentListItem {
  return {
    id: AGENT_ID,
    workspaceId: WORKSPACE_ID,
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

function machine(online: boolean): WorkspaceComputerSummary {
  return {
    computerId: COMPUTER_ID,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: online ? "online" : "offline",
    connectedAt: online ? "2026-08-29T00:00:20.000Z" : null,
    lastSeenAt: NOW,
    observedAt: NOW,
    enrolledAt: NOW,
    agentIds: [],
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }],
    imCliReadiness: [{ provider: "feishu", status: "ready", observedAt: NOW }],
  };
}

function attempt(state: FeishuSetupAttempt["state"]): FeishuSetupAttempt {
  return {
    id: ATTEMPT_ID,
    agentId: AGENT_ID,
    intent: "create",
    state,
    qrUrl: "https://example.test/qr",
    expiresAt: "2026-08-29T00:10:00.000Z",
    errorCode: null,
    completedAt: state === "succeeded" ? NOW : null,
    createdAt: NOW,
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

describe("the messaging wait at ab76497", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("says why it is waiting when the Computer the Agent needs has gone offline", async () => {
    // Reached the messaging step with everything ready, then the daemon stops. The connection is
    // deliberately not demoted here — that was decided when finishing did not depend on the
    // machine. But `handoffReady` needs live runtime readiness, so the flow can no longer finish,
    // and the demotion branch returns before refreshing readiness, so the CLI reason cannot fire
    // either. The reader gets "Checking your agent can be reached…" for as long as they wait.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [existingAgent()] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // Online while the reader works through the step, then the machine goes away.
      return { computers: [machine(call <= 3)] };
    });
    vi.spyOn(browserApi, "createAgent").mockResolvedValue({} as AgentAdminConfig);
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt("awaiting_user"));
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt("succeeded"));
    // The binding is live; what is missing is the runtime, because the machine is gone.
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue({ bindingState: "active", handoffReady: false });

    render(<OnboardingV2Page />);
    await settle();
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle();
    await tick(POLL_MS * 6);

    expect(screen.queryByText("Connected. Checking your agent can be reached…")).toBeNull();
  });
  it("returns to the computer step when the runtime stops being ready, so its wait reason never renders", async () => {
    // Documented behaviour, not a guarantee: `done.computer` requires `readinessPassed`, so any
    // runtime status other than `ready` moves the flow back a step *before* the messaging step can
    // render. `COPY.messaging.runtimeNotReady` therefore has no reachable state — and the round-6
    // hold-back covers a lost connection only, not a readiness that regresses.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [existingAgent()] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // Online throughout, but the runtime probe has not landed yet after the first few reads.
      const online = machine(true);
      if (call <= 3) return { computers: [online] };
      return { computers: [{ ...online, providerReadiness: undefined }] };
    });
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt("awaiting_user"));
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt("succeeded"));
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue({ bindingState: "active", handoffReady: false });

    render(<OnboardingV2Page />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle();
    await tick(POLL_MS * 6);

    expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();
    expect(screen.queryByText(/runtime isn't ready/)).toBeNull();
  });
});
