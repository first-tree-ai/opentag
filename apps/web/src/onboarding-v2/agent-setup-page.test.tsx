/**
 * The Agent Setup surface, end to end against the in-memory model and scripted adapters.
 *
 * What is pinned here is the contract the route will rely on: the page renders only what the
 * canonical snapshot says (stage, identities, blockers, permitted actions), it never invents a
 * Provider or a stage, a stale read can never overwrite a newer one, and the only way across
 * Providers is an explicit unbind followed by the fresh choice.
 */

import type { AgentSetupSnapshot } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../api.js";
import { AgentSetupPage } from "./agent-setup-page.js";
import {
  deferred,
  SETUP_AGENT_ID,
  SETUP_COMPUTER_ID,
  SETUP_OTHER_AGENT_ID,
  setupAgent,
} from "./agent-setup-test-fixtures.js";
import { OnboardingV2Page } from "./page.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

const POLL_MS = 2_000;

/** Flushes the promise queue: reads, writes, and QR rendering all settle without a clock. */
async function settle(rounds = 6): Promise<void> {
  await act(async () => {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** An adapter whose read is whatever the test says; the writes are recorded spies. */
function scriptedAdapter(
  read: (agentId: string) => Promise<AgentSetupSnapshot>,
  overrides: Partial<AgentSetupAdapter> = {},
): AgentSetupAdapter {
  return {
    readSnapshot: vi.fn(read),
    startFeishuAttempt: vi.fn(async () => undefined),
    cancelFeishuAttempt: vi.fn(async () => undefined),
    startSlackInstall: vi.fn(async () => "https://slack.com/oauth/v2/authorize?state=scripted"),
    unbindMessaging: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderSetup(
  adapter: AgentSetupAdapter,
  props: {
    agentId?: string;
    onReady?: (agentId: string) => Promise<void> | void;
    reviewMode?: boolean;
    slackOAuthError?: string;
  } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSetupPage
        adapter={adapter}
        agentId={props.agentId ?? SETUP_AGENT_ID}
        onReady={props.onReady}
        reviewMode={props.reviewMode}
        slackOAuthError={props.slackOAuthError}
      />
    </QueryClientProvider>,
  );
}

function mockComputerInventory() {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
  // The connect command never lands in these tests: what matters is what the page renders while waiting.
  return vi.spyOn(browserApi, "issueComputerConnectCode").mockImplementation(() => deferred<never>().promise);
}

async function currentBindingId(adapter: AgentSetupAdapter): Promise<string> {
  const snapshot = await adapter.readSnapshot(SETUP_AGENT_ID);
  if (snapshot.messaging.kind === "blocked" && snapshot.messaging.bindingId) return snapshot.messaging.bindingId;
  if (snapshot.messaging.kind === "ready" || snapshot.messaging.kind === "waiting-handoff") {
    return snapshot.messaging.bindingId;
  }
  throw new Error("no current binding");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("AgentSetupPage stages", () => {
  it("offers the shared bind surface when the Agent has no Computer", async () => {
    const issue = mockComputerInventory();
    const memory = createMemorySetupAdapter({ agent: setupAgent({ computer: null }) });
    renderSetup(memory.adapter);
    await settle();
    await advance(1);

    expect(screen.getByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
    expect(screen.getByText("Reviewer has no computer yet. Connect the machine it should run on.")).toBeTruthy();
    expect(screen.getByText("Connect your computer")).toBeTruthy();
    expect(document.querySelector('[data-ui="agent-setup-computer"]')?.getAttribute("data-state")).toBe("not-bound");
    expect(issue).toHaveBeenCalledWith({ mode: "create", targetAgentId: SETUP_AGENT_ID });
  });

  it("offers an owned Computer choice when a cross-Account rebind is required", async () => {
    mockComputerInventory();
    const memory = createMemorySetupAdapter({ agent: setupAgent({ requiresComputerRebind: true }) });
    renderSetup(memory.adapter);
    await settle();

    expect(
      screen.getByText("Review Mac belongs to another Account. Choose a Computer owned by this Account for Reviewer."),
    ).toBeTruthy();
    expect(document.querySelector('[data-ui="agent-setup-computer"]')?.getAttribute("data-state")).toBe(
      "requires-rebind",
    );
    expect(screen.getByText("Connect your computer")).toBeTruthy();
  });

  it("says an offline Computer is offline and keeps watching it", async () => {
    const issue = mockComputerInventory();
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();

    expect(
      screen.getByText(
        "Review Mac is offline. Run opentag daemon start in a terminal on that Computer; this page will continue when it reconnects.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(reads).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Need to reinstall? Generate a repair command." }));
    await settle();
    await advance(1);
    expect(issue).toHaveBeenCalledWith({
      mode: "repair",
      targetAgentId: SETUP_AGENT_ID,
      targetComputerId: SETUP_COMPUTER_ID,
    });

    // An offline Computer is expected to come back without the page being touched, so it is polled.
    const readsBeforePoll = reads.mock.calls.length;
    await advance(POLL_MS + 10);
    expect(reads.mock.calls.length).toBeGreaterThan(readsBeforePoll);
  });

  it("points a missing runtime at the repair command on the exact Computer", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByRole("heading", { name: "Prepare Codex" })).toBeTruthy();
    expect(screen.getByText("Codex isn't installed on Review Mac yet.")).toBeTruthy();
    expect(screen.getByText('"$HOME/.local/bin/opentag" doctor --json')).toBeTruthy();
  });

  it("waits visibly while the runtime check is still resolving", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "checking" });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByText("Checking Codex on Review Mac…")).toBeTruthy();
    expect(document.querySelector('[data-ui="agent-setup-runtime"]')?.getAttribute("data-state")).toBe("checking");
  });

  it("offers exactly the Providers the snapshot permits, and no others", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      imCliReadiness: { feishu: "install", slack: "ready" },
    });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
    const readiness = document.querySelector('[data-ui="onboarding-v2-im-cli-readiness"]');
    expect(readiness).not.toBeNull();
    expect(within(readiness as HTMLElement).getByText("Preparing")).toBeTruthy();
    expect(within(readiness as HTMLElement).getByText("Ready")).toBeTruthy();
  });

  it("shows the Feishu authorization with its QR, expiry, and cancel from the snapshot", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    renderSetup(memory.adapter);
    await settle(10);

    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();
    expect(screen.getByAltText("Scan this QR code in Lark")).toBeTruthy();
    expect(screen.getByText(/QR code expires/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("models the browser-away Slack install wait for Review Lab", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startSlackInstall(SETUP_AGENT_ID, "create", { kind: "unbound" });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByText("Waiting for you to finish in Slack…")).toBeTruthy();
    expect(screen.getByText(/This install link expires/)).toBeTruthy();
  });

  it("shows the handoff wait once an app is connected but not yet reachable", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack" },
    });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();
  });

  it("renders a blocked binding with its identity and recovery actions, and no direct switch", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "reauthorization-required" },
    });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByText("Lark needs updated permissions.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Update permissions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change bot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Lark" })).toBeTruthy();
    // No direct switch: the other Provider's start is not offered while a binding is current.
    expect(screen.queryByRole("button", { name: /Your Slack workspace/ })).toBeNull();
    expect(document.querySelector('[data-ui="agent-setup-messaging-choices"]')).toBeNull();
  });

  it("reports readiness once the snapshot's stage is ready", async () => {
    const onReady = vi.fn();
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    renderSetup(memory.adapter, { onReady });
    await settle();

    expect(screen.getByRole("heading", { name: "reviewer is ready." })).toBeTruthy();
    // Provider identity reaches the done screen from the snapshot, not from page state.
    expect(screen.getByText("Tag @reviewer in Slack to put it to work.")).toBeTruthy();
    expect(onReady).toHaveBeenCalledWith(SETUP_AGENT_ID);
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe("AgentSetupPage blockers", () => {
  it("says when the Server could not observe a resource", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    const adapter = scriptedAdapter(async () => ({
      ...snapshot,
      blockers: [...snapshot.blockers, { code: "resource-observation-failed", resource: "runtime" } as const],
    }));
    renderSetup(adapter);
    await settle();

    expect(screen.getByText("We couldn't read the latest state from the server. Check again.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prepare Codex" })).toBeTruthy();
  });

  it("names the requested Provider when a switch was refused", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", attention: "unbind-required" },
    });
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    const bindingId =
      snapshot.messaging.kind === "blocked" && snapshot.messaging.bindingId
        ? snapshot.messaging.bindingId
        : "44444444-4444-4444-8444-444444444444";
    const adapter = scriptedAdapter(async () => ({
      ...snapshot,
      blockers: [
        ...snapshot.blockers,
        {
          code: "messaging-unbind-required",
          currentProvider: "slack",
          currentBindingId: bindingId,
          requestedProvider: "feishu",
        } as const,
      ],
    }));
    renderSetup(adapter);
    await settle();

    expect(screen.getByText("Disconnect Slack before connecting a different app.")).toBeTruthy();
    expect(screen.getByText("Disconnect Slack before connecting Lark.")).toBeTruthy();
  });
});

