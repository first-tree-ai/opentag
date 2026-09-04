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
import { AgentSetupSurface } from "./page.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import type { MemorySetupSeed } from "./setup-memory-adapter.js";
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
    refreshPreparation: vi.fn(async () => undefined),
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
    onOpenAgent?: () => void;
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
        onOpenAgent={props.onOpenAgent}
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

/** The four stable checks Step 2 exposes in the order the operator needs them. */
const PREP_ROW_COMPONENTS = ["computer", "runtime", "im-cli:feishu", "im-cli:slack"] as const;

function readinessRow(component: string): HTMLElement {
  const element = document.querySelector(`[data-ui="readiness-list"] [data-component="${component}"]`);
  if (!element) throw new Error(`Missing readiness row for ${component}`);
  return element as HTMLElement;
}

function readinessRows(): HTMLElement[] {
  const list = document.querySelector('[data-ui="readiness-list"]');
  if (!list) throw new Error("Missing readiness list");
  return within(list as HTMLElement).getAllByRole("listitem");
}

function rowTitle(component: string): string {
  return readinessRow(component).querySelector('[data-ui="readiness-title"]')?.textContent ?? "";
}

function rowDetail(component: string): string {
  return readinessRow(component).querySelector('[data-ui="readiness-detail"]')?.textContent ?? "";
}

