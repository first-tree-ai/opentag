import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../query/client.js";
import { AgentSetupPage, SETUP_POLL_MS } from "./agent-setup-page.js";
import { SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

async function pendingActivation() {
  const memory = createMemorySetupAdapter({ agent: setupAgent() });
  await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
  memory.controls.awaitFeishuActivation();
  return memory;
}

function mount(adapter: AgentSetupAdapter, onReady = vi.fn()) {
  const client = createQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AgentSetupPage agentId={SETUP_AGENT_ID} adapter={adapter} onReady={onReady} />
    </QueryClientProvider>,
  );
  return { ...view, onReady, client };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("durable Feishu activation presentation", () => {
  it.each(["offline", "runtime"])(
    "keeps preparation refresh available while authorization waits and %s needs recovery",
    async (condition) => {
      const memory = await pendingActivation();
      if (condition === "offline") memory.controls.setComputerOnline(false);
      else memory.controls.setRuntimeStatus("install");
      const refresh = vi.spyOn(memory.adapter, "refreshPreparation");
      const check = vi.spyOn(memory.adapter, "checkFeishuAttempt");
      const view = mount(memory.adapter);
      await settle();
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      await settle();
      expect(refresh).toHaveBeenCalledExactlyOnceWith(SETUP_AGENT_ID);
      expect(check).not.toHaveBeenCalled();
      view.client.clear();
    },
  );

  it("resumes a saved request after remount and observes activation without registering again", async () => {
    const memory = await pendingActivation();
    const start = vi.spyOn(memory.adapter, "startFeishuAttempt");
    const cancel = vi.spyOn(memory.adapter, "cancelFeishuAttempt");
    const first = mount(memory.adapter);
    await settle();
    expect(screen.getByText("Waiting for all required permissions")).toBeTruthy();
    expect(screen.getByText(/You can close this page/)).toBeTruthy();
    expect(screen.queryByRole("img", { name: /QR code/ })).toBeNull();
    first.unmount();
    first.client.clear();

    // A different page lifecycle sees the same durable application and attempt.
    const second = mount(memory.adapter);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Application and permissions" }));
    await settle();
    expect(screen.getByText("App ID: cli_saved_authorization")).toBeTruthy();
    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    await act(async () => vi.advanceTimersByTimeAsync(SETUP_POLL_MS));
    await settle();
    expect(second.onReady).toHaveBeenCalledWith(SETUP_AGENT_ID);
    expect(screen.queryByText("Waiting for all required permissions")).toBeNull();
    expect(start).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    second.client.clear();
  });

  it("checks the exact saved attempt and leaves a transient failure recoverable by polling", async () => {
    const memory = await pendingActivation();
    const snapshot = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
    if (
      snapshot.messaging.kind !== "authorizing" ||
      snapshot.messaging.provider !== "feishu" ||
      !snapshot.messaging.activation
    )
      throw new Error("Expected pending activation");
    const check = vi
      .spyOn(memory.adapter, "checkFeishuAttempt")
      .mockRejectedValueOnce(new Error("temporarily offline"));
    const start = vi.spyOn(memory.adapter, "startFeishuAttempt");
    const view = mount(memory.adapter);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Check latest status" }));
    await settle();
    expect(check).toHaveBeenCalledExactlyOnceWith(snapshot.messaging.attemptId);
    expect(screen.getByText("Waiting for all required permissions")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t check right now");
    memory.controls.scanFeishuCode();
    memory.controls.completeHandoff();
    await act(async () => vi.advanceTimersByTimeAsync(SETUP_POLL_MS));
    await settle();
    expect(view.onReady).toHaveBeenCalledWith(SETUP_AGENT_ID);
    expect(start).not.toHaveBeenCalled();
    view.client.clear();
  });

  it("cancels only on an explicit action and never marks a pending request ready", async () => {
    const memory = await pendingActivation();
    const cancel = vi.spyOn(memory.adapter, "cancelFeishuAttempt");
    const view = mount(memory.adapter);
    await settle();
    expect(view.onReady).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection request" }));
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Waiting for all required permissions")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3));
    expect(view.onReady).not.toHaveBeenCalled();
    view.client.clear();
  });
});