describe("AgentSetupPage transitions", () => {
  it("walks Feishu from fresh start to ready and reports it", async () => {
    const onReady = vi.fn();
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    renderSetup(memory.adapter, { onReady });
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle(10);
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

    memory.controls.scanFeishuCode();
    await advance(POLL_MS + 10);
    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Lark" })).toBeTruthy();

    memory.controls.completeHandoff();
    await advance(POLL_MS + 10);
    expect(screen.getByRole("heading", { name: "reviewer is ready." })).toBeTruthy();
    expect(onReady).toHaveBeenCalledWith(SETUP_AGENT_ID);
  });

  it("cancels the exact open attempt and requires unbind before starting again", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const cancel = vi.spyOn(memory.adapter, "cancelFeishuAttempt");
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    const authorizing = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    const attemptId =
      authorizing.messaging.kind === "authorizing" && authorizing.messaging.provider === "feishu"
        ? authorizing.messaging.attemptId
        : "missing";
    renderSetup(memory.adapter);
    await settle(10);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(cancel).toHaveBeenCalledWith(attemptId);
    expect(
      screen.getByText(
        "The Lark authorization didn't complete. Disconnect this incomplete connection, then start again.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Lark" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Your Slack workspace/ })).toBeNull();
  });

  it("starts the Slack install by leaving for Slack", async () => {
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    try {
      const memory = createMemorySetupAdapter({ agent: setupAgent() });
      renderSetup(memory.adapter);
      await settle();

      fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
      await settle();

      expect(assign).toHaveBeenCalledWith(expect.stringContaining("https://slack.com/"));
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("reauthorizes the current Slack binding rather than starting fresh", async () => {
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", { configurable: true, value: { ...originalLocation, assign } });
    try {
      const memory = createMemorySetupAdapter({
        agent: setupAgent(),
        messaging: { kind: "bound", provider: "slack", reachable: true, attention: "reauthorization-required" },
      });
      const start = vi.spyOn(memory.adapter, "startSlackInstall");
      renderSetup(memory.adapter);
      await settle();

      fireEvent.click(screen.getByRole("button", { name: "Update permissions" }));
      await settle();

      expect(start).toHaveBeenCalledWith(SETUP_AGENT_ID, "reauthorize", {
        kind: "bound",
        provider: "slack",
        bindingId: expect.any(String),
        credentialGeneration: 1,
      });
      expect(assign).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
    }
  });

  it("replaces the current Feishu bot through a same-Provider attempt", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "reauthorization-required" },
    });
    const start = vi.spyOn(memory.adapter, "startFeishuAttempt");
    renderSetup(memory.adapter);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Change bot" }));
    await settle(10);

    expect(start).toHaveBeenCalledWith(SETUP_AGENT_ID, "replace", {
      kind: "bound",
      provider: "feishu",
      bindingId: expect.any(String),
      credentialGeneration: 1,
    });
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();
  });

  it("moves across Providers only through an explicit unbind, then offers the fresh choice", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true, attention: "provider-error" },
    });
    const unbind = vi.spyOn(memory.adapter, "unbindMessaging");
    const bindingId = await currentBindingId(memory.adapter);
    renderSetup(memory.adapter);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    await settle();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain("Teammates will no longer be able to send messages");

    const confirm = within(dialog).getAllByRole("button", { name: "Disconnect Slack" });
    fireEvent.click(confirm[confirm.length - 1] as HTMLElement);
    await settle();

    expect(unbind).toHaveBeenCalledWith(SETUP_AGENT_ID, "slack", bindingId);
    // The binding is gone, and only now is a fresh Provider choice offered.
    expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
  });

  it("keeps a failed action's feedback beside it and the snapshot on screen", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const failing = scriptedAdapter((agentId) => memory.adapter.readSnapshot(agentId), {
      startFeishuAttempt: vi.fn(async () => {
        throw new ApiError(409, "refused", "FEISHU_APP_ALREADY_BOUND");
      }),
    });
    renderSetup(failing);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle();

    expect(
      screen.getByText("This Lark bot is already connected to another Agent. Choose a different bot and try again."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();
  });

  it("re-reads the canonical snapshot after a stale cross-Provider start is refused", async () => {
    const initial = createMemorySetupAdapter({ agent: setupAgent() });
    const current = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true, attention: "provider-error" },
    });
    const bindingId = await currentBindingId(current.adapter);
    let reads = 0;
    const adapter = scriptedAdapter(
      (agentId) => {
        reads += 1;
        return reads === 1 ? initial.adapter.readSnapshot(agentId) : current.adapter.readSnapshot(agentId);
      },
      {
        startFeishuAttempt: vi.fn(async () => {
          throw new ApiError(
            409,
            "Unbind the current messaging connection before starting a different Provider",
            "IM_BINDING_UNBIND_REQUIRED",
            "deterministic",
            undefined,
            undefined,
            undefined,
            { currentProvider: "slack", currentBindingId: bindingId, requestedProvider: "feishu" },
          );
        }),
      },
    );
    renderSetup(adapter);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle(10);

    expect(reads).toBe(2);
    expect(screen.getByText("Disconnect Slack before connecting Lark.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Slack" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Lark/ })).toBeNull();
  });

  it("refuses a second submission while an action is in flight", async () => {
    const gate = deferred<void>();
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const adapter = scriptedAdapter((agentId) => memory.adapter.readSnapshot(agentId), {
      startFeishuAttempt: vi.fn(async () => {
        await gate.promise;
        await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
      }),
    });
    renderSetup(adapter);
    await settle();

    const start = screen.getByRole("button", { name: /Lark/ });
    fireEvent.click(start);
    fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
    fireEvent.click(start);
    await settle();

    expect(adapter.startFeishuAttempt).toHaveBeenCalledTimes(1);
    expect(adapter.startSlackInstall).not.toHaveBeenCalled();
    gate.resolve();
    await settle(10);
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();
  });

  it("checks again on demand and shows the new state", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    renderSetup(memory.adapter);
    await settle();
    expect(screen.getByText(/Review Mac is offline/)).toBeTruthy();

    memory.controls.setComputerOnline(true);
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();

    expect(reads).toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
  });

  it("keeps the last good snapshot on screen when a background re-read fails", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    let calls = 0;
    const adapter = scriptedAdapter(async (agentId) => {
      calls += 1;
      if (calls > 1) throw new Error("network is down");
      return memory.adapter.readSnapshot(agentId);
    });
    renderSetup(adapter);
    await settle();
    expect(screen.getByRole("heading", { name: "Prepare Codex" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();

    expect(screen.getByText("network is down")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prepare Codex" })).toBeTruthy();
  });
});

describe("AgentSetupPage request fencing", () => {
  it("never lets an earlier Agent's read overwrite the current one", async () => {
    const first = deferred<AgentSetupSnapshot>();
    const second = deferred<AgentSetupSnapshot>();
    const firstAgent = setupAgent({ id: SETUP_AGENT_ID, displayName: "First Agent", name: "first-agent" });
    const secondAgent = setupAgent({ id: SETUP_OTHER_AGENT_ID, displayName: "Second Agent", name: "second-agent" });
    const firstMemory = createMemorySetupAdapter({ agent: firstAgent });
    const secondMemory = createMemorySetupAdapter({ agent: secondAgent });
    const adapter = scriptedAdapter((agentId) => (agentId === SETUP_AGENT_ID ? first.promise : second.promise));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={queryClient}>
        <AgentSetupPage adapter={adapter} agentId={SETUP_AGENT_ID} />
      </QueryClientProvider>,
    );
    await settle();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <AgentSetupPage adapter={adapter} agentId={SETUP_OTHER_AGENT_ID} />
      </QueryClientProvider>,
    );
    second.resolve(await secondMemory.adapter.readSnapshot(SETUP_OTHER_AGENT_ID));
    await settle();
    expect(screen.getByRole("heading", { name: "Set up Second Agent" })).toBeTruthy();

    // The earlier read landing late must not put the previous Agent back on screen.
    first.resolve(await firstMemory.adapter.readSnapshot(SETUP_AGENT_ID));
    await settle();
    expect(screen.getByRole("heading", { name: "Set up Second Agent" })).toBeTruthy();
    expect(screen.queryByText(/First Agent/)).toBeNull();
  });

  it("discards a poll that resolves after an action has moved the state on", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    const stale = deferred<AgentSetupSnapshot>();
    const modelRead = memory.adapter.readSnapshot;
    let calls = 0;
    vi.spyOn(memory.adapter, "readSnapshot").mockImplementation((agentId) => {
      calls += 1;
      // The first poll (the second read) hangs; every other read answers from the model.
      if (calls === 2) return stale.promise;
      return modelRead(agentId);
    });
    renderSetup(memory.adapter);
    await settle(10);
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

    // The poll starts, and while it is in flight the reader cancels: the cancel's own re-read wins.
    await advance(POLL_MS + 10);
    expect(calls).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();

    // The poll's late reply still describes the attempt the reader just canceled; it must not land.
    stale.resolve(await modelRead(SETUP_AGENT_ID));
    await settle();
    expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();
    expect(screen.queryByText("Waiting for you to scan…")).toBeNull();
  });

  it("waits for a slow poll before scheduling the next one", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    const slow = deferred<AgentSetupSnapshot>();
    const modelRead = memory.adapter.readSnapshot;
    let calls = 0;
    vi.spyOn(memory.adapter, "readSnapshot").mockImplementation((agentId) => {
      calls += 1;
      if (calls === 2) return slow.promise;
      return modelRead(agentId);
    });
    renderSetup(memory.adapter);
    await settle();

    await advance(POLL_MS * 4);
    expect(calls).toBe(2);

    slow.resolve(await modelRead(SETUP_AGENT_ID));
    await settle();
    await advance(POLL_MS + 10);
    expect(calls).toBe(3);
  });

  it("stops polling when an active setup target becomes lifecycle-ineligible", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    const modelRead = memory.adapter.readSnapshot;
    let calls = 0;
    const adapter = scriptedAdapter(async (agentId) => {
      calls += 1;
      if (calls > 1) {
        throw new ApiError(409, "not active", "AGENT_LIFECYCLE_CONFLICT", "deterministic");
      }
      return modelRead(agentId);
    });
    renderSetup(adapter);
    await settle();

    await advance(POLL_MS + 10);
    expect(screen.getByRole("heading", { name: "This agent can't be set up here" })).toBeTruthy();
    await advance(POLL_MS * 3);
    expect(calls).toBe(2);
  });
});