/** Computer, selected Runtime, Lark CLI, and Slack CLI stay individually visible in Step 2. */
function expectPreparationReadinessRows(): void {
  const rows = readinessRows();
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.getAttribute("data-component"))).toEqual([...PREP_ROW_COMPONENTS]);
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

    expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();
    expect(screen.getByText("Reviewer runs on your own computer.")).toBeTruthy();
    expect(
      screen.getByText("Agent work runs on this computer. Task messages and agent results pass through OpenTag."),
    ).toBeTruthy();
    const summary = document.querySelector('[data-ui="agent-setup-computer-summary"]');
    expect(summary?.textContent).toContain("No computer connected");
    expect(summary?.textContent).toContain("Not connected");
    expect(summary?.classList).not.toContain("border-y");
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
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();

    const summary = document.querySelector('[data-ui="agent-setup-computer-summary"]');
    expect(summary?.textContent).toContain("Review Mac");
    expect(summary?.textContent).toContain("macOS");
    expect(summary?.textContent).toContain("Offline");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(reads).toHaveBeenCalledTimes(1);

    // An offline Computer is expected to come back without the page being touched, so it is polled.
    const readsBeforePoll = reads.mock.calls.length;
    await advance(POLL_MS + 10);
    expect(reads.mock.calls.length).toBeGreaterThan(readsBeforePoll);
  });

  it("expands the shared command surface directly when an offline Computer needs reinstalling", async () => {
    const issue = vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
      bootstrapCommand: "opentag computer connect --server https://opentag.example.com -- repair-code",
      connectCodeId: "repair-code",
      expiresIn: 900,
      issuedAt: new Date().toISOString(),
    });
    vi.spyOn(browserApi, "computerConnectCodeStatus").mockResolvedValue({
      computerId: null,
      connectCodeId: "repair-code",
      redeemedAt: null,
      state: "pending",
    });
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    renderSetup(memory.adapter);
    await settle();

    const repairAction = screen.getByRole("button", { name: "Generate a repair command" });
    expect(repairAction.closest(".ots-command__body")).toBeTruthy();
    expect(screen.getByText("Need to reinstall?")).toBeTruthy();
    fireEvent.click(repairAction);
    await settle();

    const repairSurface = document.querySelector('[data-ui="computer-connect"]');
    expect(repairSurface?.querySelector(".ots-command__body")).not.toBeNull();
    expect(screen.getByText("Run this in your terminal, or paste it into your coding agent.")).toBeTruthy();
    expect(screen.getByText("Expires in 15:00")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Waiting for Review Mac to reconnect");
    expect(issue).toHaveBeenCalledWith({
      mode: "repair",
      targetAgentId: SETUP_AGENT_ID,
      targetComputerId: SETUP_COMPUTER_ID,
    });
  });

  it("renders an install-required Runtime row without claiming any installation", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expectPreparationReadinessRows();
    expect(readinessRow("runtime").getAttribute("data-state")).toBe("failed");
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("install-required");
    expect(rowTitle("runtime")).toContain("Codex");
    expect(rowTitle("runtime")).toContain("Installation required");
    // An install is a manual action the operator owns: OpenTag never installs Runtime CLIs, and
    // the row never claims a preparing/installing state exists.
    expect(rowDetail("runtime")).toContain("Install Codex on Review Mac, then check again.");
    expect(rowDetail("runtime")).toContain("OpenTag won't install it for you");
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("ready");
    expect(readinessRow("im-cli:slack").getAttribute("data-status")).toBe("ready");
  });

  it("shows a real checking observation as checking and nothing else animates", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "checking" });
    renderSetup(memory.adapter);
    await settle();

    expect(readinessRow("runtime").getAttribute("data-state")).toBe("pending");
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("checking");
    expect(rowTitle("runtime")).toContain("Codex");
    expect(rowTitle("runtime")).toContain("Checking");
    expect(rowDetail("runtime")).toContain("Checking the version and sign-in on Review Mac");
  });

  it("moves to Messaging without repeating Step 2 readiness", async () => {
    // Omitting the CLI reports presets both required CLIs ready, so the gate has passed.
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Slack/ })).toBeTruthy();
    // Slack leads here for the same reason it leads in Messaging settings: neither channel is the
    // recommended one, so the two surfaces must not disagree about which comes first.
    const choices = document.querySelector('[data-ui="agent-setup-messaging-choices"]') as HTMLElement;
    expect(
      within(choices)
        .getAllByRole("button")
        .map((button) => (/Slack/.test(button.textContent ?? "") ? "slack" : "feishu")),
    ).toEqual(["slack", "feishu"]);
    expect(document.querySelector('[data-ui="readiness-list"]')).toBeNull();
    // Messaging content carries no CLI readiness, installation, PATH, or Runtime sign-in copy.
    const messaging = document.querySelector('[data-ui="agent-setup-messaging"]') as HTMLElement;
    expect(messaging.querySelector('[data-ui="readiness-list"]')).toBeNull();
    expect(messaging.textContent).not.toMatch(
      /CLI|opentag doctor|Installation required|Checking|Waiting for Computer|sign[ -]?in/i,
    );
  });

  it("holds the Provider CLI gate open until both required CLIs are ready", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      imCliReadiness: { feishu: "install", slack: "ready" },
    });
    renderSetup(memory.adapter);
    await settle();

    // The rail keeps the second step current and Messaging upcoming.
    const rail = document.querySelector('[data-ui="onboarding-v2-rail"]') as HTMLElement;
    const current = rail.querySelector('li[data-status="current"]') as HTMLElement;
    expect(current.textContent).toContain("Prepare computer");
    expect(screen.queryByRole("heading", { name: "Connect your messaging app" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Your Slack workspace/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Lark/ })).toBeNull();

    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Set up Reviewer" })).toBeNull();
    expectPreparationReadinessRows();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("ready");
    expect(readinessRow("im-cli:feishu").getAttribute("data-state")).toBe("failed");
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("install-required");
    expect(rowTitle("im-cli:feishu")).toContain("Lark CLI");
    expect(rowTitle("im-cli:feishu")).toContain("Installation required");
    expect(readinessRow("im-cli:slack").getAttribute("data-status")).toBe("ready");
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("shows both missing Provider CLI reports as waiting, not checking", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), imCliReadiness: {} });
    renderSetup(memory.adapter);
    await settle();

    expectPreparationReadinessRows();
    expect(readinessRow("im-cli:feishu").getAttribute("data-state")).toBe("pending");
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("waiting");
    expect(readinessRow("im-cli:slack").getAttribute("data-state")).toBe("pending");
    expect(readinessRow("im-cli:slack").getAttribute("data-status")).toBe("waiting");
    expect(rowTitle("im-cli:feishu")).toContain("Lark CLI");
    expect(rowTitle("im-cli:slack")).toContain("Slack CLI");
    expect(screen.queryByText("Checking")).toBeNull();
    expect(screen.queryByRole("button", { name: /Your Slack workspace/ })).toBeNull();
  });

  it("keeps both compact rows visible while the Runtime report is missing", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeMissing: true });
    renderSetup(memory.adapter);
    await settle();

    expectPreparationReadinessRows();
    expect(readinessRow("runtime").getAttribute("data-state")).toBe("pending");
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("waiting");
    expect(rowTitle("runtime")).toContain("Waiting");
    expect(rowDetail("runtime")).toContain("No recent report from Review Mac");
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("ready");
    expect(readinessRow("im-cli:slack").getAttribute("data-status")).toBe("ready");
  });

  it("names the creation step's non-Codex runtime in the single Runtime row", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent({ runtimeProvider: "claude-code" }),
      runtimeStatus: "checking",
    });
    renderSetup(memory.adapter);
    await settle();

    expectPreparationReadinessRows();
    expect(rowTitle("runtime")).toContain("Claude Code");
    expect(rowTitle("runtime")).toContain("Checking");
    expect(rowTitle("runtime")).not.toContain("Codex");
  });

  it("shows the Feishu authorization with its QR, expiry, and cancel from the snapshot", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    renderSetup(memory.adapter);
    await settle(10);

    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();
    const qr = screen.getByAltText("Scan this QR code in Lark");
    expect(qr.parentElement?.getAttribute("data-ui")).toBe("setup-qr");
    expect(qr.classList.contains("ots-qr__image")).toBe(true);
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

describe("preparation review regressions", () => {
  it("does not invent a timeout cause for a coarse unavailable Runtime report", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "unavailable" });
    renderSetup(memory.adapter);
    await settle();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("needs-attention");
    expect(rowDetail("runtime")).toContain("Codex isn't ready on Review Mac");
    expect(rowDetail("runtime")).not.toMatch(/not responding|isn't responding|timed out|opentag doctor/i);
  });

  it("coalesces focus, visibility and pageshow into one automatic read", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    const pending = deferred<AgentSetupSnapshot>();
    const adapter = scriptedAdapter(async () => snapshot);
    vi.mocked(adapter.readSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => pending.promise);
    renderSetup(adapter);
    await settle();
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pageshow"));
    });
    await settle();
    expect(adapter.readSnapshot).toHaveBeenCalledTimes(2);
    pending.resolve(snapshot);
    await settle();
    expect(adapter.readSnapshot).toHaveBeenCalledTimes(2);
  });

  it("queues one return refresh behind an existing automatic poll", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), imCliReadiness: {} });
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    const pending = deferred<AgentSetupSnapshot>();
    const adapter = scriptedAdapter(async () => snapshot);
    vi.mocked(adapter.readSnapshot)
      .mockResolvedValueOnce(snapshot)
      .mockImplementationOnce(() => pending.promise);
    renderSetup(adapter);
    await settle();
    await advance(POLL_MS);
    expect(adapter.readSnapshot).toHaveBeenCalledTimes(2);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await settle();
    expect(adapter.readSnapshot).toHaveBeenCalledTimes(2);
    pending.resolve(snapshot);
    await settle();
    expect(adapter.readSnapshot).toHaveBeenCalledTimes(3);
  });

  it("continues observing required CLI work after a Runtime failure", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      runtimeStatus: "install",
      imCliReadiness: { feishu: "checking", slack: "ready" },
    });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("install-required");
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("checking");
    expect(readinessRow("im-cli:slack").getAttribute("data-status")).toBe("ready");
    memory.controls.setImCliReadiness("feishu", "ready");
    await advance(POLL_MS);
    expect(readinessRow("im-cli:feishu").getAttribute("data-status")).toBe("ready");
    const settledReads = reads.mock.calls.length;
    await advance(POLL_MS * 40);
    expect(reads).toHaveBeenCalledTimes(settledReads);
    expect(document.querySelector('[data-ui="agent-setup-messaging"]')).toBeNull();
  });

  it.each([
    { phase: "preparing_cli" as const },
    { phase: "checking_credentials" as const },
    { phase: "needs_attention" as const },
    { phase: "needs_attention" as const, reason: "upgrade_required" as const },
    { phase: "needs_attention" as const, reason: "scope_missing" as const },
  ])("keeps handoff $phase about the IM connection, not CLI installation", async (progress) => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack" },
    });
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    if (snapshot.messaging.kind !== "waiting-handoff") throw new Error("Expected handoff fixture");
    const adapter = scriptedAdapter(async () => ({
      ...snapshot,
      messaging: { ...snapshot.messaging, progress } as AgentSetupSnapshot["messaging"],
    }));
    renderSetup(adapter);
    await settle();
    const messaging = document.querySelector('[data-ui="agent-setup-messaging"]') as HTMLElement;
    expect(messaging.textContent).not.toMatch(/CLI|PATH|install|sign[ -]?in/i);
    expect(document.querySelector('[data-ui="readiness-list"]')).toBeNull();
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
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("install-required");
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
  it("polls needs-provider-clis within a finite budget and then stops", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), imCliReadiness: {} });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    // The documented budget: 30 polls at the 2s interval, then the timer stops on its own.
    await advance(POLL_MS * 31 + 10);
    expect(reads.mock.calls.length).toBe(31);

    await advance(POLL_MS * 4);
    expect(reads.mock.calls.length).toBe(31);
  });

  it("reopens the bounded observation window on an explicit Check again", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), imCliReadiness: {} });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads.mock.calls.length).toBe(1);

    await advance(POLL_MS * 31 + 10);
    expect(reads.mock.calls.length).toBe(31);

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();
    expect(reads.mock.calls.length).toBe(32);

    await advance(POLL_MS + 10);
    expect(reads.mock.calls.length).toBe(33);
  });

  it("does not overlap automatic reads when a bounded poll is slow", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), imCliReadiness: {} });
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
    expect(calls).toBe(1);

    await advance(POLL_MS * 5);
    expect(calls).toBe(2);

    slow.resolve(await modelRead(SETUP_AGENT_ID));
    await settle();
    await advance(POLL_MS + 10);
    expect(calls).toBe(3);
  });

  it("keeps automatic reads single-flight across a manual restart and fences the stale reply", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), imCliReadiness: {} });
    const modelRead = memory.adapter.readSnapshot;
    const slow = deferred<AgentSetupSnapshot>();
    let calls = 0;
    let staleSnapshot: AgentSetupSnapshot | undefined;
    vi.spyOn(memory.adapter, "readSnapshot").mockImplementation(async (agentId) => {
      calls += 1;
      // The first automatic poll hangs; every other read answers from the model.
      if (calls === 2) return slow.promise;
      const snapshot = await modelRead(agentId);
      if (calls === 1) {
        staleSnapshot = { ...snapshot, agent: { ...snapshot.agent, displayName: "Stale Reviewer" } };
      }
      return snapshot;
    });
    renderSetup(memory.adapter);
    await settle();
    expect(calls).toBe(1);
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();

    await advance(POLL_MS + 10);
    expect(calls).toBe(2);

    // An explicit Check again supersedes the hanging poll and re-reads immediately.
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();
    expect(calls).toBe(3);
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();

    // Two more poll intervals while the old automatic read is STILL pending: no automatic read
    // may start on top of it, even from the restarted observation window.
    await advance(POLL_MS * 2 + 10);
    expect(calls).toBe(3);

    // The stale reply lands and must not overwrite the newer manual result.
    slow.resolve(staleSnapshot as AgentSetupSnapshot);
    await settle();
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Set up Stale Reviewer" })).toBeNull();

    // The beat resumes exactly once per interval once the fence clears.
    await advance(POLL_MS + 10);
    expect(calls).toBe(4);
  });

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
    expect(dialog.textContent).toContain("stops new messages from reaching this Agent");
    expect(dialog.textContent).toContain("Message history is preserved");

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
    expect(document.querySelector('[data-ui="agent-setup-computer-summary"]')?.textContent).toContain("Offline");

    memory.controls.setComputerOnline(true);
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    const refreshes = vi.spyOn(memory.adapter, "refreshPreparation");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();

    expect(refreshes).toHaveBeenCalledWith(SETUP_AGENT_ID);
    expect(refreshes.mock.invocationCallOrder[0]).toBeLessThan(reads.mock.invocationCallOrder.at(-1) ?? 0);
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
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();

    expect(screen.getByText("network is down")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
  });
});

