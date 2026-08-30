/**
 * The defects this seam actually had, kept as the guard against having them again.
 *
 * Each of these was a real failure of the Server-backed flow, written first as an assertion of the
 * behaviour the flow is supposed to have. Two of them could create an Agent on a Computer this
 * reader never enrolled; one could answer for a messaging app nobody had probed. None describes a
 * Server fault — they are all decisions this hook and its steps make locally, which is why they
 * are guarded here rather than left to a live run to catch.
 */

import type { AgentAdminConfig, FeishuSetupAttempt, WorkspaceComputerSummary } from "@opentag/shared/browser";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { messagingCliCheck } from "../setup/index.js";
import type { AgentDraft, Runtime } from "./flow.js";
import { OnboardingV2Page } from "./page.js";
import { useServerBackend } from "./server-backend.js";
import { ComputerStep } from "./steps.js";

const NOW = "2026-08-29T00:00:00.000Z";
const COMPUTER_ID = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const USER_ID = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const ATTEMPT_ID = "2b73a21e-f6c7-4474-91ea-4dabf0566a24";
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

function issuing(overrides: Partial<{ bootstrapCommand: string; expiresIn: number; issuedAt: string }> = {}) {
  return vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
    bootstrapCommand: "sh -c 'curl -fsSL https://example.test/install.sh | sh' -- connect ABC",
    expiresIn: 900,
    issuedAt: NOW,
    ...overrides,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  act(() => view.result.current.issueConnectCode());
  await settle();
  await tick(POLL_MS);
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not adopt a Computer from a poll that returns after the code expired", async () => {
    // The expiry check runs at the top of the interval, but a request already in flight when the
    // code expires still lands. Its handler adopts the Computer and publishes readiness before it
    // looks at whether the connection is still the one being waited on.
    const late = deferred<{ computers: WorkspaceComputerSummary[] }>();
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      if (call === 2) return late.promise;
      return { computers: [] };
    });
    issuing({ expiresIn: 2 });
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());

    const view = mount();
    act(() => view.result.current.issueConnectCode());
    await settle();
    await tick(POLL_MS); // the poll leaves; the code has 500ms left
    await tick(POLL_MS); // the next tick finds it expired
    expect(view.result.current.connect.kind).toBe("expired");

    await act(async () => {
      late.resolve({
        computers: [computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] })],
      });
      await Promise.resolve();
    });

    act(() => view.result.current.createAgent(draft()));
    await settle();
    expect(create).not.toHaveBeenCalled();
    expect(view.result.current.readiness).toBeUndefined();
  });

  it("keeps Continue disabled while the Computer is not connected, whatever readiness says", () => {
    // `readinessPassed` is the only gate on the footer, so a readiness fact that outlives its
    // connection re-enables the button on a step that is showing an expired command.
    render(
      <ComputerStep
        connect={{ kind: "expired", command: "sh install" }}
        creation="idle"
        draft={draft()}
        onBack={() => undefined}
        onCreate={() => undefined}
        onRefreshCommand={() => undefined}
        readiness={{ runtime: "ready", messagingCli: {} }}
      />,
    );

    expect(screen.getByRole("button", { name: "Continue" })).toHaveProperty("disabled", true);
  });

  it("drops a readiness verdict that belongs to a runtime the reader has stopped choosing", async () => {
    // Readiness is stored as one flat fact with no record of which runtime produced it, so
    // changing the runtime leaves the previous runtime's verdict on screen — and the footer
    // enabled — until the next poll lands, up to a full interval later.
    computersReturning(
      [],
      [
        computer({
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: NOW },
            { provider: "claude-code", status: "install", observedAt: NOW },
          ],
        }),
      ],
    );
    issuing();

    const view = mount(draft("codex"));
    await connected(view);
    expect(view.result.current.readiness?.runtime).toBe("ready");

    view.rerender(draft("claude-code"));

    expect(view.result.current.readiness?.runtime).not.toBe("ready");
  });

  it("does not report a messaging CLI verdict taken from a different provider", async () => {
    // `imCliReadiness[0]` is whichever CLI the Server happened to observe first, in its own
    // canonical order. Here only Slack has been probed, so a reader who picks Feishu is told
    // Feishu's CLI is present on the strength of Slack's result.
    computersReturning(
      [],
      [
        computer({
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }],
          imCliReadiness: [{ provider: "slack", status: "ready", observedAt: NOW }],
        }),
      ],
    );
    issuing();

    const view = mount();
    await connected(view);

    // Slack's result answers for Slack and for nothing else; Feishu has simply not been probed.
    expect(view.result.current.readiness?.messagingCli.slack).toBe("ready");
    expect(view.result.current.readiness?.messagingCli.feishu).toBeUndefined();
    expect(messagingCliCheck(view.result.current.readiness?.messagingCli.feishu)).toBe("pending");
  });

  it("stops polling a Feishu attempt that Start over abandoned", async () => {
    computersReturning(
      [],
      [computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] })],
    );
    issuing();
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
  it("asks for one Feishu code per attempt rather than retrying a refused one on sight", async () => {
    // The messaging step starts an attempt whenever the state is idle, and a refused attempt is
    // returned to idle, so the effect starts another one immediately. Nothing paces the two, and
    // nothing bounds them: the mock below has to stop refusing in order for the test to end.
    computersReturning(
      [],
      [computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] })],
    );
    issuing();
    vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    let calls = 0;
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockImplementation(async () => {
      calls += 1;
      if (calls < 8) throw new Error("Feishu is unavailable");
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
    fireEvent.click(screen.getByRole("button", { name: /Feishu/ }));
    await settle();

    expect(calls).toBe(1);
  });

  it("clears a transient polling error once the Computer it was waiting for arrives", async () => {
    // `error` is only cleared by issuing a code or creating an Agent, so a poll that failed once
    // leaves its line above a step that has since succeeded.
    let call = 0;
    vi.spyOn(browserApi, "computers").mockImplementation(async () => {
      call += 1;
      if (call === 2) throw new Error("We lost contact");
      if (call >= 3) {
        return {
          computers: [computer({ providerReadiness: [{ provider: "codex", status: "ready", observedAt: NOW }] })],
        };
      }
      return { computers: [] };
    });
    issuing();

    const view = mount();
    act(() => view.result.current.issueConnectCode());
    await settle();
    await tick(POLL_MS);
    expect(view.result.current.error).toBe("We lost contact");

    await tick(POLL_MS);
    expect(view.result.current.connect.kind).toBe("connected");
    expect(view.result.current.error).toBeUndefined();
  });
});
