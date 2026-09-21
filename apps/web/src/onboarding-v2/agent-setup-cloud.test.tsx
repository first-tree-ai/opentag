/**
 * The Agent Setup surface for a Cloud-bound Agent: the managed environment section states what is
 * true (hosted, started with the first task), an unavailable deployment blocks with its reason and
 * an explicit re-check, and the Messaging leg is the same Server-owned authorization path a Local
 * Agent walks. No Computer connect, no CLI checks, no Local repair copy ever appears.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSetupPage, SETUP_POLL_MS } from "./agent-setup-page.js";
import { SETUP_AGENT_ID, SETUP_COMPUTER_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import type { MemorySetupSeed } from "./setup-memory-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

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

function cloudSeed(overrides: Partial<MemorySetupSeed> = {}): MemorySetupSeed {
  return {
    agent: setupAgent({
      runtimeProvider: "pi",
      computer: { computerId: SETUP_COMPUTER_ID, displayName: "Cloud", platform: "linux" },
    }),
    cloudService: {},
    ...overrides,
  };
}

function renderCloudSetup(seed: MemorySetupSeed, props: { onReady?: (agentId: string) => Promise<void> | void } = {}) {
  const memory = createMemorySetupAdapter(seed);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentSetupPage adapter={memory.adapter} agentId={SETUP_AGENT_ID} onReady={props.onReady} />
    </QueryClientProvider>,
  );
  return memory;
}

describe("AgentSetupPage for a Cloud-bound Agent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("states the managed environment and never offers a Local connect or repair", async () => {
    renderCloudSetup(cloudSeed());
    await settle();
    await advance(1);

    expect(screen.getByRole("heading", { name: "Cloud environment" })).toBeTruthy();
    expect(screen.getByText("Hosted by OpenTag. The environment starts when your first task begins.")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect your computer" })).toBeNull();
    expect(screen.queryByText(/Install/)).toBeNull();
    expect(document.querySelector('[data-ui="agent-setup-cloud"]')).not.toBeNull();
    expect(document.querySelector('[data-ui="agent-setup-preparation"]')).toBeNull();
  });

  it("walks from the managed environment to a ready Messaging binding", async () => {
    const onReady = vi.fn();
    const memory = renderCloudSetup(cloudSeed(), { onReady });
    await settle();
    await advance(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle(10);
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

    memory.controls.scanFeishuCode();
    await advance(SETUP_POLL_MS + 10);
    expect(screen.getByText("Connected. Checking your agent can be reached…")).toBeTruthy();

    memory.controls.completeHandoff();
    await advance(SETUP_POLL_MS + 10);
    expect(screen.getByRole("heading", { name: "reviewer is ready." })).toBeTruthy();
    expect(onReady).toHaveBeenCalledWith(SETUP_AGENT_ID);
  });

  it("blocks on the deployment reason while the service is unavailable, then recovers by re-check", async () => {
    const memory = renderCloudSetup(cloudSeed({ cloudService: { available: false, reason: "model_unavailable" } }));
    await settle();
    await advance(1);

    expect(screen.getByText("Temporarily unavailable")).toBeTruthy();
    expect(screen.getByText("The Cloud model service is not configured on this deployment yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(true);
    // No Messaging choice is offered while the managed service cannot execute.
    expect(screen.queryByRole("button", { name: /Lark/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Slack/ })).toBeNull();

    // The deployment was fixed: the next observation reads the new answer.
    memory.controls.setCloudAvailability(true);
    await advance(SETUP_POLL_MS + 10);
    await settle();
    expect(screen.getByRole("button", { name: "Continue" }).hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("The Cloud model service is not configured on this deployment yet.")).toBeNull();
  });

  it("keeps a pending approval honest and cancels it", async () => {
    renderCloudSetup(cloudSeed());
    await settle();
    await advance(1);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
    await settle(10);
    expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(screen.getByText("Couldn’t connect Lark. Try scanning a new QR code.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Lark setup" })).toBeTruthy();
  });
});
