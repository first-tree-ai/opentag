/**
 * The operation boundary of the shared Setup read transport.
 *
 * The default HTTP adapter reads the canonical snapshot through the shared QueryClient so
 * concurrent readers share one in-flight GET. A write moves the state an earlier snapshot
 * described, so a GET begun before the write must never answer the read that follows it: the
 * adapter retires in-flight snapshot reads at every operation boundary, and the controller's
 * post-write read starts its own request after the write.
 */

import type { AgentSetupSnapshot } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { createQueryClient } from "../query/client.js";
import { queryKeys } from "../query/keys.js";
import { AgentSetupPage, SETUP_POLL_MS } from "./agent-setup-page.js";
import { deferred, SETUP_AGENT_ID, setupAgent } from "./agent-setup-test-fixtures.js";
import { createHttpSetupAdapter } from "./setup-adapter.js";
import { createMemorySetupAdapter } from "./setup-memory-adapter.js";

let client: ReturnType<typeof useQueryClient>;
function Capture() {
  client = useQueryClient();
  return null;
}

/** Flushes the promise queue and the short timers the controller schedules around a beat. */
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

it("starts the post-write read after an authorization write instead of adopting the pre-write focus read", async () => {
  const memory = createMemorySetupAdapter({ agent: setupAgent() });
  const before = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
  const preWrite = deferred<AgentSetupSnapshot>();
  const get = vi
    .spyOn(browserApi, "agentSetup")
    .mockResolvedValueOnce(before)
    .mockImplementationOnce(() => preWrite.promise)
    .mockImplementation((id) => memory.adapter.readSnapshot(id));
  const post = vi.spyOn(browserApi, "createFeishuSetupAttempt").mockImplementation(async (id, intent, expected) => {
    if (!intent || !expected) throw new Error("The start action always names its intent and expected messaging");
    await memory.adapter.startFeishuAttempt(id, intent, expected);
    return {} as never;
  });

  const view = await renderInRouter(<Capture />);
  view.rerender(
    <>
      <Capture />
      <AgentSetupPage agentId={SETUP_AGENT_ID} />
    </>,
  );
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await settle();
  expect(screen.getByRole("button", { name: /Lark/ })).toBeTruthy();

  // The window returning to view starts a slow snapshot GET that is still in flight when the write lands.
  act(() => window.dispatchEvent(new Event("focus")));
  await settle();
  expect(get).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: /Lark/ }));
  await settle();
  expect(post).toHaveBeenCalledTimes(1);
  // The read that follows the write is its own request, begun after the write — not the pre-write GET.
  expect(get).toHaveBeenCalledTimes(3);
  expect(screen.queryByText("Waiting for you to scan…")).not.toBeNull();

  // The retired pre-write answer lands late and must not bury the authorizing snapshot or the beat.
  preWrite.resolve(before);
  await settle();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETUP_POLL_MS * 3);
  });
  expect(screen.queryByText("Waiting for you to scan…")).not.toBeNull();
  expect(get.mock.calls.length).toBeGreaterThan(3);
});

it("starts the post-write read after a cancel instead of republishing the pre-write poll read", async () => {
  const memory = createMemorySetupAdapter({ agent: setupAgent() });
  await memory.adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" });
  const authorizing = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
  const preWrite = deferred<AgentSetupSnapshot>();
  const get = vi
    .spyOn(browserApi, "agentSetup")
    .mockResolvedValueOnce(authorizing)
    .mockImplementationOnce(() => preWrite.promise)
    .mockImplementation((id) => memory.adapter.readSnapshot(id));
  const cancel = vi.spyOn(browserApi, "cancelFeishuSetupAttempt").mockImplementation(async (attemptId) => {
    await memory.adapter.cancelFeishuAttempt(attemptId);
    return {} as never;
  });

  const view = await renderInRouter(<Capture />);
  view.rerender(
    <>
      <Capture />
      <AgentSetupPage agentId={SETUP_AGENT_ID} />
    </>,
  );
  await settle();
  expect(screen.getByText("Waiting for you to scan…")).toBeTruthy();

  // The 2s beat starts a slow snapshot GET that is still in flight when the cancel lands.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SETUP_POLL_MS);
  });
  expect(get).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await settle();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledTimes(3);
  expect(screen.queryByText("Waiting for you to scan…")).toBeNull();

  // The retired pre-cancel answer must not bring the QR back once it lands.
  preWrite.resolve(authorizing);
  await settle();
  expect(screen.queryByText("Waiting for you to scan…")).toBeNull();
});

