import type { TaskTurn } from "@opentag/shared/browser";
import { describe, expect, it } from "vitest";
import { buildTaskTimeline, type TaskReply } from "./task-timeline.js";

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
    entry.kind === "reply" ? entry.reply.messageId : `${entry.kind}:${entry.turn.message.id}`,
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
