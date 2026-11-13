import { randomUUID } from "node:crypto";
import { type TurnQuotaWaitRequest, TurnQuotaWaitRequestSchema } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { ImQuotaWaitNotices } from "../services/im/im-quota-wait-notice.js";

// 12:00 in Shanghai.
const NOW = new Date("2026-11-11T04:00:00.000Z");
const CONVERSATION = {
  provider: "feishu" as const,
  bindingId: randomUUID(),
  bindingGeneration: 1,
  installationId: null,
  channelId: "oc_chat",
  threadKey: null,
};

function fixture(options: { owns?: boolean; conversation?: boolean; language?: "zh" | "en" } = {}) {
  const messenger = {
    postConversationText: vi.fn(async () => "om_notice"),
    updateConversationText: vi.fn(async () => undefined),
  };
  const notices = new ImQuotaWaitNotices({
    database: {} as DatabaseClient,
    messenger,
    now: () => NOW,
    owns: async () => options.owns ?? true,
    conversation: async () =>
      options.conversation === false ? undefined : { conversation: CONVERSATION, language: options.language ?? "zh" },
  });
  const deliveryId = randomUUID();
  const frame = (sequence: number, fields: Partial<TurnQuotaWaitRequest> = {}): TurnQuotaWaitRequest => ({
    type: "turn:quota-wait",
    requestId: randomUUID(),
    deliveryId,
    sessionId: randomUUID(),
    agentId: randomUUID(),
    turnId: "turn-1",
    placementGeneration: 1,
    sequence,
    ...fields,
  });
  const send = (request: TurnQuotaWaitRequest) => notices.handle(request, {} as RuntimeBusinessContext);
  return { messenger, frame, send };
}

describe("ImQuotaWaitNotices", () => {
  it("writes one notice, edits it when the reset moves, and forgets it when the wait ends", async () => {
    const f = fixture();
    const first = f.frame(1, { resetAt: "2026-11-11T07:30:00.000Z" });
    expect(await f.send(first)).toMatchObject({ status: "recorded", sequence: 1, turnId: "turn-1" });
    expect(f.messenger.postConversationText).toHaveBeenCalledExactlyOnceWith(
      CONVERSATION,
      "模型额度已用完，约 15:30 自动继续",
      first.requestId,
    );
    // The same time again, or an older frame repeated, changes nothing.
    await f.send(f.frame(2, { resetAt: "2026-11-11T07:30:00.000Z" }));
    await f.send(f.frame(1, { resetAt: "2026-11-11T09:00:00.000Z" }));
    expect(f.messenger.updateConversationText).not.toHaveBeenCalled();
    await f.send(f.frame(3, { resetAt: "2026-11-11T08:45:00.000Z" }));
    expect(f.messenger.updateConversationText).toHaveBeenCalledExactlyOnceWith(
      CONVERSATION,
      "om_notice",
      "模型额度已用完，约 16:45 自动继续",
    );
    expect(await f.send(f.frame(4, { ended: true }))).toMatchObject({ status: "recorded" });
    // A later wait of the same Turn is a new notice.
    await f.send(f.frame(1, { resetAt: "2026-11-11T10:00:00.000Z" }));
    expect(f.messenger.postConversationText).toHaveBeenCalledTimes(2);
  });

  it("answers stale for a Turn this connection does not hold, and sends nothing", async () => {
    const f = fixture({ owns: false });
    expect(await f.send(f.frame(1, { resetAt: "2026-11-11T07:30:00.000Z" }))).toMatchObject({
      status: "stale_generation",
    });
    expect(f.messenger.postConversationText).not.toHaveBeenCalled();
  });

  it.each([
    ["a delivery without a conversation", { conversation: false }, "2026-11-11T07:30:00.000Z"],
    ["a reset already past", {}, "2026-11-11T03:00:00.000Z"],
  ] as const)("sends nothing for %s", async (_name, options, resetAt) => {
    const f = fixture(options);
    expect(await f.send(f.frame(1, { resetAt }))).toMatchObject({ status: "recorded" });
    expect(f.messenger.postConversationText).not.toHaveBeenCalled();
  });

  it("reports a provider failure, and sends again for the next frame", async () => {
    const f = fixture({ language: "en" });
    f.messenger.postConversationText.mockRejectedValueOnce(new Error("feishu down"));
    expect(await f.send(f.frame(1, { resetAt: "2026-11-11T07:30:00.000Z" }))).toMatchObject({ status: "failed" });
    expect(await f.send(f.frame(2, { resetAt: "2026-11-11T07:30:00.000Z" }))).toMatchObject({ status: "recorded" });
    expect(f.messenger.postConversationText).toHaveBeenLastCalledWith(
      CONVERSATION,
      "Model quota used up. OpenTag continues automatically at 15:30 (UTC+8).",
      expect.any(String),
    );
  });

  it("requires a reset time until the wait ends", () => {
    const base = {
      type: "turn:quota-wait",
      requestId: randomUUID(),
      deliveryId: randomUUID(),
      sessionId: randomUUID(),
    };
    const frame = { ...base, agentId: randomUUID(), turnId: "t", placementGeneration: 1, sequence: 1 };
    expect(TurnQuotaWaitRequestSchema.safeParse(frame).success).toBe(false);
    expect(TurnQuotaWaitRequestSchema.safeParse({ ...frame, ended: true }).success).toBe(true);
    expect(TurnQuotaWaitRequestSchema.safeParse({ ...frame, resetAt: "2026-11-11T07:30:00.000Z" }).success).toBe(true);
  });
});