describe("AgentSetupPage preparation rows across stages", () => {
  const stageMatrix: ReadonlyArray<{
    readonly name: string;
    readonly seed: MemorySetupSeed;
    readonly expected: ReadonlyArray<readonly [component: string, state: string, status: string]>;
  }> = [
    {
      name: "an unbound Computer",
      seed: { agent: setupAgent({ computer: null }) },
      expected: [
        ["computer", "pending", "waiting"],
        ["runtime", "blocked", "waiting"],
        ["im-cli:feishu", "blocked", "waiting"],
        ["im-cli:slack", "blocked", "waiting"],
      ],
    },
    {
      name: "a Computer that needs rebinding",
      seed: { agent: setupAgent({ requiresComputerRebind: true }) },
      expected: [
        ["computer", "failed", "needs-attention"],
        ["runtime", "blocked", "waiting"],
        ["im-cli:feishu", "blocked", "waiting"],
        ["im-cli:slack", "blocked", "waiting"],
      ],
    },
    {
      name: "an offline Computer",
      seed: { agent: setupAgent(), computerOnline: false },
      expected: [
        ["computer", "blocked", "needs-attention"],
        ["runtime", "blocked", "waiting"],
        ["im-cli:feishu", "blocked", "waiting"],
        ["im-cli:slack", "blocked", "waiting"],
      ],
    },
    {
      name: "a checking Runtime report",
      seed: { agent: setupAgent(), runtimeStatus: "checking" },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "pending", "checking"],
        ["im-cli:feishu", "passed", "ready"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
    {
      name: "a Runtime report that needs installation",
      seed: { agent: setupAgent(), runtimeStatus: "install" },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "failed", "install-required"],
        ["im-cli:feishu", "passed", "ready"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
    {
      name: "a Runtime that needs its sign-in",
      seed: { agent: setupAgent(), runtimeStatus: "sign-in" },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "failed", "needs-attention"],
        ["im-cli:feishu", "passed", "ready"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
    {
      name: "a missing Runtime report",
      seed: { agent: setupAgent(), runtimeMissing: true },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "pending", "waiting"],
        ["im-cli:feishu", "passed", "ready"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
    {
      name: "an unavailable Runtime report over an online Computer",
      seed: { agent: setupAgent(), runtimeStatus: "unavailable" },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "failed", "needs-attention"],
        ["im-cli:feishu", "passed", "ready"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
    {
      name: "missing Provider CLI reports",
      seed: { agent: setupAgent(), imCliReadiness: {} },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "passed", "ready"],
        ["im-cli:feishu", "pending", "waiting"],
        ["im-cli:slack", "pending", "waiting"],
      ],
    },
    {
      name: "one Provider CLI that needs installation and one ready",
      seed: { agent: setupAgent(), imCliReadiness: { feishu: "install", slack: "ready" } },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "passed", "ready"],
        ["im-cli:feishu", "failed", "install-required"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
    {
      name: "one checking and one unavailable Provider CLI",
      seed: { agent: setupAgent(), imCliReadiness: { feishu: "checking", slack: "unavailable" } },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "passed", "ready"],
        ["im-cli:feishu", "pending", "checking"],
        ["im-cli:slack", "failed", "needs-attention"],
      ],
    },
    {
      name: "the completed gate before Messaging starts",
      seed: { agent: setupAgent() },
      expected: [
        ["computer", "passed", "ready"],
        ["runtime", "passed", "ready"],
        ["im-cli:feishu", "passed", "ready"],
        ["im-cli:slack", "passed", "ready"],
      ],
    },
  ];

  it.each(stageMatrix)("renders all four Step 2 checks at $name", async ({ seed, expected }) => {
    const memory = createMemorySetupAdapter(seed);
    renderSetup(memory.adapter);
    await settle();

    const computerReady = expected[0]?.[2] === "ready";
    const allReady = expected.every(([, , status]) => status === "ready");
    if (!computerReady || allReady) {
      expect(document.querySelector('[data-ui="readiness-list"]')).toBeNull();
      return;
    }

    expectPreparationReadinessRows();
    for (const [component, state, status] of expected) {
      expect(readinessRow(component).getAttribute("data-state")).toBe(state);
      expect(readinessRow(component).getAttribute("data-status")).toBe(status);
    }
  });

  it("focuses a not-yet-connected Computer on the connection command", async () => {
    mockComputerInventory();
    const memory = createMemorySetupAdapter({ agent: setupAgent({ computer: null }) });
    renderSetup(memory.adapter);
    await settle();

    expect(document.querySelector('[data-ui="readiness-list"]')).toBeNull();
    expect(screen.getByRole("heading", { name: "Connect your computer" })).toBeTruthy();
    expect(screen.queryByText("Checking")).toBeNull();
  });

  it("hides the preparation summary once a Messaging interaction has started", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    renderSetup(memory.adapter);
    await settle();
    expect(document.querySelector('[data-ui="readiness-list"]')).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle(10);

    // An unselected Provider's later reports must never regress started Messaging: the rows leave
    // the page and only the Messaging surface remains.
    expect(document.querySelector('[data-ui="readiness-list"]')).toBeNull();
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();
  });
});

describe("AgentSetupPage preparation polling", () => {
  it("never polls a settled Provider CLI install failure", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      imCliReadiness: { feishu: "install", slack: "ready" },
    });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    await advance(POLL_MS * 4);
    expect(reads).toHaveBeenCalledTimes(1);

    // The explicit Check again is still the way a manual-action failure moves forward.
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await settle();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("never polls a settled Runtime install or sign-in failure", async () => {
    for (const runtimeStatus of ["install", "sign-in"] as const) {
      const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus });
      const reads = vi.spyOn(memory.adapter, "readSnapshot");
      renderSetup(memory.adapter);
      await settle();
      expect(reads).toHaveBeenCalledTimes(1);
      await advance(POLL_MS * 4);
      expect(reads).toHaveBeenCalledTimes(1);
    }
  });

  it("polls a checking Runtime report inside the finite budget and then stops", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "checking" });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    await advance(POLL_MS * 31 + 10);
    expect(reads).toHaveBeenCalledTimes(31);

    await advance(POLL_MS * 4);
    expect(reads).toHaveBeenCalledTimes(31);
  });

  it("polls while one blocking required CLI is transitional, even beside a settled row", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      imCliReadiness: { feishu: "checking", slack: "install" },
    });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    await advance(POLL_MS * 3 + 10);
    expect(reads.mock.calls.length).toBeGreaterThan(1);

    // The budget still ends the window on an unchanged snapshot.
    await advance(POLL_MS * 28);
    expect(reads.mock.calls.length).toBe(31);
  });
});

