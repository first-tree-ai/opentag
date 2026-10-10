import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { WebClient } from "@slack/web-api";
import type { runtimeApprovals } from "../db/schema/index.js";
import type { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import { feishuDomainForWorkspaceBrand } from "../services/im-bindings/feishu/adapter.js";
import type { ImBindingService } from "../services/im-bindings/im-binding-service.js";

type Approval = typeof runtimeApprovals.$inferSelect;
export class ApprovalMessenger {
  constructor(
    private readonly bindings: ImBindingService,
    private readonly policy: ExternalCallPolicy,
  ) {}

  async post(approval: Approval): Promise<{ messageId: string; channelId: string }> {
    const { authority } = approval;
    if (authority.provider === "slack") {
      const material = await this.bindings.getSlackConnectionMaterial(approval.imBindingId);
      if (!material || material.generation !== authority.generation) throw new Error("APPROVAL_BINDING_STALE");
      const client = new WebClient(material.botAccessToken, { retryConfig: { retries: 0 } });
      const opened = await this.policy.run(
        "slack.approval.open",
        () => client.conversations.open({ users: authority.senderExternalId }),
        { maxAttempts: 1 },
      );
      const channelId = opened.channel?.id;
      if (!channelId) throw new Error("APPROVAL_DM_UNAVAILABLE");
      const result = await this.policy.run(
        "slack.approval.post",
        () => client.chat.postMessage({ channel: channelId, ...slackCard(approval) }),
        { maxAttempts: 1 },
      );
      if (!result.ts) throw new Error("APPROVAL_MESSAGE_MISSING");
      return { messageId: result.ts, channelId };
    }
    const client = await this.feishuClient(approval);
    if (!client) throw new Error("APPROVAL_BINDING_STALE");
    const result = await this.policy.run(
      "feishu.approval.post",
      () =>
        client.im.v1.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: authority.senderExternalId,
            msg_type: "interactive",
            content: feishuCard(approval),
          },
        }),
      { maxAttempts: 1 },
    );
    if (result.code !== 0 || !result.data?.message_id || !result.data.chat_id) {
      throw new Error("APPROVAL_MESSAGE_FAILED");
    }
    return { messageId: result.data.message_id, channelId: result.data.chat_id };
  }

  async finish(approval: Approval): Promise<void> {
    const { messageId, messageChannelId } = approval;
    if (!messageId || !messageChannelId) return;
    if (approval.authority.provider === "slack") {
      const material = await this.bindings.getSlackConnectionMaterial(approval.imBindingId);
      if (!material || material.generation !== approval.authority.generation) return;
      await this.policy.run(
        "slack.approval.update",
        () =>
          new WebClient(material.botAccessToken, { retryConfig: { retries: 0 } }).chat.update({
            channel: messageChannelId,
            ts: messageId,
            ...slackCard(approval),
          }),
        { maxAttempts: 1 },
      );
      return;
    }
    const client = await this.feishuClient(approval);
    // Replaced credentials cannot update the old card; finish without retrying.
    if (!client) return;
    const result = await this.policy.run(
      "feishu.approval.update",
      () =>
        client.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: feishuCard(approval) },
        }),
      { maxAttempts: 1 },
    );
    if (result.code !== 0) throw new Error("APPROVAL_UPDATE_FAILED");
  }

  private async feishuClient(approval: Approval) {
    const material = await this.bindings.getFeishuConnectionMaterial(approval.imBindingId);
    if (!material || material.generation !== approval.authority.generation) return undefined;
    return new Client({
      appId: material.appId,
      appSecret: material.appSecret,
      domain: feishuDomainForWorkspaceBrand(material.teamBrand),
      loggerLevel: LoggerLevel.error,
    });
  }
}

function statusText(status: Approval["status"]): string | undefined {
  if (status === "approved") return "Approved";
  if (status === "denied") return "Denied";
  if (status === "stale") return "Approval expired or the turn ended";
  return undefined;
}

function slackCard(approval: Approval) {
  const summary = `${approval.request.title}\n\n${approval.request.description}`;
  const text = statusText(approval.status);
  const status =
    approval.status === "approved" ? "*✅ Approved*" : approval.status === "denied" ? "*⛔ Denied*" : undefined;
  return {
    text: text ? `${summary}\n\n${text}` : summary,
    blocks: [
      ...(summary.match(/[\s\S]{1,2900}/gu)?.map((content) => ({
        type: "section" as const,
        text: { type: "plain_text" as const, text: content },
      })) ?? []),
      ...(text
        ? [{ type: "section" as const, text: { type: "mrkdwn" as const, text: status ?? text } }]
        : [
            {
              type: "actions" as const,
              elements: [
                {
                  type: "button" as const,
                  action_id: "opentag_approval_accept",
                  text: { type: "plain_text" as const, text: "Approve" },
                  value: approval.id,
                  style: "primary" as const,
                },
                {
                  type: "button" as const,
                  action_id: "opentag_approval_decline",
                  text: { type: "plain_text" as const, text: "Deny" },
                  value: approval.id,
                  style: "danger" as const,
                },
              ],
            },
          ]),
    ],
  };
}

function feishuCard(approval: Approval): string {
  const text = statusText(approval.status);
  const buttonType =
    approval.status === "approved" ? "primary_filled" : approval.status === "denied" ? "danger_filled" : undefined;
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { title: { tag: "plain_text", content: approval.request.title } },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: approval.request.description } },
      ...(text
        ? buttonType
          ? [
              {
                tag: "action",
                actions: [{ tag: "button", text: { tag: "plain_text", content: text }, type: buttonType }],
              },
            ]
          : [{ tag: "div", text: { tag: "plain_text", content: text } }]
        : [
            {
              tag: "action",
              actions: [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "Approve" },
                  type: "primary",
                  value: { approvalId: approval.id, decision: "accept" },
                },
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "Deny" },
                  type: "danger",
                  value: { approvalId: approval.id, decision: "decline" },
                },
              ],
            },
          ]),
    ],
  });
}
