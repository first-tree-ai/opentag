import type { TaskDetail, TaskSummary } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { queryKeys } from "../query/keys.js";
import { TaskDetailPage, TasksPage } from "./tasks-page.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const task = {
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
  status: "completed",
  createdAt: "2026-08-27T01:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-08-27T02:00:00.000Z",
} satisfies TaskSummary;

const detail = {
  task,
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
        reportedAt: "2026-08-27T02:00:00.000Z",
      },
    },
  ],
  internalSessions: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      createdBySessionId: sessionId,
      createdAt: "2026-08-27T01:10:00.000Z",
      endedAt: null,
      runtimeModel: "gpt-5",
      runtimeReasoningEffort: null,
    },
  ],
  collaborationMessages: [],
  nextCursor: null,
} satisfies TaskDetail;

function RefreshTaskButton() {
  const queryClient = useQueryClient();
  return (
    <button
      type="button"
      onClick={() => void queryClient.refetchQueries({ queryKey: queryKeys.tasks.detail(sessionId) })}
    >
      Refresh Task
    </button>
  );
}

function RefreshTasksButton() {
  const queryClient = useQueryClient();
  return (
    <button type="button" onClick={() => void queryClient.refetchQueries({ queryKey: queryKeys.tasks.list() })}>
      Refresh Tasks
    </button>
  );
}

afterEach(() => vi.restoreAllMocks());

