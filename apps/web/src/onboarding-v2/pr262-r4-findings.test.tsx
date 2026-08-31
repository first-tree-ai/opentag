/**
 * Probes for the review of `a4e2662` — the head that made resume read the Computer's real state.
 *
 * Reading it was the right fix. What is still missing is an answer for the case that read now
 * exposes: the Agent's Computer is not usable. Every path out of that leads somewhere worse than
 * where it started.
 */

import type { AgentListItem, FeishuSetupAttempt, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const AGENT_COMPUTER = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const OTHER_COMPUTER = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const ATTEMPT_ID = "2b73a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";

function agentOn(computerId: string, displayName: string, extra: Partial<AgentListItem> = {}): AgentListItem {
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
    ...extra,
  };
}

function machine(id: string, name: string, online: boolean): WorkspaceComputerSummary {
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
    providerReadiness: online ? [{ provider: "codex", status: "ready", observedAt: NOW }] : undefined,
  };
}

function scanned(): FeishuSetupAttempt {
  return {
    id: ATTEMPT_ID,
    agentId: AGENT_ID,
    intent: "create",
    state: "succeeded",
    qrUrl: "https://example.test/qr",
    expiresAt: NOW,
    errorCode: null,
    completedAt: NOW,
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

describe("resume at a4e2662", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
      expiresIn: 900,
      issuedAt: NOW,
    });
    // Nobody redeems the issued repair code in these tests: the wait never concludes without the
    // Server's verdict, whichever machines the Computers list happens to show.
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "pending",
      computerId: null,
      redeemedAt: null,
    });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not finish setup on a Computer the Agent is not bound to", async () => {
    // Resume correctly refuses to claim the offline Computer, so the step issues a repair code for
    // it. A different machine enrolling during the wait is not the machine the code names, and the
    // Server's verdict is the only thing that can settle the wait — so the checks that would go
    // green on the wrong machine never run.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's old Mac")] });
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      // 1 = the resume read; the verdict stays pending, so nothing later is even consulted.
      const departed = machine(AGENT_COMPUTER, "Ada's old Mac", false);
      if (call <= 1) return { computers: [departed] };
      return { computers: [departed, machine(OTHER_COMPUTER, "Ada's new Mac", true)] };
    });
    const create = vi.spyOn(browserApi, "createAgent");
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(scanned());
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(scanned());
    const onComplete = vi.fn();

    render(<OnboardingV2Page onComplete={onComplete} />);
    await settle();
    await tick(5_000);
    const feishuButton = screen.queryByRole("button", { name: /Feishu/ });
    if (feishuButton) {
      fireEvent.click(feishuButton);
      await settle();
      await tick(5_000);
    }

    expect(create).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not send an Account that already has an Agent back to make a second one", async () => {
    // An Agent whose Computer is owned by someone else is skipped, which leaves the reader on the
    // first screen — and the create at the end of it is refused, because active Agent names are
    // unique per Account. Skipping the Agent is not the same as having an answer for it.
    vi.spyOn(browserApi, "agents").mockResolvedValue({
      agents: [agentOn(AGENT_COMPUTER, "Ada's Mac", { requiresComputerRebind: true })],
    });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [machine(AGENT_COMPUTER, "Ada's Mac", true)] });

    render(<OnboardingV2Page />);
    await settle();
    await tick(2_000);

    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
  });

  it("says so when it cannot read what the Account already has", async () => {
    // The read is swallowed and the flow opens as if the Account were new. The reader walks to the
    // end and the create is refused on name uniqueness, with nothing anywhere explaining why.
    vi.spyOn(browserApi, "agents").mockRejectedValue(new Error("Service unavailable"));
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });

    render(<OnboardingV2Page />);
    await settle();
    await tick(2_000);

    expect(screen.queryByRole("alert")).not.toBeNull();
  });

  it("hides Go back on a resumed step rather than showing one that cannot act", async () => {
    // This replaces the R3 probe, which now returns early when the button is absent and so passes
    // without asserting anything.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agentOn(AGENT_COMPUTER, "Ada's Mac")] });
    // Online but still probing, so the flow rests on the computer step, which is the one with a footer.
    vi.spyOn(browserApi, "computers").mockResolvedValue({
      computers: [{ ...machine(AGENT_COMPUTER, "Ada's Mac", true), providerReadiness: undefined }],
    });

    render(<OnboardingV2Page />);
    await settle();
    await tick(2_000);

    expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
    expect(document.querySelector('[data-ui="onboarding-v2-nav-back"]')).not.toBeNull();
  });
});
