/**
 * Agent Setup recovery paths: the words a failed action is given, the Lark reauthorization that
 * maintains a binding in place, the disconnect confirmation, Lab-adapter Computer completion, and
 * the handoff and blocked copy the Server projects but the in-memory model never emits on its own.
 */

import type { AgentSetupAction, AgentSetupSnapshot, ProviderCliHandoffProgress } from "@opentag/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api.js";
import { AgentSetupPage, type AgentSetupPageProps, setupSnapshotIsTransitional } from "./agent-setup-page.js";
import { deferred, SETUP_AGENT_ID, SETUP_COMPUTER_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter, type MemorySetupSeed } from "./setup-memory-adapter.js";

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

function renderSetup(
  adapter: AgentSetupAdapter,
  props: Omit<AgentSetupPageProps, "adapter" | "agentId"> & { agentId?: string } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentSetupPage adapter={adapter} {...props} agentId={props.agentId ?? SETUP_AGENT_ID} />
    </QueryClientProvider>,
  );
}

/** The in-memory model with one write replaced, so a refusal can be scripted where it happens. */
function failingAdapter(memory: ReturnType<typeof createMemorySetupAdapter>, overrides: Partial<AgentSetupAdapter>) {
  return { ...memory.adapter, ...overrides };
}

/** The in-memory model with its snapshot reshaped on the way out, for states it does not model. */
function patchedAdapter(
  memory: ReturnType<typeof createMemorySetupAdapter>,
  patch: (snapshot: AgentSetupSnapshot) => AgentSetupSnapshot,
): AgentSetupAdapter {
  return {
    ...memory.adapter,
    readSnapshot: async (agentId) => patch(await memory.adapter.readSnapshot(agentId)),
  };
}

async function snapshotFor(seed: MemorySetupSeed): Promise<AgentSetupSnapshot> {
  return createMemorySetupAdapter(seed).adapter.readSnapshot(seed.agent.id);
}

function continueFromPreparation(): void {
  const button = screen.getByRole("button", { name: "Continue" });
  expect(button.hasAttribute("disabled")).toBe(false);
  fireEvent.click(button);
}

const onlineReviewMac = {
  computerId: SETUP_COMPUTER_ID,
  displayName: "Review Mac",
  platform: "darwin" as const,
  connectionStatus: "online" as const,
  connectedAt: "2026-09-01T10:00:00.000Z",
  lastSeenAt: null,
  observedAt: "2026-09-01T10:00:00.000Z",
  createdAt: "2026-09-01T10:00:00.000Z",
  agentIds: [],
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("setupSnapshotIsTransitional", () => {
  it("is true only while the outside world is still expected to move the snapshot", async () => {
    expect(setupSnapshotIsTransitional(await snapshotFor({ agent: setupAgent(), computerOnline: false }))).toBe(true);
    expect(setupSnapshotIsTransitional(await snapshotFor({ agent: setupAgent(), runtimeMissing: true }))).toBe(true);
    expect(setupSnapshotIsTransitional(await snapshotFor({ agent: setupAgent(), runtimeStatus: "checking" }))).toBe(
      true,
    );
    expect(setupSnapshotIsTransitional(await snapshotFor({ agent: setupAgent(), imCliReadiness: {} }))).toBe(true);
    expect(
      setupSnapshotIsTransitional(
        await snapshotFor({ agent: setupAgent(), messaging: { kind: "bound", provider: "slack" } }),
      ),
    ).toBe(true);

    expect(setupSnapshotIsTransitional(await snapshotFor({ agent: setupAgent({ computer: null }) }))).toBe(false);
    expect(setupSnapshotIsTransitional(await snapshotFor({ agent: setupAgent() }))).toBe(false);
    expect(
      setupSnapshotIsTransitional(
        await snapshotFor({ agent: setupAgent(), messaging: { kind: "bound", provider: "slack", reachable: true } }),
      ),
    ).toBe(false);
    expect(
      setupSnapshotIsTransitional(
        await snapshotFor({
          agent: setupAgent(),
          messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "provider-error" },
        }),
      ),
    ).toBe(false);
  });
});