describe("AgentSetupPage closed failures and review", () => {
  it("fails closed on a terminal answer instead of offering any creation path", async () => {
    const adapter = scriptedAdapter(async () => {
      throw new ApiError(404, "refused: RESOURCE_NOT_FOUND", "RESOURCE_NOT_FOUND", "deterministic");
    });
    renderSetup(adapter);
    await settle();

    expect(screen.getByRole("heading", { name: "This agent can't be set up here" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Create your agent" })).toBeNull();
  });

  it("treats a transient read failure as recoverable", async () => {
    let calls = 0;
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const adapter = scriptedAdapter((agentId) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("network is down"));
      return memory.adapter.readSnapshot(agentId);
    });
    renderSetup(adapter);
    await settle();

    expect(screen.getByText("network is down")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
  });

  it("holds a re-board's readiness report until the tester finishes the review", async () => {
    const onReady = vi.fn();
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    renderSetup(memory.adapter, { onReady, reviewMode: true });
    await settle();

    expect(screen.getByRole("heading", { name: "reviewer is ready." })).toBeTruthy();
    expect(onReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Finish re-board" }));
    await settle();
    expect(onReady).toHaveBeenCalledWith(SETUP_AGENT_ID);
  });

  it("retries a refused readiness report a bounded number of times", async () => {
    const onReady = vi
      .fn<(agentId: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("refused"))
      .mockRejectedValueOnce(new Error("refused"))
      .mockRejectedValueOnce(new Error("refused"))
      .mockResolvedValue(undefined);
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    renderSetup(memory.adapter, { onReady });
    await settle();
    await settle();

    expect(onReady).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle();
    expect(onReady).toHaveBeenCalledTimes(4);
  });
});

describe("OnboardingV2Page integration seam", () => {
  it("renders the canonical setup surface when the route names an exact Agent", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <OnboardingV2Page agentId={SETUP_AGENT_ID} setupAdapter={memory.adapter} />
      </QueryClientProvider>,
    );
    await settle();

    expect(document.querySelector('[data-ui="agent-setup"]')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });
});
