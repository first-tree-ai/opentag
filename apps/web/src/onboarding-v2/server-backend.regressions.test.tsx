/**
 * The defects this seam actually had, kept as the guard against having them again.
 *
 * Each of these was a real failure of the Server-backed flow, written first as an assertion of the
 * behaviour the flow is supposed to have. Two of them could create an Agent on a Computer this
 * reader never enrolled; one could answer for a messaging app nobody had probed. None describes a
 * Server fault — they are all decisions this hook and its steps make locally, which is why they
 * are guarded here rather than left to a live run to catch.
 */

import type {
  AgentAdminConfig,
  AgentListItem,
  ComputerConnectCodeStatus,
  FeishuSetupAttempt,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { messagingCliCheck } from "../setup/index.js";
import type { AgentDraft, Runtime } from "./flow.js";
import { OnboardingV2Page } from "./page.js";
import { useServerBackend } from "./server-backend.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ATTEMPT_ID = "2b73a21e-f6c7-4474-91ea-4dabf0566a24";
const CONNECT_CODE_ID = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
const REDEEMED_AT = "2026-08-29T00:00:05.000Z";
const POLL_MS = 1_500;
const FEISHU_POLL_MS = 2_000;

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

function listItem(overrides: Partial<AgentListItem> = {}): AgentListItem {
  return {
    id: AGENT_ID,
    name: "opentag",
    displayName: "opentag",
    createdBy: { userId: USER_ID, displayName: "Ada" },
    computer: { computerId: COMPUTER_ID, displayName: "Ada's Mac", platform: "darwin" },
    runtimeProvider: "codex",
    receiveMode: "mention_only",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    activity: { state: "idle" },
    usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
    ...overrides,
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

function issuing(
  overrides: Partial<{ connectCodeId: string; bootstrapCommand: string; expiresIn: number; issuedAt: string }> = {},
) {
  return vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    connectCodeId: CONNECT_CODE_ID,
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
    expiresIn: 900,
    issuedAt: NOW,
    ...overrides,
  });
}

/** The Server's verdict on the issued code: the exact Computer redeemed it. */
function redeemedVerdict(): ComputerConnectCodeStatus {
  return { connectCodeId: CONNECT_CODE_ID, state: "redeemed", computerId: COMPUTER_ID, redeemedAt: REDEEMED_AT };
}

function pendingVerdict(): ComputerConnectCodeStatus {
  return { connectCodeId: CONNECT_CODE_ID, state: "pending", computerId: null, redeemedAt: null };
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

function mount(initial: AgentDraft = draft()) {
  return renderHook((props: AgentDraft) => useServerBackend(props), { initialProps: initial });
}

async function connected(view: ReturnType<typeof mount>) {
  act(() =>
    view.result.current.computerConnected(
      computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] }),
    ),
  );
}

describe("Server-backed onboarding: the defects it had", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date(NOW));
    // The flow now reads what the Account already has before it renders, so a fresh Account has to
    // be stated: no Agents, and therefore no messaging binding.
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    // A code the test says nothing about stays pending: the wait never concludes without a verdict.
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockImplementation(async () => pendingVerdict());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("drops a readiness verdict that belongs to a runtime the reader has stopped choosing", async () => {
    // Readiness is stored as one flat fact with no record of which runtime produced it, so
    // changing the runtime leaves the previous runtime's verdict on screen — and the footer
    // enabled — until the next poll lands, up to a full interval later.
    const view = mount(draft("codex"));
    act(() =>
      view.result.current.computerConnected(
        computer({
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: NOW },
            { provider: "claude-code", status: "install", observedAt: NOW },
          ],
        }),
      ),
    );
    expect(view.result.current.readiness?.runtime).toBe("ready");

    view.rerender(draft("claude-code"));

    expect(view.result.current.readiness?.runtime).not.toBe("ready");
  });

  it("does not report a messaging CLI verdict taken from a different provider", async () => {
    // `imCliReadiness[0]` is whichever CLI the Server happened to observe first, in its own
    // canonical order. Here only Slack has been probed, so a reader who picks Lark is told
    // Lark's CLI is present on the strength of Slack's result.
    const view = mount();
    act(() =>
      view.result.current.computerConnected(
        computer({
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }],
          imCliReadiness: [{ provider: "slack", status: "ready", observedAt: NOW }],
        }),
      ),
    );

    // Slack's result answers for Slack and for nothing else; Lark has simply not been probed.
    expect(view.result.current.readiness?.messagingCli.slack).toBe("ready");
    expect(view.result.current.readiness?.messagingCli.feishu).toBeUndefined();
    expect(messagingCliCheck(view.result.current.readiness?.messagingCli.feishu)).toBe("pending");
  });

  it("stops polling a Lark attempt that Start over abandoned", async () => {
    computersReturning([computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] })]);
    issuing();
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemedVerdict());
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue(attempt());
    const poll = vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt());

    const view = mount();
    await connected(view);
    act(() => view.result.current.createAgent(draft()));
    await settle();
    act(() => view.result.current.startMessaging("feishu"));
    await settle();
    await tick(FEISHU_POLL_MS);
    expect(poll).toHaveBeenCalled();

    act(() => view.result.current.reset());
    poll.mockClear();
    poll.mockResolvedValue(attempt({ state: "succeeded", completedAt: NOW }));
    await tick(FEISHU_POLL_MS * 2);

    expect(poll).not.toHaveBeenCalled();
    expect(view.result.current.messaging).toEqual({ kind: "idle" });
  });
  it("asks for one Lark code per attempt rather than retrying a refused one on sight", async () => {
    // The messaging step starts an attempt whenever the state is idle, and a refused attempt is
    // returned to idle, so the effect starts another one immediately. Nothing paces the two, and
    // nothing bounds them: the mock below has to stop refusing in order for the test to end.
    computersReturning([computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] })]);
    issuing();
    vi.mocked(browserApi.computerConnectCodeStatus).mockResolvedValue(redeemedVerdict());
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    let calls = 0;
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockImplementation(async () => {
      calls += 1;
      if (calls < 8) throw new Error("Lark is unavailable");
      return attempt();
    });
    vi.spyOn(browserApi, "feishuSetupAttempt").mockResolvedValue(attempt());

    render(<OnboardingV2Page />);

    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    await tick(POLL_MS);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle();

    expect(calls).toBe(1);
  });

  it("refuses to resume an Agent that has no Computer rather than reporting someone else's machine", async () => {
    /*
     * An unbound Agent is not resumed at all. Reporting a Computer for it would have to come from
     * an arrival -- a machine on the Account that enrolled or reconnected -- which identifies a
     * machine but not one this Agent was ever given, and the run would then advance into messaging,
     * which refuses an Agent with nowhere to run. So the reader is handed the page where the Agent
     * gets a Computer instead, and nothing durable is written on a guess.
     */
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [listItem({ computer: null })] });
    computersReturning([
      computer({ computerId: "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f", displayName: "Someone else's laptop" }),
    ]);
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer");

    const view = mount();
    await settle();

    expect(view.result.current.resumeBlocked).toEqual({ agentId: AGENT_ID, agentName: "opentag" });
    expect(rebind).not.toHaveBeenCalled();
    // Not silently created either, so nothing advances toward messaging.
    expect(view.result.current.creation).not.toBe("created");
  });
});