describe("AgentSetupPage action failures", () => {
  it("says a refused disconnect in the confirmation and keeps the binding on screen", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "authorization-failed" },
    });
    const unbind = vi.fn(async () => {
      throw new Error("refused");
    });
    renderSetup(failingAdapter(memory, { unbindMessaging: unbind }));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Lark" }));
    await settle();
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect Lark?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Lark" }));
    await settle();

    expect(unbind).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByRole("alert").textContent).toBe("Couldn’t disconnect Lark. Try again.");
    // The failure is said inside the confirmation, not repeated behind it.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByText("Lark authorization didn't complete. Disconnect Lark, then reconnect it.")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep connected" }));
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Disconnect Lark" })).toBeTruthy();
  });

  it("says a refused cancel beside the open Lark authorization", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    const cancel = vi.fn(async () => {
      throw new Error("refused");
    });
    renderSetup(failingAdapter(memory, { cancelFeishuAttempt: cancel }));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("Couldn’t cancel Lark setup. Try again.");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it.each([
    [
      "a Server code",
      new ApiError(502, "upstream", "SLACK_UPSTREAM_UNAVAILABLE", "transient"),
      "Slack is unavailable right now. Check the connection and try again.",
    ],
    ["no code", new Error("network"), "Couldn’t connect Slack. Start the connection again from this Agent."],
  ])("explains a refused Slack start with %s", async (_label, cause, message) => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    renderSetup(
      failingAdapter(memory, {
        startSlackInstall: vi.fn(async () => {
          throw cause;
        }),
      }),
    );
    await settle();
    continueFromPreparation();

    fireEvent.click(screen.getByRole("button", { name: /Slack/ }));
    await settle();

    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.getByRole("button", { name: /Slack/ }).hasAttribute("disabled")).toBe(false);
  });

  it.each([
    [
      "FEISHU_SCOPE_REAUTH_REQUIRED",
      "Lark permissions are incomplete. Try again and approve all requested permissions.",
    ],
    [
      "IM_BINDING_SCOPE_REAUTH_REQUIRED",
      "Lark permissions are incomplete. Try again and approve all requested permissions.",
    ],
    ["FEISHU_UPSTREAM_UNAVAILABLE", "Lark is unavailable right now. Check the connection and try again."],
    ["FEISHU_SOMETHING_NEW", "Couldn’t connect Lark. Try scanning a new QR code."],
  ])("maps a refused Lark start with code %s onto its recovery sentence", async (code, message) => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    renderSetup(
      failingAdapter(memory, {
        startFeishuAttempt: vi.fn(async () => {
          throw new ApiError(409, "refused", code, "deterministic");
        }),
      }),
    );
    await settle();
    continueFromPreparation();

    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle();

    expect(screen.getByRole("alert").textContent).toBe(message);
  });

  it("drops the outcome of an action that finishes after the page is gone", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true, attention: "authorization-failed" },
    });
    const unbinding = deferred<void>();
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    const view = renderSetup(failingAdapter(memory, { unbindMessaging: vi.fn(() => unbinding.promise) }));
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    await settle();
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect Slack?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect Slack" }));
    await settle();
    const readsBeforeUnmount = reads.mock.calls.length;
    view.unmount();

    await act(async () => unbinding.resolve());
    await settle();

    // No re-read is started for a page that no longer exists.
    expect(reads).toHaveBeenCalledTimes(readsBeforeUnmount);
  });

  it("does not retry a readiness report that is refused after the page is gone", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    const report = deferred<void>();
    const onReady = vi.fn(() => report.promise);
    const view = renderSetup(memory.adapter, { onReady });
    await settle();
    expect(onReady).toHaveBeenCalledTimes(1);
    view.unmount();

    await act(async () => report.reject(new Error("refused")));
    await settle();

    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe("AgentSetupPage messaging recovery", () => {
  it("reauthorizes the current Lark bot in place, then waits for the new scan", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "feishu", reachable: true, attention: "reauthorization-required" },
    });
    const start = vi.spyOn(memory.adapter, "startFeishuAttempt");
    const before = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    const bindingId = before.messaging.kind === "blocked" ? before.messaging.bindingId : "missing";
    renderSetup(memory.adapter);
    await settle();

    fireEvent.click(screen.getByRole("button", { name: "Update permissions" }));
    await settle();

    expect(start).toHaveBeenCalledWith(SETUP_AGENT_ID, "reauthorize", {
      kind: "bound",
      provider: "feishu",
      bindingId,
      credentialGeneration: 1,
    });
    expect(screen.getByRole("status").textContent).toContain("Waiting");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update permissions" })).toBeNull();
  });

  it("asks before disconnecting during the handoff wait and honours Keep connected", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack" },
    });
    const unbind = vi.spyOn(memory.adapter, "unbindMessaging");
    renderSetup(memory.adapter);
    await settle();
    expect(screen.getByText(/In Slack, add OpenTag to a channel/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    await settle();
    const dialog = screen.getByRole("alertdialog", { name: "Disconnect Slack?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep connected" }));
    await settle();

    expect(unbind).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));
    await settle();
    const confirm = screen.getByRole("alertdialog", { name: "Disconnect Slack?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect Slack" }));
    await settle();

    expect(unbind).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.querySelector('[data-ui="agent-setup-messaging-choices"]')).toBeTruthy();
  });

  it("explains a Provider-reported problem with a plain Reconnect", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true, attention: "provider-error" },
    });
    renderSetup(memory.adapter);
    await settle();

    expect(screen.getByText("Slack reported a problem. Reconnect it to continue.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Update permissions" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change bot" })).toBeNull();
  });

  it.each([
    [{ phase: "preparing_cli" }, "Confirming the computer can connect to Slack…"],
    [{ phase: "checking_credentials" }, "Checking credentials"],
    [
      { phase: "needs_attention" },
      "Repair the Slack connection in the coding agent on this computer, then check again.",
    ],
    [
      { phase: "needs_attention", reason: "upgrade_required" },
      "Repair the Slack connection in the coding agent on this computer, then check again.",
    ],
    [
      { phase: "needs_attention", reason: "credential_rejected" },
      "Reauthorize this messaging app. The current credential was rejected.",
    ],
  ] satisfies readonly (readonly [ProviderCliHandoffProgress, string])[])(
    "narrates the handoff progress %j",
    async (progress, copy) => {
      const memory = createMemorySetupAdapter({
        agent: setupAgent(),
        messaging: { kind: "bound", provider: "slack" },
      });
      renderSetup(
        patchedAdapter(memory, (snapshot) =>
          snapshot.messaging.kind === "waiting-handoff"
            ? { ...snapshot, messaging: { ...snapshot.messaging, progress } }
            : snapshot,
        ),
      );
      await settle();

      expect(screen.getByText(copy)).toBeTruthy();
      expect(screen.queryByText(/In Slack, add OpenTag to a channel/)).toBeNull();
    },
  );

  it("shows a cross-Provider block without a binding to act on as copy only", async () => {
    const memory = createMemorySetupAdapter({
      agent: setupAgent(),
      messaging: { kind: "bound", provider: "slack", reachable: true },
    });
    const currentBindingId = crypto.randomUUID();
    renderSetup(
      patchedAdapter(memory, (snapshot) => ({
        ...snapshot,
        stage: "needs-messaging",
        messaging: { kind: "blocked", provider: "slack", code: "unbind-required", errorCode: null },
        blockers: [
          {
            code: "messaging-unbind-required",
            currentProvider: "slack",
            currentBindingId,
            requestedProvider: "feishu",
          },
        ],
        actions: [],
      })),
    );
    await settle();

    expect(screen.getByRole("heading", { name: "Restore your messaging connection" })).toBeTruthy();
    expect(screen.getByText("Disconnect Slack before connecting a different app.")).toBeTruthy();
    expect(screen.getByText("Disconnect Slack before connecting Lark.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Disconnect Slack/ })).toBeNull();
    expect(document.querySelector('[data-ui="agent-setup-messaging-recovery-actions"]')).toBeNull();
  });

  it("keeps the messaging description when the snapshot offers no Provider to start", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    renderSetup(
      patchedAdapter(memory, (snapshot) => ({
        ...snapshot,
        actions: snapshot.actions.filter((action: AgentSetupAction) => action.kind !== "start-messaging"),
      })),
    );
    await settle();
    continueFromPreparation();

    expect(screen.getByText("Pick the app your team already works in.")).toBeTruthy();
    expect(document.querySelector('[data-ui="agent-setup-messaging-choices"]')).toBeNull();
  });
});

