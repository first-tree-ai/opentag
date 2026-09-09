import type {
  AccountComputerSummary,
  AgentDetail,
  AgentUsageDetail,
  TaskDetail,
  TaskSummary,
} from "@opentag/shared/browser";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { AgentUsageOverview, AgentUsageTab } from "../features/agent-usage.js";
import { useAgentListView, useComputersQuery } from "../features/agents/agent-queries.js";
import { AgentTasksSection, TaskDetailPage, TasksPage } from "../features/tasks-page.js";
import { syncAgentQueries } from "./agent-sync.js";
import { createQueryClient } from "./client.js";
import { queryKeys } from "./keys.js";
import { LIVE_REFETCH_INTERVAL_MS } from "./live.js";
import { fetchSharedResource } from "./session-cache.js";

const accountId = "0b9c8d7e-6f50-4a1b-8c2d-3e4f50617283";
const agentId = "3f1d3a2c-1f2e-4a1b-9c3d-5e6f70819a2b";
const sessionId = "11111111-1111-4111-8111-111111111111";
const computerId = "8c2b1d4e-5a6f-4b7c-8d9e-0f1a2b3c4d5e";

const computer: AccountComputerSummary = {
  computerId,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:01:00.000Z",
  observedAt: "2026-08-20T00:01:00.000Z",
  createdAt: "2026-08-19T00:00:00.000Z",
  agentIds: [agentId],
};

const agentDetail: AgentDetail = {
  id: agentId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId: "9a8b7c6d-5e4f-4a3b-8c1d-0e9f8a7b6c5d", displayName: "Ada" },
  computer: { computerId, displayName: "Ada's Mac", platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  activity: { state: "idle" },
};

const task: TaskSummary = {
  id: sessionId,
  agent: { id: agentId, name: "atlas", displayName: "Atlas", runtimeProvider: "codex" },
  source: {
    provider: "feishu",
    conversationKind: "dm",
    channelId: "oc_debug_channel",
    threadKey: null,
  },
  sessionKind: "channel",
  title: "Investigate the failed deployment",
  status: "queued",
  createdAt: "2026-08-27T01:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-08-27T01:00:00.000Z",
};

const completedTask: TaskSummary = {
  ...task,
  status: "completed",
  lastActivityAt: "2026-08-27T02:00:00.000Z",
};

const detail: TaskDetail = {
  task: completedTask,
  turns: [
    {
      deliveryId: "33333333-3333-4333-8333-333333333333",
      attention: "direct",
      delivery: {
        state: "accepted",
        attemptCount: 1,
        acceptedAt: "2026-08-27T01:01:00.000Z",
        steeredAt: null,
        expiresAt: "2026-08-28T01:00:00.000Z",
        reason: null,
        lastErrorCode: null,
      },
      message: {
        id: "44444444-4444-4444-8444-444444444444",
        externalMessageId: "om_debug",
        operation: "created",
        authorKind: "human",
        authorDisplayName: "Mia Zhang",
        fallbackText: "Please investigate the failed deployment.",
        truncated: false,
        occurredAt: "2026-08-27T01:00:00.000Z",
      },
      absorbedBy: null,
      report: {
        turnId: "turn-debug",
        outcome: "completed",
        executionEffects: "completed",
        finalText: "The runtime finished and the provider reply was sent separately.",
        errorReason: null,
        usage: { inputTokens: 100, cachedInputTokens: null, outputTokens: 50 },
        traceSummary: { lastSequence: 4, droppedEvents: 0 },
        outgoingReplies: null,
        reportedAt: "2026-08-27T02:00:00.000Z",
      },
    },
  ],
  internalSessions: [],
  collaborationMessages: [],
  nextCursor: null,
};

const usage: AgentUsageDetail = {
  windowDays: 30,
  startedAt: "2026-07-27T00:00:00.000Z",
  endedAt: "2026-08-25T23:59:59.999Z",
  tasks: 32,
  measuredTasks: 31,
  failed: 0,
  inputTokens: 400_000,
  cachedInputTokens: 350_000,
  outputTokens: 28_000,
  tokens: 428_000,
  daily: [],
};

let currentClient: ReturnType<typeof useQueryClient>;
function CaptureClient() {
  currentClient = useQueryClient();
  return null;
}

function ComputersProbe({ name }: { name: string }) {
  const result = useComputersQuery(true);
  return <span data-testid={name}>{result.isSuccess ? "ready" : "pending"}</span>;
}

