import { describe, expect, it } from "vitest";
import {
  ListTasksResponseSchema,
  TASK_TITLE_MAX_LENGTH,
  TaskDetailSchema,
  TaskTitleUpdateRequestSchema,
  TaskTitleUpdateResponseSchema,
  taskByIdPath,
} from "../index.js";

const summary = {
  id: "11111111-1111-4111-8111-111111111111",
  agent: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "atlas",
    displayName: "Atlas",
    runtimeProvider: "codex",
  },
  source: { provider: "feishu", conversationKind: "dm", channelId: "oc_debug", threadKey: null },
  sessionKind: "channel",
  title: "Debug the latest Turn",
  status: "completed",
  createdAt: "2026-08-27T01:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-08-27T02:00:00.000Z",
};

describe("Task browser contracts", () => {
  it("parses paginated summaries and encodes Session identifiers in detail paths", () => {
    expect(ListTasksResponseSchema.parse({ tasks: [summary], nextCursor: "cursor" })).toEqual({
      tasks: [summary],
      nextCursor: "cursor",
    });
    expect(taskByIdPath("session/with spaces")).toBe("/api/v1/sessions/session%2Fwith%20spaces");
  });

  it("bounds the resolved title while leaving room for a future manual title", () => {
    expect(
      ListTasksResponseSchema.parse({
        tasks: [{ ...summary, title: "x".repeat(TASK_TITLE_MAX_LENGTH) }],
        nextCursor: null,
      }),
    ).toBeTruthy();
    expect(() =>
      ListTasksResponseSchema.parse({
        tasks: [{ ...summary, title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1) }],
        nextCursor: null,
      }),
    ).toThrow();
    expect(
      ListTasksResponseSchema.parse({
        tasks: [{ ...summary, title: "👨‍👩‍👧‍👦".repeat(TASK_TITLE_MAX_LENGTH) }],
        nextCursor: null,
      }),
    ).toBeTruthy();
  });

  it("keeps debug details strict and distinguishes runtime output from Provider output", () => {
    const detail = TaskDetailSchema.parse({
      task: summary,
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
            authorDisplayName: "Mia",
            fallbackText: "Please debug this.",
            truncated: false,
            occurredAt: "2026-08-27T01:00:00.000Z",
          },
          absorbedBy: null,
          report: {
            turnId: "turn-debug",
            outcome: "completed",
            executionEffects: "completed",
            finalText: "Stored runtime final output",
            errorReason: null,
            usage: null,
            traceSummary: { lastSequence: 2, droppedEvents: 0 },
            reportedAt: "2026-08-27T02:00:00.000Z",
          },
        },
      ],
      internalSessions: [],
      collaborationMessages: [],
      nextCursor: null,
    });
    expect(detail.turns[0]?.report?.finalText).toBe("Stored runtime final output");
    expect(() => TaskDetailSchema.parse({ ...detail, providerOutboundMessages: [] })).toThrow();
  });

  it("accepts trimmed manual titles and an explicit clear operation", () => {
    expect(TaskTitleUpdateRequestSchema.parse({ title: "  Name the work  " })).toEqual({ title: "Name the work" });
    expect(TaskTitleUpdateRequestSchema.parse({ title: null })).toEqual({ title: null });
    expect(() => TaskTitleUpdateRequestSchema.parse({ title: "   " })).toThrow();
    expect(() => TaskTitleUpdateRequestSchema.parse({ title: "A", accountId: "foreign" })).toThrow();
    expect(TaskTitleUpdateResponseSchema.parse({ task: summary })).toEqual({ task: summary });
  });
});
