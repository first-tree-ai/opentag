import { computeTurnResultHash, RUNTIME_MAX_FRAME_BYTES, type TurnReportHashInput } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  budgetTurnReportHashInput,
  isOutgoingReplyInScope,
  snapshotOutgoingReplies,
} from "../runtime/provider-cli/outgoing-reply-report.js";
import type { ProviderCliOutgoingReplyReceipt } from "../runtime/provider-cli/outgoing-reply-store.js";

const scope = { chatId: "oc_chat", messageId: "om_root", chatType: "p2p", teamBrand: "lark" as const };
function receipt(overrides: Partial<ProviderCliOutgoingReplyReceipt> = {}): ProviderCliOutgoingReplyReceipt {
  return {
    schemaVersion: 1,
    recordedAt: "2026-09-08T08:00:00.000Z",
    sequenceHint: 1,
    kind: "send",
    messageId: "om_sent",
    chatId: scope.chatId,
    contentStatus: "available",
    content: { msgType: "text", text: "Actual sent body" },
    ...overrides,
  };
}

describe("outgoing reply reporting boundaries", () => {
  it("excludes messages attributed to another app or a human sender", () => {
    const bound = { ...scope, appId: "cli_bound", botOpenId: "ou_bound" };
    expect(isOutgoingReplyInScope(bound, receipt({ senderType: "app", senderId: "cli_bound" }))).toBe(true);
    expect(isOutgoingReplyInScope(bound, receipt({ senderType: "app", senderId: "ou_bound" }))).toBe(true);
    expect(isOutgoingReplyInScope(bound, receipt({ senderType: "app", senderId: "cli_other" }))).toBe(false);
    expect(isOutgoingReplyInScope(bound, receipt({ senderType: "user", senderId: "ou_bound" }))).toBe(false);
  });
  it("budgets the real v2 connection envelope with escaped control characters", () => {
    const input: TurnReportHashInput = {
      deliveryId: "delivery",
      turnId: "turn",
      sessionId: "session",
      agentId: "agent",
      placementGeneration: 1,
      outcome: "completed",
      executionEffects: "completed",
      traceSummary: { lastSequence: 0, droppedEvents: 0 },
      finalText: "\u0001".repeat(48 * 1024),
      outgoingReplies: { status: "complete", replies: [] },
    };
    const fitted = budgetTurnReportHashInput(input);
    const frame = {
      type: "turn:report",
      requestId: "00000000-0000-4000-8000-000000000000",
      ...fitted,
      resultHash: computeTurnResultHash(fitted),
      connectionId: "11111111-1111-4111-8111-111111111111",
    };
    expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(RUNTIME_MAX_FRAME_BYTES);
    expect(fitted.outgoingReplies?.runtimeSummaryTruncated).toBe(true);
  });

  it("deduplicates idempotent send receipts and retains the enriched content", () => {
    const result = snapshotOutgoingReplies(
      {
        status: "complete",
        receipts: [
          receipt({ contentStatus: "unavailable", content: undefined }),
          receipt(),
          receipt({ messageId: "om_second" }),
        ],
      },
      scope,
    );
    expect(result.replies.map((reply) => reply.messageId)).toEqual(["om_sent", "om_second"]);
    expect(result.replies[0]?.content.text).toBe("Actual sent body");
    expect(result.status).toBe("complete");
  });

  it("marks retained partial content and excluded targets as incomplete", () => {
    const partial = snapshotOutgoingReplies(
      { status: "complete", receipts: [receipt({ contentStatus: "truncated" })] },
      scope,
    );
    expect(partial.status).toBe("incomplete");
    expect(partial.replies[0]?.content.unavailable).toBe("content_truncated");
    const excluded = snapshotOutgoingReplies(
      { status: "complete", receipts: [receipt({ chatId: "oc_other" })] },
      scope,
    );
    expect(excluded).toEqual({ status: "incomplete", replies: [], omittedCount: 1 });
  });

  it("keeps private-chat replies while requiring group topic evidence", () => {
    expect(isOutgoingReplyInScope(scope, receipt({ rootId: "om_other" }))).toBe(true);
    const group = { ...scope, chatType: "group" };
    expect(isOutgoingReplyInScope(group, receipt({ rootId: "om_root" }))).toBe(true);
    expect(isOutgoingReplyInScope(group, receipt({ rootId: "om_other" }))).toBe(false);
    expect(isOutgoingReplyInScope(group, receipt())).toBe(false);
    const topic = { ...group, threadId: "omt_topic", rootId: "om_topic_root" };
    expect(isOutgoingReplyInScope(topic, receipt({ threadId: "omt_topic" }))).toBe(true);
    expect(isOutgoingReplyInScope(topic, receipt({ rootId: "om_topic_root" }))).toBe(true);
    expect(isOutgoingReplyInScope(topic, receipt({ threadId: "om_topic_root" }))).toBe(false);
    expect(isOutgoingReplyInScope(topic, receipt({ threadId: "omt_other", rootId: "om_topic_root" }))).toBe(false);
  });

  it("keeps the earliest useful content when bounding many large replies", () => {
    const result = snapshotOutgoingReplies(
      {
        status: "complete",
        receipts: Array.from({ length: 20 }, (_, index) =>
          receipt({ messageId: `om_${index}`, content: { msgType: "text", text: "x".repeat(8 * 1024) } }),
        ),
      },
      scope,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32 * 1024);
    expect(result.status).toBe("incomplete");
    expect(result.replies[0]?.content.text).toBe("x".repeat(8 * 1024));
    expect(result.replies.length + (result.omittedCount ?? 0)).toBe(20);
  });
});