function EnrichedListProbe() {
  const state = useAgentListView(accountId);
  return <span data-testid="summary">{state.kind}</span>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
});

describe("shared live resource queries", () => {
  it("reuses an in-flight computers read and a just-settled result", async () => {
    const read = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const view = await renderInRouter(<ComputersProbe name="first" />);
    await waitFor(() => expect(screen.getByTestId("first").textContent).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);

    view.rerender(
      <>
        <ComputersProbe name="first" />
        <ComputersProbe name="second" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId("second").textContent).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("two observers of the same computers key share interval updates", async () => {
    const read = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    vi.useFakeTimers();
    const view = await renderInRouter(<ComputersProbe name="first" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    view.rerender(
      <>
        <ComputersProbe name="first" />
        <ComputersProbe name="second" />
      </>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    const before = read.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_REFETCH_INTERVAL_MS);
    });
    expect(read.mock.calls.length - before).toBe(1);
  });

  it("rereads on focus and reconnect even inside the freshness window", async () => {
    const read = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    await renderInRouter(<ComputersProbe name="first" />);
    await waitFor(() => expect(screen.getByTestId("first").textContent).toBe("ready"));
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));

    onlineManager.setOnline(false);
    await act(async () => {
      onlineManager.setOnline(true);
    });
    await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  });

  it("shares Computer inventory while loading each Agent's list status evidence", async () => {
    vi.spyOn(browserApi, "agents").mockResolvedValue({
      agents: [
        { ...agentDetail, usage: { windowDays: 30, tasks: 1, failed: 0, tokens: 1 } },
        {
          ...agentDetail,
          id: "22222222-2222-4222-8222-222222222222",
          usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
        },
      ],
    });
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computer] });
    const binding = vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    const handoff = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    await renderInRouter(<EnrichedListProbe />);
    await waitFor(() => expect(screen.getByTestId("summary").textContent).toBe("ready"));
    expect(computers).toHaveBeenCalledTimes(1);
    expect(binding).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledTimes(2);
  });
});

