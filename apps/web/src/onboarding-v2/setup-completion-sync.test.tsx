/**
 * The completion boundary of Setup messaging: when a ready binding is observed, the shared Agent,
 * binding, and handoff caches synchronize exactly once per completion, so a reader who returns
 * home inside the 30s freshness window re-reads instead of trusting what was cached before Setup.
 *
 * The page drives the sync only on the production adapter; Lab and in-memory adapters keep their
 * isolation from the real QueryClient.
 */

import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { browserApi } from "../api.js";
import { useImBindingQuery } from "../features/agents/agent-queries.js";
import { queryKeys } from "../query/keys.js";
import { AgentSetupPage, SETUP_POLL_MS } from "./agent-setup-page.js";
import { SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

let client: ReturnType<typeof useQueryClient>;
function Capture() {
  client = useQueryClient();
  return null;
}

/** The home binding consumer: reads the shared IM binding cache for the exact Agent. */
function BindingProbe() {
  const query = useImBindingQuery(SETUP_AGENT_ID);
  return (
    <output data-testid="binding">{query.isPending ? "loading" : query.data ? "connected" : "not connected"}</output>
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  client?.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Setup completion sync", () => {
  it("synchronizes the Agent caches when authorization completes, before the reader returns home", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    let connected = false;
    const bindingRead = vi
      .spyOn(browserApi, "imBinding")
      .mockImplementation(async () => (connected ? { id: "bound-now", provider: "feishu" } : undefined) as never);
    vi.spyOn(browserApi, "agentSetup").mockImplementation((id) => memory.adapter.readSnapshot(id));

    const view = await renderInRouter(
      <>
        <Capture />
        <BindingProbe />
      </>,
    );
    await settle();
    expect(screen.getByTestId("binding").textContent).toBe("not connected");

    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    const open = vi.fn();
    view.rerender(
      <>
        <Capture />
        <AgentSetupPage agentId={SETUP_AGENT_ID} onOpenAgent={open} />
      </>,
    );
    await settle();
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    connected = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS + 10);
    });
    await settle();
    expect(memory.inspect().snapshot.stage).toBe("ready");

    // The completion synced before any navigation: the binding cached as absent is already stale.
    fireEvent.click(screen.getByRole("button", { name: "Open agent" }));
    expect(open).toHaveBeenCalledTimes(1);
    view.rerender(
      <>
        <Capture />
        <BindingProbe />
      </>,
    );
    await settle();
    expect(screen.getByTestId("binding").textContent).toBe("connected");
    expect(bindingRead).toHaveBeenCalledTimes(2);
  });

  it("syncs an already-ready first snapshot once, and not again for repeated snapshots of it", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    vi.spyOn(browserApi, "agentSetup").mockImplementation((id) => memory.adapter.readSnapshot(id));

    const view = await renderInRouter(<Capture />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    view.rerender(
      <>
        <Capture />
        <AgentSetupPage agentId={SETUP_AGENT_ID} />
      </>,
    );
    await settle();

    // One sync for the completion the return from authorization arrived at: the list root and the
    // Agent's own prefix, nothing more.
    expect(invalidate.mock.calls.map(([input]) => input?.queryKey)).toEqual([
      queryKeys.agents.listRoot(),
      queryKeys.agents.all(SETUP_AGENT_ID),
    ]);

    // Repeated reads of the same ready snapshot — focus returns inside the polling beat — never sync again.
    for (let index = 0; index < 3; index += 1) {
      act(() => window.dispatchEvent(new Event("focus")));
      await settle();
    }
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("syncs again when a reauthorization completes on the same mounted page", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    vi.spyOn(browserApi, "agentSetup").mockImplementation((id) => memory.adapter.readSnapshot(id));

    const view = await renderInRouter(<Capture />);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    view.rerender(
      <>
        <Capture />
        <AgentSetupPage agentId={SETUP_AGENT_ID} />
      </>,
    );
    await settle();
    expect(invalidate).toHaveBeenCalledTimes(2);

    const prior = memory.inspect().snapshot.messaging;
    if (prior.kind !== "ready") throw new Error("Expected ready messaging");
    // Another authorization cycle can complete between two reads of the same mounted page, without
    // the transitional state ever being shown.
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "reauthorize", {
      kind: "bound",
      provider: "feishu",
      bindingId: prior.bindingId,
      credentialGeneration: prior.credentialGeneration,
    });
    memory.controls.scanFeishuCode();
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();

    const current = memory.inspect().snapshot.messaging;
    expect(current.kind).toBe("ready");
    expect(current.kind === "ready" && current.credentialGeneration).toBe(prior.credentialGeneration + 1);
    expect(invalidate).toHaveBeenCalledTimes(4);

    // The second completion synced once: further snapshots of it do not repeat the sync.
    act(() => window.dispatchEvent(new Event("focus")));
    await settle();
    expect(invalidate).toHaveBeenCalledTimes(4);
  });

  it("syncs the completed messaging evidence even when the Computer is offline and the stage is not ready", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    let connected = false;
    const bindingRead = vi
      .spyOn(browserApi, "imBinding")
      .mockImplementation(async () => (connected ? { id: "bound-now", provider: "feishu" } : undefined) as never);
    vi.spyOn(browserApi, "agentSetup").mockImplementation((id) => memory.adapter.readSnapshot(id));

    const view = await renderInRouter(
      <>
        <Capture />
        <BindingProbe />
      </>,
    );
    await settle();
    expect(screen.getByTestId("binding").textContent).toBe("not connected");

    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    view.rerender(
      <>
        <Capture />
        <AgentSetupPage agentId={SETUP_AGENT_ID} />
      </>,
    );
    await settle();

    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    connected = true;
    memory.controls.setComputerOnline(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETUP_POLL_MS + 10);
    });
    await settle();
    expect(memory.inspect().snapshot.messaging.kind).toBe("ready");
    expect(memory.inspect().snapshot.stage).not.toBe("ready");

    view.rerender(
      <>
        <Capture />
        <BindingProbe />
      </>,
    );
    await settle();
    expect(screen.getByTestId("binding").textContent).toBe("connected");
    expect(bindingRead).toHaveBeenCalledTimes(2);
  });

  it("leaves the shared caches alone on a custom adapter, preserving Lab isolation", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    const adapter: AgentSetupAdapter = memory.adapter;

    const view = await renderInRouter(<Capture />);
    await settle();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    view.rerender(
      <>
        <Capture />
        <AgentSetupPage adapter={adapter} agentId={SETUP_AGENT_ID} />
      </>,
    );
    await settle();
    expect(screen.getByText(/is ready\./)).toBeTruthy();
    expect(invalidate).not.toHaveBeenCalled();
  });
});
