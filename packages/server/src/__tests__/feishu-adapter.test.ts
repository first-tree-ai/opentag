import { Readable } from "node:stream";
import {
  Domain,
  type EventDispatcher,
  type LarkChannel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  createFeishuHttpCapability,
  createReliableFeishuDispatcher,
  FeishuAdapter,
  feishuDomainForWorkspaceBrand,
  normalizeFeishuMessage,
} from "../services/im-bindings/feishu/adapter.js";

describe("Feishu adapter", () => {
  it("maps Channel SDK message, thread, mention, and resource fields", () => {
    const message: NormalizedMessage = {
      messageId: "om_1",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_human",
      senderName: "Human",
      content: "@_user_1 hello",
      rawContentType: "post",
      resources: [{ type: "image", fileKey: "img_1", fileName: "image.png" }],
      mentions: [{ key: "@_user_1", openId: "ou_bot", name: "Agent", isBot: true }],
      mentionAll: false,
      mentionedBot: true,
      rootId: "om_root",
      threadId: "omt_1",
      replyToMessageId: "om_parent",
      createTime: 1_724_025_600_000,
      raw: { header: { event_id: "ev_1", tenant_key: "workspace_1" } },
    };
    const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message });
    expect(event).toMatchObject({
      providerEventId: "ev_1",
      externalAppId: "cli_1",
      externalTeamId: "workspace_1",
      providerContext: {
        provider: "feishu",
        chatType: "group",
        threadId: "omt_1",
        rootId: "om_root",
        parentId: "om_parent",
      },
      conversation: { externalId: "oc_1", kind: "channel" },
      message: {
        externalId: "om_1",
        threadKey: "omt_1",
        replyToExternalId: "om_parent",
        content: {
          fallbackText: "@_user_1 hello",
          blocks: [
            { type: "mention", externalId: "ou_bot", label: "@Agent" },
            { type: "text", text: " hello" },
          ],
        },
      },
      mentions: [{ externalId: "ou_bot", displayName: "Agent" }],
    });
    expect(event?.message.resources[0]).toMatchObject({ providerResourceKey: "img_1", kind: "image" });
  });

  it("preserves a Feishu thread without inventing a missing root", () => {
    const message: NormalizedMessage = {
      messageId: "om_reply",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_human",
      content: "reply",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      threadId: "omt_1",
      replyToMessageId: "om_parent",
      createTime: 1_724_025_600_000,
      raw: { header: { event_id: "ev_2", tenant_key: "workspace_1" } },
    };
    const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message });
    expect(event).toMatchObject({
      providerContext: {
        provider: "feishu",
        chatType: "group",
        threadId: "omt_1",
        parentId: "om_parent",
      },
      message: { threadKey: "omt_1" },
    });
    expect(event?.providerContext).not.toHaveProperty("rootId");
  });

  it("uses the external Workspace authorization response as the capability authority", async () => {
    const adapter = new FeishuAdapter({
      appId: "cli_1",
      appSecret: "secret",
      teamId: null,
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

    await expect(adapter.listGrantedWorkspaceScopes()).resolves.toEqual(["im:message:send_as_bot"]);
  });

  it("routes international Workspaces through the Lark API domain", () => {
    expect(feishuDomainForWorkspaceBrand("lark")).toBe(Domain.Lark);
    expect(feishuDomainForWorkspaceBrand("feishu")).toBe(Domain.Feishu);
  });

  it("uses the HTTP resource capability without constructing or owning an inbound Channel", async () => {
    const fetchResource = vi.fn(async () => ({ stream: Readable.from(Buffer.from("resource")) }));
    const adapter = new FeishuAdapter({
      appId: "cli_http",
      appSecret: "secret",
      teamId: "workspace_http",
      channel: null,
      http: {
        fetchResource,
      },
    });
    await expect(
      adapter.fetchResource({ messageExternalId: "om_1", providerResourceKey: "file_1", kind: "file" }),
    ).resolves.toMatchObject({ stream: expect.any(Readable) });
    expect(() => adapter.channel).toThrow("FEISHU_INBOUND_CHANNEL_UNAVAILABLE");
  });

  it("creates a read-only HTTP capability for provider resources", async () => {
    const get = vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.from("resource")) });
    const http = createFeishuHttpCapability({
      im: {
        v1: {
          messageResource: { get },
        },
      },
    });
    await expect(
      http.fetchResource({ messageExternalId: "om_1", providerResourceKey: "file_1", kind: "file" }),
    ).resolves.toMatchObject({ stream: expect.any(Readable) });
    expect(get).toHaveBeenCalledTimes(1);
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

  it("does not invent an edit operation from the receive payload update_time field", async () => {
    const raw = rawMessage("ev-update-time", "om-update-time", "1");
    Object.assign(raw.event.message, { update_time: "2" });
    let received: NormalizedMessage | undefined;
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received = message;
    });
    await dispatcher.invoke(raw, { needCheck: false });
    expect((received?.raw as { opentagOperation?: string } | undefined)?.opentagOperation).toBe("created");
    expect(received?.createTime).toBe(1);
  });

  it("marks recall conversation scope unknown instead of guessing DM or group semantics", async () => {
    let received: NormalizedMessage | undefined;
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received = message;
    });
    await dispatcher.invoke(
      {
        schema: "2.0",
        header: { event_id: "ev-recall", event_type: "im.message.recalled_v1", tenant_key: "workspace_1" },
        event: {
          tenant_key: "workspace_1",
          message_id: "om-recalled",
          chat_id: "oc_1",
          recall_time: "2",
        },
      },
      { needCheck: false },
    );
    const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message: received as never });
    expect(event).toMatchObject({
      conversation: { externalId: "oc_1", kind: "unknown" },
      message: { externalId: "om-recalled", operation: "deleted" },
    });
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
    header: { event_id: eventId, event_type: "im.message.receive_v1", tenant_key: "workspace_1" },
    event: {
      sender: { sender_id: { open_id: "ou_human" }, sender_type: "user", tenant_key: "workspace_1" },
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