describe("task and usage live revalidation", () => {
  it("rereads the home task list on focus, including a completed DM that received another turn", async () => {
    const later = {
      ...completedTask,
      lastActivityAt: "2026-08-27T03:00:00.000Z",
      title: "Investigate the failed deployment",
    };
    const request = vi
      .spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [task], nextCursor: null })
      .mockResolvedValue({ tasks: [later], nextCursor: null });
    await renderInRouter(
      <>
        <AgentTasksSection agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText(task.title)).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(screen.getByText("Completed")).toBeTruthy());
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("updates an empty task list when the first Task arrives", async () => {
    vi.spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [], nextCursor: null })
      .mockResolvedValue({ tasks: [completedTask], nextCursor: null });
    await renderInRouter(
      <>
        <AgentTasksSection agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText("Message this Agent in your chat app to put it to work.")).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByText(completedTask.title)).toBeTruthy();
  });

  it("walks infinite pages from the new first-page cursor and blocks load-more while a fetch is active", async () => {
    const older = { ...task, id: "66666666-6666-4666-8666-666666666666", title: "Older task" };
    const newest = { ...task, id: "77777777-7777-4777-8777-777777777777", title: "Newest task" };
    const request = vi
      .spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "old-cursor" })
      .mockResolvedValueOnce({ tasks: [older], nextCursor: null })
      .mockResolvedValueOnce({ tasks: [newest], nextCursor: "new-cursor" })
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "new-page-3" });
    await renderInRouter(
      <>
        <AgentTasksSection agentId={agentId} />
        <CaptureClient />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Older task")).toBeTruthy();
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    expect(await screen.findByText("Newest task")).toBeTruthy();
    expect(screen.queryByText("Older task")).toBeNull();
    expect(request.mock.calls.map(([input]) => input?.cursor)).toEqual([
      undefined,
      "old-cursor",
      undefined,
      "new-cursor",
    ]);
  });

  it("does not start load-more while a refetch is in flight", async () => {
    let release!: (value: { tasks: TaskSummary[]; nextCursor: string | null }) => void;
    vi.spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [completedTask], nextCursor: "next" })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
    await renderInRouter(
      <>
        <TasksPage agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByRole("link", { name: completedTask.title })).toBeTruthy();
    let refetch!: Promise<unknown>;
    await act(async () => {
      refetch = currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    await waitFor(() => {
      const button = screen.getByRole("button", { name: "Load more" });
      expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true);
    });
    await act(async () => {
      release({ tasks: [completedTask], nextCursor: "next" });
      await refetch;
    });
  });

  it("does not cancel an in-flight refetch when Load more is clicked", async () => {
    let releaseRefetch!: (value: { tasks: TaskSummary[]; nextCursor: string | null }) => void;
    const request = vi
      .spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [completedTask], nextCursor: "next" })
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseRefetch = resolve;
          }),
      );
    await renderInRouter(
      <>
        <TasksPage agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByRole("link", { name: completedTask.title })).toBeTruthy();
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => {
      void currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[0]?.cursor).toBeUndefined();
    await act(async () => {
      releaseRefetch({ tasks: [completedTask], nextCursor: "next" });
    });
  });

  it("keeps a terminal task refusal across a later 503 and a remount until an authorized success", async () => {
    vi.spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [completedTask], nextCursor: null })
      .mockRejectedValueOnce(new ApiError(403, "Refused"))
      .mockRejectedValueOnce(new ApiError(503, "Temporary outage"))
      .mockResolvedValue({ tasks: [completedTask], nextCursor: null });
    const view = await renderInRouter(
      <>
        <TasksPage agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText(completedTask.title)).toBeTruthy();
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    await waitFor(() => expect(screen.queryByText(completedTask.title)).toBeNull());
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    expect(screen.queryByText(completedTask.title)).toBeNull();
    expect(screen.queryByText("Temporary outage")).toBeNull();

    view.rerender(
      <>
        <TasksPage agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(screen.queryByText(completedTask.title)).toBeNull();

    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    expect(await screen.findByText(completedTask.title)).toBeTruthy();
  });

  it("keeps previous tasks on a transient refresh failure and offers recovery", async () => {
    vi.spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [completedTask], nextCursor: null })
      .mockRejectedValueOnce(new ApiError(503, "Temporary outage"));
    await renderInRouter(
      <>
        <TasksPage agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText(completedTask.title)).toBeTruthy();
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.tasks.byAgent(agentId) });
    });
    expect(await screen.findByText("Update failed. Showing last available data.")).toBeTruthy();
    expect(screen.getByText(completedTask.title)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("rereads task details on focus", async () => {
    const request = vi.spyOn(browserApi, "task").mockResolvedValue(detail);
    await renderInRouter(<TaskDetailPage taskId={sessionId} />);
    expect(await screen.findByText(completedTask.title)).toBeTruthy();
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(request.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("reuses a valid 30-day list summary on the home card and does not seed the detail cache", async () => {
    vi.spyOn(browserApi, "agents").mockResolvedValue({
      agents: [{ ...agentDetail, usage: { windowDays: 30, tasks: 32, failed: 0, tokens: 428_000 } }],
    });
    const usageRead = vi.spyOn(browserApi, "agentUsage");
    await renderInRouter(
      <>
        <AgentUsageOverview accountId={accountId} agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText("428K")).toBeTruthy();
    expect(usageRead).not.toHaveBeenCalled();
    expect(currentClient.getQueryData(queryKeys.agents.usage(agentId, 30))).toBeUndefined();
  });

  it("still reads full usage for other windows and the usage page", async () => {
    const usageRead = vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);
    await renderInRouter(<AgentUsageTab agentId={agentId} />);
    expect(await screen.findByText("428K")).toBeTruthy();
    expect(usageRead).toHaveBeenCalledWith(agentId, 30);
  });

  it("keeps a terminal usage refusal across a later 503 until recovery", async () => {
    vi.spyOn(browserApi, "agentUsage")
      .mockResolvedValueOnce(usage)
      .mockRejectedValueOnce(new ApiError(403, "Refused"))
      .mockRejectedValueOnce(new ApiError(503, "Temporary outage"))
      .mockResolvedValue(usage);
    await renderInRouter(
      <>
        <AgentUsageOverview agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText("428K")).toBeTruthy();
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.agents.usage(agentId, 30) });
    });
    await waitFor(() => expect(screen.queryByText("428K")).toBeNull());
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.agents.usage(agentId, 30) });
    });
    expect(screen.queryByText("428K")).toBeNull();
    await act(async () => {
      await currentClient.refetchQueries({ queryKey: queryKeys.agents.usage(agentId, 30) });
    });
    expect(await screen.findByText("428K")).toBeTruthy();
  });

  it("does not replace a more recent full usage answer with older list totals", async () => {
    const listResult = {
      agents: [{ ...agentDetail, usage: { windowDays: 30 as const, tasks: 7, failed: 0, tokens: 100_000 } }],
    };
    vi.spyOn(browserApi, "agents").mockResolvedValue(listResult);
    vi.spyOn(browserApi, "agentUsage").mockResolvedValue(usage);
    const view = await renderInRouter(<CaptureClient />);
    currentClient.setQueryData(queryKeys.agents.list(accountId), listResult, { updatedAt: Date.now() - 1_000 });
    currentClient.setQueryData(queryKeys.agents.usage(agentId, 30), usage);
    view.rerender(
      <>
        <AgentUsageOverview accountId={accountId} agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText("428K")).toBeTruthy();
    expect(screen.queryByText("100K")).toBeNull();
  });

  it("does not restore usage withdrawn by a newer forbidden response from older list totals", async () => {
    const listResult = {
      agents: [{ ...agentDetail, usage: { windowDays: 30 as const, tasks: 7, failed: 0, tokens: 100_000 } }],
    };
    vi.spyOn(browserApi, "agents").mockResolvedValue(listResult);
    vi.spyOn(browserApi, "agentUsage").mockRejectedValue(new ApiError(403, "Usage access removed"));
    const view = await renderInRouter(<CaptureClient />);
    currentClient.setQueryData(queryKeys.agents.list(accountId), listResult, { updatedAt: Date.now() - 1_000 });
    await currentClient
      .fetchQuery({
        queryKey: queryKeys.agents.usage(agentId, 30),
        queryFn: () => browserApi.agentUsage(agentId, 30),
      })
      .catch(() => undefined);
    view.rerender(
      <>
        <AgentUsageOverview accountId={accountId} agentId={agentId} />
        <CaptureClient />
      </>,
    );
    expect(await screen.findByText("Usage access removed")).toBeTruthy();
    expect(screen.queryByText("100K")).toBeNull();
  });

  it("does not treat setQueryData as an authorized read that retires a task refusal", async () => {
    const view = await renderInRouter(<CaptureClient />);
    const key = queryKeys.tasks.byAgent(agentId);
    const cached = { pages: [{ tasks: [completedTask], nextCursor: null }], pageParams: [undefined] };
    currentClient.setQueryData(key, cached);
    await currentClient
      .fetchQuery({
        queryKey: key,
        queryFn: async () => {
          throw new ApiError(403, "Task access removed");
        },
      })
      .catch(() => undefined);
    currentClient.setQueryData(key, cached);
    vi.spyOn(browserApi, "tasks").mockRejectedValue(new ApiError(503, "No current answer"));
    view.rerender(
      <>
        <AgentTasksSection agentId={agentId} />
        <CaptureClient />
      </>,
    );
    await waitFor(() => expect(screen.queryByText(completedTask.title)).toBeNull());
  });
});

