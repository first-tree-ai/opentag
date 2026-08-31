/**
 * Probes for the review of `9a64ce6` — the head that makes this flow the real onboarding.
 *
 * Each asserts the behaviour the flow needs now that it sits behind the setup gate, and fails on
 * that head.
 */

import type {
  AgentAdminConfig,
  AgentListItem,
  FeishuSetupAttempt,
  ImBindingSummary,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import type { AgentDraft, Runtime } from "./flow.js";
import { OnboardingV2Page } from "./page.js";
import { useServerBackend } from "./server-backend.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const BINDING_ID = "3c83a21e-f6c7-4474-91ea-4dabf0566a24";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ATTEMPT_ID = "2b73a21e-f6c7-4474-91ea-4dabf0566a24";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REDEEMED_AT = "2026-08-29T00:00:05.000Z";
const POLL_MS = 1_500;
const FEISHU_POLL_MS = 2_000;
const HANDOFF_POLL_MS = 2_000;

function computer(overrides: Partial<WorkspaceComputerSummary> = {}): WorkspaceComputerSummary {
  return {
    computerId: COMPUTER_ID,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "online",
    connectedAt: "2026-08-29T00:00:10.000Z",
    lastSeenAt: "2026-08-29T00:00:10.000Z",
    observedAt: "2026-08-29T00:00:10.000Z",
    enrolledAt: "2026-08-29T00:00:10.000Z",
    agentIds: [],
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }],
    ...overrides,
  };
}

function draft(runtime: Runtime | undefined = "codex"): AgentDraft {
  return { destination: "local", name: "opentag", runtime, cloudRuntime: undefined, tokenSource: undefined };
}

