import type { TaskTurn } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { buildTaskTimeline, type CapturedTaskReply, type TaskReply } from "./task-timeline.js";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 21, 0, minute)).toISOString();
function reply(id: string, minute?: number): TaskReply {
  return {
    provider: "feishu",
    teamBrand: "lark",
    chatId: "chat",
    messageId: id,
    createTime: minute === undefined ? undefined : String(Date.parse(at(minute))),
    content: { msgType: "text", text: "The same text" },
  };
}
function turn(id: string, minute: number, replies: TaskReply[] = []): TaskTurn {
  return {
    deliveryId: id,
    attention: "direct",
    delivery: {
      state: "accepted",
      attemptCount: 1,
      acceptedAt: at(minute),
      steeredAt: null,
      expiresAt: at(60),
      reason: null,
      lastErrorCode: null,
    },
    message: {
      id,
      externalMessageId: id,
      operation: "created",
      authorKind: "human",
      authorDisplayName: "Mia",
      fallbackText: "The same text",
      truncated: false,
      occurredAt: at(minute),
    },
    absorbedBy: null,
    report: {
      turnId: id,
      outcome: "completed",
      executionEffects: "completed",
      finalText: "Summary",
      errorReason: null,
      usage: null,
      traceSummary: { lastSequence: 0, droppedEvents: 0 },
      outgoingReplies: { status: "complete", replies },
      reportedAt: at(10),
    },
  };
}
function labels(turns: TaskTurn[]) {
  return buildTaskTimeline(turns, "feishu").map((entry) =>
    entry.kind === "reply"
      ? entry.reply.messageId
      : entry.kind === "captured"
        ? `captured:${entry.reply.externalMessageId}`
        : `${entry.kind}:${entry.turn.message.id}`,
  );
}

describe("Task conversation order", () => {
  it("interleaves user steering with actual replies and a single terminal summary", () => {
    const root = turn("root", 0, [reply("first", 2), reply("second", 5)]);
    const steer = { ...turn("steer", 3), absorbedBy: { deliveryId: "root", turnId: "root" }, report: null };
    expect(labels([root, steer])).toEqual(["request:root", "first", "request:steer", "second", "report:root"]);
  });

  it("deduplicates overlapping identities while preserving identical text and message revisions", () => {
    const root = turn("root", 0, [reply("first", 1)]);
    const second = turn("second", 3, [reply("first", 1), reply("second", 4)]);
    second.message.externalMessageId = root.message.externalMessageId;
    second.message.operation = "edited";
    expect(labels([root, root, second])).toEqual([
      "request:root",
      "first",
      "request:second",
      "second",
      "report:root",
      "report:second",
    ]);
  });

  it("uses the newest delivery snapshot when pages overlap", () => {
    const old = { ...turn("root", 0), report: null };
    const current = turn("root", 0, [reply("sent", 2)]);
    expect(labels([old, current])).toEqual(["request:root", "sent", "report:root"]);
  });

  it("keeps missing or invalid timestamps beside neighbouring receipts without inventing a time", () => {
    const replies = [
      reply("before"),
      reply("first", 2),
      { ...reply("between"), createTime: "invalid" },
      reply("second", 5),
      reply("after"),
    ];
    expect(
      labels([
        turn("root", 0, replies),
        { ...turn("steer", 3), absorbedBy: { deliveryId: "root", turnId: "root" }, report: null },
      ]),
    ).toEqual(["request:root", "before", "first", "between", "request:steer", "second", "after", "report:root"]);
    expect(replies[0]?.createTime).toBeUndefined();
  });

  it("keeps snapshot order without timestamps and stable input order for equal times", () => {
    expect(labels([turn("a", 0, [reply("z"), reply("a")]), turn("b", 0)])).toEqual([
      "request:a",
      "request:b",
      "z",
      "a",
      "report:a",
      "report:b",
    ]);
  });

  it("places a late report after subsequent input without fabricating Slack sent replies", () => {
    const entries = buildTaskTimeline([turn("a", 0, [reply("ignored", 1)]), turn("b", 2)], "slack");
    expect(entries.map((entry) => entry.id)).toEqual(["message:a", "message:b", "report:a", "report:b"]);
    expect(entries.some((entry) => entry.kind === "reply")).toBe(false);
  });
});

function capturedReply(id: string, externalMessageId: string, minute: number, text = "Sent body"): CapturedTaskReply {
  return {
    id,
    provider: "feishu",
    channelId: "chat",
    externalMessageId,
    authorKind: "bot",
    authorDisplayName: null,
    messageType: "text",
    contentAvailable: true,
    fallbackText: text,
    truncated: false,
    occurredAt: at(minute),
    timeSource: "provider",
  };
}

