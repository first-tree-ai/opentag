/**
 * The whole local route against stubbed Server calls, driven the way a reader drives it.
 *
 * The hook tests next door prove what the seam concludes; this one proves the pages and the seam
 * are wired to each other — that the connect code reaches the block, the check reaches the footer,
 * and creating the Agent hands the flow to the messaging step.
 */

import type { AgentAdminConfig, FeishuSetupAttempt, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingV2Page } from "./page.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ATTEMPT_ID = "2b73a21e-f6c7-4474-91ea-4dabf0566a24";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REDEEMED_AT = "2026-08-29T00:00:05.000Z";
const POLL_MS = 1_500;
const FEISHU_POLL_MS = 2_000;
const HANDOFF_POLL_MS = 2_000;
const COMMAND = "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABCDEF";

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

function attempt(overrides: Partial<FeishuSetupAttempt> = {}): FeishuSetupAttempt {
  return {
    id: ATTEMPT_ID,
    agentId: AGENT_ID,
    intent: "create",
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

/** The Server's verdict on the issued code: the exact Computer redeemed it. */
function redeemedVerdict() {
  return vi
    .spyOn(browserApi, "computerConnectCodeStatus")
    .mockResolvedValueOnce({
      connectCodeId: CONNECT_CODE_ID,
      state: "pending",
      computerId: null,
      redeemedAt: null,
    })
    .mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "redeemed",
      computerId: COMPUTER_ID,
      redeemedAt: REDEEMED_AT,
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

/** Local route, Codex, default name — the shortest path to the step that talks to the Server. */
async function reachComputerStep() {
  press(/Local computer/);
  press("Continue");
  press(/Codex/);
  press("Continue");
  await settle();
}

describe("the onboarding flow against the Server", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    // The flow now reads what the Account already has before it renders, so a fresh Account has to
    // be stated: no Agents, and therefore no messaging binding.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
    // A code the test says nothing about stays pending: the wait never concludes without a verdict.
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      connectCodeId: CONNECT_CODE_ID,
      state: "pending",
      computerId: null,
      redeemedAt: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("starts with Local available and Cloud visibly coming soon", async () => {
    computersReturning([]);
    render(<OnboardingV2Page />);

    await settle();
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Local computer/ })).toHaveProperty("disabled", false);
    const cloud = screen.getByRole("button", { name: /Cloud computer/ });
    expect(cloud).toHaveProperty("disabled", true);
    expect(cloud.textContent).toContain("Coming soon");
  });

  it("walks from the connect command to a created Agent and a scanned Lark code", async () => {
    computersReturning([], [computer()]);
    redeemedVerdict();
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    vi.spyOn(browserApi, "feishuSetupAttempt")
      .mockResolvedValueOnce(attempt())
      .mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await settle();

    // The block breaks the code by character, so the command lives across two spans in one <code>.
    expect(document.querySelector("code")?.textContent).toContain(COMMAND);
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);

    await tick(POLL_MS);
    expect(screen.getByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("Everything your agent needs is ready.")).toBeTruthy();

    press("Continue");
    await settle();
    expect(create).toHaveBeenCalledWith({
      name: "opentag",
      displayName: "opentag",
      runtimeProvider: "codex",
      computerId: COMPUTER_ID,
    });

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    press(/Lark/);
    await settle();
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

    await tick(FEISHU_POLL_MS * 2);
    // Scanning installs the app; the Server observing that the Agent can be reached is a second
    // thing, and completing setup waits on it.
    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();
    await tick(HANDOFF_POLL_MS * 2);
    await tick(HANDOFF_POLL_MS * 2);
    expect(screen.getByRole("heading", { name: "opentag is ready." })).toBeTruthy();
  });

  it("gives the agent name field an accessible name despite Kumo's own warning", async () => {
    computersReturning([]);
    render(<OnboardingV2Page />);
    await settle();
    press(/Local computer/);
    press("Continue");

    expect(screen.getByLabelText("Agent name")).toBeTruthy();
  });

  it("checks and preserves the runtime selected on the Create agent step", async () => {
    computersReturning([
      computer({
        providerReadiness: [
          { provider: "codex", status: "ready", observedAt: NOW },
          { provider: "claude-code", status: "install", observedAt: NOW },
        ],
      }),
    ]);
    redeemedVerdict();
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    render(<OnboardingV2Page />);

    await settle();
    press(/Local computer/);
    press("Continue");
    press(/Claude Code/);
    press("Continue");
    await settle();
    await tick(POLL_MS);

    expect(screen.getByText("Claude Code CLI is installed")).toBeTruthy();
    expect(screen.getByText("We can't find the Claude Code command on this computer.")).toBeTruthy();
    expect(screen.queryByText("Codex CLI is installed")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    expect(create).not.toHaveBeenCalled();
  });

  it("labels a not-yet-issued Lark QR as generating rather than scannable", async () => {
    computersReturning([computer()]);
    redeemedVerdict();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt({ qrUrl: null }));
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt({ qrUrl: null }));
    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/Lark/);
    await settle();

    expect(screen.getByText("Generating QR code…")).toBeTruthy();
    expect(screen.queryByText("Waiting for you to scan…")).toBeNull();
  });

  it("keeps the reader on the check while the runtime is still being probed", async () => {
    computersReturning([computer({ providerReadiness: undefined })]);
    redeemedVerdict();

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);

    expect(screen.getByText("Waiting for the computer check…")).toBeTruthy();
    expect(screen.queryByText(/We can't find the Codex command/)).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
  });

  it("names the failing check and refuses to create the Agent", async () => {
    computersReturning([computer({ providerReadiness: [{ provider: "codex", status: "install", observedAt: NOW }] })]);
    redeemedVerdict();
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);

    expect(screen.getByText("One thing needs fixing before your agent can run.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
    expect(create).not.toHaveBeenCalled();
  });

  it("surfaces a failure to issue the connect command", async () => {
    computersReturning([]);
    vi.spyOn(browserApi, "issueComputerConnectCode").mockRejectedValue(new Error("Service unavailable"));

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();

    expect(screen.getByRole("alert").textContent).toContain("Service unavailable");
  });
});
