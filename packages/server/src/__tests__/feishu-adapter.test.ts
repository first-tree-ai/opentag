import {
  Domain,
  type EventDispatcher,
  type LarkChannel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import {
  createReliableFeishuDispatcher,
  FeishuAdapter,
  feishuDomainForTenantBrand,
  normalizeFeishuMessage,
} from "../services/integrations/feishu/adapter.js";

describe("Feishu adapter", () => {
  it("maps Channel SDK message, thread, mention, and resource fields", () => {
    const message: NormalizedMessage = {
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_human",
      senderName: "Human",
      content: "hello @Agent",
      rawContentType: "post",
      resources: [{ type: "image", fileKey: "img_1", fileName: "image.png" }],
      mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Agent", isBot: true }],
      mentionAll: false,
      mentionedBot: true,
      rootId: "om_root",
      threadId: "omt_1",
      replyToMessageId: "om_parent",
      createTime: 1_724_025_600_000,
      raw: { header: { event_id: "ev_1", tenant_key: "tenant_1" } },
    };
    const [event] = normalizeFeishuMessage({ appId: "cli_1", tenantKey: "tenant_1", message });
    expect(event).toMatchObject({
      providerEventId: "ev_1",
      externalAppId: "cli_1",
      externalTenantId: "tenant_1",
      conversation: { externalId: "oc_1", kind: "channel" },
      message: { externalId: "om_1", threadKey: "omt_1", replyToExternalId: "om_parent" },
      mentions: [{ externalId: "ou_bot", displayName: "Agent" }],
    });
    expect(event?.message.resources[0]).toMatchObject({ providerResourceKey: "img_1", kind: "image" });
  });

  it("uses the tenant authorization response as the capability authority", async () => {
    const adapter = new FeishuAdapter({
      appId: "cli_1",
      appSecret: "secret",
      tenantKey: null,
      channel: {} as LarkChannel,
      scopeList: async () => ({
        code: 0,
        data: {
          scopes: [
            { scope_name: "im:message:send_as_bot", grant_status: 1, scope_type: "tenant" },
            { scope_name: "im:message.group_msg", grant_status: 2, scope_type: "tenant" },
            { scope_name: "contact:user.id:readonly", grant_status: 1, scope_type: "user" },
          ],
        },
      }),
    });

    await expect(adapter.listGrantedTenantScopes()).resolves.toEqual(["im:message:send_as_bot"]);
  });

  it("routes international tenants through the Lark API domain", () => {
    expect(feishuDomainForTenantBrand("lark")).toBe(Domain.Lark);
    expect(feishuDomainForTenantBrand("feishu")).toBe(Domain.Feishu);
  });

  it("awaits each raw provider event and propagates admission failure without safety batching or stale-drop", async () => {
    let release: (() => void) | undefined;
    const admitted: string[] = [];
    const dispatcher = createReliableFeishuDispatcher(async (message) => {
      admitted.push(message.messageId);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = dispatcher.invoke(rawMessage("ev-old", "om-old", "1"), { needCheck: false });
    await Promise.resolve();
    expect(admitted).toEqual(["om-old"]);
    let settled = false;
    void first.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await first;

    const failing = createReliableFeishuDispatcher(async () => {
      throw new Error("database unavailable");
    });
    await expect(failing.invoke(rawMessage("ev-fail", "om-fail", "2"), { needCheck: false })).rejects.toThrow(
      "database unavailable",
    );
  });

  it("keeps the pinned WS acknowledgment open through admission and maps rejection to 500", async () => {
    let release: (() => void) | undefined;
    const success = createReliableFeishuDispatcher(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const pending = invokePinnedWs(success, rawMessage("ev-ok", "om-ok", "1"));
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();
    await expect(pending).resolves.toBe(200);

    const failing = createReliableFeishuDispatcher(async () => {
      throw new Error("database unavailable");
    });
    await expect(invokePinnedWs(failing, rawMessage("ev-fail-ack", "om-fail-ack", "2"))).resolves.toBe(500);
  });
});

async function invokePinnedWs(dispatcher: EventDispatcher, body: unknown): Promise<number> {
  type WsContract = {
    eventDispatcher?: EventDispatcher;
    handleEventData(data: { headers: Array<{ key: string; value: string }>; payload: Uint8Array }): Promise<void>;
    sendMessage(data: { payload: Uint8Array }): void;
    close(input: { force: boolean }): void;
  };
  const logger = { error() {}, warn() {}, info() {}, debug() {}, trace() {} };
  const client = new WSClient({
    appId: "cli_1",
    appSecret: "secret",
    autoReconnect: false,
    logger,
  }) as unknown as WsContract;
  client.eventDispatcher = dispatcher;
  let code: number | undefined;
  client.sendMessage = (frame) => {
    code = (JSON.parse(new TextDecoder().decode(frame.payload)) as { code: number }).code;
  };
  try {
    await client.handleEventData({
      headers: [
        { key: "message_id", value: crypto.randomUUID() },
        { key: "sum", value: "1" },
        { key: "seq", value: "0" },
        { key: "type", value: "event" },
        { key: "trace_id", value: crypto.randomUUID() },
      ],
      payload: new TextEncoder().encode(JSON.stringify(body)),
    });
  } finally {
    client.close({ force: true });
  }
  if (code === undefined) throw new Error("Pinned Feishu SDK did not emit an acknowledgment");
  return code;
}

function rawMessage(eventId: string, messageId: string, createTime: string) {
  return {
    schema: "2.0",
    header: { event_id: eventId, event_type: "im.message.receive_v1", tenant_key: "tenant_1" },
    event: {
      sender: { sender_id: { open_id: "ou_human" }, sender_type: "user", tenant_key: "tenant_1" },
      message: {
        message_id: messageId,
        create_time: createTime,
        chat_id: "oc_1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: messageId }),
      },
    },
  };
}
