import type { TaskDetail, TaskSummary } from "@opentag/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { queryKeys } from "../query/keys.js";
import { AgentTasksSection, TaskDetailPage, TasksPage } from "./tasks-page.js";

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

describe("Tasks view", () => {
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
    expect(screen.getByRole("columnheader", { name: "Task" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Agent" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Last activity" })).toBeTruthy();
    expect(screen.queryByText("Read-only debug view")).toBeNull();
    expect(screen.queryByText("Demo data")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit title" })).toBeNull();
    const toolbar = screen.getByRole("form", { name: "Filter Tasks" });
    expect(toolbar.outerHTML).toContain("@min-[48rem]/content:flex-row");
    expect(toolbar.outerHTML).toContain("@min-[36rem]/content:w-44");
    expect(toolbar.outerHTML).not.toContain("/workspace");

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

  it("renders a read-only activity record without exposing diagnostics", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detail);
    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Please investigate the failed deployment.")).toBeTruthy();
    expect(within(activity).getByText("The runtime finished and the provider reply was sent separately.")).toBeTruthy();
    expect(screen.getByLabelText("Task details").textContent).toContain("Atlas");
    expect(screen.queryByText(/Provider outbound messages and detailed tool traces/)).toBeNull();
    expect(screen.queryByText(/Internal collaboration/)).toBeNull();
    expect(screen.queryByText("Runtime details")).toBeNull();
    expect(screen.queryByText(/150 tokens/)).toBeNull();
  });

  it("keeps generated Task titles read-only and separates useful list metadata into columns", async () => {
    vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [task], nextCursor: null });

    await renderInRouter(<TasksPage />);
    const row = (await screen.findByRole("link", { name: task.title })).closest("tr");
    if (!row) throw new Error("Expected the Task link to be inside a row");
    expect(within(row).getByText(task.agent.displayName)).toBeTruthy();
    expect(within(row).getByText("Lark · Direct message")).toBeTruthy();
    expect(within(row).getByText("Completed")).toBeTruthy();
    expect(within(row).queryByLabelText(/^Completed, updated/u)).toBeNull();
    expect(within(row).queryByText(task.source.channelId)).toBeNull();
    expect(within(row).queryByRole("button", { name: "Edit title" })).toBeNull();
  });

  it("loads explicit development examples without replacing API-backed empty states", async () => {
    const taskRequest = vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [], nextCursor: null });

    const view = await renderInRouter(<TasksPage agentId={agentId} />);
    expect(await screen.findByRole("heading", { name: "No Tasks yet" })).toBeTruthy();
    expect(screen.getByText("Message this Agent in your chat app to put it to work.")).toBeTruthy();
    expect(screen.queryByText("Review Q3 launch readiness and flag unowned work")).toBeNull();
    expect(taskRequest).toHaveBeenCalledTimes(1);

    view.rerender(<TasksPage showExamples />);
    const example = await screen.findByRole("link", { name: "Review Q3 launch readiness and flag unowned work" });
    expect(screen.getByText("Showing local example Tasks because this Agent has no Task history yet.")).toBeTruthy();
    expect(example.getAttribute("href")).toBe("/tasks/10000000-0000-4000-8000-000000000001?examples=true");
    expect(taskRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps filtered empty results distinct from an Agent with no Tasks", async () => {
    vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [task], nextCursor: null });

    await renderInRouter(<TasksPage agentId={agentId} />);
    fireEvent.change(await screen.findByRole("searchbox", { name: "Search Tasks" }), {
      target: { value: "does not exist" },
    });

    expect(screen.getByRole("heading", { name: "No Tasks found" })).toBeTruthy();
    expect(screen.getByText("Try a different search or filter.")).toBeTruthy();
  });

  it("uses the local preview detail route without entering a synthetic Agent shell", async () => {
    const taskRequest = vi.spyOn(browserApi, "task");

    await renderInRouter(<TaskDetailPage showExamples taskId="10000000-0000-4000-8000-000000000001" />, {
      path: "/tasks/10000000-0000-4000-8000-000000000001?examples=true",
    });

    expect(
      await screen.findByRole("heading", { name: "Review Q3 launch readiness and flag unowned work" }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Tasks" }).getAttribute("href")).toBe("/tasks");
    expect(taskRequest).not.toHaveBeenCalled();
  });

  it("omits the repeated Agent column in an Agent-scoped Task list", async () => {
    vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [task], nextCursor: null });

    await renderInRouter(<TasksPage agentId={agentId} />);

    expect(await screen.findByRole("table", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Agent" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeTruthy();
    expect(screen.getByRole("link", { name: task.title }).closest("tr")?.className).toContain(
      "grid-cols-[minmax(0,1fr)_auto]",
    );
  });

  it("uses a user-facing author role when a sender name is unavailable", async () => {
    const root = detail.turns[0];
    if (!root) throw new Error("Expected the Task fixture to include a root Turn");
    vi.spyOn(browserApi, "task").mockResolvedValue({
      ...detail,
      turns: [{ ...root, message: { ...root.message, authorDisplayName: null } }],
    });

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(within(activity).getByText("User")).toBeTruthy();
    expect(within(activity).queryByText("Human")).toBeNull();
  });

  it("keeps the title alone and lists the status last among the Task details", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detail);

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    const heading = await screen.findByRole("heading", { name: task.title });
    expect(heading.parentElement?.textContent).toBe(task.title);
    const details = screen.getByLabelText("Task details");
    expect(
      within(details)
        .getAllByRole("term")
        .map((term) => term.textContent),
    ).toEqual(["Agent", "Source", "Started", "Last activity", "Status"]);
    expect(within(details).getByText("Completed")).toBeTruthy();
  });

  it("names a Turn failure for the reader instead of printing its reason code", async () => {
    const root = detail.turns[0];
    if (!root) throw new Error("Expected the Task fixture to include a root Turn");
    vi.spyOn(browserApi, "task").mockResolvedValue({
      ...detail,
      turns: [
        {
          ...root,
          report: {
            ...root.report,
            finalText: null,
            errorReason: "credential_unavailable",
            outcome: "failed" as const,
          },
        },
      ],
    });

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Credential unavailable")).toBeTruthy();
    expect(within(activity).queryByText("credential_unavailable")).toBeNull();
  });

  it("announces Task status separately from the last activity time", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detail);

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    expect(await screen.findByRole("heading", { name: task.title })).toBeTruthy();
    expect(screen.queryByLabelText(/^Completed, updated/u)).toBeNull();
    expect(screen.getByLabelText("Task details").textContent).toContain("Last activity");
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

    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(within(activity).getByText("This message was included in the Agent's active work.")).toBeTruthy();
    expect(within(activity).getByText("Added to active work")).toBeTruthy();
    expect(within(activity).queryByText(/150 tokens/)).toBeNull();
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

    fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));
    expect(await screen.findByText("This is an older inbound message.")).toBeTruthy();
    expect(taskRequest).toHaveBeenLastCalledWith(sessionId, "older-turns");
    expect(screen.queryByRole("button", { name: "Load earlier activity" })).toBeNull();
  });

  it("does not let a late page for one Agent land on another Agent's Tasks", async () => {
    const secondAgentId = "44444444-4444-4444-8444-444444444444";
    const secondTask = { ...task, id: "55555555-5555-4555-8555-555555555555", title: "Draft the release notes" };
    let releaseFirstPage: (value: { tasks: TaskSummary[]; nextCursor: string | null }) => void = () => undefined;
    vi.spyOn(browserApi, "tasks").mockImplementation((input = {}) => {
      if (input.cursor) {
        // The page requested for the first Agent, still in flight when the Agent changes.
        return new Promise((next) => {
          releaseFirstPage = next;
        });
      }
      return Promise.resolve(
        input.agentId === secondAgentId
          ? { tasks: [secondTask], nextCursor: null }
          : { tasks: [task], nextCursor: "next-page" },
      );
    });

    const view = await renderInRouter(<AgentTasksSection agentId={agentId} />);
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    view.rerender(<AgentTasksSection agentId={secondAgentId} />);
    expect(await screen.findByRole("link", { name: "Draft the release notes" })).toBeTruthy();

    releaseFirstPage({
      tasks: [{ ...task, id: "66666666-6666-4666-8666-666666666666", title: "Older Atlas Task" }],
      nextCursor: null,
    });
    await waitFor(() => expect(screen.getByRole("link", { name: "Draft the release notes" })).toBeTruthy());
    expect(screen.queryByText("Older Atlas Task")).toBeNull();
    expect(screen.queryByRole("link", { name: "Investigate the failed deployment" })).toBeNull();
  });

  it("does not let a late page land after the same Agent is loaded again", async () => {
    const otherAgentId = "77777777-7777-4777-8777-777777777777";
    let releaseFirstPage: (value: { tasks: TaskSummary[]; nextCursor: string | null }) => void = () => undefined;
    vi.spyOn(browserApi, "tasks").mockImplementation((input = {}) => {
      if (input.cursor) {
        return new Promise((next) => {
          releaseFirstPage = next;
        });
      }
      return Promise.resolve(
        input.agentId === otherAgentId ? { tasks: [], nextCursor: null } : { tasks: [task], nextCursor: "next-page" },
      );
    });

    const view = await renderInRouter(<AgentTasksSection agentId={agentId} />);
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    // Away and back: the Agent id is the same again, but the list underneath is a different load.
    view.rerender(<AgentTasksSection agentId={otherAgentId} />);
    view.rerender(<AgentTasksSection agentId="44444444-4444-4444-8444-444444444444" />);
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();

    releaseFirstPage({
      tasks: [{ ...task, id: "88888888-8888-4888-8888-888888888888", title: "STALE ROW" }],
      nextCursor: null,
    });
    await waitFor(() => expect(screen.getByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy());
    expect(screen.queryByTitle("STALE ROW")).toBeNull();
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
      fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));

      view.rerender(<TaskDetailPage taskId={secondTaskId} />);
      expect(await screen.findByRole("heading", { name: "Task B" })).toBeTruthy();
      expect((screen.getByRole("button", { name: "Load earlier activity" }) as HTMLButtonElement).disabled).toBe(false);

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
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));

    // The Server resolves the Task before it parses a cursor, so a terminal status on an append is
    // about the Task itself. The stored output must not stay on screen behind an inline note.
    expect(
      await screen.findByRole("heading", { name: status === 404 ? "Task not found" : "Task unavailable" }),
    ).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agent response" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load earlier activity" })).toBeNull();
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
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));
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
    await waitFor(() => expect(screen.getByRole("heading", { name: "No Tasks yet" })).toBeTruthy());
  });

  it("renders Agent Tasks loading, empty, append success, and append failure states", async () => {
    let release: (value: { tasks: TaskSummary[]; nextCursor: string | null }) => void = () => undefined;
    vi.spyOn(browserApi, "tasks").mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const view = await renderInRouter(<AgentTasksSection agentId={agentId} />);
    expect(screen.getByText("Loading Tasks…")).toBeTruthy();
    release({ tasks: [], nextCursor: null });
    expect(await screen.findByText("Message this Agent in your chat app to put it to work.")).toBeTruthy();

    vi.mocked(browserApi.tasks)
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "next" })
      .mockResolvedValueOnce({
        tasks: [{ ...task, id: "66666666-6666-4666-8666-666666666666", title: "Next Task" }],
        nextCursor: null,
      });
    view.rerender(<AgentTasksSection agentId="44444444-4444-4444-8444-444444444444" />);
    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("link", { name: "Next Task" })).toBeTruthy();

    vi.mocked(browserApi.tasks)
      .mockResolvedValueOnce({ tasks: [task], nextCursor: "retry" })
      .mockRejectedValueOnce(new Error("Agent append failed"));
    view.rerender(<AgentTasksSection agentId={agentId} />);
    expect(await screen.findByRole("link", { name: task.title })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Could not load more Tasks.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("reports when an Agent's Tasks cannot be loaded", async () => {
    vi.spyOn(browserApi, "tasks").mockRejectedValueOnce(new ApiError(503, "Tasks unavailable"));

    await renderInRouter(<AgentTasksSection agentId={agentId} />);

    expect(await screen.findByText("Tasks are temporarily unavailable.")).toBeTruthy();
  });

  it("renders missing, unavailable, and empty Task detail states", async () => {
    const view = await renderInRouter(<TaskDetailPage />, { path: "/tasks/missing" });
    expect(await screen.findByRole("heading", { name: "Task not found" })).toBeTruthy();
    expect(screen.getByText("Task not found")).toBeTruthy();

    vi.spyOn(browserApi, "task").mockRejectedValueOnce(new ApiError(404, "not found"));
    view.rerender(<TaskDetailPage taskId={sessionId} />);
    expect(await screen.findByText("This Task does not exist or is outside your Account.")).toBeTruthy();

    vi.mocked(browserApi.task).mockRejectedValueOnce(new Error("database unavailable"));
    view.rerender(<TaskDetailPage taskId="66666666-6666-4666-8666-666666666666" />);
    expect(await screen.findByRole("heading", { name: "Task unavailable" })).toBeTruthy();
    expect(screen.getByText("database unavailable")).toBeTruthy();

    vi.mocked(browserApi.task).mockResolvedValueOnce({
      ...detail,
      turns: [],
      internalSessions: [],
      collaborationMessages: [],
    });
    view.rerender(<TaskDetailPage taskId="77777777-7777-4777-8777-777777777777" />);
    expect(await screen.findByRole("heading", { name: "No activity recorded" })).toBeTruthy();
  });

  it("shows concise pending and failed states without internal collaboration details", async () => {
    const root = detail.turns[0];
    if (!root) throw new Error("Expected the Task fixture to include a root Turn");
    const pending = {
      ...root,
      deliveryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      delivery: { ...root.delivery, state: "accepted" as const, attemptCount: 2, reason: null, lastErrorCode: null },
      message: {
        ...root.message,
        id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        authorDisplayName: null,
        fallbackText: "",
      },
      report: null,
    } satisfies TaskDetail["turns"][number];
    const failed = {
      ...root,
      deliveryId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      delivery: {
        ...root.delivery,
        state: "terminal_rejected" as const,
        attemptCount: 3,
        reason: "Rejected by runtime",
        lastErrorCode: "RUNTIME_REJECTED",
      },
      message: { ...root.message, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fallbackText: "Rejected input" },
      report: {
        ...root.report,
        finalText: null,
        errorReason: "Provider failed",
        usage: null,
        traceSummary: { lastSequence: 0, droppedEvents: 2 },
        outcome: "failed" as const,
      },
    } satisfies TaskDetail["turns"][number];
    const collaboration = {
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      sourceSessionId: sessionId,
      targetSessionId: "55555555-5555-4555-8555-555555555555",
      content: "Please verify the deployment state.",
      outcome: "accepted" as const,
      attemptCount: 1,
      lastErrorCode: null,
      createdAt: "2026-08-27T01:20:00.000Z",
      updatedAt: "2026-08-27T01:21:00.000Z",
    };
    const firstSession = detail.internalSessions[0];
    if (!firstSession) throw new Error("Expected an internal session");
    vi.spyOn(browserApi, "task").mockResolvedValue({
      ...detail,
      turns: [pending, failed],
      internalSessions: [{ ...firstSession, endedAt: "2026-08-27T01:30:00.000Z", runtimeModel: null }],
      collaborationMessages: [collaboration],
    });
    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    const activity = await screen.findByRole("region", { name: "Activity" });
    expect(within(activity).getByText("Work is in progress.")).toBeTruthy();
    expect(within(activity).getByText("No text content")).toBeTruthy();
    expect(within(activity).getByText("Provider failed")).toBeTruthy();
    expect(within(activity).queryByText(/attempts/)).toBeNull();
    expect(screen.queryByText(/Internal collaboration/)).toBeNull();
    expect(screen.queryByText("Please verify the deployment state.")).toBeNull();
  });

  // The provider identifier is the Server's vocabulary, not a name anybody chose for a reader. These
  // two surfaces used to print it straight, which reads as the lowercase `feishu` today and would
  // silently name any future channel after whatever casing its id happened to carry.
  it("names the channel of a listed Task instead of printing its provider id", async () => {
    vi.spyOn(browserApi, "tasks").mockResolvedValue({ tasks: [task], nextCursor: null });

    const { container } = await renderInRouter(<TasksPage />);
    await screen.findByText("Investigate the failed deployment");

    const source = container.querySelector('[data-label="Source"]');
    expect(source?.textContent).toContain("Lark");
    expect(source?.textContent).not.toMatch(/feishu/);
  });

  it("names the channel of a Task's source instead of printing its provider id", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detail);

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });

    /*
     * Anchored on the Source fact rather than the page, because the guarantee is about one field:
     * the channel reads as the product name and the lowercase identifier never reaches the reader.
     * `not.toMatch` is case-sensitive, so it pins the raw id specifically rather than a substring.
     */
    const sourceTerm = await screen.findByText("Source");
    const sourceValue = sourceTerm.parentElement?.querySelector("dd");
    expect(sourceValue?.textContent).toContain("Lark");
    expect(sourceValue?.textContent).not.toMatch(/feishu/);
  });
});