describe("captured Server replies in the Task conversation", () => {
  it("merges captured replies chronologically without requiring a Turn", () => {
    const entries = buildTaskTimeline([turn("root", 0, [reply("legacy", 4)])], "feishu", [
      capturedReply("captured-1", "om_captured", 2),
    ]);
    expect(labels([turn("root", 0, [reply("legacy", 4)])])).toEqual(["request:root", "legacy", "report:root"]);
    expect(entries.map((entry) => entry.id)).toEqual([
      "message:root",
      'reply:["feishu","chat","om_captured"]',
      'reply:["feishu","chat","legacy"]',
      "report:root",
    ]);
    const captured = entries.find((entry) => entry.kind === "captured");
    expect(
      captured && "reply" in captured && captured.kind === "captured" ? captured.reply.externalMessageId : null,
    ).toBe("om_captured");
    expect(entries.some((entry) => entry.kind === "captured" && "turn" in entry)).toBe(false);
  });

  it("deduplicates a legacy receipt against the Server record with the same native identity", () => {
    const root = turn("root", 0, [reply("om_same", 2)]);
    const entries = buildTaskTimeline([root], "feishu", [capturedReply("captured-1", "om_same", 2)]);
    expect(entries.map((entry) => entry.kind)).toEqual(["request", "captured", "report"]);
    expect(entries.filter((entry) => entry.kind === "reply")).toHaveLength(0);
  });

  it("keeps same-text messages with distinct native identities separate", () => {
    const root = turn("root", 0, [reply("om_legacy", 3)]);
    const entries = buildTaskTimeline([root], "feishu", [
      capturedReply("captured-1", "om_captured_a", 2),
      capturedReply("captured-2", "om_captured_b", 2),
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual(["request", "captured", "captured", "reply", "report"]);
  });

  it("lets an old receipt supply the body only when the Server record's content is unavailable", () => {
    const root = turn("root", 0, [reply("om_same", 2)]);
    const unavailable = { ...capturedReply("captured-1", "om_same", 2), contentAvailable: false, fallbackText: "" };
    const entries = buildTaskTimeline([root], "feishu", [unavailable]);
    const captured = entries.find((entry) => entry.kind === "captured");
    expect(captured?.kind === "captured" ? captured.legacyReply?.content.text : undefined).toBe("The same text");

    const available = buildTaskTimeline([root], "feishu", [capturedReply("captured-2", "om_same", 2, "Server body")]);
    const serverRecord = available.find((entry) => entry.kind === "captured");
    expect(serverRecord?.kind === "captured" ? serverRecord.legacyReply : undefined).toBeUndefined();
  });

  it("carries the whole legacy receipt so a non-text attachment can still render", () => {
    const file = {
      ...reply("om_same", 2),
      content: { msgType: "file" as const, filename: "review.pdf", fileKey: "file_fixture" },
    };
    const entries = buildTaskTimeline([turn("root", 0, [file])], "feishu", [
      { ...capturedReply("captured-1", "om_same", 2), contentAvailable: false, fallbackText: "" },
    ]);
    const captured = entries.find((entry) => entry.kind === "captured");
    expect(captured?.kind === "captured" ? captured.legacyReply?.content.filename : undefined).toBe("review.pdf");
  });

  it("keeps one native-identity entry id whether a legacy receipt or the stored row represents the message", () => {
    const root = turn("root", 0, [reply("om_same", 2)]);
    const legacyOnly = buildTaskTimeline([root], "feishu");
    const withStoredRow = buildTaskTimeline([root], "feishu", [capturedReply("captured-1", "om_same", 2)]);
    const legacyEntry = legacyOnly.find((entry) => entry.kind === "reply");
    const capturedEntry = withStoredRow.find((entry) => entry.kind === "captured");
    expect(legacyEntry?.id).toBe('reply:["feishu","chat","om_same"]');
    expect(capturedEntry?.id).toBe(legacyEntry?.id);
  });

  it("never sources a reply body from the report finalText", () => {
    const root = turn("root", 0);
    const entries = buildTaskTimeline([root], "feishu", [capturedReply("captured-1", "om_captured", 2)]);
    const captured = entries.find((entry) => entry.kind === "captured");
    expect(captured?.kind === "captured" ? captured.reply.fallbackText : null).toBe("Sent body");
    expect(captured?.kind === "captured" ? captured.reply.fallbackText : null).not.toBe("Summary");
  });
});
