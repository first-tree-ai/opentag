import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ApprovalMessenger } from "../runtime/approval-messenger.js";
import type { PendingApproval } from "../runtime/approval-store.js";

const sdk = vi.hoisted(() => ({
  post: vi.fn(async (_input: unknown) => ({ ts: "card" })),
  reply: vi.fn(async (_input: unknown) => ({ code: 0, data: { message_id: "card" } })),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: sdk.post };
  },
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = { v1: { message: { reply: sdk.reply } } };
  },
  LoggerLevel: { error: "error" },
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
}));

describe("ApprovalMessenger", () => {
  it.each(["feishu", "slack"] as const)(
    "shows a concise %s approval with working decision buttons",
    async (provider) => {
      const approval: PendingApproval = {
        id: randomUUID(),
        computerId: randomUUID(),
        instanceId: randomUUID(),
        serverInstanceId: randomUUID(),
        connectionId: "connection",
        imBindingId: randomUUID(),
        authority: {
          provider,
          approverExternalId: "owner",
          generation: 1,
          channelId: "channel",
          externalMessageId: "source-message",
          threadKey: "thread",
          configRevision: 1,
        },
        request: {
          type: "approval:request",
          requestId: randomUUID(),
          turnId: "turn",
          sessionId: "session",
          deliveryId: "delivery",
          placementGeneration: 1,
          title: "Approve command",
          description: "Publish the changes?\n\ngit push",
          expiresAt: "2026-09-28T14:00:00.000Z",
        },
        messageId: null,
        status: "pending",
        expiresAt: new Date("2026-09-28T14:00:00.000Z"),
      };
      const messenger = new ApprovalMessenger(
        {
          getFeishuConnectionMaterial: async () => ({
            generation: 1,
            appId: "app",
            appSecret: "secret",
            teamBrand: "feishu",
          }),
          getSlackConnectionMaterial: async () => ({ generation: 1, botAccessToken: "token" }),
        } as never,
        { run: async (_operation: string, action: () => unknown) => action() } as never,
      );
      expect(await messenger.post(approval)).toBe("card");
      if (provider === "feishu") {
        const input = sdk.reply.mock.calls.at(-1)?.[0] as {
          path: unknown;
          data: { content: string; reply_in_thread: boolean };
        };
        const card = JSON.parse(input.data.content);
        expect(input.path).toEqual({ message_id: "source-message" });
        expect(input.data.reply_in_thread).toBe(true);
        expect(card.header.title.content).toBe("Approve command");
        expect(card.elements[0].text.content).toBe(approval.request.description);
        expect(card.elements[1].actions.map((button: { value: unknown }) => button.value)).toEqual([
          { approvalId: approval.id, decision: "accept" },
          { approvalId: approval.id, decision: "decline" },
        ]);
      } else {
        const input = sdk.post.mock.calls.at(-1)?.[0] as {
          text: string;
          thread_ts: string;
          blocks: { elements: unknown[] }[];
        };
        expect(input.text).toBe("Approve command\n\nPublish the changes?\n\ngit push");
        expect(input.thread_ts).toBe("thread");
        expect(input.blocks.at(-1)?.elements).toMatchObject([
          { action_id: "opentag_approval_accept", value: approval.id },
          { action_id: "opentag_approval_decline", value: approval.id },
        ]);
      }
    },
  );
});
