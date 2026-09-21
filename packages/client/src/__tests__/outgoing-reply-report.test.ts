import {
  computeTurnResultHash,
  RUNTIME_MAX_FRAME_BYTES,
  RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES,
  type RuntimeProviderMessageRef,
  type TurnOutgoingReplySnapshot,
  type TurnReportHashInput,
} from "@opentag/shared";
import { describe, expect, it } from "vitest";
import {
  budgetTurnReportHashInput,
  emptyCompleteOutgoingReplies,
  feishuOutgoingReplyScope,
  isOutgoingReplyInScope,
  snapshotOutgoingReplies,
  unavailableOutgoingReplies,
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

function reportInput(overrides: Partial<TurnReportHashInput> = {}): TurnReportHashInput {
  return {
    deliveryId: "delivery",
    turnId: "turn",
    sessionId: "session",
    agentId: "agent",
    placementGeneration: 1,
    outcome: "completed",
    executionEffects: "completed",
    traceSummary: { lastSequence: 0, droppedEvents: 0 },
    ...overrides,
  };
}

function wireReply(index: number): TurnOutgoingReplySnapshot["replies"][number] {
  return {
    provider: "feishu",
    teamBrand: "lark",
    messageId: `om_${index}`,
    chatId: "oc_chat",
    content: { msgType: "text", text: "x" },
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

  it("derives the Feishu reply scope and ignores other providers", () => {
    const reference: RuntimeProviderMessageRef = {
      provider: "feishu",
      teamBrand: "lark",
      appId: "cli_app",
      botOpenId: "ou_bot",
      chatId: "oc_chat",
      chatType: "group",
      messageId: "om_root",
      threadId: "omt_topic",
      rootId: "om_root",
      parentId: "om_parent",
    };
    expect(feishuOutgoingReplyScope(reference)).toEqual({
      appId: "cli_app",
      botOpenId: "ou_bot",
      chatId: "oc_chat",
      messageId: "om_root",
      threadId: "omt_topic",
      rootId: "om_root",
      parentId: "om_parent",
      chatType: "group",
      teamBrand: "lark",
    });
    const slack: RuntimeProviderMessageRef = {
      provider: "slack",
      appId: "A0",
      teamId: "T0",
      botUserId: "U0",
      channelId: "C0",
      messageTs: "1.0",
    };
    expect(feishuOutgoingReplyScope(slack)).toBeUndefined();
  });

  it("exposes the empty complete and unavailable snapshots", () => {
    expect(emptyCompleteOutgoingReplies()).toEqual({ status: "complete", replies: [] });
    expect(unavailableOutgoingReplies()).toEqual({ status: "unavailable", replies: [] });
  });

  it("reports an unavailable capture without inventing replies", () => {
    expect(snapshotOutgoingReplies({ status: "unavailable", receipts: [] }, scope)).toEqual({
      status: "unavailable",
      replies: [],
    });
  });

  it("drops a receipt whose message reference cannot fit the wire contract", () => {
    const result = snapshotOutgoingReplies(
      { status: "complete", receipts: [receipt({ messageId: "m".repeat(513) })] },
      scope,
    );
    expect(result).toEqual({ status: "incomplete", replies: [], omittedCount: 1 });
  });

  it("returns an already budgeted report untouched", () => {
    const fitted = budgetTurnReportHashInput(
      reportInput({ finalText: "short reply", outgoingReplies: { status: "complete", replies: [] } }),
    );
    expect(fitted.finalText).toBe("short reply");
    expect(fitted.outgoingReplies).toEqual({ status: "complete", replies: [] });
  });

  it("bounds the snapshot when the surrounding report fields alone exhaust the frame budget", () => {
    // The frame budget covers the whole report, so a report whose other fields already
    // exceed it must still terminate with a parsed, bounded snapshot.
    const fitted = budgetTurnReportHashInput(
      reportInput({
        deliveryId: "d".repeat(80 * 1024),
        finalText: "reply text",
        outgoingReplies: { status: "complete", replies: [wireReply(1), wireReply(2)] },
      }),
    );
    expect(fitted.finalText).toBeUndefined();
    expect(fitted.outgoingReplies).toEqual({
      status: "incomplete",
      replies: [],
      omittedCount: 2,
      runtimeSummaryTruncated: true,
    });
  });

  it("omits message identities only once their metadata alone exceeds the snapshot limit", () => {
    const large = (pad: string, index: number) => `${pad.repeat(500)}${index}`;
    const result = snapshotOutgoingReplies(
      {
        status: "complete",
        receipts: Array.from({ length: 16 }, (_, index) =>
          receipt({
            messageId: large("m", index),
            chatId: scope.chatId,
            threadId: large("t", index),
            rootId: large("r", index),
            parentId: large("p", index),
            contentStatus: "unavailable",
            content: undefined,
          }),
        ),
      },
      scope,
    );
    expect(result.status).toBe("incomplete");
    expect(result.replies.length).toBeLessThan(16);
    expect(result.replies.length + (result.omittedCount ?? 0)).toBe(16);
    expect(result.replies[0]?.messageId).toBe(large("m", 0));
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(RUNTIME_OUTGOING_REPLY_SNAPSHOT_MAX_BYTES);
  });
});
