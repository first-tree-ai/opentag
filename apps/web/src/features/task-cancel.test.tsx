import type { TaskDetail, TaskSummary } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderInRouter } from "../__tests__/support/router.js";
import { ApiError, browserApi } from "../api.js";
import { TaskDetailPage } from "./tasks-page.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const queuedTask = {
  id: sessionId,
  agent: { id: agentId, name: "atlas", displayName: "Atlas", runtimeProvider: "codex" },
  source: { provider: "slack", conversationKind: "channel", channelId: "C123", threadKey: null },
  sessionKind: "channel",
  title: "Summarize the incident channel",
  status: "queued",
  createdAt: "2026-08-27T01:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-08-27T01:00:00.000Z",
} satisfies TaskSummary;

function detailFor(task: TaskSummary, delivery: Partial<TaskDetail["turns"][number]["delivery"]> = {}): TaskDetail {
  return {
    task,
    turns: [
      {
        deliveryId: "33333333-3333-4333-8333-333333333333",
        attention: "direct",
        delivery: {
          state: "pending",
          isRunning: false,
          attemptCount: 0,
          acceptedAt: null,
          steeredAt: null,
          expiresAt: "2026-08-28T01:00:00.000Z",
          reason: null,
          lastErrorCode: null,
          ...delivery,
        },
        message: {
          id: "44444444-4444-4444-8444-444444444444",
          externalMessageId: "1724720400.000100",
          operation: "created",
          authorKind: "human",
          authorDisplayName: "Mia Zhang",
          fallbackText: "Please summarize the incident channel.",
          truncated: false,
          occurredAt: "2026-08-27T01:00:00.000Z",
        },
        absorbedBy: null,
        report: null,
      },
    ],
    internalSessions: [],
    collaborationMessages: [],
    nextCursor: null,
  };
}

async function openConfirmation() {
  fireEvent.click(await screen.findByRole("button", { name: "Cancel queued Task" }));
  return screen.findByRole("alertdialog", { name: "Cancel this Task?" });
}

afterEach(() => vi.restoreAllMocks());

describe("Cancelling a queued Task", () => {
  it("cancels from the detail page and shows the refreshed status without a reload", async () => {
    const cancelled = { ...queuedTask, status: "cancelled" as const };
    vi.spyOn(browserApi, "task")
      .mockResolvedValueOnce(detailFor(queuedTask))
      .mockResolvedValue(detailFor(cancelled, { state: "expired", reason: "cancelled" }));
    const cancel = vi.spyOn(browserApi, "cancelTask").mockResolvedValue(cancelled);

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    expect(await screen.findByText("Queued")).toBeTruthy();
    const dialog = await openConfirmation();
    expect(within(dialog).getByText(/will not be delivered to the Agent/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Task" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(sessionId));
    expect((await screen.findByRole("status")).textContent).toContain("The Task was cancelled.");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const details = screen.getByLabelText("Task details");
    await waitFor(() => expect(within(details).getByText("Cancelled")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Cancel queued Task" })).toBeNull();
    // The withdrawn Turn arrives with the revalidation the cancel triggered.
    const activity = await screen.findByRole("region", { name: "Activity" });
    await waitFor(() => expect(within(activity).getByText("Message cancelled.")).toBeTruthy());
  });

  it("refreshes the Task instead of failing when it is no longer queued", async () => {
    const running = { ...queuedTask, status: "running" as const };
    vi.spyOn(browserApi, "task")
      .mockResolvedValueOnce(detailFor(queuedTask))
      .mockResolvedValue(detailFor(running, { state: "accepted", isRunning: true, acceptedAt: running.createdAt }));
    vi.spyOn(browserApi, "cancelTask").mockRejectedValue(new ApiError(409, "The Task is running", "TASK_NOT_QUEUED"));

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Task" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "This Task is no longer queued. Its status has been refreshed.",
    );
    const details = screen.getByLabelText("Task details");
    await waitFor(() => expect(within(details).getByText("Running")).toBeTruthy());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel queued Task" })).toBeNull();
  });

  it("does not announce a cancel the Server's answer says still reads as queued", async () => {
    // A Server that withdrew part of the queue and answered 200 with the rest still pending.
    vi.spyOn(browserApi, "task").mockResolvedValue(detailFor(queuedTask));
    vi.spyOn(browserApi, "cancelTask").mockResolvedValue({ ...queuedTask, status: "queued" });

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Task" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "This Task could not be cancelled yet: its queued message is being delivered or awaiting confirmation.",
    );
    expect(screen.queryByText("The Task was cancelled.")).toBeNull();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(within(screen.getByLabelText("Task details")).getByText("Queued")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel queued Task" })).toBeTruthy();
  });

  it("says the cancel did not happen when the queued message is already being delivered", async () => {
    // The Task stays queued: the worker holds its only pending delivery, which the Server left alone.
    vi.spyOn(browserApi, "task").mockResolvedValue(
      detailFor(queuedTask, { attemptCount: 1, lastErrorCode: "IM_DELIVERY_CLAIM_0123456789ABCDEF" }),
    );
    vi.spyOn(browserApi, "cancelTask").mockRejectedValue(
      new ApiError(409, "The Task's queued message is already being delivered", "TASK_NOT_QUEUED"),
    );

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Task" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "This Task could not be cancelled yet: its queued message is being delivered or awaiting confirmation.",
    );
    expect(screen.queryByText(/no longer queued/)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    const details = screen.getByLabelText("Task details");
    expect(within(details).getByText("Queued")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel queued Task" })).toBeTruthy();
  });

  it("keeps the confirmation open with the failure and lets the reader keep the Task queued", async () => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detailFor(queuedTask));
    const cancel = vi
      .spyOn(browserApi, "cancelTask")
      .mockRejectedValue(new ApiError(503, "The Server is unavailable", "SERVICE_UNAVAILABLE"));

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    const dialog = await openConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel Task" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("The Server is unavailable");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Keep in queue" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByRole("button", { name: "Cancel queued Task" })).toBeTruthy();
    expect(screen.getByText("Queued")).toBeTruthy();
  });

  it.each(["running", "completed", "cancelled"] as const)("offers no cancel control to a %s Task", async (status) => {
    vi.spyOn(browserApi, "task").mockResolvedValue(detailFor({ ...queuedTask, status }));
    const cancel = vi.spyOn(browserApi, "cancelTask");

    await renderInRouter(<TaskDetailPage taskId={sessionId} />, { path: `/tasks/${sessionId}` });
    expect(await screen.findByLabelText("Task details")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel queued Task" })).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });
});
