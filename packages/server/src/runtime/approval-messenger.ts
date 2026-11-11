import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { WebClient } from "@slack/web-api";
import type { runtimeApprovals } from "../db/schema/index.js";
import { type ExternalCallPolicy, ExternalCallPolicyError } from "../services/im/external-call-policy.js";
import { feishuDomainForWorkspaceBrand } from "../services/im-bindings/feishu/adapter.js";
import { numericProviderCode } from "../services/im-bindings/feishu/setup-check.js";
import type { ImBindingService } from "../services/im-bindings/im-binding-service.js";

type Approval = typeof runtimeApprovals.$inferSelect;
export class ApprovalMessenger {
  constructor(
    private readonly bindings: ImBindingService,
    private readonly policy: ExternalCallPolicy,
    private readonly publicUrl: string,
  ) {}

  async post(approval: Approval): Promise<{ messageId: string; channelId: string }> {
    if (approval.authority.provider === "slack") {
      return this.postSlack(approval);
    }
    return this.postFeishu(approval);
  }

  private async postSlack(approval: Approval): Promise<{ messageId: string; channelId: string }> {
    const { authority } = approval;
    const material = await this.bindings.getSlackConnectionMaterial(approval.imBindingId);
    if (!material || material.generation !== authority.generation) throw new Error("APPROVAL_BINDING_STALE");
    const client = new WebClient(material.botAccessToken, { retryConfig: { retries: 0 } });
    const card = slackCard(approval, this.modelSettingsUrl(material.agentId));
    if (authority.channelId) {
      const threadTs = authority.threadKey ?? authority.externalMessageId;
      try {
        const result = await this.policy.run(
          "slack.approval.post",
          () =>
            client.chat.postMessage({
              channel: authority.channelId,
              ...(threadTs ? { thread_ts: threadTs } : {}),
              ...card,
            }),
          { maxAttempts: 1 },
        );
        if (!result.ts) throw new Error("APPROVAL_MESSAGE_MISSING");
        return { messageId: result.ts, channelId: authority.channelId };
      } catch (error) {
        if (!isConfirmedSlackNonDelivery(error)) throw error;
      }
    }
    const opened = await this.policy.run(
      "slack.approval.open",
      () => client.conversations.open({ users: authority.senderExternalId }),
      { maxAttempts: 1 },
    );
    const channelId = opened.channel?.id;
    if (!channelId) throw new Error("APPROVAL_DM_UNAVAILABLE");
    const result = await this.policy.run(
      "slack.approval.post",
      () =>
        client.chat.postMessage({
          channel: channelId,
          ...card,
        }),
      { maxAttempts: 1 },
    );
    if (!result.ts) throw new Error("APPROVAL_MESSAGE_MISSING");
    return { messageId: result.ts, channelId };
  }

  private async postFeishu(approval: Approval): Promise<{ messageId: string; channelId: string }> {
    const { authority } = approval;
    const connection = await this.feishuConnection(approval);
    if (!connection) throw new Error("APPROVAL_BINDING_STALE");
    const content = feishuCard(approval, connection.modelSettingsUrl);
    if (authority.externalMessageId) {
      const replied = await this.replyFeishu(connection.client, authority, content);
      if (replied) return replied;
    }
    const result = await this.policy.run(
      "feishu.approval.post",
      () =>
        connection.client.im.v1.message.create({
          params: { receive_id_type: "open_id" },
          data: {
            receive_id: authority.senderExternalId,
            msg_type: "interactive",
            content,
          },
        }),
      { maxAttempts: 1 },
    );
    if (result.code !== 0 || !result.data?.message_id || !result.data.chat_id) {
      throw new Error("APPROVAL_MESSAGE_FAILED");
    }
    return { messageId: result.data.message_id, channelId: result.data.chat_id };
  }

  private async replyFeishu(
    client: Client,
    authority: Approval["authority"],
    content: string,
  ): Promise<{ messageId: string; channelId: string } | undefined> {
    try {
      const replyResult = await this.policy.run(
        "feishu.approval.post",
        () =>
          client.im.v1.message.reply({
            path: { message_id: authority.externalMessageId },
            data: {
              msg_type: "interactive",
              content,
              reply_in_thread: Boolean(authority.threadKey),
            },
          }),
        { maxAttempts: 1 },
      );
      if (replyResult.code === 0) {
        const replyChannelId = replyResult.data?.chat_id ?? authority.channelId;
        if (!replyResult.data?.message_id || !replyChannelId) {
          throw new Error("APPROVAL_MESSAGE_FAILED");
        }
        return { messageId: replyResult.data.message_id, channelId: replyChannelId };
      }
      if (!isConfirmedFeishuNonDelivery(replyResult)) {
        throw new Error("APPROVAL_MESSAGE_FAILED");
      }
      return undefined;
    } catch (error) {
      if (!isConfirmedFeishuNonDelivery(error)) throw error;
      return undefined;
    }
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
            ...slackCard(approval, this.modelSettingsUrl(material.agentId)),
          }),
        { maxAttempts: 1 },
      );
      return;
    }
    const connection = await this.feishuConnection(approval);
    // Replaced credentials cannot update the old card; finish without retrying.
    if (!connection) return;
    const result = await this.policy.run(
      "feishu.approval.update",
      () =>
        connection.client.im.v1.message.patch({
          path: { message_id: messageId },
          data: { content: feishuCard(approval, connection.modelSettingsUrl) },
        }),
      { maxAttempts: 1 },
    );
    if (result.code !== 0) throw new Error("APPROVAL_UPDATE_FAILED");
  }

  private modelSettingsUrl(agentId: string): string {
    return new URL(`/agents/${encodeURIComponent(agentId)}/settings/execution`, this.publicUrl).href;
  }

  private async feishuConnection(approval: Approval) {
    const material = await this.bindings.getFeishuConnectionMaterial(approval.imBindingId);
    if (!material || material.generation !== approval.authority.generation) return undefined;
    return {
      client: new Client({
        appId: material.appId,
        appSecret: material.appSecret,
        domain: feishuDomainForWorkspaceBrand(material.teamBrand),
        loggerLevel: LoggerLevel.error,
      }),
      modelSettingsUrl: this.modelSettingsUrl(material.agentId),
    };
  }
}

