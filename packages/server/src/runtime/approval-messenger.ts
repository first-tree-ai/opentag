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

  async post(approval: Approval): Promise<string> {
    const { authority, request, id } = approval;
    const summary = `${request.title}\n${request.description}\nOnly ${authority.approverExternalId} can answer. Expires ${request.expiresAt}.`;
    if (authority.provider === "slack") {
      const material = await this.bindings.getSlackConnectionMaterial(approval.imBindingId);
      if (!material || material.generation !== authority.generation) throw new Error("APPROVAL_BINDING_STALE");
      const result = await this.policy.run(
        "slack.approval.post",
        () =>
          new WebClient(material.botAccessToken, { retryConfig: { retries: 0 } }).chat.postMessage({
            channel: authority.channelId,
            thread_ts: authority.threadKey ?? authority.externalMessageId,
            text: summary,
            blocks: [
              ...(summary
                .match(/[\s\S]{1,2900}/gu)
                ?.map((text) => ({ type: "section" as const, text: { type: "plain_text" as const, text } })) ?? []),
              {
                type: "actions",
                elements: [
                  {
                    type: "button",
                    action_id: "opentag_approval_accept",
                    text: { type: "plain_text", text: "Approve once" },
                    value: id,
                    style: "primary",
                  },
                  {
                    type: "button",
                    action_id: "opentag_approval_decline",
                    text: { type: "plain_text", text: "Deny" },
                    value: id,
                    style: "danger",
                  },
                ],
              },
            ],
          }),
        { maxAttempts: 1 },
      );
      if (!result.ts) throw new Error("APPROVAL_MESSAGE_MISSING");
      return result.ts;
    }
    const client = await this.feishuClient(approval);
    const result = await this.policy.run(
      "feishu.approval.post",
      () =>
        client.im.v1.message.reply({
          path: { message_id: authority.externalMessageId },
          data: {
            msg_type: "interactive",
            reply_in_thread: true,
            content: JSON.stringify({
              config: { wide_screen_mode: true },
              header: { title: { tag: "plain_text", content: request.title } },
              elements: [
                { tag: "div", text: { tag: "plain_text", content: summary } },
                {
                  tag: "action",
                  actions: [
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "Approve once" },
                      type: "primary",
                      value: { approvalId: id, decision: "accept" },
                    },
                    {
                      tag: "button",
                      text: { tag: "plain_text", content: "Deny" },
                      type: "danger",
                      value: { approvalId: id, decision: "decline" },
                    },
                  ],
                },
              ],
            }),
          },
        }),
      { maxAttempts: 1 },
    );
    if (result.code !== 0 || !result.data?.message_id) throw new Error("APPROVAL_MESSAGE_FAILED");
    return result.data.message_id;
  }

  async finish(approval: Approval, text: string): Promise<void> {
    if (!approval.messageId) return;
    if (approval.authority.provider === "slack") {
      const material = await this.bindings.getSlackConnectionMaterial(approval.imBindingId);
      if (!material || material.generation !== approval.authority.generation) return;
      await this.policy.run(
        "slack.approval.update",
        () =>
          new WebClient(material.botAccessToken, { retryConfig: { retries: 0 } }).chat.update({
            channel: approval.authority.channelId,
            ts: approval.messageId as string,
            text,
            blocks: [{ type: "section", text: { type: "plain_text", text } }],
          }),
        { maxAttempts: 1 },
      );
      return;
    }
    const client = await this.feishuClient(approval);
    const result = await this.policy.run(
      "feishu.approval.update",
      () =>
        client.im.v1.message.patch({
          path: { message_id: approval.messageId as string },
          data: {
            content: JSON.stringify({
              elements: [{ tag: "div", text: { tag: "plain_text", content: text } }],
            }),
          },
        }),
      { maxAttempts: 1 },
    );
    if (result.code !== 0) throw new Error("APPROVAL_UPDATE_FAILED");
  }

  private async feishuClient(approval: Approval) {
    const material = await this.bindings.getFeishuConnectionMaterial(approval.imBindingId);
    if (!material || material.generation !== approval.authority.generation) throw new Error("APPROVAL_BINDING_STALE");
    return new Client({
      appId: material.appId,
      appSecret: material.appSecret,
      domain: feishuDomainForWorkspaceBrand(material.teamBrand),
      loggerLevel: LoggerLevel.error,
    });
  }
}