it("shares one in-flight read within an operation and retires it at the write boundary", async () => {
  const queryClient = createQueryClient();
  const memory = createMemorySetupAdapter({ agent: setupAgent() });
  const slow = deferred<AgentSetupSnapshot>();
  const get = vi
    .spyOn(browserApi, "agentSetup")
    .mockImplementationOnce(() => slow.promise)
    .mockImplementation((id) => memory.adapter.readSnapshot(id));
  const refresh = vi.spyOn(browserApi, "refreshAgentSetup").mockResolvedValue(undefined);
  const adapter = createHttpSetupAdapter(browserApi, queryClient);

  // Ordinary reuse: two readers of the same key share the GET that is already in the air.
  const first = adapter.readSnapshot(SETUP_AGENT_ID);
  const firstShared = adapter.readSnapshot(SETUP_AGENT_ID);
  expect(get).toHaveBeenCalledTimes(1);

  // The operation boundary: an explicit refresh retires the pre-write read, so the controller's
  // next read starts its own GET after the write.
  await adapter.refreshPreparation(SETUP_AGENT_ID);
  expect(refresh).toHaveBeenCalledTimes(1);
  const second = adapter.readSnapshot(SETUP_AGENT_ID);
  expect(get).toHaveBeenCalledTimes(2);
  await expect(second).resolves.toEqual(await memory.adapter.readSnapshot(SETUP_AGENT_ID));

  // The retired read's late answer is fenced: its callers are cancelled and the cache keeps the
  // post-write snapshot.
  await expect(first).rejects.toThrow();
  await expect(firstShared).rejects.toThrow();
  const current = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
  slow.resolve({ ...current, stage: "needs-computer" });
  await Promise.resolve();
  expect(queryClient.getQueryData(queryKeys.agentSetup(SETUP_AGENT_ID))).toEqual(current);
  expect(get).toHaveBeenCalledTimes(2);
});

it("starts a post-write snapshot after binding an owned Computer while an old read is in flight", async () => {
  const seededInventory = await createMemorySetupAdapter({ agent: setupAgent() }).computerAdapter.inventory.computers();
  const inventory = { computers: [...seededInventory.computers] };
  const memory = createMemorySetupAdapter({
    agent: setupAgent({ computer: null }),
    computers: inventory.computers,
  });
  const before = await memory.adapter.readSnapshot(SETUP_AGENT_ID);
  const preWrite = deferred<AgentSetupSnapshot>();
  const inventoryGate = deferred<typeof inventory>();
  const get = vi
    .spyOn(browserApi, "agentSetup")
    .mockResolvedValueOnce(before)
    .mockImplementationOnce(() => preWrite.promise)
    .mockImplementation((id) => memory.adapter.readSnapshot(id));
  vi.spyOn(browserApi, "computers")
    .mockImplementationOnce(() => inventoryGate.promise)
    .mockImplementation(async () => {
      const current = await memory.computerAdapter.inventory.computers();
      return { computers: [...current.computers] };
    });
  const bind = vi.spyOn(browserApi, "rebindAgentComputer").mockImplementation(async (id, computerId) => {
    await memory.computerAdapter.inventory.bindComputer(id, computerId);
    const agent = memory.inspect().snapshot.agent;
    return {
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      runtimeProvider: agent.runtimeProvider,
      receiveMode: agent.receiveMode,
      status: agent.status,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
      createdByUserId: agent.createdBy.userId,
      computerId,
      revision: 1,
      runtimeConfig: { revision: 1, model: null, reasoningEffort: null, instructions: "", maxDurationMs: null },
    };
  });
  await renderInRouter(
    <>
      <Capture />
      <AgentSetupPage agentId={SETUP_AGENT_ID} />
    </>,
  );
  await settle();
  expect(get).toHaveBeenCalledTimes(1);
  expect(bind).not.toHaveBeenCalled();

  act(() => window.dispatchEvent(new Event("focus")));
  await settle();
  expect(get).toHaveBeenCalledTimes(2);
  inventoryGate.resolve(inventory);
  await settle();
  expect(bind).toHaveBeenCalledTimes(1);
  expect(memory.inspect().snapshot.computer.kind).toBe("bound");
  expect(get).toHaveBeenCalledTimes(3);

  preWrite.resolve(before);
  await settle();
  expect(screen.getByRole("heading", { name: "Prepare this computer" })).toBeTruthy();
  expect(client.getQueryData<AgentSetupSnapshot>(queryKeys.agentSetup(SETUP_AGENT_ID))?.computer.kind).toBe("bound");
});

it("keeps mutation error behavior: a refused write surfaces and the next read still asks", async () => {
  const queryClient = createQueryClient();
  const memory = createMemorySetupAdapter({ agent: setupAgent() });
  const get = vi.spyOn(browserApi, "agentSetup").mockImplementation((id) => memory.adapter.readSnapshot(id));
  vi.spyOn(browserApi, "createFeishuSetupAttempt").mockRejectedValue(new ApiError(409, "IM_BINDING_UNBIND_REQUIRED"));
  const adapter = createHttpSetupAdapter(browserApi, queryClient);

  await expect(adapter.startFeishuAttempt(SETUP_AGENT_ID, "create", { kind: "unbound" })).rejects.toBeInstanceOf(
    ApiError,
  );
  await expect(adapter.readSnapshot(SETUP_AGENT_ID)).resolves.toEqual(
    await memory.adapter.readSnapshot(SETUP_AGENT_ID),
  );
  expect(get).toHaveBeenCalledTimes(1);
});