describe("Tasks debug view", () => {
  it("loads stored Tasks and filters them locally", async () => {
    const second = {
      ...task,
      id: "66666666-6666-4666-8666-666666666666",
      title: "Review onboarding",
      status: "failed",
      agent: { ...task.agent, id: "77777777-7777-4777-8777-777777777777", displayName: "Scout" },
    } satisfies TaskSummary;
    vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [task, second], nextCursor: null });

    await renderInRouter(<TasksPage />);

    expect(await screen.findByRole("table", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Tasks table" }).tabIndex).toBe(0);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("Read-only debug view")).toBeTruthy();
    expect(screen.queryByText("Demo data")).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Filter by status" }));
    const failedOption = await screen.findByRole("option", { name: "Failed" });
    fireEvent.pointerMove(failedOption, { pointerType: "mouse" });
    fireEvent.pointerDown(failedOption, { pointerType: "mouse" });
    fireEvent.pointerUp(failedOption, { pointerType: "mouse" });
    fireEvent.click(failedOption);
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.getByText("Review onboarding")).toBeTruthy();
    expect(screen.queryByText("Investigate the failed deployment")).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Filter by status" }));
    const allStatusesOption = await screen.findByRole("option", { name: "All statuses" });
    fireEvent.pointerMove(allStatusesOption, { pointerType: "mouse" });
    fireEvent.pointerDown(allStatusesOption, { pointerType: "mouse" });
    fireEvent.pointerUp(allStatusesOption, { pointerType: "mouse" });
    fireEvent.click(allStatusesOption);
    fireEvent.change(screen.getByLabelText("Search Tasks"), { target: { value: sessionId } });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("Investigate the failed deployment")).toBeTruthy();
  });

  it("keeps the loaded rows and retries a failed page append", async () => {
    const second = {
      ...task,
      id: "66666666-6666-4666-8666-666666666666",
      title: "Review onboarding",
    } satisfies TaskSummary;
    const taskRequest = vi
      .spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "next-page" })
      .mockRejectedValueOnce(new Error("Temporary pagination failure"))
      .mockResolvedValueOnce({ tasks: [second], nextCursor: null });

    await renderInRouter(<TasksPage />);
    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(taskRequest).toHaveBeenCalledTimes(2);
    expect(await screen.findByText("Temporary pagination failure")).toBeTruthy();
    expect(screen.getByRole("link", { name: task.title })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: second.title })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(taskRequest).toHaveBeenLastCalledWith({ cursor: "next-page" });
  });

  it("retries an initial Tasks load after displaying the request error", async () => {
    const taskRequest = vi
      .spyOn(browserApi, "tasks")
      .mockRejectedValueOnce(new Error("Temporary initial load failure"))
      .mockResolvedValueOnce({ tasks: [task], nextCursor: null });

    await renderInRouter(<TasksPage />);

    expect(await screen.findByText("Temporary initial load failure")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();
    expect(taskRequest).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it.each([401, 403])("surfaces a terminal Tasks list refetch error instead of cached rows (%d)", async (status) => {
    const taskRequest = vi
      .spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [task], nextCursor: null })
      .mockRejectedValueOnce(new ApiError(status, `Tasks forbidden (${status})`));

    await renderInRouter(
      <>
        <TasksPage />
        <RefreshTasksButton />
      </>,
    );

    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Tasks" }));

    expect(await screen.findByRole("heading", { name: "Tasks unavailable" })).toBeTruthy();
    expect(screen.getByText(`Tasks forbidden (${status})`)).toBeTruthy();
    expect(screen.queryByRole("link", { name: task.title })).toBeNull();
    expect(taskRequest).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 410])("withdraws the loaded rows when a page append is refused (%d)", async (status) => {
    vi.spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "next-page" })
      .mockRejectedValueOnce(new ApiError(status, `Tasks forbidden (${status})`));

    await renderInRouter(<TasksPage />);
    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    // Which page asked does not change what the status means: the rows already read are exactly
    // what a refusal withdraws, so they must not survive behind an inline note beside the button.
    expect(await screen.findByRole("heading", { name: "Tasks unavailable" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: task.title })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps a non-terminal page append failure beside the rows it could not extend", async () => {
    vi.spyOn(browserApi, "tasks")
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "next-page" })
      .mockRejectedValueOnce(new ApiError(503, "Tasks temporarily unavailable"));

    await renderInRouter(<TasksPage />);
    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Tasks temporarily unavailable")).toBeTruthy();
    expect(screen.getByRole("link", { name: task.title })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Tasks unavailable" })).toBeNull();
  });

  it.each([401, 403, 404, 410])(
    "stops offering the Agent filter built from rows a terminal response withdrew (%d)",
    async (status) => {
      vi.spyOn(browserApi, "tasks")
        .mockResolvedValueOnce({ tasks: [task], nextCursor: null })
        .mockRejectedValueOnce(new ApiError(status, `Tasks forbidden (${status})`));

      await renderInRouter(
        <>
          <TasksPage />
          <RefreshTasksButton />
        </>,
      );
      expect(await screen.findByRole("combobox", { name: "Filter by Agent" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Refresh Tasks" }));

      // The Agent options are Agent names read off the withdrawn rows, so the toolbar has to go
      // with them rather than keep naming Agents from a list the Server has just refused.
      expect(await screen.findByRole("heading", { name: "Tasks unavailable" })).toBeTruthy();
      expect(screen.queryByRole("combobox", { name: "Filter by Agent" })).toBeNull();
      expect(document.body.textContent).not.toContain(task.agent.displayName);
    },
  );

  it("renders the stored inbound message and runtime report without claiming an outbound record", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detail);
    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    const conversation = await screen.findByLabelText("Task conversation");
    expect(within(conversation).getByText("Please investigate the failed deployment.")).toBeTruthy();
    expect(
      within(conversation).getByText("The runtime finished and the provider reply was sent separately."),
    ).toBeTruthy();
    expect(screen.getByText(/Provider outbound messages and detailed tool traces are not captured/)).toBeTruthy();
    expect(screen.getByText(/Internal collaboration · 1 Sessions/)).toBeTruthy();

    fireEvent.click(within(conversation).getByText("Runtime details"));
    expect(
      within(conversation).getByText("1 attempt · Outcome completed · Effects completed · 150 tokens · 4 trace events"),
    ).toBeTruthy();
    expect(screen.getByLabelText("Copy Session")).toBeTruthy();
  });

  it("surfaces a terminal detail refetch error instead of showing cached Task data", async () => {
    const taskRequest = vi
      .spyOn(browserApi, "task")
      .mockResolvedValueOnce(detail)
      .mockRejectedValueOnce(new ApiError(404, "Task not found"));

    await renderInRouter(
      <>
        <TaskDetailPage taskId={sessionId} />
        <RefreshTaskButton />
      </>,
      { path: `/tasks/${sessionId}` },
    );

    expect(await screen.findByRole("heading", { name: task.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Task" }));
    expect(await screen.findByRole("heading", { name: "Task not found" })).toBeTruthy();
    expect(screen.queryByText("The runtime finished and the provider reply was sent separately.")).toBeNull();
    expect(taskRequest).toHaveBeenCalledTimes(2);
  });

  it("renders a steered input as absorbed without a second report or usage", async () => {
    const root = detail.turns[0];
    if (!root) throw new Error("Expected the Task fixture to include a root Turn");
    const steered = {
      ...root,
      deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      delivery: {
        ...root.delivery,
        state: "steered" as const,
        acceptedAt: null,
        steeredAt: "2026-08-27T01:30:00.000Z",
      },
      message: {
        ...root.message,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        externalMessageId: "om_steered",
        fallbackText: "Use the newer requirement.",
      },
      absorbedBy: { deliveryId: root.deliveryId, turnId: root.report?.turnId ?? "turn-debug" },
      report: null,
    } satisfies TaskDetail["turns"][number];
    vi.spyOn(browserApi, "task").mockResolvedValue({ ...detail, turns: [steered, root] });
    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    const conversation = await screen.findByLabelText("Task conversation");
    expect(within(conversation).getByText("This input was steered into the active Turn.")).toBeTruthy();
    expect(within(conversation).getByText("absorbed into running Turn")).toBeTruthy();
    expect(within(conversation).getAllByText(/150 tokens/)).toHaveLength(1);
  });

  it("loads older Turns from the detail cursor", async () => {
    const firstPage = { ...detail, nextCursor: "older-turns" } satisfies TaskDetail;
    const baseTurn = detail.turns[0];
    if (!baseTurn) throw new Error("Expected the Task fixture to include a Turn");
    const olderTurn = {
      ...baseTurn,
      deliveryId: "88888888-8888-4888-8888-888888888888",
      message: {
        ...baseTurn.message,
        id: "99999999-9999-4999-8999-999999999999",
        externalMessageId: "om_older",
        fallbackText: "This is an older inbound message.",
      },
    } satisfies TaskDetail["turns"][number];
    const taskRequest = vi
      .spyOn(browserApi, "task")
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce({ ...detail, turns: [olderTurn], nextCursor: null });
    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    fireEvent.click(await screen.findByRole("button", { name: "Load more Turns" }));
    expect(await screen.findByText("This is an older inbound message.")).toBeTruthy();
    expect(taskRequest).toHaveBeenLastCalledWith(sessionId, "older-turns");
    expect(screen.queryByRole("button", { name: "Load more Turns" })).toBeNull();
  });

  it.each(["success", "error"] as const)(
    "ignores a delayed Task A append %s after switching to Task B",
    async (outcome) => {
      const firstPage = { ...detail, nextCursor: "older-turns" } satisfies TaskDetail;
      const secondTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const secondDetail = {
        ...detail,
        task: { ...detail.task, id: secondTaskId, title: "Task B" },
        nextCursor: "task-b-older-turns",
      } satisfies TaskDetail;
      const baseTurn = detail.turns[0];
      if (!baseTurn) throw new Error("Expected the Task fixture to include a Turn");
      const staleTurn = {
        ...baseTurn,
        deliveryId: "88888888-8888-4888-8888-888888888888",
        message: {
          ...baseTurn.message,
          id: "99999999-9999-4999-8999-999999999999",
          externalMessageId: "om_stale",
          fallbackText: "Stale Task A Turn",
        },
      } satisfies TaskDetail["turns"][number];
      let resolveTaskA: (value: TaskDetail) => void = () => undefined;
      let rejectTaskA: (reason: Error) => void = () => undefined;
      vi.spyOn(browserApi, "task").mockImplementation((requestedTaskId, cursor) => {
        if (requestedTaskId === sessionId && !cursor) return Promise.resolve(firstPage);
        if (requestedTaskId === sessionId && cursor === "older-turns") {
          return new Promise((resolve, reject) => {
            resolveTaskA = resolve;
            rejectTaskA = reject;
          });
        }
        if (requestedTaskId === secondTaskId && !cursor) return Promise.resolve(secondDetail);
        return Promise.reject(new Error("Unexpected Task request"));
      });

      const view = await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
      fireEvent.click(await screen.findByRole("button", { name: "Load more Turns" }));

      view.rerender(<TaskDetailPage taskId={secondTaskId} />);
      expect(await screen.findByRole("heading", { name: "Task B" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Load more Turns" }) as HTMLButtonElement).disabled).toBe(false);

      await act(async () => {
        if (outcome === "success") {
          resolveTaskA({ ...detail, turns: [staleTurn], nextCursor: null });
        } else {
          rejectTaskA(new Error("Stale Task A pagination failure"));
        }
      });

      expect(screen.getByRole("heading", { name: "Task B" })).toBeTruthy();
      expect(screen.queryByText("Stale Task A Turn")).toBeNull();
      expect(screen.queryByText("Stale Task A pagination failure")).toBeNull();
    },
  );

  it.each([401, 403, 404, 410])("withdraws the conversation when a Turn append is refused (%d)", async (status) => {
    const firstPage = { ...detail, nextCursor: "older-turns" } satisfies TaskDetail;
    vi.spyOn(browserApi, "task")
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new ApiError(status, `Task refused (${status})`));

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Load more Turns" }));

    // The Server resolves the Task before it parses a cursor, so a terminal status on an append is
    // about the Task itself. The stored output must not stay on screen behind an inline note.
    expect(
      await screen.findByRole("heading", { name: status === 404 ? "Task not found" : "Task unavailable" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Stored runtime final output" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more Turns" })).toBeNull();
  });

  it("clears a Task append error when taskId changes", async () => {
    const firstPage = { ...detail, nextCursor: "older-turns" } satisfies TaskDetail;
    const secondTaskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const secondDetail = {
      ...detail,
      task: { ...detail.task, id: secondTaskId, title: "Task B" },
      nextCursor: null,
    } satisfies TaskDetail;
    vi.spyOn(browserApi, "task")
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error("Task A pagination failure"))
      .mockResolvedValueOnce(secondDetail);

    const view = await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Load more Turns" }));
    expect(await screen.findByText("Task A pagination failure")).toBeTruthy();

    view.rerender(<TaskDetailPage taskId={secondTaskId} />);
    expect(await screen.findByRole("heading", { name: "Task B" })).toBeTruthy();
    expect(screen.queryByText("Task A pagination failure")).toBeNull();
  });

  it("shows loading and empty states from the API", async () => {
    let resolve: (value: { tasks: []; nextCursor: null }) => void = () => undefined;
    vi.spyOn(browserApi, "tasks").mockReturnValue(
      new Promise((next) => {
        resolve = next;
      }),
    );
    await renderInRouter(<TasksPage />);

    expect(screen.getByRole("heading", { name: "Loading Tasks" })).toBeTruthy();
    resolve({ tasks: [], nextCursor: null });
    await waitFor(() => expect(screen.getByRole("heading", { name: "No Tasks found" })).toBeTruthy());
  });
});