describe("AgentSetupPage focus and visibility recovery", () => {
  it("re-reads the snapshot when the window regains focus", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "checking" });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
  });

  it("re-reads on a pageshow return and never reads while the tab is hidden", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "checking" });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("pageshow"));
    });
    await settle();
    expect(reads).toHaveBeenCalledTimes(2);

    // A hidden tab gets no refresh even when the visibility event fires.
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();
      expect(reads).toHaveBeenCalledTimes(2);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await settle();
      expect(reads).toHaveBeenCalledTimes(3);
    } finally {
      if (original) Object.defineProperty(document, "visibilityState", original);
      else delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it("keeps the last good snapshot when a focus refresh fails transiently", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), runtimeStatus: "install" });
    let calls = 0;
    const adapter = scriptedAdapter(async (agentId) => {
      calls += 1;
      if (calls > 1) throw new Error("network is down");
      return memory.adapter.readSnapshot(agentId);
    });
    renderSetup(adapter);
    await settle();
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();

    expect(screen.getByText("network is down")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(readinessRow("runtime").getAttribute("data-status")).toBe("install-required");
  });

  it("does not refresh on focus while an action is in flight", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const gate = deferred<void>();
    const adapter = scriptedAdapter((agentId) => memory.adapter.readSnapshot(agentId), {
      startFeishuAttempt: vi.fn(async () => {
        await gate.promise;
        await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
      }),
    });
    const reads = vi.spyOn(adapter, "readSnapshot");
    renderSetup(adapter);
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle();
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await settle();
    expect(reads).toHaveBeenCalledTimes(1);

    gate.resolve();
    await settle(10);
    expect(reads.mock.calls.length).toBeGreaterThan(1);
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
  it("replaces the return action with Open agent when setup becomes ready", async () => {
    const onOpenAgent = vi.fn();
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    renderSetup(memory.adapter, { onOpenAgent });
    await settle();

    expect(screen.queryByRole("button", { name: "Back to agent" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    expect(onOpenAgent).toHaveBeenCalledTimes(1);
  });

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

describe("AgentSetupSurface integration seam", () => {
  it("renders the canonical setup surface when the route names an exact Agent", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AgentSetupSurface agentId={SETUP_AGENT_ID} setupAdapter={memory.adapter} />
      </QueryClientProvider>,
    );
    await settle();

    expect(document.querySelector('[data-ui="agent-setup"]')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });
});
