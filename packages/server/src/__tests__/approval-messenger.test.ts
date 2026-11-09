import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalMessenger } from "../runtime/approval-messenger.js";
import type { PendingApproval } from "../runtime/approval-store.js";

const publicUrl = "https://opentag.example.com";
const agentId = randomUUID();
const modelSettingsUrl = `${publicUrl}/agents/${agentId}/settings/execution`;
const slackFooter = {
  type: "context",
  elements: [
    {
      type: "mrkdwn",
      text: `Requested by <@sender> · Whitelist command or disable approvals in <${modelSettingsUrl}|Agent Model Settings>`,
    },
  ],
};
const feishuFooter = {
  tag: "note",
  elements: [
    {
      tag: "lark_md",
      content: `Requested by <at id=sender></at> · Whitelist command or disable approvals in [Agent Model Settings](${modelSettingsUrl})`,
    },
  ],
};

const sdk = vi.hoisted(() => ({
  post: vi.fn(async (_input: unknown) => ({ ts: "card" })),
  update: vi.fn(async (_input: unknown) => ({ ok: true })),
  open: vi.fn(async (_input: unknown) => ({ channel: { id: "sender-dm" } })),
  create: vi.fn(async (_input: unknown) => ({ code: 0, data: { message_id: "card", chat_id: "sender-dm" } })),
  reply: vi.fn(async (_input: unknown) => ({ code: 0, data: { message_id: "card", chat_id: "channel" } })),
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
    im = { v1: { message: { create: sdk.create, reply: sdk.reply, patch: sdk.patch } } };
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
            agentId,
            generation: 1,
            appId: "app",
            appSecret: "secret",
            teamBrand: "feishu",
          }),
          getSlackConnectionMaterial: async () => ({ agentId, generation: 1, botAccessToken: "token" }),
        } as never,
        { run: async (_operation: string, action: () => unknown) => action() } as never,
        publicUrl,
      );
      const posted = await messenger.post(approval);
      expect(posted).toEqual({ messageId: "card", channelId: "channel" });
      if (provider === "feishu") {
        const input = sdk.reply.mock.calls.at(-1)?.[0] as {
          path: { message_id: string };
          data: { msg_type: string; content: string; reply_in_thread: boolean };
        };
        const card = JSON.parse(input.data.content);
        expect(input.path.message_id).toBe("source-message");
        expect(input.data.msg_type).toBe("interactive");
        expect(input.data.reply_in_thread).toBe(true);
        expect(sdk.create).not.toHaveBeenCalled();
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
        expect(card.elements.at(-1)).toEqual(feishuFooter);
      } else {
        const input = sdk.post.mock.calls.at(-1)?.[0] as {
          text: string;
          channel: string;
          thread_ts?: string;
          blocks: { elements: unknown[] }[];
        };
        expect(input.text).toBe("Approve command\n\nPublish the changes?\n\ngit push");
        expect(input.channel).toBe("channel");
        expect(input.thread_ts).toBe("thread");
        expect(sdk.open).not.toHaveBeenCalled();
        expect(input.blocks.at(-2)?.elements).toMatchObject([
          { action_id: "opentag_approval_accept", text: { text: "Approve" }, value: approval.id },
          { action_id: "opentag_approval_decline", text: { text: "Deny" }, value: approval.id },
        ]);
        expect(input.blocks.at(-1)).toEqual(slackFooter);
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
          expect(card.elements.at(-1)).toEqual(feishuFooter);
        } else {
          const input = sdk.update.mock.calls.at(-1)?.[0] as {
            channel: string;
            ts: string;
            text: string;
            blocks: { type: string; text: { type: string; text: string } }[];
          };
          expect(input.channel).toBe("channel");
          expect(input.ts).toBe("card");
          expect(input.text).toBe(`Approve command\n\nPublish the changes?\n\ngit push\n\n${text}`);
          expect(input.blocks.at(-2)?.text).toEqual({
            type: "mrkdwn",
            text: slackText,
          });
          expect(input.blocks.at(-1)).toEqual(slackFooter);
          expect(input.blocks.some((block) => block.type === "actions")).toBe(false);
        }
      }
    },
  );

  it("posts approval cards in conversations or falls back to direct messages when posting in the conversation fails", async () => {
    const messenger = new ApprovalMessenger(
      {
        getFeishuConnectionMaterial: async () => ({
          agentId,
          generation: 1,
          appId: "app",
          appSecret: "secret",
          teamBrand: "feishu",
        }),
        getSlackConnectionMaterial: async () => ({ agentId, generation: 1, botAccessToken: "token" }),
      } as never,
      { run: async (_operation: string, action: () => unknown) => action() } as never,
      publicUrl,
    );

    const feishuChannelReply = approvalFor("feishu");
    feishuChannelReply.authority.threadKey = null;
    sdk.reply.mockResolvedValueOnce({ code: 0, data: { message_id: "card-reply" } as never });
    await expect(messenger.post(feishuChannelReply)).resolves.toEqual({
      messageId: "card-reply",
      channelId: "channel",
    });
    expect(sdk.reply).toHaveBeenLastCalledWith(
      expect.objectContaining({
        path: { message_id: "source-message" },
        data: expect.objectContaining({ reply_in_thread: false }),
      }),
    );

    const feishuReplyFailedFallback = approvalFor("feishu");
    sdk.reply.mockRejectedValueOnce(new Error("message recalled"));
    sdk.create.mockResolvedValueOnce({ code: 0, data: { message_id: "card-dm", chat_id: "sender-dm" } });
    await expect(messenger.post(feishuReplyFailedFallback)).resolves.toEqual({
      messageId: "card-dm",
      channelId: "sender-dm",
    });
    expect(sdk.create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        params: { receive_id_type: "open_id" },
        data: expect.objectContaining({ receive_id: "sender" }),
      }),
    );

    const slackMessageReply = approvalFor("slack");
    slackMessageReply.authority.threadKey = null;
    await expect(messenger.post(slackMessageReply)).resolves.toEqual({
      messageId: "card",
      channelId: "channel",
    });
    expect(sdk.post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: "channel",
        thread_ts: "source-message",
      }),
    );
    expect(sdk.open).not.toHaveBeenCalled();

    const slackChannelFailedFallback = approvalFor("slack");
    sdk.post.mockRejectedValueOnce(new Error("is_archived"));
    await expect(messenger.post(slackChannelFailedFallback)).resolves.toEqual({
      messageId: "card",
      channelId: "sender-dm",
    });
    expect(sdk.open).toHaveBeenCalledWith({ users: "sender" });
    const dmCall = sdk.post.mock.calls.at(-1)?.[0] as { channel: string; thread_ts?: string };
    expect(dmCall.channel).toBe("sender-dm");
    expect(dmCall.thread_ts).toBeUndefined();
  });

  it.each(["pending", "approved", "denied", "stale"] as const)(
    "preserves literal commands and separates the reason in %s Slack cards",
    async (status) => {
      const command = "printf '``` <@U123> & *literal*'\npnpm test";
      const reason = "Rerun outside the sandbox?";
      const approval = approvalFor("slack");
      approval.status = status;
      approval.request.description = `${reason}\n\n${command}`;
      approval.request.commandPresentation = { command, reason };
      const messenger = new ApprovalMessenger(
        { getSlackConnectionMaterial: async () => ({ agentId, generation: 1, botAccessToken: "token" }) } as never,
        { run: async (_operation: string, action: () => unknown) => action() } as never,
        publicUrl,
      );
      const posted = await messenger.post(approval);
      await messenger.finish({ ...approval, messageId: posted.messageId, messageChannelId: posted.channelId });
      for (const input of [sdk.post.mock.calls.at(-1)?.[0], sdk.update.mock.calls.at(-1)?.[0]]) {
        expect(input).toMatchObject({
          text: expect.stringContaining(`${reason}\n\n${command}`),
          blocks: [
            {
              type: "rich_text",
              elements: [
                { type: "rich_text_section", elements: [{ text: "Command approval", style: { bold: true } }] },
              ],
            },
            { type: "section", text: { type: "plain_text", text: reason } },
            {
              type: "rich_text",
              elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: command }] }],
            },
            status === "pending" ? { type: "actions" } : { type: "section" },
            slackFooter,
          ],
        });
      }
    },
  );

  it("shows a command without a reason and keeps long commands intact", async () => {
    const approval = approvalFor("slack");
    const command = "x".repeat(6000);
    approval.request.description = command;
    approval.request.commandPresentation = { command, reason: "" };
    const messenger = new ApprovalMessenger(
      { getSlackConnectionMaterial: async () => ({ agentId, generation: 1, botAccessToken: "token" }) } as never,
      { run: async (_operation: string, action: () => unknown) => action() } as never,
      publicUrl,
    );
    await messenger.post(approval);
    const input = sdk.post.mock.calls.at(-1)?.[0] as { blocks: { type: string; elements?: unknown[] }[] };
    expect(input.blocks).toHaveLength(4);
    expect(input.blocks[1]).toMatchObject({
      type: "rich_text",
      elements: [{ type: "rich_text_preformatted", elements: [{ text: command }] }],
    });
  });

  it.each(["feishu", "slack"] as const)(
    "finishes %s cards without retrying missing or replaced credentials",
    async (provider) => {
      for (const generation of [undefined, 2]) {
        const messenger = new ApprovalMessenger(
          {
            getFeishuConnectionMaterial: async () =>
              generation === undefined
                ? undefined
                : { agentId, generation, appId: "app", appSecret: "secret", teamBrand: "feishu" },
            getSlackConnectionMaterial: async () =>
              generation === undefined ? undefined : { agentId, generation, botAccessToken: "token" },
          } as never,
          { run: async (_operation: string, action: () => unknown) => action() } as never,
          publicUrl,
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
