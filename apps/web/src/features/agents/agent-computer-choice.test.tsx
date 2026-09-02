/**
 * The automatic bind must be decided from a read this mount made, never from what another page
 * left in the cache. The cache is served immediately on mount while a re-read runs, and with the
 * repository's `staleTime: 0` a mounted observer always looks fresh; a bind taken from it picks the
 * one Computer the Account had before a second was connected elsewhere, or one it no longer has.
 */

import type { AccountComputerSummary, AgentAdminConfig } from "@opentag/shared/browser";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { createQueryClient } from "../../query/client.js";
import { queryKeys } from "../../query/keys.js";
import { AgentComputerChoice } from "./agent-computer-choice.js";

const AGENT_ID = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const COMPUTER_ID = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";
const OTHER_COMPUTER_ID = "9d3c2e5f-6b7a-4c8d-9e0f-1a2b3c4d5e6f";

const cachedComputer: AccountComputerSummary = {
  computerId: COMPUTER_ID,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:01:00.000Z",
  observedAt: "2026-08-20T00:01:00.000Z",
  createdAt: "2026-08-19T00:00:00.000Z",
  agentIds: [],
};

const spareComputer: AccountComputerSummary = {
  ...cachedComputer,
  computerId: OTHER_COMPUTER_ID,
  displayName: "Spare",
};

const boundConfig: AgentAdminConfig = {
  id: AGENT_ID,
  createdByUserId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d",
  computerId: COMPUTER_ID,
  name: "reviewer",
  displayName: "Reviewer",
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  revision: 2,
  runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

/** A read this mount will make, held open until the test releases it. */
function heldRead() {
  let release: (computers: AccountComputerSummary[]) => void = () => undefined;
  const read = new Promise<{ computers: AccountComputerSummary[] }>((resolve) => {
    release = (computers) => resolve({ computers });
  });
  vi.spyOn(browserApi, "computers").mockReturnValue(read);
  return release;
}

/** Mounts the choice over a cache another page already filled with one Computer. */
function renderOverCachedInventory() {
  const queryClient = createQueryClient();
  queryClient.setQueryData(queryKeys.computers(), { computers: [cachedComputer] });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentComputerChoice agentId={AGENT_ID} onBound={() => undefined} />
    </QueryClientProvider>,
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AgentComputerChoice over a cached inventory", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not bind the cached Computer while this mount's own read is still open", async () => {
    const release = heldRead();
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    renderOverCachedInventory();
    await flush();

    // The cache says one Computer; that is exactly the answer an automatic bind would take.
    expect(rebind).not.toHaveBeenCalled();
    expect(screen.getByText("Checking which Computers this Account has…")).toBeTruthy();

    // The Account has since connected a second machine: the question is now the reader's.
    await act(async () => release([cachedComputer, spareComputer]));

    expect(await screen.findByRole("button", { name: "Use Spare" })).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("offers enrolment when the fresh read says the cached Computer is gone", async () => {
    const release = heldRead();
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);
    vi.spyOn(browserApi, "issueComputerConnectCode").mockReturnValue(new Promise(() => undefined));

    renderOverCachedInventory();
    await flush();
    await act(async () => release([]));

    expect(await screen.findByText("Connect a Computer")).toBeTruthy();
    expect(rebind).not.toHaveBeenCalled();
  });

  it("still binds by itself once the fresh read confirms the one Computer", async () => {
    const release = heldRead();
    const rebind = vi.spyOn(browserApi, "rebindAgentComputer").mockResolvedValue(boundConfig);

    renderOverCachedInventory();
    await flush();
    expect(rebind).not.toHaveBeenCalled();

    await act(async () => release([cachedComputer]));

    await waitFor(() => expect(rebind).toHaveBeenCalledWith(AGENT_ID, COMPUTER_ID));
    expect(rebind).toHaveBeenCalledTimes(1);
  });
});
