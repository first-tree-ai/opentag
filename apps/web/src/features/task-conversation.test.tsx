import type { TaskSummary, TaskTurn } from "@opentag/shared/browser";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { TaskActivity } from "./task-conversation.js";

const task: TaskSummary = {
  id: "task",
  agent: { id: "agent", name: "atlas", displayName: "Atlas", runtimeProvider: "codex" },
  source: { provider: "feishu", conversationKind: "dm", channelId: "chat", threadKey: null },
  sessionKind: "channel",
  title: "Review",
  status: "completed",
  createdAt: "2026-09-21T00:00:00Z",
  endedAt: null,
  lastActivityAt: "2026-09-21T00:10:00Z",
};
function turn(): TaskTurn {
  return {
    deliveryId: "delivery",
    attention: "direct",
    delivery: {
      state: "accepted",
      attemptCount: 1,
      acceptedAt: task.createdAt,
      steeredAt: null,
      expiresAt: task.lastActivityAt,
      reason: null,
      lastErrorCode: null,
    },
    message: {
      id: "request",
      externalMessageId: "external",
      operation: "created",
      authorKind: "human",
      authorDisplayName: "Mia",
      fallbackText: "Review this",
      truncated: false,
      occurredAt: task.createdAt,
    },
    absorbedBy: null,
    report: {
      turnId: "turn",
      outcome: "completed",
      executionEffects: "completed",
      finalText: "Review finished",
      errorReason: null,
      usage: null,
      traceSummary: { lastSequence: 0, droppedEvents: 0 },
      outgoingReplies: {
        status: "complete",
        replies: [
          {
            provider: "feishu",
            teamBrand: "lark",
            messageId: "sent",
            chatId: "chat",
            content: { msgType: "text", text: "Here is the review" },
          },
        ],
      },
      reportedAt: task.lastActivityAt,
    },
  };
}

it("keeps an expanded summary open across refresh, duplicate pages and prepended history", () => {
  const current = turn();
  const view = render(<TaskActivity task={task} turns={[current]} pagination={null} />);
  expect(screen.queryByText("Review finished")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Execution summary" }));
  expect(screen.getByText("Review finished")).toBeTruthy();
  const earlier = turn();
  earlier.deliveryId = "earlier";
  earlier.message = { ...earlier.message, id: "earlier", occurredAt: "2026-09-20T23:00:00Z" };
  earlier.absorbedBy = { deliveryId: current.deliveryId, turnId: "turn" };
  earlier.report = null;
  view.rerender(
    <TaskActivity
      task={task}
      turns={[earlier, structuredClone(current), structuredClone(current)]}
      pagination={null}
    />,
  );
  expect(screen.getByText("Review finished")).toBeTruthy();
  expect(screen.getAllByText("Here is the review")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Execution summary" }).getAttribute("aria-expanded")).toBe("true");
});

it("keeps incomplete capture, truncation and execution failure visible beside a collapsed summary", () => {
  const current = turn();
  if (!current.report?.outgoingReplies) throw new Error("Expected capture fixture");
  current.report.outcome = "failed";
  current.report.errorReason = "provider_failed";
  current.report.outgoingReplies.status = "incomplete";
  current.report.outgoingReplies.runtimeSummaryTruncated = true;
  render(<TaskActivity task={task} turns={[current]} pagination={null} />);
  expect(screen.queryByText("Review finished")).toBeNull();
  expect(screen.getByText("Here is the review")).toBeTruthy();
  expect(screen.getByText("Provider failed")).toBeTruthy();
  expect(screen.getByText("Execution summary was truncated.")).toBeTruthy();
  expect(screen.getByText("Reply history is incomplete. Some messages or content could not be included.")).toBeTruthy();
});

it("explains a rejected restore in the work record without exposing resource controls", () => {
  const current = turn();
  current.report = null;
  current.delivery.state = "terminal_rejected";
  current.delivery.reason = "restore_required";
  render(<TaskActivity task={task} turns={[current]} pagination={null} />);

  expect(screen.getByText("Saved progress could not be restored. This request could not continue.")).toBeTruthy();
  expect(screen.queryByText("restore_required")).toBeNull();
  expect(screen.queryByRole("button", { name: /release|discard|restore/i })).toBeNull();
});

it("explains a reported resume failure as lost continuity in the existing execution record", () => {
  const current = turn();
  if (!current.report) throw new Error("Expected report fixture");
  current.report.outcome = "failed";
  current.report.errorReason = "session_resume_failed";
  render(<TaskActivity task={task} turns={[current]} pagination={null} />);

  expect(screen.getByText("Previous execution progress could not be resumed.")).toBeTruthy();
  expect(screen.queryByText("session_resume_failed")).toBeNull();
});

it("keeps resource preparation behind the ordinary waiting status", () => {
  const current = turn();
  current.report = null;
  current.delivery.state = "pending";
  current.delivery.lastErrorCode = "IM_DELIVERY_CLOUD_ALLOCATION_FAILED";
  render(<TaskActivity task={task} turns={[current]} pagination={null} />);

  expect(screen.getByText("Message pending.")).toBeTruthy();
  expect(screen.queryByText(/IM_DELIVERY_CLOUD|Runner|Sandbox|environment preparation/i)).toBeNull();
});

it.each([0, 3])("shows the incomplete-history notice only when replies were omitted (count: %i)", (omittedCount) => {
  const current = turn();
  if (!current.report?.outgoingReplies) throw new Error("Expected capture fixture");
  current.report.outgoingReplies.omittedCount = omittedCount;
  render(<TaskActivity task={task} turns={[current]} pagination={null} />);

  expect(screen.queryByText("Review finished")).toBeNull();
  expect(screen.getByText("Here is the review")).toBeTruthy();
  expect(screen.queryAllByText(/Reply history is incomplete/)).toHaveLength(omittedCount > 0 ? 1 : 0);
});

it("renders attachment-only input with names, types and availability without an empty text placeholder", () => {
  const current = turn();
  current.message.fallbackText = "";
  current.message.truncated = true;
  current.message.attachments = [
    {
      kind: "file",
      filename: "requirements.pdf",
      mediaType: "application/pdf",
      sizeBytes: 1234,
      availability: "available",
    },
    { kind: "image", filename: "diagram.png", mediaType: "image/png", sizeBytes: null, availability: "too_large" },
    { kind: "audio", filename: null, mediaType: null, sizeBytes: null, availability: "unavailable" },
    { kind: "video", filename: "demo.mov", mediaType: null, sizeBytes: null, availability: "unsupported" },
  ];
  render(<TaskActivity task={task} turns={[current]} pagination={null} />);
  expect(screen.getByRole("list", { name: "Attachments" })).toBeTruthy();
  expect(screen.getByText("File · requirements.pdf")).toBeTruthy();
  expect(screen.getByText("Image · diagram.png")).toBeTruthy();
  expect(screen.getByText("Attachment exceeds the processing size limit.")).toBeTruthy();
  expect(screen.getByText("Attachment unavailable.")).toBeTruthy();
  expect(screen.getByText("This attachment type is not supported.")).toBeTruthy();
  expect(screen.getByText("This message was truncated.")).toBeTruthy();
  expect(screen.queryByText("No text content")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