const CONFIRMED_SLACK_NON_DELIVERY_CODES = new Set([
  "cannot_reply_to_message",
  "channel_not_found",
  "ekm_access_denied",
  "is_archived",
  "message_not_found",
  "missing_scope",
  "no_permission",
  "not_in_channel",
  "posting_to_general_channel_denied",
  "restricted_action",
  "restricted_action_non_threadable_channel",
  "restricted_action_read_only_channel",
  "restricted_action_thread_locked",
  "restricted_action_thread_only_channel",
  "thread_not_found",
]);

const CONFIRMED_FEISHU_NON_DELIVERY_CODES = new Set([
  230001, 230002, 230006, 230011, 230013, 230019, 230023, 230027, 230035,
]);

const CONFIRMED_FEISHU_NON_DELIVERY_MESSAGES = [
  "bot is not in chat",
  "chat disbanded",
  "chat dissolved",
  "message deleted",
  "message not found",
  "message recalled",
  "not in chat",
];

function isConfirmedSlackNonDelivery(error: unknown): boolean {
  if (error instanceof ExternalCallPolicyError) return false;
  const dataError = (error as { data?: { error?: unknown } } | null)?.data?.error;
  return typeof dataError === "string" && CONFIRMED_SLACK_NON_DELIVERY_CODES.has(dataError);
}

function isConfirmedFeishuNonDelivery(error: unknown): boolean {
  if (error instanceof ExternalCallPolicyError) return false;
  const code = numericProviderCode(error);
  if (code !== undefined && CONFIRMED_FEISHU_NON_DELIVERY_CODES.has(code)) return true;
  const message =
    error instanceof Error
      ? error.message
      : typeof (error as { msg?: unknown } | null)?.msg === "string"
        ? (error as { msg: string }).msg
        : undefined;
  return (
    message !== undefined &&
    CONFIRMED_FEISHU_NON_DELIVERY_MESSAGES.some((pattern) => message.toLowerCase().includes(pattern))
  );
}

function statusText(status: Approval["status"]): string | undefined {
  if (status === "approved") return "Approved";
  if (status === "denied") return "Denied";
  if (status === "stale") return "Approval expired or the turn ended";
  return undefined;
}

function slackCard(approval: Approval, modelSettingsUrl: string) {
  const { commandPresentation } = approval.request;
  const title = commandPresentation ? "Command approval" : approval.request.title;
  const summary = `${title}\n\n${approval.request.description}`;
  const text = statusText(approval.status);
  const status =
    approval.status === "approved" ? "*✅ Approved*" : approval.status === "denied" ? "*⛔ Denied*" : undefined;
  return {
    text: text ? `${summary}\n\n${text}` : summary,
    blocks: [
      {
        type: "rich_text" as const,
        elements: [
          {
            type: "rich_text_section" as const,
            elements: [{ type: "text" as const, text: title, style: { bold: true } }],
          },
        ],
      },
      ...((commandPresentation ? commandPresentation.reason : approval.request.description)
        .match(/[\s\S]{1,2900}/gu)
        ?.map((content) => ({
          type: "section" as const,
          text: { type: "plain_text" as const, text: content },
        })) ?? []),
      ...(commandPresentation
        ? [
            {
              type: "rich_text" as const,
              elements: [
                {
                  type: "rich_text_preformatted" as const,
                  elements: [{ type: "text" as const, text: commandPresentation.command }],
                },
              ],
            },
          ]
        : []),
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
      {
        type: "context" as const,
        elements: [
          {
            type: "mrkdwn" as const,
            text: `Requested by <@${approval.authority.senderExternalId}> · Whitelist command or disable approvals in <${modelSettingsUrl}|Agent Model Settings>`,
          },
        ],
      },
    ],
  };
}

function feishuCard(approval: Approval, modelSettingsUrl: string): string {
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
      {
        tag: "note",
        elements: [
          {
            tag: "lark_md",
            content: `Requested by <at id=${approval.authority.senderExternalId}></at> · Whitelist command or disable approvals in [Agent Model Settings](${modelSettingsUrl})`,
          },
        ],
      },
    ],
  });
}
