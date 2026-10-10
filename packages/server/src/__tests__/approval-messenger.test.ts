import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalMessenger } from "../runtime/approval-messenger.js";
import type { PendingApproval } from "../runtime/approval-store.js";

const sdk = vi.hoisted(() => ({
  post: vi.fn(async (_input: unknown) => ({ ts: "card" })),
  update: vi.fn(async (_input: unknown) => ({ ok: true })),
  open: vi.fn(async (_input: unknown) => ({ channel: { id: "sender-dm" } })),
  create: vi.fn(async (_input: unknown) => ({ code: 0, data: { message_id: "card", chat_id: "sender-dm" } })),
  patch: vi.fn(async (_input: unknown) => ({ code: 0 })),
}));
vi.mock("@slack/web-api", () => ({
  WebClient: class {
    chat = { postMessage: sdk.post, update: sdk.update };
    conversations = { open: sdk.open };
  },
}));
vi.mock("@larksuiteoapi/node-sdk", () => ({
  Client: class {
    im = { v1: { message: { create: sdk.create, patch: sdk.patch } } };
  },
  LoggerLevel: { error: "error" },
  Domain: { Feishu: "https://open.feishu.cn", Lark: "https://open.larksuite.com" },
}));

function approvalFor(provider: "feishu" | "slack"): PendingApproval {
  return {
    id: randomUUID(),
    computerId: randomUUID(),
    instanceId: randomUUID(),
    serverInstanceId: randomUUID(),
    connectionId: "connection",
    imBindingId: randomUUID(),
    authority: {
      provider,
      senderExternalId: "sender",
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
    messageChannelId: null,
    cardUpdatedAt: null,
    status: "pending",
    expiresAt: new Date("2026-09-28T14:00:00.000Z"),
  };
}

describe("ApprovalMessenger", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["feishu", "slack"] as const)(
    "shows a concise %s approval with working decision buttons",
    async (provider) => {
      const approval = approvalFor(provider);
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
      const posted = await messenger.post(approval);
      expect(posted).toEqual({ messageId: "card", channelId: "sender-dm" });
      if (provider === "feishu") {
        const input = sdk.create.mock.calls.at(-1)?.[0] as {
          params: { receive_id_type: string };
          data: { receive_id: string; content: string };
        };
        const card = JSON.parse(input.data.content);
        expect(input.params.receive_id_type).toBe("open_id");
        expect(input.data.receive_id).toBe("sender");
        expect(card.config.update_multi).toBe(true);
        expect(card.header.title.content).toBe("Approve command");
        expect(card.elements[0].text.content).toBe(approval.request.description);
        expect(card.elements[1].actions.map((button: { text: { content: string } }) => button.text.content)).toEqual([
          "Approve",
          "Deny",
        ]);
        expect(card.elements[1].actions.map((button: { value: unknown }) => button.value)).toEqual([
          { approvalId: approval.id, decision: "accept" },
          { approvalId: approval.id, decision: "decline" },
        ]);
      } else {
        const input = sdk.post.mock.calls.at(-1)?.[0] as {
          text: string;
          channel: string;
          blocks: { elements: unknown[] }[];
        };
        expect(input.text).toBe("Approve command\n\nPublish the changes?\n\ngit push");
        expect(input.channel).toBe("sender-dm");
        expect(sdk.open).toHaveBeenCalledWith({ users: "sender" });
        expect(input.blocks.at(-1)?.elements).toMatchObject([
          { action_id: "opentag_approval_accept", text: { text: "Approve" }, value: approval.id },
          { action_id: "opentag_approval_decline", text: { text: "Deny" }, value: approval.id },
        ]);
      }

      for (const [status, text, buttonType, slackText] of [
        ["approved", "Approved", "primary_filled", "*✅ Approved*"],
        ["denied", "Denied", "danger_filled", "*⛔ Denied*"],
        ["stale", "Approval expired or the turn ended", undefined, "Approval expired or the turn ended"],
      ] as const) {
        await messenger.finish({
          ...approval,
          status,
          messageId: posted.messageId,
          messageChannelId: posted.channelId,
        });
        if (provider === "feishu") {
          const input = sdk.patch.mock.calls.at(-1)?.[0] as {
            path: { message_id: string };
            data: { content: string };
          };
          const card = JSON.parse(input.data.content);
          expect(input.path.message_id).toBe("card");
          expect(card.config.update_multi).toBe(true);
          expect(card.header.title.content).toBe(approval.request.title);
          expect(card.elements[0].text.content).toBe(approval.request.description);
          expect(card.elements[1]).toEqual(
            buttonType
              ? {
                  tag: "action",
                  actions: [{ tag: "button", text: { tag: "plain_text", content: text }, type: buttonType }],
                }
              : { tag: "div", text: { tag: "plain_text", content: text } },
          );
        } else {
          const input = sdk.update.mock.calls.at(-1)?.[0] as {
            channel: string;
            ts: string;
            text: string;
            blocks: { type: string; text: { type: string; text: string } }[];
          };
          expect(input.channel).toBe("sender-dm");
          expect(input.ts).toBe("card");
          expect(input.text).toBe(`Approve command\n\nPublish the changes?\n\ngit push\n\n${text}`);
          expect(input.blocks.at(-1)?.text).toEqual({
            type: "mrkdwn",
            text: slackText,
          });
          expect(input.blocks.every((block) => block.type === "section")).toBe(true);
        }
      }
    },
  );

  it.each(["feishu", "slack"] as const)(
    "finishes %s cards without retrying missing or replaced credentials",
    async (provider) => {
      for (const generation of [undefined, 2]) {
        const messenger = new ApprovalMessenger(
          {
            getFeishuConnectionMaterial: async () =>
              generation === undefined
                ? undefined
                : { generation, appId: "app", appSecret: "secret", teamBrand: "feishu" },
            getSlackConnectionMaterial: async () =>
              generation === undefined ? undefined : { generation, botAccessToken: "token" },
          } as never,
          { run: async (_operation: string, action: () => unknown) => action() } as never,
        );
        const approval = {
          ...approvalFor(provider),
          status: "stale" as const,
          messageId: "card",
          messageChannelId: "sender-dm",
        };
        await expect(messenger.finish(approval)).resolves.toBeUndefined();
        await expect(messenger.post(approval)).rejects.toThrow("APPROVAL_BINDING_STALE");
      }
      expect(sdk.patch).not.toHaveBeenCalled();
      expect(sdk.update).not.toHaveBeenCalled();
      expect(sdk.create).not.toHaveBeenCalled();
      expect(sdk.post).not.toHaveBeenCalled();
    },
  );
});