describe("AgentSetupPage with the Lab Computer adapters", () => {
  it("re-reads the snapshot once the Lab inventory binds the only owned Computer", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent({ computer: null }), computers: [onlineReviewMac] });
    const reads = vi.spyOn(memory.adapter, "readSnapshot");
    renderSetup(memory.adapter, { computerAdapter: memory.computerAdapter });
    await settle();
    await advance(1);
    await settle();

    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect((await memory.adapter.readSnapshot(SETUP_AGENT_ID)).computer).toMatchObject({
      kind: "bound",
      computerId: SETUP_COMPUTER_ID,
    });
    expect(reads.mock.calls.length).toBeGreaterThan(1);
  });

  it("re-reads the snapshot once a Lab repair command is redeemed", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent(), computerOnline: false });
    renderSetup(memory.adapter, { computerAdapter: memory.computerAdapter });
    await settle();
    expect(screen.getByText("Start OpenTag on Review Mac; this page will continue when it reconnects.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Generate an install command" }));
    await settle();
    expect(memory.inspect().computerConnectState).toBe("pending");
    expect(screen.getByText("Waiting for Review Mac to reconnect…")).toBeTruthy();

    act(() => memory.controls.completeComputerConnection());
    await advance(1_600);
    await settle();

    expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
    expect(screen.queryByText("Waiting for Review Mac to reconnect…")).toBeNull();
  });
});
