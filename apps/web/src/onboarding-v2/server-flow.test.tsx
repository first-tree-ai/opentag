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
const SECOND_ATTEMPT_ID = "3b73a21e-f6c7-4474-91ea-4dabf0566a24";
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
      bootstrapCommand: COMMAND,
      expiresIn: 900,
      issuedAt: NOW,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("walks from the connect command to a created Agent and a scanned Feishu code", async () => {
    computersReturning([], [computer()]);
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    vi.spyOn(browserApi, "feishuSetupAttempt")
      .mockResolvedValueOnce(attempt())
      .mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    vi.mocked(browserApi.imBindingHandoff).mockResolvedValue({ bindingState: "active", handoffReady: true });

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();

    // The block breaks the code by character, so the command lives across two spans in one <code>.
    expect(document.querySelector("code")?.textContent).toContain(COMMAND);
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);

    await tick(POLL_MS);
    expect(screen.getByText("Your computer is connected.")).toBeTruthy();
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
    press(/Feishu/);
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

  /*
   * The way out of a wrong guess. A code is minted against one brand's domain and cannot be
   * authorized from the other, so switching is not a relabelling: the attempt on screen has to be
   * released and a new code issued, or `createOrReuse` hands back the very code the reader left.
   */
  it("issues a fresh code against the other brand when the reader switches", async () => {
    computersReturning([], [computer()]);
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    const create = vi
      .spyOn(browserApi, "createFeishuSetupAttempt")
      .mockImplementation(async (_agentId, _intent, brand) =>
        attempt({ id: brand === "lark" ? SECOND_ATTEMPT_ID : ATTEMPT_ID, brand: brand ?? "feishu" }),
      );
    const cancel = vi
      .spyOn(browserApi, "cancelFeishuSetupAttempt")
      .mockImplementation(async (id) => attempt({ id, state: "canceled", qrUrl: null }));
    vi.spyOn(browserApi, "feishuSetupAttempt").mockImplementation(async (id) => attempt({ id }));

    render(<OnboardingV2Page />);
    await settle();
    await reachComputerStep();
    await tick(POLL_MS);
    press("Continue");
    await settle();
    press(/^Feishu/);
    await settle();

    const chosen = create.mock.calls[0]?.[2];
    if (!chosen) throw new Error("The first connect did not name a brand");
    const other = chosen === "feishu" ? "lark" : "feishu";
    const otherLabel = other === "lark" ? "Lark" : "Feishu";
    expect(
      screen.getByRole("img", { name: `Scan this QR code in ${chosen === "lark" ? "Lark" : "Feishu"}` }),
    ).toBeTruthy();

    press(`Use ${otherLabel} instead`);
    await settle();

    // Released first, then reissued: the order is what stops the Server returning the old code.
    expect(cancel).toHaveBeenCalledWith(chosen === "lark" ? SECOND_ATTEMPT_ID : ATTEMPT_ID);
    expect(create).toHaveBeenLastCalledWith(AGENT_ID, "create", other);
    expect(screen.getByRole("img", { name: `Scan this QR code in ${otherLabel}` })).toBeTruthy();
  });

  it("gives the agent name field an accessible name despite Kumo's own warning", async () => {
    computersReturning([]);
    render(<OnboardingV2Page />);
    await settle();
    press(/Local computer/);
    press("Continue");

    expect(screen.getByLabelText("Agent name")).toBeTruthy();
  });

  it("keeps the reader on the check while the runtime is still being probed", async () => {
    computersReturning([], [computer({ providerReadiness: undefined })]);

    render(<OnboardingV2Page />);

    await settle();
    await reachComputerStep();
    await tick(POLL_MS);

    expect(screen.getByText("Waiting for the computer check…")).toBeTruthy();
    expect(screen.queryByText(/We can't find the Codex command/)).toBeNull();
    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
  });

  it("names the failing check and refuses to create the Agent", async () => {
    computersReturning(
      [],
      [computer({ providerReadiness: [{ provider: "codex", status: "install", observedAt: NOW }] })],
    );
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