function adminConfig(): AgentAdminConfig {
  return {
    id: AGENT_ID,
    name: "opentag",
    displayName: "opentag",
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

/** The binding Slack's install leaves behind once the App is authorized. */
function activeSlackBinding(): ImBindingSummary {
  return {
    id: BINDING_ID,
    agentId: AGENT_ID,
    provider: "slack",
    bindingState: "active",
    bot: { displayName: "opentag", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: NOW,
    lastRuntimeObservationAt: null,
  };
}

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

function attempt(overrides: Partial<FeishuSetupAttempt> = {}): FeishuSetupAttempt {
  return {
    id: ATTEMPT_ID,
    agentId: AGENT_ID,
    intent: "create",
    brand: "feishu",
    state: "awaiting_user",
    qrUrl: "https://example.test/qr",
    expiresAt: "2026-08-29T00:10:00.000Z",
    errorCode: null,
    completedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function computersReturning(...pages: readonly (readonly WorkspaceComputerSummary[])[]) {
  let call = 0;
  return vi.spyOn(browserApi, "computers").mockImplementation(async () => {
    const page = pages[Math.min(call, pages.length - 1)] ?? [];
    call += 1;
    return { computers: [...page] };
  });
}

function issuing() {
  return vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    connectCodeId: CONNECT_CODE_ID,
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
    expiresIn: 900,
    issuedAt: NOW,
  });
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

function press(name: string | RegExp) {
  fireEvent.click(screen.getByRole("button", { name }));
}

async function reachComputerStep() {
  press(/Local computer/);
  press("Continue");
  press(/Codex/);
  press("Continue");
  await settle();
}

function mount(initial: AgentDraft = draft()) {
  return renderHook((props: AgentDraft) => useServerBackend(props), { initialProps: initial });
}

describe("onboarding-v2 as the real onboarding: findings at 9a64ce6", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    // The flow now reads what the Account already has before it renders, so a fresh Account has to
    // be stated: no Agents, and therefore no messaging binding.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    // Every walk here connects its Computer: the Server's verdict is that the issued code was
    // redeemed by exactly it.
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "redeemed",
      computerId: COMPUTER_ID,
      redeemedAt: REDEEMED_AT,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("keeps a failed creation's explanation on screen while the reader reads it", async () => {
    // The readiness poll now clears `error` on every success, and it keeps running through the
    // rest of the flow — so it retires messages it never set, within one poll interval.
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockRejectedValue(new Error("An active Agent with this name already exists"));

    const view = mount();
    act(() => view.result.current.computerConnected(computer()));
    await settle();
    await tick(POLL_MS);
    act(() => view.result.current.createAgent(draft()));
    await settle();
    expect(view.result.current.error).toBe("An active Agent with this name already exists");

    await tick(POLL_MS);
    expect(view.result.current.error).toBe("An active Agent with this name already exists");
  });

  it("offers a way back after Feishu refuses the attempt", async () => {
    // `failed` no longer retries on sight, which is right — but nothing restarts it either, and
    // the messaging step has no footer, so the panel is inert.
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockRejectedValue(new Error("Feishu is unavailable"));

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Feishu/);
    await settle();

    expect(screen.queryByText("Waiting for you to scan…")).toBeNull();
  });

  it("resumes from the Agent and Computer the Account already has", async () => {
    // Behind the setup gate this page is re-entered constantly: Slack's OAuth callback lands on a
    // gated route and bounces back here, and so does any reload. It reads nothing that already
    // exists, so it opens on "Where should your agent run?" with the work already done.
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [existingAgent()] });

    render(<OnboardingV2Page />);
    await settle();

    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
  });

  it("reports completion once the messaging app is connected", async () => {
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });
    const onComplete = vi.fn();

    render(<OnboardingV2Page onComplete={onComplete} />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Feishu/);
    await settle();
    await tick(8_000);
    await tick(8_000);
    console.log("BODY:", document.body.textContent?.slice(0, 400));
    console.log("handoff calls:", vi.mocked(browserApi.imBindingHandoff).mock.calls.length);

    expect(onComplete).toHaveBeenCalledWith(AGENT_ID);
  });

  it("reports completion for a Slack install too", async () => {
    // Slack's callback redirects to a gated Agent route, the setup gate sends it back here, and a
    // fresh page has no Agent — so `onComplete` is never reached and setup is never marked done.
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "startSlackOAuth").mockResolvedValue({
      authorizationUrl: "https://slack.com/oauth/v2/authorize?client_id=x",
      expiresAt: "2026-08-29T00:10:00.000Z",
    });
    const assign = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { ...window.location, assign } });
    const onComplete = vi.fn();

    render(<OnboardingV2Page onComplete={onComplete} />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Slack/);
    await settle();
    press(/Add to Slack/);
    await settle();

    expect(assign).toHaveBeenCalled();
    // The user comes back to a gated route, is bounced to /onboarding, and this page remounts.
    // By then the install has happened, so the Account has the Agent and a live Slack binding —
    // which is the whole point: the page has to recognise that rather than start over.
    vi.mocked(browserApi.agents).mockResolvedValue({ agents: [existingAgent()] });
    vi.mocked(browserApi.imBinding).mockResolvedValue(activeSlackBinding());
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });
    const onCompleteAfterReturn = vi.fn();
    render(<OnboardingV2Page onComplete={onCompleteAfterReturn} />);
    await settle();
    await tick(POLL_MS * 2);

    expect(onCompleteAfterReturn).toHaveBeenCalled();
  });

  it("keeps a re-board review open until the tester explicitly finishes it", async () => {
    vi.mocked(browserApi.agents).mockResolvedValue({ agents: [existingAgent()] });
    computersReturning([computer()]);
    vi.mocked(browserApi.imBinding).mockResolvedValue(activeSlackBinding());
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });
    const onComplete = vi.fn();

    render(<OnboardingV2Page onComplete={onComplete} reviewMode />);
    await settle();

    expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish re-board" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start over" })).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();

    press("Finish re-board");
    expect(screen.getByRole("button", { name: "Finishing…" })).toHaveProperty("disabled", true);
    await settle();

    expect(onComplete).toHaveBeenCalledExactlyOnceWith(AGENT_ID);
  });

  it("keeps re-board completion recoverable after its bounded attempts fail", async () => {
    vi.mocked(browserApi.agents).mockResolvedValue({ agents: [existingAgent()] });
    computersReturning([computer()]);
    vi.mocked(browserApi.imBinding).mockResolvedValue(activeSlackBinding());
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });
    const onComplete = vi.fn().mockRejectedValue(new Error("Service unavailable"));

    render(<OnboardingV2Page onComplete={onComplete} reviewMode />);
    await settle();
    press("Finish re-board");
    await settle();

    expect(onComplete).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("alert").textContent).not.toContain("Reload");
    expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", false);

    press("Try again");
    expect(screen.getByRole("button", { name: "Finishing…" })).toHaveProperty("disabled", true);
    await settle();

    expect(onComplete).toHaveBeenCalledTimes(6);
    expect(screen.getByRole("button", { name: "Try again" })).toHaveProperty("disabled", false);
  });

  it("retries marking setup complete when the Server refuses it once", async () => {
    // The claim is released after a refusal so a transient failure does not strand the reader on
    // the finished screen with an account the Server still considers incomplete.
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });
    const onComplete = vi.fn().mockRejectedValueOnce(new Error("Service unavailable")).mockResolvedValue(undefined);

    render(<OnboardingV2Page onComplete={onComplete} />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Feishu/);
    await settle();
    await tick(FEISHU_POLL_MS * 2);
    await tick(HANDOFF_POLL_MS * 2);
    await tick(HANDOFF_POLL_MS * 2);

    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  /*
   * The Server refuses to complete setup until the Agent is genuinely reachable — an active
   * binding, a ready runtime, a ready provider CLI, and an observation of the messaging identity.
   * Slack's install marks the binding active before that observation lands, so a page that treats
   * "installed" as "finished" asks for something that will be refused, and spends its attempts
   * doing it.
   */
  it("does not complete setup on an installed app the Server cannot yet reach", async () => {
    computersReturning([computer()]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    // Bound, but not yet reachable: exactly the window a real Slack callback lands in.
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: false });
    const onComplete = vi.fn();

    render(<OnboardingV2Page onComplete={onComplete} />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Feishu/);
    await settle();
    await tick(FEISHU_POLL_MS * 2);
    await tick(HANDOFF_POLL_MS * 4);

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();

    // Once the Server has made its observation, the flow finishes on the same poll.
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });
    await tick(HANDOFF_POLL_MS * 2);

    expect(onComplete).toHaveBeenCalledWith(AGENT_ID);
  });

  /*
   * Reachability needs the messaging CLI too, so an Account without it waits forever — and the
   * Server's handoff status carries no reason. The page knows this one from the Computer's own
   * readiness, so an unexplained spinner is a choice rather than a limitation.
   */
  it("says what a wait for reachability is waiting on, when it knows", async () => {
    computersReturning([computer({ imCliReadiness: [{ provider: "feishu", status: "install", observedAt: NOW }] })]);
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: false });

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Feishu/);
    await settle();
    await tick(FEISHU_POLL_MS * 2);
    await tick(HANDOFF_POLL_MS * 2);

    expect(screen.getByText(/Feishu messages are sent through its CLI/)).toBeTruthy();
  });
});