describe("session fencing and mutation sync", () => {
  it("drops a late imperative read after the session is cleared", async () => {
    const client = createQueryClient();
    let settle!: (value: { computers: AccountComputerSummary[] }) => void;
    const pending = new Promise<{ computers: AccountComputerSummary[] }>((resolve) => {
      settle = resolve;
    });
    const read = fetchSharedResource(client, {
      queryKey: queryKeys.computers(),
      queryFn: () => pending,
      staleTime: 0,
    });
    client.clear();
    settle({ computers: [computer] });
    await expect(read).rejects.toThrow();
    expect(client.getQueryData(queryKeys.computers())).toBeUndefined();
  });

  it("does not let an old Account read evict a new Account result for the same key", async () => {
    const client = createQueryClient();
    let resolveOld!: (value: { computers: string[] }) => void;
    const oldNetwork = new Promise<{ computers: string[] }>((resolve) => {
      resolveOld = resolve;
    });
    const key = ["computers", "session-race"];
    const oldResult = fetchSharedResource(client, { queryKey: key, queryFn: () => oldNetwork }).catch(
      (error: unknown) => error,
    );
    client.clear();
    client.setQueryData(key, { computers: ["new-account-computer"] });
    resolveOld({ computers: ["old-account-computer"] });
    await oldResult;
    expect(client.getQueryData(key)).toEqual({ computers: ["new-account-computer"] });
    client.clear();
  });

  it("invalidates the Agent list and the Agent prefix once after a mutation", async () => {
    const client = createQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await syncAgentQueries(client, agentId, { computers: true });
    expect(invalidate.mock.calls.map(([input]) => input?.queryKey)).toEqual([
      queryKeys.agents.listRoot(),
      queryKeys.agents.all(agentId),
      queryKeys.computers(),
    ]);
  });
});
