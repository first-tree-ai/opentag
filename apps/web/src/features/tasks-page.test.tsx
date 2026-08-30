import type { TaskDetail, TaskSummary } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { browserApi } from "../api.js";
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
