import { QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../query/client.js";
import { AgentSetupPage } from "./agent-setup-page.js";
import { SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import type { AgentSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

async function settle() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

function mount(adapter: AgentSetupAdapter) {
  const client = createQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <AgentSetupPage agentId={SETUP_AGENT_ID} adapter={adapter} onReady={vi.fn()} />
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("re-check on entering the preparation step", () => {
  it("asks an online Computer once per entry, at most once a minute", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    memory.controls.setRuntimeStatus("install");
    const refresh = vi.spyOn(memory.adapter, "refreshPreparation");
    const first = mount(memory.adapter);
    await settle();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(SETUP_AGENT_ID);
    first.unmount();
    first.client.clear();

    const second = mount(memory.adapter);
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    second.client.clear();
  });

  it("does not ask an offline Computer", async () => {
    const memory = createMemorySetupAdapter({ agent: setupAgent() });
    memory.controls.setRuntimeStatus("install");
    memory.controls.setComputerOnline(false);
    const refresh = vi.spyOn(memory.adapter, "refreshPreparation");
    const view = mount(memory.adapter);
    await settle();
    expect(refresh).not.toHaveBeenCalled();
    view.client.clear();
  });
});
