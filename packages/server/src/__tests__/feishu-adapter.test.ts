import { Readable } from "node:stream";
import {
  Client,
  Domain,
  type EventDispatcher,
  type LarkChannel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { agentAvatarPath, FEISHU_REQUIRED_TENANT_SCOPES, RuntimeProviderMessageRefSchema } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { agents, computers, imBindings, imMessages } from "../db/schema/index.js";
import { createPerformanceLogger, instrumentServerWorkers } from "../observability/index.js";
import { runtimeProviderMessageRef } from "../runtime/runtime-provider-message-ref.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import { ExternalCallPolicy } from "../services/im/external-call-policy.js";
import {
  createFeishuHttpCapability,
  createReliableFeishuDispatcher,
  FeishuAdapter,
  type FeishuChatMetadata,
  feishuDomainForWorkspaceBrand,
  normalizeFeishuMessage,
} from "../services/im-bindings/feishu/adapter.js";
import { FeishuConnectionManager } from "../services/im-bindings/feishu/connection-manager.js";
import { FeishuOperationError } from "../services/im-bindings/feishu/errors.js";
import { ImBindingService } from "../services/im-bindings/index.js";
import { createUnitDatabase, type UnitDatabase } from "./support/unit-database.js";

let connectionDatabase: UnitDatabase;
const connectionNow = new Date("2026-08-19T00:00:00.000Z");

beforeAll(async () => {
  connectionDatabase = await createUnitDatabase();
}, 60_000);
afterAll(async () => connectionDatabase?.close());
beforeEach(async () => connectionDatabase?.reset());

async function connectionFixture() {
  const bootstrap = await bootstrapTestAccount(connectionDatabase.database, {
    displayName: "Admin",
    email: `connection-${crypto.randomUUID()}@example.com`,
  });
  const [computer] = await connectionDatabase.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "connection-computer",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.1",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const agent = await new AgentService(connectionDatabase.database).createForAccount(bootstrap.userId, {
    name: "connection-agent",
    displayName: "Connection Agent",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindings = new ImBindingService(connectionDatabase.database, cipher, { now: () => connectionNow });
  return { bootstrap, agent, cipher, imBindings, computer };
}

describe("Feishu adapter", () => {
  it("reads the actual Feishu app name and avatar without opening a channel", async () => {
    const request = vi.spyOn(Client.prototype, "request").mockResolvedValue({
      code: 0,
      bot: {
        open_id: "ou_profile",
        app_name: "Actual Feishu Cat",
        avatar_url: "https://example.com/cat.png",
        activate_status: 2,
      },
    });
    try {
      const adapter = new FeishuAdapter({ appId: "cli_profile", appSecret: "secret", teamId: null, channel: null });
      await expect(adapter.probeBotIdentity()).resolves.toEqual({
        openId: "ou_profile",
        activateStatus: 2,
        profile: { displayName: "Actual Feishu Cat", avatarUrl: "https://example.com/cat.png" },
      });
      expect(request).toHaveBeenCalledWith({ url: "/open-apis/bot/v3/info", method: "GET" });
    } finally {
      request.mockRestore();
    }
  });

  it("preserves profiles through reauthorization and rejected replacement", async () => {
    const value = await connectionFixture();
    const input = {
      agentId: value.agent.id,
      appId: "cli_profile",
      teamId: "tenant_1",
      botOpenId: "ou_bot",
      appSecret: "secret",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    };
    const profile = { displayName: "Actual Cat", avatarUrl: "https://example.com/feishu.png" };
    await value.imBindings.activateFeishu({ ...input, profile });
    const read = () => value.imBindings.getForAgent(value.bootstrap.userId, value.agent.id);
    expect((await read())?.bot).toEqual(profile);
    const service = new AgentService(connectionDatabase.database);
    expect((await service.getById(value.bootstrap.userId, value.agent.id)).avatarPath).toBe(
      agentAvatarPath(value.agent.id),
    );
    expect((await service.listForAccount(value.bootstrap.userId)).agents[0]?.avatarPath).toBe(
      agentAvatarPath(value.agent.id),
    );
    const newer = { ...profile, avatarUrl: "https://example.com/new.png" };
    await value.imBindings.activateFeishu({ ...input, profile: newer });
    expect((await read())?.bot).toEqual(newer);
    await value.imBindings.activateFeishu(input);
    expect((await read())?.bot).toEqual(newer);
    await expect(
      value.imBindings.activateFeishu({ ...input, appId: "cli_replacement", botOpenId: "ou_other" }),
    ).rejects.toMatchObject({ code: "IM_BINDING_CONFIGURATION_CONFLICT" });
    expect((await read())?.bot).toEqual(newer);
  });

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

  it("keeps a quote reply without thread_id out of Thread Sessions", () => {
    const message: NormalizedMessage = {
      messageId: "om_quote",
      chatId: "oc_1",
      chatType: "group",
      senderId: "ou_human",
      content: "quoted reply",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      rootId: "om_root",
      replyToMessageId: "om_parent",
      createTime: 1_724_025_600_000,
      raw: { header: { event_id: "ev_quote", tenant_key: "workspace_1" } },
    };
    const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message });
    expect(event).toMatchObject({
      providerContext: { provider: "feishu", chatType: "group", rootId: "om_root", parentId: "om_parent" },
      conversation: { externalId: "oc_1", kind: "channel" },
      message: { threadKey: null, replyToExternalId: "om_parent" },
    });
  });

  it("keys a Feishu topic-group topic by its thread_id, including the topic root", () => {
    const message: NormalizedMessage = {
      messageId: "om_topic_root",
      chatId: "oc_topic",
      chatType: "group",
      senderId: "ou_human",
      content: "new topic",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      threadId: "omt_topic",
      createTime: 1_724_025_600_000,
      raw: { header: { event_id: "ev_topic", tenant_key: "workspace_1" }, opentagChatMode: "topic" },
    };
    const [event] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message });
    expect(event).toMatchObject({
      providerContext: { provider: "feishu", chatMode: "topic", threadId: "omt_topic" },
      message: { threadKey: "omt_topic", replyToExternalId: null },
    });
  });

  it("parses raw text, media, post, malformed, and unsupported events", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const malformed = rawMessage("ev-malformed", "om-malformed", "1");
    malformed.event.message.content = "not-json";
    const image = rawMessage("ev-image", "om-image", "2");
    image.event.message.message_type = "image";
    image.event.message.content = JSON.stringify({ image_key: "img_1", file_name: "image.png" });
    const file = rawMessage("ev-file", "om-file", "3");
    file.event.message.message_type = "file";
    file.event.message.content = JSON.stringify({ file_key: "file_1" });
    const post = rawMessage("ev-post", "om-post", "4");
    post.event.message.message_type = "post";
    post.event.message.content = JSON.stringify({
      zh_cn: { title: "Title", content: [[{ tag: "text", text: "first" }], [{ tag: "text", text: "second" }]] },
    });
    const unsupported = rawMessage("ev-unsupported", "om-unsupported", "5");
    unsupported.event.message.message_type = "sticker";
    unsupported.event.message.content = JSON.stringify({ sticker: "unknown" });
    await dispatcher.invoke(malformed, { needCheck: false });
    await dispatcher.invoke(image, { needCheck: false });
    await dispatcher.invoke(file, { needCheck: false });
    await dispatcher.invoke(post, { needCheck: false });
    await dispatcher.invoke(unsupported, { needCheck: false });
    expect(received.map((message) => message.content)).toEqual([
      "[unsupported:text]",
      "[image]",
      "[file]",
      "Title\nfirst\nsecond",
      "[unsupported:sticker]",
    ]);
    expect(received[1]?.resources[0]).toMatchObject({ fileKey: "img_1", fileName: "image.png" });
    expect(received[2]?.resources[0]).toMatchObject({ fileKey: "file_1" });
  });

  it("reads a rich-text message's paragraphs once when Feishu also sends them as markdown", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    // Feishu delivers a `post` twice over: `content` as tagged elements and `content_v2` as
    // markdown. Every paragraph is in both, so reading both repeats the whole message.
    const post = rawMessage("ev-post-v2", "om-post-v2", "6");
    post.event.message.message_type = "post";
    post.event.message.content = JSON.stringify({
      title: "",
      content: [[{ tag: "text", text: "检查当前 Agent 的运行状态", style: [] }]],
      content_v2: [[{ tag: "md", text: "检查当前 Agent 的运行状态" }]],
    });
    await dispatcher.invoke(post, { needCheck: false });
    expect(received.map((message) => message.content)).toEqual(["检查当前 Agent 的运行状态"]);
  });

  it("keeps the runs of one rich-text paragraph on one line and writes an @ element as its mention key", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const post = rawMessage("ev-post-runs", "om-post-runs", "7");
    post.event.message.message_type = "post";
    post.event.message.content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "at", user_id: "ou_bot", user_name: "Atlas" },
          { tag: "text", text: " please ", style: [] },
          { tag: "text", text: "fix", style: ["bold"] },
          { tag: "a", text: " the docs", href: "https://example.com/docs" },
        ],
        [{ tag: "img", image_key: "img_1" }],
        [{ tag: "text", text: "before 5pm", style: [] }],
      ],
    });
    (post.event.message as { mentions?: unknown }).mentions = [
      { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Atlas", mentioned_type: "app" },
    ];
    await dispatcher.invoke(post, { needCheck: false });
    expect(received.map((message) => message.content)).toEqual([
      "@_user_1 please **fix**[ the docs](https://example.com/docs)\n[Attachment 1]\nbefore 5pm",
    ]);
  });

  it("writes an @ element without a usable id by name rather than matching a mention without one", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const post = rawMessage("ev-post-at", "om-post-at", "9");
    post.event.message.message_type = "post";
    post.event.message.content = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "at", user_name: "Someone" },
          { tag: "text", text: " hi", style: [] },
        ],
      ],
    });
    (post.event.message as { mentions?: unknown }).mentions = [{ key: "@_user_1", id: {}, name: "Other" }];
    await dispatcher.invoke(post, { needCheck: false });
    expect(received.map((message) => message.content)).toEqual(["@Someone hi"]);
  });

  it("keeps tagged attachments alongside a rich-text message's original markdown", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const post = rawMessage("ev-post-md", "om-post-md", "8");
    post.event.message.message_type = "post";
    post.event.message.content = JSON.stringify({
      title: "",
      content: [[{ tag: "img", image_key: "img_1" }]],
      content_v2: [[{ tag: "md", text: "**检查** 状态" }]],
    });
    await dispatcher.invoke(post, { needCheck: false });
    expect(received.map((message) => message.content)).toEqual(["**检查** 状态\n[Attachment 1]"]);
    expect(received[0]?.resources).toEqual([{ type: "image", fileKey: "img_1" }]);
  });

  it("deduplicates a repeated group/thread representation by provider event identity", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const groupThreadEvent = rawMessage("event-group-thread", "message-group-thread", "10");
    groupThreadEvent.event.message.chat_id = "oc_example_group";
    Object.assign(groupThreadEvent.event.message, { thread_id: "omt_example_thread" });
    const threadRepresentation = structuredClone(groupThreadEvent);
    threadRepresentation.header.event_id = "event-thread-representation";

    await Promise.all([
      dispatcher.invoke(groupThreadEvent, { needCheck: false }),
      dispatcher.invoke(threadRepresentation, { needCheck: false }),
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      chatId: "oc_example_group",
      threadId: "omt_example_thread",
      raw: {
        event_id: "event-group-thread",
        tenant_key: "workspace_1",
        opentagSenderOpenId: "ou_human",
      },
    });
  });

  it("keeps distinct messages in the same group chat and thread", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const first = rawMessage("event-distinct-1", "message-distinct-1", "11");
    const second = rawMessage("event-distinct-2", "message-distinct-2", "12");
    for (const event of [first, second]) {
      event.event.message.chat_id = "oc_example_group";
      Object.assign(event.event.message, { thread_id: "omt_example_thread" });
      await dispatcher.invoke(event, { needCheck: false });
    }

    expect(received.map((message) => message.messageId)).toEqual(["message-distinct-1", "message-distinct-2"]);
  });

  it("does not let an event ID from one conversation suppress another conversation", async () => {
    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const first = rawMessage("event-reused", "message-chat-a", "13");
    const second = rawMessage("event-reused", "message-chat-b", "13");
    second.event.message.chat_id = "oc_other_chat";
    await dispatcher.invoke(first, { needCheck: false });
    await dispatcher.invoke(second, { needCheck: false });
    expect(received.map((message) => message.chatId)).toEqual(["oc_1", "oc_other_chat"]);
  });

  it("falls back to user sender ids and maps raw mentions", async () => {
    let received: NormalizedMessage | undefined;
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received = message;
    });
    const raw = rawMessage("ev-mention", "om-mention", "6");
    (raw.event.sender.sender_id as { open_id?: string; user_id?: string }) = { user_id: "ou_user" };
    raw.event.sender.sender_type = "app";
    raw.event.message.content = JSON.stringify({ text: "hello @_all" });
    (raw.event.message as { mentions?: unknown[] }).mentions = [
      { key: "@bot", id: { open_id: "ou_bot" }, mentioned_type: "app", name: "Bot" },
      { key: "@user", id: { user_id: "u_user" }, name: "User" },
    ];
    await dispatcher.invoke(raw, { needCheck: false });
    expect(received).toMatchObject({
      senderId: "ou_user",
      mentionAll: true,
      mentions: [
        { key: "@bot", openId: "ou_bot", name: "Bot", isBot: true },
        { key: "@user", userId: "u_user", name: "User", isBot: false },
      ],
    });
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

  it("bounds oversized content and ignores mentions without an external id", () => {
    const [event] = normalizeFeishuMessage({
      appId: "cli_large",
      teamId: "tenant_large",
      message: {
        messageId: "om_large",
        chatId: "oc_large",
        chatType: "group",
        senderId: "ou_human",
        content: "x".repeat(24 * 1024 + 10),
        rawContentType: "text",
        resources: [],
        mentions: [{ key: "@missing", name: "", isBot: false }],
        mentionAll: false,
        mentionedBot: false,
        createTime: 1,
        raw: { header: { event_id: "ev_large", tenant_key: "tenant_large" } },
      },
    });
    expect(event?.message.content.truncated).toBe(true);
    expect(event?.mentions).toEqual([]);
  });

  it("runs the default reliable Channel lifecycle with an isolated SDK", async () => {
    vi.resetModules();
    const actual = await vi.importActual<typeof import("@larksuiteoapi/node-sdk")>("@larksuiteoapi/node-sdk");
    const outbound = {
      botIdentity: { openId: "ou_default", name: "Default Bot" },
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    class FakeWsClient {
      static instances: FakeWsClient[] = [];
      static startCalls = 0;
      readonly options: {
        onReady?: () => void;
        onError?: (error: unknown) => void;
        onReconnecting?: () => void;
        onReconnected?: () => void;
      };
      constructor(options: FakeWsClient["options"]) {
        this.options = options;
        FakeWsClient.instances.push(this);
      }
      async start(): Promise<void> {
        FakeWsClient.startCalls += 1;
        this.options.onReady?.();
      }
      close(): void {}
    }
    vi.doMock("@larksuiteoapi/node-sdk", () => ({
      ...actual,
      WSClient: FakeWsClient,
      createLarkChannel: vi.fn(() => outbound),
    }));
    try {
      const module = await import("../services/im-bindings/feishu/adapter.js");
      const adapter = new module.FeishuAdapter({ appId: "cli_default", appSecret: "secret", teamId: null });
      expect(FakeWsClient.startCalls).toBe(0);
      await expect(adapter.validateBinding()).resolves.toEqual({
        externalAppId: "cli_default",
        externalTeamId: "cli_default",
        externalBotId: "ou_default",
      });
      expect(FakeWsClient.startCalls).toBe(1);
      const reconnecting = vi.fn();
      const reconnected = vi.fn();
      const error = vi.fn();
      const handlers = { reconnecting, reconnected, error };
      const unsubscribe = adapter.channel.on(handlers);
      const ws = FakeWsClient.instances.at(-1);
      ws?.options.onReconnecting?.();
      ws?.options.onReconnected?.();
      ws?.options.onError?.(new Error("socket closed"));
      expect(reconnecting).toHaveBeenCalledTimes(1);
      expect(reconnected).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledTimes(1);
      adapter.channel.on({});
      unsubscribe();
      const finalUnsubscribe = adapter.channel.on(handlers);
      finalUnsubscribe();
      await adapter.channel.disconnect();
      expect(outbound.connect).toHaveBeenCalledTimes(1);
      expect(outbound.disconnect).toHaveBeenCalledTimes(1);

      // Late outbound.connect() resolution after abort + disconnect is quarantined
      let resolveOutboundConnect!: () => void;
      outbound.connect.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveOutboundConnect = resolve;
          }),
      );
      outbound.disconnect.mockClear();
      const abortController = new AbortController();
      const abortedAdapter = new module.FeishuAdapter({ appId: "cli_aborted", appSecret: "secret", teamId: null });
      const pendingValidate = abortedAdapter.validateBinding(abortController.signal);
      abortController.abort(new Error("FEISHU_CONNECT_CANCELLED"));
      await expect(pendingValidate).rejects.toThrow("FEISHU_CONNECT_CANCELLED");
      await abortedAdapter.channel.disconnect();
      resolveOutboundConnect();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(abortedAdapter.channel.botIdentity).toBeUndefined();
      expect(outbound.disconnect.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Two-microtask abort race when outbound.connect() and onReady resolve immediately
      const microtaskAbort = new AbortController();
      const racedAdapter = new module.FeishuAdapter({ appId: "cli_microtask", appSecret: "secret", teamId: null });
      queueMicrotask(() => {
        queueMicrotask(() => {
          microtaskAbort.abort(new Error("FEISHU_MICROTASK_ABORT"));
        });
      });
      await expect(racedAdapter.validateBinding(microtaskAbort.signal)).rejects.toThrow("FEISHU_MICROTASK_ABORT");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(racedAdapter.channel.botIdentity).toBeUndefined();
    } finally {
      vi.doUnmock("@larksuiteoapi/node-sdk");
      vi.resetModules();
    }
  });

  it("creates a read-only HTTP capability for provider resources", async () => {
    const get = vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.from("resource")) });
    const getChatMembers = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: "ou_other", name: "Other" }],
          has_more: true,
          page_token: "next",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: { items: [{ member_id: "ou_sender", name: " Mia Zhang " }], has_more: false },
      });
    const http = createFeishuHttpCapability({
      im: {
        v1: {
          chatMembers: { get: getChatMembers },
          messageResource: { get },
        },
      },
    });
    const signal = new AbortController().signal;
    await expect(
      http.fetchResource({ messageExternalId: "om_1", providerResourceKey: "file_1", kind: "file" }, signal),
    ).resolves.toMatchObject({ stream: expect.any(Readable) });
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith(
      {
        path: { message_id: "om_1", file_key: "file_1" },
        params: { type: "file" },
      },
      { signal },
    );

    await expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_sender" })).resolves.toBe("Mia Zhang");
    await expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_other" })).resolves.toBe("Other");
    expect(getChatMembers).toHaveBeenCalledTimes(2);
    expect(getChatMembers).toHaveBeenLastCalledWith({
      path: { chat_id: "oc_1" },
      params: { member_id_type: "open_id", page_size: 100, page_token: "next" },
    });
  });

  it("retires a timed-out sender-name lookup so a later request can retry", async () => {
    vi.useFakeTimers();
    try {
      const getChatMembers = vi
        .fn()
        .mockReturnValueOnce(new Promise(() => undefined))
        .mockResolvedValueOnce({
          code: 0,
          data: { items: [{ member_id: "ou_sender", name: "Mia Zhang" }], has_more: false },
        });
      const http = createFeishuHttpCapability({
        im: {
          v1: {
            chatMembers: { get: getChatMembers },
            messageResource: {
              get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
            },
          },
        },
      });
      const timedOut = expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_sender" })).rejects.toThrow(
        "FEISHU_SENDER_NAME_LOOKUP_TIMEOUT",
      );

      await vi.advanceTimersByTimeAsync(4_000);
      await timedOut;
      await expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_sender" })).resolves.toBe("Mia Zhang");
      expect(getChatMembers).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scans past the third member page before the sender-name lookup expires", async () => {
    vi.useFakeTimers();
    try {
      let page = 0;
      const getChatMembers = vi.fn(async () => {
        page += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (page < 5) {
          return {
            code: 0,
            data: {
              items: [{ member_id: `ou_page_${page}`, name: `Member ${page}` }],
              has_more: true,
              page_token: `token_${page}`,
            },
          };
        }
        return { code: 0, data: { items: [{ member_id: "ou_sender", name: "Late Sender" }], has_more: false } };
      });
      const http = createFeishuHttpCapability({
        im: {
          v1: {
            chatMembers: { get: getChatMembers },
            messageResource: {
              get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
            },
          },
        },
      });

      const resolved = http.resolveSenderName?.({ chatId: "oc_large", senderOpenId: "ou_sender" });
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(resolved).resolves.toBe("Late Sender");
      expect(getChatMembers).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the lookup timeout before the adapter policy deadline", async () => {
    vi.useFakeTimers();
    try {
      const http = createFeishuHttpCapability({
        im: {
          v1: {
            chatMembers: { get: vi.fn().mockReturnValue(new Promise(() => undefined)) },
            messageResource: {
              get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
            },
          },
        },
      });
      const adapter = new FeishuAdapter({
        appId: "cli_sender_name_budget",
        appSecret: "secret",
        teamId: null,
        channel: null,
        http,
        policy: new ExternalCallPolicy(),
      });

      const outcome = adapter.resolveSenderName({ chatId: "oc_1", senderOpenId: "ou_sender" }).then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      await vi.advanceTimersByTimeAsync(4_000);

      await expect(outcome).resolves.toBe("FEISHU_SENDER_NAME_LOOKUP_TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent same-chat sender-name lookups and resolves early page hits before later pages finish", async () => {
    let releaseSecondPage: (() => void) | undefined;
    const getChatMembers = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { member_id: "ou_page_1_a", name: "Alice" },
            { member_id: "ou_page_1_b", name: "Bob" },
          ],
          has_more: true,
          page_token: "page_2",
        },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecondPage = () =>
              resolve({
                code: 0,
                data: {
                  items: [{ member_id: "ou_page_2", name: "Charlie" }],
                  has_more: false,
                },
              });
          }),
      );
    const http = createFeishuHttpCapability({
      im: {
        v1: {
          chatMembers: { get: getChatMembers },
          messageResource: {
            get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
          },
        },
      },
    });

    const firstA = http.resolveSenderName?.({ chatId: "oc_shared", senderOpenId: "ou_page_1_a" });
    const firstB = http.resolveSenderName?.({ chatId: "oc_shared", senderOpenId: "ou_page_1_b" });
    const secondPage = http.resolveSenderName?.({ chatId: "oc_shared", senderOpenId: "ou_page_2" });

    await expect(Promise.all([firstA, firstB])).resolves.toEqual(["Alice", "Bob"]);
    expect(getChatMembers).toHaveBeenCalledTimes(2);
    expect(getChatMembers).toHaveBeenNthCalledWith(1, {
      path: { chat_id: "oc_shared" },
      params: { member_id_type: "open_id", page_size: 100 },
    });
    expect(getChatMembers).toHaveBeenNthCalledWith(2, {
      path: { chat_id: "oc_shared" },
      params: { member_id_type: "open_id", page_size: 100, page_token: "page_2" },
    });

    releaseSecondPage?.();
    await expect(secondPage).resolves.toBe("Charlie");
    expect(getChatMembers).toHaveBeenCalledTimes(2);
  });

  it("resumes pagination from the next page token on sequential lookups in the same chat", async () => {
    const getChatMembers = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: "ou_1", name: "User One" }],
          has_more: true,
          page_token: "token_page_2",
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: "ou_2", name: "User Two" }],
          has_more: false,
        },
      });
    const http = createFeishuHttpCapability({
      im: {
        v1: {
          chatMembers: { get: getChatMembers },
          messageResource: {
            get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
          },
        },
      },
    });

    await expect(http.resolveSenderName?.({ chatId: "oc_resume", senderOpenId: "ou_1" })).resolves.toBe("User One");
    expect(getChatMembers).toHaveBeenCalledTimes(1);

    await expect(http.resolveSenderName?.({ chatId: "oc_resume", senderOpenId: "ou_2" })).resolves.toBe("User Two");
    expect(getChatMembers).toHaveBeenCalledTimes(2);
    expect(getChatMembers).toHaveBeenNthCalledWith(2, {
      path: { chat_id: "oc_resume" },
      params: { member_id_type: "open_id", page_size: 100, page_token: "token_page_2" },
    });
  });

  it("does not restore a successor cursor when earlier chat members are evicted during an in-flight page fetch", async () => {
    let releasePage2: (() => void) | undefined;
    const targetCalls: Array<string | undefined> = [];
    const getChatMembers = vi
      .fn()
      .mockImplementation((request: { path?: { chat_id?: string }; params?: { page_token?: string } }) => {
        const chatId = request.path?.chat_id ?? "";
        const pageToken = request.params?.page_token;
        if (chatId === "oc_target") {
          targetCalls.push(pageToken);
          if (!pageToken) {
            return Promise.resolve({
              code: 0,
              data: {
                items: [{ member_id: "ou_alice", name: "Alice" }],
                has_more: true,
                page_token: "a2",
              },
            });
          }
          if (pageToken === "a2") {
            return new Promise((resolve) => {
              releasePage2 = () =>
                resolve({
                  code: 0,
                  data: {
                    items: [{ member_id: "ou_bob", name: "Bob" }],
                    has_more: true,
                    page_token: "a3",
                  },
                });
            });
          }
          return Promise.resolve({
            code: 0,
            data: {
              items: [],
              has_more: false,
            },
          });
        }

        const items = Array.from({ length: 100 }, (_, index) => ({
          member_id: `ou_${chatId}_${index}`,
          name: `Member ${chatId} ${index}`,
        }));
        return Promise.resolve({
          code: 0,
          data: {
            items,
            has_more: false,
          },
        });
      });
    const http = createFeishuHttpCapability({
      im: {
        v1: {
          chatMembers: { get: getChatMembers },
          messageResource: {
            get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
          },
        },
      },
    });

    await expect(http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_alice" })).resolves.toBe("Alice");
    expect(targetCalls).toEqual([undefined]);

    const bobPromise = http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_bob" });
    expect(targetCalls).toEqual([undefined, "a2"]);

    for (let chatIndex = 0; chatIndex < 100; chatIndex += 1) {
      const chatId = `oc_fill_${chatIndex}`;
      await expect(http.resolveSenderName?.({ chatId, senderOpenId: `ou_${chatId}_0` })).resolves.toBe(
        `Member ${chatId} 0`,
      );
    }

    releasePage2?.();
    await expect(bobPromise).resolves.toBe("Bob");

    await expect(http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_alice" })).resolves.toBe("Alice");
    expect(targetCalls).toEqual([undefined, "a2", undefined]);
  });

  it("retires a detached scan when its last waiter times out so late pages do not overwrite fresher names", async () => {
    vi.useFakeTimers();
    try {
      let releaseStalePage2: (() => void) | undefined;
      let targetPage1Count = 0;
      const respondTargetPage = (pageToken: string | undefined) => {
        if (pageToken === "a2") {
          return new Promise((resolve) => {
            releaseStalePage2 = () =>
              resolve({
                code: 0,
                data: {
                  items: [{ member_id: "ou_bob", name: "Stale Bob" }],
                  has_more: false,
                },
              });
          });
        }
        targetPage1Count += 1;
        return Promise.resolve({
          code: 0,
          data:
            targetPage1Count === 1
              ? { items: [{ member_id: "ou_alice", name: "Alice" }], has_more: true, page_token: "a2" }
              : { items: [{ member_id: "ou_bob", name: "Fresh Bob" }], has_more: false },
        });
      };
      const getChatMembers = vi
        .fn()
        .mockImplementation((request: { path?: { chat_id?: string }; params?: { page_token?: string } }) => {
          const chatId = request.path?.chat_id ?? "";
          if (chatId === "oc_target") {
            return respondTargetPage(request.params?.page_token);
          }
          const items = Array.from({ length: 100 }, (_, index) => ({
            member_id: `ou_${chatId}_${index}`,
            name: `Member ${chatId} ${index}`,
          }));
          return Promise.resolve({
            code: 0,
            data: {
              items,
              has_more: false,
            },
          });
        });
      const http = createFeishuHttpCapability({
        im: {
          v1: {
            chatMembers: { get: getChatMembers },
            messageResource: {
              get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
            },
          },
        },
      });

      await expect(http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_alice" })).resolves.toBe("Alice");

      const bobTimedOut = expect(
        http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_bob" }),
      ).rejects.toThrow("FEISHU_SENDER_NAME_LOOKUP_TIMEOUT");

      for (let chatIndex = 0; chatIndex < 100; chatIndex += 1) {
        const chatId = `oc_fill_${chatIndex}`;
        await expect(http.resolveSenderName?.({ chatId, senderOpenId: `ou_${chatId}_0` })).resolves.toBe(
          `Member ${chatId} 0`,
        );
      }

      await vi.advanceTimersByTimeAsync(4_001);
      await bobTimedOut;

      await expect(http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_bob" })).resolves.toBe(
        "Fresh Bob",
      );

      releaseStalePage2?.();
      await Promise.resolve();
      await Promise.resolve();

      await expect(http.resolveSenderName?.({ chatId: "oc_target", senderOpenId: "ou_bob" })).resolves.toBe(
        "Fresh Bob",
      );
      await expect(http.resolveSenderName?.({ chatId: "oc_other", senderOpenId: "ou_bob" })).resolves.toBe("Fresh Bob");
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses resolved sender names across chats while preserving per-chat display name priority", async () => {
    const getChatMembers = vi
      .fn()
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [{ member_id: "ou_shared", name: "Global Name" }],
          has_more: false,
        },
      })
      .mockResolvedValueOnce({
        code: 0,
        data: {
          items: [
            { member_id: "ou_shared", name: "Chat 2 Nickname" },
            { member_id: "ou_chat2_only", name: "Chat 2 Member" },
          ],
          has_more: false,
        },
      });
    const http = createFeishuHttpCapability({
      im: {
        v1: {
          chatMembers: { get: getChatMembers },
          messageResource: {
            get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
          },
        },
      },
    });

    await expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_shared" })).resolves.toBe("Global Name");
    expect(getChatMembers).toHaveBeenCalledTimes(1);

    // Cross-chat lookup hits the open_id cache without another chatMembers.get request
    await expect(http.resolveSenderName?.({ chatId: "oc_2", senderOpenId: "ou_shared" })).resolves.toBe("Global Name");
    expect(getChatMembers).toHaveBeenCalledTimes(1);

    // Fetching oc_2 members for another user populates oc_2's per-chat nickname for ou_shared
    await expect(http.resolveSenderName?.({ chatId: "oc_2", senderOpenId: "ou_chat2_only" })).resolves.toBe(
      "Chat 2 Member",
    );
    expect(getChatMembers).toHaveBeenCalledTimes(2);

    await expect(http.resolveSenderName?.({ chatId: "oc_2", senderOpenId: "ou_shared" })).resolves.toBe(
      "Chat 2 Nickname",
    );
    await expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_shared" })).resolves.toBe("Global Name");
    expect(getChatMembers).toHaveBeenCalledTimes(2);
  });

  it("evicts expired sender-name cache entries and recovers after a failed chatMembers lookup", async () => {
    vi.useFakeTimers();
    try {
      const getChatMembers = vi
        .fn()
        .mockResolvedValueOnce({
          code: 99991663,
          msg: "rate limited",
        })
        .mockResolvedValueOnce({
          code: 0,
          data: {
            items: [{ member_id: "ou_1", name: "First Name" }],
            has_more: false,
          },
        })
        .mockResolvedValueOnce({
          code: 0,
          data: {
            items: [{ member_id: "ou_1", name: "Refreshed Name" }],
            has_more: false,
          },
        });
      const http = createFeishuHttpCapability({
        im: {
          v1: {
            chatMembers: { get: getChatMembers },
            messageResource: {
              get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
            },
          },
        },
      });

      await expect(http.resolveSenderName?.({ chatId: "oc_ttl", senderOpenId: "ou_1" })).rejects.toThrow(
        "FEISHU_SENDER_NAME_LOOKUP_FAILED",
      );
      await expect(http.resolveSenderName?.({ chatId: "oc_ttl", senderOpenId: "ou_1" })).resolves.toBe("First Name");
      expect(getChatMembers).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 1);
      await expect(http.resolveSenderName?.({ chatId: "oc_ttl", senderOpenId: "ou_1" })).resolves.toBe(
        "Refreshed Name",
      );
      expect(getChatMembers).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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

  it("resolves and caches Feishu chat_mode and group_message_type, aborts stalled lookups, caches failures negatively, and strips them from runtime provider refs", async () => {
    vi.useFakeTimers();
    try {
      let stalledClientSignal: AbortSignal | undefined;
      let stalledCallSignal: AbortSignal | undefined;
      const getChat = vi
        .fn()
        .mockResolvedValueOnce({ code: 0, data: { chat_mode: "topic" } })
        .mockResolvedValueOnce({ code: 0, data: { chat_mode: "group", group_message_type: "thread" } })
        .mockResolvedValueOnce({ code: 99_999, msg: "transient error" })
        .mockResolvedValueOnce({ code: 0, data: { chat_mode: "group", group_message_type: "chat" } })
        .mockImplementationOnce((_input: unknown, options?: { signal?: AbortSignal }) => {
          stalledCallSignal = options?.signal;
          return new Promise(() => undefined);
        });
      const baseClient = {
        im: {
          v1: {
            chats: { get: getChat },
            chatMembers: { get: vi.fn() },
            messageResource: {
              get: vi.fn().mockResolvedValue({ getReadableStream: () => Readable.from(Buffer.alloc(0)) }),
            },
          },
        },
      };
      const http = createFeishuHttpCapability(baseClient, (signal) => {
        stalledClientSignal = signal;
        return baseClient;
      });
      const adapter = new FeishuAdapter({
        appId: "cli_chat_mode",
        appSecret: "secret",
        teamId: null,
        channel: null,
        http,
        policy: new ExternalCallPolicy(),
      });

      await expect(adapter.resolveChatMetadata({ chatId: "oc_topic" })).resolves.toEqual({ chatMode: "topic" });
      await expect(adapter.resolveChatMetadata({ chatId: "oc_topic" })).resolves.toEqual({ chatMode: "topic" });
      await expect(adapter.resolveChatMetadata({ chatId: "oc_group" })).resolves.toEqual({
        chatMode: "group",
        groupMessageType: "thread",
      });
      expect(getChat).toHaveBeenCalledTimes(2);

      await expect(adapter.resolveChatMetadata({ chatId: "oc_failing" })).rejects.toThrow(
        "FEISHU_CHAT_MODE_LOOKUP_FAILED",
      );
      await expect(adapter.resolveChatMetadata({ chatId: "oc_failing" })).resolves.toBeUndefined();
      expect(getChat).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(30_001);
      await expect(adapter.resolveChatMetadata({ chatId: "oc_failing" })).resolves.toEqual({
        chatMode: "group",
        groupMessageType: "chat",
      });
      expect(getChat).toHaveBeenCalledTimes(4);

      const stalled = adapter.resolveChatMetadata({ chatId: "oc_stalled" }).then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(stalledClientSignal?.aborted).toBe(false);
      expect(stalledCallSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      await expect(stalled).resolves.toBe("FEISHU_CHAT_MODE_LOOKUP_TIMEOUT");
      expect(stalledClientSignal?.aborted).toBe(true);
      expect(stalledCallSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    const received: NormalizedMessage[] = [];
    const dispatcher = createReliableFeishuDispatcher((message) => {
      received.push(message);
    });
    const rawP2p = rawMessage("ev-p2p", "om-p2p", "21");
    rawP2p.event.message.chat_type = "p2p";
    await dispatcher.invoke(rawP2p, { needCheck: false });

    const [p2pEvent] = normalizeFeishuMessage({ appId: "cli_1", teamId: "workspace_1", message: received[0] as never });
    expect(p2pEvent?.providerContext).toMatchObject({ provider: "feishu", chatType: "p2p", chatMode: "p2p" });

    const ref = runtimeProviderMessageRef(
      {
        channelId: "oc_topic",
        externalMessageId: "om_1",
        authorKind: "human",
        authorExternalId: "ou_human",
        providerContext: {
          provider: "feishu",
          chatType: "group",
          chatMode: "topic",
          groupMessageType: "thread",
          threadId: "omt_1",
          rootId: "om_1",
        },
      },
      {
        externalAppId: "cli_1",
        externalBotId: "ou_bot",
        externalTeamBrand: "feishu",
      } as never,
    );
    expect(RuntimeProviderMessageRefSchema.parse(ref)).toEqual({
      provider: "feishu",
      teamBrand: "feishu",
      appId: "cli_1",
      botOpenId: "ou_bot",
      chatId: "oc_topic",
      chatType: "group",
      messageId: "om_1",
      threadId: "omt_1",
      rootId: "om_1",
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

function fakeConnectionAdapter(input: {
  appId: string;
  botOpenId?: string;
  scopes?: string[];
  disconnect?: ReturnType<typeof vi.fn>;
  resolveSenderName?: () => Promise<string | undefined>;
  resolveChatMetadata?: (input: { chatId: string }) => Promise<FeishuChatMetadata | undefined>;
  resolveChatMode?: (input: { chatId: string }) => Promise<"group" | "topic" | "p2p" | undefined>;
}) {
  let handlers: Record<string, (value?: unknown) => unknown> = {};
  const channel = {
    on: vi.fn((next: Record<string, (value?: unknown) => unknown>) => {
      handlers = next;
      return () => undefined;
    }),
    disconnect: input.disconnect ?? vi.fn().mockResolvedValue(undefined),
  };
  const adapter = {
    channel,
    validateBinding: vi.fn().mockResolvedValue({
      externalAppId: input.appId,
      externalTeamId: "tenant_1",
      externalBotId: input.botOpenId ?? "ou_bot",
    }),
    probeBotIdentity: vi.fn().mockResolvedValue({
      openId: input.botOpenId ?? "ou_bot",
      activateStatus: 2,
      profile: { displayName: "Provider Cat", avatarUrl: "https://example.com/provider.png" },
    }),
    listGrantedWorkspaceScopes: vi.fn().mockResolvedValue(input.scopes ?? FEISHU_REQUIRED_TENANT_SCOPES),
    normalizeInbound: vi.fn().mockReturnValue([]),
    resolveSenderName: vi.fn(input.resolveSenderName ?? (async () => undefined)),
    ...(input.resolveChatMetadata ? { resolveChatMetadata: vi.fn(input.resolveChatMetadata) } : {}),
    resolveChatMode: vi.fn(input.resolveChatMode ?? (async () => undefined)),
  };
  return {
    adapter: adapter as unknown as FeishuAdapter,
    channel,
    getHandlers: () => handlers,
    resolveSenderName: adapter.resolveSenderName,
    resolveChatMode: adapter.resolveChatMode,
  };
}

async function validatingConnectionAttempt(value: Awaited<ReturnType<typeof connectionFixture>>, owner: string) {
  const attemptId = crypto.randomUUID();
  await connectionDatabase.database.insert(imBindings).values({
    agentId: value.agent.id,
    provider: "feishu",
    status: "provisioning",
    setupAttemptId: attemptId,
    setupIntent: "create",
    setupState: "validating",
    setupOwnerInstanceId: owner,
    setupOwnerHeartbeatAt: connectionNow,
    encryptedSetupContext: value.cipher.encrypt(JSON.stringify({ qrUrl: "https://qr" })),
    setupExpiresAt: new Date(connectionNow.getTime() + 60_000),
    createdAt: connectionNow,
    updatedAt: connectionNow,
  });
  return attemptId;
}

describe("FeishuConnectionManager", () => {
  it.each(["unavailable", "different-bot"] as const)(
    "connects without optional profile metadata when it is %s",
    async (failure) => {
      const value = await connectionFixture();
      const owner = crypto.randomUUID();
      const attemptId = await validatingConnectionAttempt(value, owner);
      const fake = fakeConnectionAdapter({ appId: "cli_conn" });
      fake.adapter.probeBotIdentity =
        failure === "unavailable"
          ? vi.fn().mockRejectedValue(new Error("provider unavailable"))
          : vi.fn().mockResolvedValue({
              openId: "ou_other",
              activateStatus: 2,
              profile: { displayName: "Wrong bot", avatarUrl: "https://example.com/wrong.png" },
            });
      const diagnostics = vi.fn();
      const manager = new FeishuConnectionManager({
        database: connectionDatabase.database,
        inbox: { ingest: vi.fn() } as never,
        instanceId: owner,
        imBindings: value.imBindings,
        createAdapter: () => fake.adapter,
        runtimeReady: async () => true,
        onDiagnostic: diagnostics,
      });
      try {
        await manager.activateAtomicAttempt({
          attemptId,
          ownerInstanceId: owner,
          agentId: value.agent.id,
          appId: "cli_conn",
          appSecret: "secret",
          teamBrand: "feishu",
        });
        expect((await value.imBindings.getForAgent(value.bootstrap.userId, value.agent.id))?.bot).toEqual({
          displayName: null,
          avatarUrl: null,
        });
        expect(diagnostics).toHaveBeenCalledWith(
          failure === "unavailable" ? "FEISHU_BOT_PROFILE_UNAVAILABLE" : "FEISHU_BOT_PROFILE_IDENTITY_MISMATCH",
        );
      } finally {
        await manager.stop();
      }
    },
  );

  it("atomically activates a Channel, admits inbound messages, and observes transitions", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    let resolveSenderName: ((name: string | undefined) => void) | undefined;
    const senderName = new Promise<string | undefined>((resolve) => {
      resolveSenderName = resolve;
    });
    const fake = fakeConnectionAdapter({ appId: "cli_conn", resolveSenderName: () => senderName });
    const persistedMessageId = crypto.randomUUID();
    const inbox = {
      ingest: vi
        .fn()
        .mockResolvedValue({ messageId: persistedMessageId, deliveryIds: ["delivery-1"], duplicate: false }),
    };
    const receipts = {
      claim: vi.fn().mockResolvedValue({
        accepted: true,
        duplicate: false,
        receiptId: "receipt-1",
        status: "processing",
      }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const diagnostics = vi.fn();
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: inbox as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter: vi.fn(() => fake.adapter),
      runtimeReady: vi.fn().mockResolvedValue(true),
      onDiagnostic: diagnostics,
      leaseMs: 60_000,
      receipts,
    });
    const verified = await manager.activateAtomicAttempt({
      attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_conn",
      appSecret: "secret",
      teamBrand: "lark",
    });
    expect(verified.profile).toEqual({ displayName: "Provider Cat", avatarUrl: "https://example.com/provider.png" });
    expect((await value.imBindings.getForAgent(value.bootstrap.userId, value.agent.id))?.bot).toEqual(verified.profile);
    expect(verified).toMatchObject({ appId: "cli_conn", teamId: "tenant_1", botOpenId: "ou_bot", teamBrand: "lark" });
    const [row] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(
        eq(
          imBindings.id,
          (
            await value.imBindings.getFeishuConnectionMaterial(
              (await value.imBindings.listFeishuConnectionIds(undefined))[0]?.imBindingId ?? "",
            )
          )?.imBindingId ?? "",
        ),
      );
    expect(row?.setupState).toBe("succeeded");
    if (!row) throw new Error("Feishu binding was not activated");
    await connectionDatabase.database.insert(imMessages).values({
      id: persistedMessageId,
      imBindingId: row.id,
      providerEventId: "ev_conn",
      channelId: "oc_conn",
      externalMessageId: "om_conn",
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      authorKind: "human",
      authorExternalId: "ou_human",
      authorDisplayName: null,
      content: { version: 1, fallbackText: "hello", blocks: [{ type: "text", text: "hello" }], truncated: false },
      providerContext: { provider: "feishu" },
      occurredAt: connectionNow,
      receivedAt: connectionNow,
    });
    fake.adapter.normalizeInbound = vi.fn().mockReturnValue(
      normalizeFeishuMessage({
        appId: "cli_conn",
        teamId: "tenant_1",
        message: {
          messageId: "om_conn",
          chatId: "oc_conn",
          chatType: "group",
          senderId: "ou_human",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: 1,
          raw: {
            header: { event_id: "ev_conn", tenant_key: "tenant_1" },
            opentagSenderOpenId: "ou_human",
          },
        },
      }),
    );
    await fake.getHandlers().message?.({
      messageId: "om_conn",
      chatId: "oc_conn",
      chatType: "group",
      senderId: "ou_human",
      content: "hello",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1,
      raw: { header: { event_id: "ev_conn", tenant_key: "tenant_1" }, opentagSenderOpenId: "ou_human" },
    } as never);
    expect(inbox.ingest).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.objectContaining({ providerEventId: "ev_conn" }),
      expect.objectContaining({ provider: "feishu" }),
      undefined,
    );
    expect(receipts.claim).toHaveBeenCalledWith({
      bindingId: expect.any(String),
      credentialGeneration: expect.any(Number),
      eventId: "ev_conn",
      work: expect.objectContaining({
        version: 1,
        provider: "feishu",
        event: expect.objectContaining({ providerEventId: "ev_conn" }),
      }),
      fence: { holderInstanceId: owner, fencingEpoch: expect.any(Number) },
    });
    expect(receipts.markProcessed).toHaveBeenCalledWith("receipt-1");
    expect(fake.resolveSenderName).toHaveBeenCalledWith({ chatId: "oc_conn", senderOpenId: "ou_human" });
    resolveSenderName?.("Mia Zhang");
    await vi.waitFor(async () => {
      const [enriched] = await connectionDatabase.database
        .select({ authorDisplayName: imMessages.authorDisplayName })
        .from(imMessages)
        .where(eq(imMessages.id, persistedMessageId));
      expect(enriched?.authorDisplayName).toBe("Mia Zhang");
    });
    inbox.ingest.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      fake.getHandlers().message?.({
        messageId: "om_conn_error",
        chatId: "oc_conn",
        chatType: "group",
        senderId: "ou_human",
        content: "hello",
        rawContentType: "text",
        resources: [],
        mentions: [],
        mentionAll: false,
        mentionedBot: false,
        createTime: 1,
        raw: { header: { event_id: "ev_conn_error", tenant_key: "tenant_1" } },
      } as never),
    ).rejects.toThrow("database unavailable");
    expect(receipts.markFailed).toHaveBeenCalledWith("receipt-1", "FEISHU_EVENT_PROCESSING_FAILED");
    fake.adapter.normalizeInbound = vi.fn().mockReturnValue(
      normalizeFeishuMessage({
        appId: "cli_conn",
        teamId: "tenant_1",
        message: {
          messageId: "om_missing_event",
          chatId: "oc_conn",
          chatType: "group",
          senderId: "ou_human",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: 2,
          raw: { header: { tenant_key: "tenant_1" } },
        },
      }),
    );
    const claimCountBeforeMissingEvent = receipts.claim.mock.calls.length;
    await fake.getHandlers().message?.({
      messageId: "om_missing_event",
      chatId: "oc_conn",
      chatType: "group",
      senderId: "ou_human",
      content: "hello",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 2,
      raw: { header: { tenant_key: "tenant_1" } },
    } as never);
    expect(receipts.claim).toHaveBeenCalledTimes(claimCountBeforeMissingEvent);
    receipts.claim.mockResolvedValueOnce({ accepted: false, duplicate: true, receiptId: "receipt-duplicate" });
    const ingestCountBeforeDuplicate = inbox.ingest.mock.calls.length;
    fake.adapter.normalizeInbound = vi.fn().mockReturnValue(
      normalizeFeishuMessage({
        appId: "cli_conn",
        teamId: "tenant_1",
        message: {
          messageId: "om_duplicate_event",
          chatId: "oc_conn",
          chatType: "group",
          senderId: "ou_human",
          content: "hello",
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime: 3,
          raw: { header: { event_id: "ev_duplicate", tenant_key: "tenant_1" } },
        },
      }),
    );
    await fake.getHandlers().message?.({} as never);
    expect(inbox.ingest).toHaveBeenCalledTimes(ingestCountBeforeDuplicate);
    await fake.getHandlers().reconnecting?.();
    await fake.getHandlers().reconnected?.();
    await fake.getHandlers().error?.(new FeishuOperationError("FEISHU_CONNECTION_LEASE_STALE"));
    await manager.maintain();
    await manager.stop();
    expect(fake.channel.disconnect).toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
  });

  it("fails closed on identity, scope, runtime, and admission errors", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    const mismatch = fakeConnectionAdapter({ appId: "wrong" });
    await expect(
      new FeishuConnectionManager({
        database: connectionDatabase.database,
        inbox: { ingest: vi.fn() } as never,
        instanceId: owner,
        imBindings: value.imBindings,
        createAdapter: () => mismatch.adapter,
      }).activateAtomicAttempt({
        attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_conn",
        appSecret: "secret",
      }),
    ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_MISMATCH" });

    const noScope = fakeConnectionAdapter({ appId: "cli_conn", scopes: ["im:message:send_as_bot"] });
    await expect(
      new FeishuConnectionManager({
        database: connectionDatabase.database,
        inbox: { ingest: vi.fn() } as never,
        instanceId: owner,
        imBindings: value.imBindings,
        createAdapter: () => noScope.adapter,
      }).activateAtomicAttempt({
        attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_conn",
        appSecret: "secret",
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SCOPE_REAUTH_REQUIRED" });

    const runtimeUnavailable = fakeConnectionAdapter({ appId: "cli_conn" });
    await expect(
      new FeishuConnectionManager({
        database: connectionDatabase.database,
        inbox: { ingest: vi.fn() } as never,
        instanceId: owner,
        imBindings: value.imBindings,
        createAdapter: () => runtimeUnavailable.adapter,
        runtimeReady: () => false,
      }).activateAtomicAttempt({
        attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_conn",
        appSecret: "secret",
      }),
    ).rejects.toMatchObject({ code: "FEISHU_RUNTIME_TOOL_UNAVAILABLE" });

    await connectionDatabase.database.update(agents).set({ status: "suspended" }).where(eq(agents.id, value.agent.id));
    const suspended = fakeConnectionAdapter({ appId: "cli_conn" });
    await expect(
      new FeishuConnectionManager({
        database: connectionDatabase.database,
        inbox: { ingest: vi.fn() } as never,
        instanceId: owner,
        imBindings: value.imBindings,
        createAdapter: () => suspended.adapter,
        runtimeReady: () => true,
      }).activateAtomicAttempt({
        attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_conn",
        appSecret: "secret",
      }),
    ).rejects.toMatchObject({ code: "FEISHU_SETUP_FENCE_STALE" });
    const [slot] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId));
    expect(slot).toMatchObject({ status: "provisioning", setupState: "validating" });
  });

  it("refuses a different App returned for same-App reauthorization", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    await connectionDatabase.database
      .update(imBindings)
      .set({
        setupIntent: "reauthorize",
        externalAppId: "cli_original",
      })
      .where(eq(imBindings.setupAttemptId, attemptId));
    const adapter = fakeConnectionAdapter({ appId: "cli_different" });
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter: () => adapter.adapter,
      runtimeReady: () => true,
    });
    await expect(
      manager.activateAtomicAttempt({
        attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_different",
        appSecret: "secret",
      }),
    ).rejects.toMatchObject({ code: "FEISHU_APP_IDENTITY_MISMATCH" });
    const [row] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId));
    expect(row).toMatchObject({ externalAppId: "cli_original", credentialGeneration: 0 });
  });

  it.each(["abort", "expiry"] as const)("rolls back activation when %s wins before commit", async (kind) => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    const adapter = fakeConnectionAdapter({ appId: "cli_conn" });
    const controller = new AbortController();
    let now = new Date();
    const expiresAt = new Date(now.getTime() + 1_000);
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter: () => adapter.adapter,
      runtimeReady: () => true,
      now: () => now,
      afterActivationAgentLocked: async () => {
        if (kind === "abort") controller.abort(new Error("check canceled"));
        else now = new Date(expiresAt.getTime() + 1);
      },
    });
    await expect(
      manager.activateAtomicAttempt({
        attemptId,
        ownerInstanceId: owner,
        agentId: value.agent.id,
        appId: "cli_conn",
        appSecret: "secret",
        candidateExpiresAt: expiresAt,
        signal: controller.signal,
      }),
    ).rejects.toThrow(kind === "abort" ? "check canceled" : "FEISHU_SETUP_CANDIDATE_EXPIRED");
    const [row] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.setupAttemptId, attemptId));
    expect(row).toMatchObject({ status: "provisioning", credentialGeneration: 0, encryptedCredential: null });
    expect(adapter.channel.disconnect).toHaveBeenCalled();
  });

  it("classifies durable candidate readiness without opening a message channel", async () => {
    const value = await connectionFixture();
    const probes: Array<{ channel: boolean; appId: string }> = [];
    let scopes: string[] = [...FEISHU_REQUIRED_TENANT_SCOPES];
    let activateStatus: number | null = 2;
    let runtimeReady = true;
    const createAdapter = (input: { appId: string; appSecret: string; teamId: string | null; channel?: unknown }) => {
      const fake = fakeConnectionAdapter({ appId: input.appId, scopes });
      const adapter = {
        ...(fake.adapter as object),
        probeBotIdentity: vi.fn(async () => ({ openId: `ou_${input.appId}`, activateStatus })),
      } as unknown as FeishuAdapter;
      probes.push({ channel: input.channel !== null, appId: input.appId });
      return adapter;
    };
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      createAdapter,
      runtimeReady: () => runtimeReady,
    });
    const base = { agentId: value.agent.id, appId: "cli_probe", appSecret: "secret" };

    const partial = [...FEISHU_REQUIRED_TENANT_SCOPES].slice(0, 65);
    scopes = partial;
    expect(await manager.checkCandidate(base)).toEqual({
      status: "waiting",
      reason: "permissions_pending",
      missingScopes: [...FEISHU_REQUIRED_TENANT_SCOPES].slice(65),
    });
    scopes = [...FEISHU_REQUIRED_TENANT_SCOPES];
    runtimeReady = false;
    expect(await manager.checkCandidate(base)).toEqual({
      status: "waiting",
      reason: "runtime_unavailable",
      missingScopes: [],
    });
    runtimeReady = true;
    // Official Bot info values: only 2 means enabled; every other documented status is explicit
    // evidence of an App that is not enabled.
    for (activateStatus of [0, 1, 3, 4, 5, 6]) {
      expect(await manager.checkCandidate(base)).toEqual({
        status: "waiting",
        reason: "app_unavailable",
        missingScopes: [],
      });
    }
    // An omitted optional field carries no evidence, and an undocumented value is decided by the
    // mandatory atomic channel activation, not guessed from this probe.
    for (activateStatus of [null, 99]) {
      expect(await manager.checkCandidate(base)).toEqual({ status: "ready" });
    }
    activateStatus = 2;
    expect(await manager.checkCandidate(base)).toEqual({ status: "ready" });
    // Every probe stayed channel-free: a candidate must never hold a socket while it waits.
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((probe) => !probe.channel)).toBe(true);
    await manager.stop();
  });

  it("claims and renews leases during maintenance, then releases changed bindings", async () => {
    const value = await connectionFixture();
    const bindingId = await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_maint",
      appSecret: "secret",
      teamId: "tenant_maint",
      botOpenId: "ou_maint",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const first = fakeConnectionAdapter({ appId: "cli_maint", botOpenId: "ou_maint" });
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      createAdapter: () => first.adapter,
      maintenanceMs: 60_000,
    });
    manager.start();
    await manager.maintain();
    await vi.waitFor(() => expect(first.adapter.validateBinding).toHaveBeenCalled());
    await connectionDatabase.database
      .update(imBindings)
      .set({ connectionOwnerInstanceId: crypto.randomUUID() })
      .where(eq(imBindings.id, bindingId));
    await vi.waitFor(async () => {
      await manager.maintain();
      expect(first.channel.disconnect).toHaveBeenCalled();
    });
    await manager.stop();
    manager.start();
    await manager.stop();
  });

  it("reports observation failures from reconnect transitions", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    const fake = fakeConnectionAdapter({ appId: "cli_observe" });
    const diagnostics = vi.fn();
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter: () => fake.adapter,
      onDiagnostic: diagnostics,
    });
    await manager.activateAtomicAttempt({
      attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_observe",
      appSecret: "secret",
    });
    const update = vi.spyOn(connectionDatabase.database, "update").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    await fake.getHandlers().reconnecting?.();
    await fake.getHandlers().reconnected?.();
    await vi.waitFor(() => {
      expect(diagnostics).toHaveBeenCalledWith("FEISHU_CONNECTION_OBSERVATION_FAILED");
    });
    update.mockRestore();
    await manager.stop();
  });

  it("disconnects the previous adapter when an activation replaces an owned channel", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    const first = fakeConnectionAdapter({ appId: "cli_replace" });
    const second = fakeConnectionAdapter({ appId: "cli_replace" });
    // Activation now probes scopes without a channel first, so the channel adapters are selected by
    // the presence of a channel input rather than by call order.
    const probe = fakeConnectionAdapter({ appId: "cli_replace" });
    const channelAdapters = [first.adapter, second.adapter];
    const createAdapter = vi.fn((input: { channel?: unknown }) =>
      input.channel === null ? probe.adapter : (channelAdapters.shift() ?? second.adapter),
    );
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter,
    });
    await manager.activateAtomicAttempt({
      attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_replace",
      appSecret: "secret",
    });
    const [binding] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.agentId, value.agent.id));
    if (!binding) throw new Error("Binding fixture was not created");
    const replacementAttemptId = crypto.randomUUID();
    await connectionDatabase.database
      .update(imBindings)
      .set({
        status: "provisioning",
        setupAttemptId: replacementAttemptId,
        setupIntent: "create",
        setupState: "validating",
        setupOwnerInstanceId: owner,
        setupOwnerHeartbeatAt: connectionNow,
        encryptedSetupContext: value.cipher.encrypt(JSON.stringify({ qrUrl: "https://qr-replace" })),
        setupExpiresAt: new Date(connectionNow.getTime() + 60_000),
      })
      .where(eq(imBindings.id, binding.id));
    await manager.activateAtomicAttempt({
      attemptId: replacementAttemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_replace",
      appSecret: "secret",
    });
    expect(first.channel.disconnect).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("releases a claimed lease after a connection validation failure", async () => {
    const value = await connectionFixture();
    const bindingId = await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_release",
      appSecret: "secret",
      teamId: "tenant_release",
      botOpenId: "ou_expected",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });
    const invalid = fakeConnectionAdapter({ appId: "cli_release", botOpenId: "ou_wrong" });
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      createAdapter: () => invalid.adapter,
    });
    manager.start();
    await manager.maintain();
    await vi.waitFor(async () => {
      const [row] = await connectionDatabase.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
      expect(row?.lastErrorCode).toBe("FEISHU_BOT_IDENTITY_MISMATCH");
    });
    const [row] = await connectionDatabase.database.select().from(imBindings).where(eq(imBindings.id, bindingId));
    expect(row?.connectionOwnerInstanceId).toBeNull();
    expect(row?.connectionLeaseExpiresAt).toBeNull();
    expect(row?.lastErrorCode).toBe("FEISHU_BOT_IDENTITY_MISMATCH");
    await manager.stop();
  });

  it("enriches Feishu chat metadata off the admission path and backfills earlier channel messages", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    let releaseChatMetadata: ((metadata: FeishuChatMetadata | undefined) => void) | undefined;
    const resolveChatMetadata = vi
      .fn<({ chatId }: { chatId: string }) => Promise<FeishuChatMetadata | undefined>>()
      .mockImplementationOnce(
        () =>
          new Promise<FeishuChatMetadata | undefined>((resolve) => {
            releaseChatMetadata = resolve;
          }),
      )
      .mockResolvedValue({ chatMode: "group", groupMessageType: "thread" });
    const fake = fakeConnectionAdapter({ appId: "cli_chat_mode", resolveChatMetadata });
    fake.adapter.normalizeInbound = (envelope) => normalizeFeishuMessage(envelope);
    const firstMessageId = crypto.randomUUID();
    const secondMessageId = crypto.randomUUID();
    const bystanderMessageId = crypto.randomUUID();
    const thirdMessageId = crypto.randomUUID();
    const inbox = {
      ingest: vi
        .fn()
        .mockResolvedValueOnce({ messageId: secondMessageId, deliveryIds: ["delivery-1"], duplicate: false })
        .mockResolvedValueOnce({ messageId: thirdMessageId, deliveryIds: ["delivery-2"], duplicate: false }),
    };
    const receipts = {
      claim: vi.fn().mockResolvedValue({
        accepted: true,
        duplicate: false,
        receiptId: "receipt-chat-mode",
        status: "processing",
      }),
      markProcessed: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: inbox as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter: () => fake.adapter,
      receipts,
    });
    await manager.activateAtomicAttempt({
      attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_chat_mode",
      appSecret: "secret",
    });
    const [binding] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.agentId, value.agent.id));
    if (!binding) throw new Error("Expected activated Feishu binding");

    await connectionDatabase.database.insert(imMessages).values([
      {
        id: firstMessageId,
        imBindingId: binding.id,
        providerEventId: "ev_missed",
        channelId: "oc_threaded_group",
        externalMessageId: "om_missed",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "missed earlier", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      },
      {
        id: secondMessageId,
        imBindingId: binding.id,
        providerEventId: "ev_current",
        channelId: "oc_threaded_group",
        externalMessageId: "om_current",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "current", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      },
    ]);

    await fake.getHandlers().message?.({
      messageId: "om_current",
      chatId: "oc_threaded_group",
      chatType: "group",
      senderId: "ou_human",
      content: "current",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 1,
      raw: { header: { event_id: "ev_current", tenant_key: "tenant_1" } },
    } as never);

    expect(inbox.ingest).toHaveBeenCalledWith(
      binding.id,
      expect.any(Number),
      expect.objectContaining({
        providerContext: { provider: "feishu", chatType: "group" },
      }),
      expect.objectContaining({ provider: "feishu" }),
      undefined,
    );
    expect(receipts.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        work: expect.objectContaining({
          event: expect.objectContaining({
            providerContext: { provider: "feishu", chatType: "group" },
          }),
        }),
      }),
    );

    releaseChatMetadata?.({ chatMode: "group", groupMessageType: "thread" });
    await vi.waitFor(async () => {
      const rows = await connectionDatabase.database
        .select({ id: imMessages.id, providerContext: imMessages.providerContext })
        .from(imMessages)
        .where(eq(imMessages.channelId, "oc_threaded_group"));
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            id: firstMessageId,
            providerContext: {
              provider: "feishu",
              chatType: "group",
              chatMode: "group",
              groupMessageType: "thread",
            },
          },
          {
            id: secondMessageId,
            providerContext: {
              provider: "feishu",
              chatType: "group",
              chatMode: "group",
              groupMessageType: "thread",
            },
          },
        ]),
      );
    });

    await connectionDatabase.database.insert(imMessages).values([
      {
        id: bystanderMessageId,
        imBindingId: binding.id,
        providerEventId: "ev_bystander",
        channelId: "oc_threaded_group",
        externalMessageId: "om_bystander",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "bystander", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      },
      {
        id: thirdMessageId,
        imBindingId: binding.id,
        providerEventId: "ev_third",
        channelId: "oc_threaded_group",
        externalMessageId: "om_third",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "third", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      },
    ]);

    await fake.getHandlers().message?.({
      messageId: "om_third",
      chatId: "oc_threaded_group",
      chatType: "group",
      senderId: "ou_human",
      content: "third",
      rawContentType: "text",
      resources: [],
      mentions: [],
      mentionAll: false,
      mentionedBot: false,
      createTime: 2,
      raw: { header: { event_id: "ev_third", tenant_key: "tenant_1" } },
    } as never);

    await vi.waitFor(async () => {
      const [thirdRow] = await connectionDatabase.database
        .select({ providerContext: imMessages.providerContext })
        .from(imMessages)
        .where(eq(imMessages.id, thirdMessageId));
      expect(thirdRow?.providerContext).toEqual({
        provider: "feishu",
        chatType: "group",
        chatMode: "group",
        groupMessageType: "thread",
      });
    });
    const [bystanderRow] = await connectionDatabase.database
      .select({ providerContext: imMessages.providerContext })
      .from(imMessages)
      .where(eq(imMessages.id, bystanderMessageId));
    expect(bystanderRow?.providerContext).toEqual({
      provider: "feishu",
      chatType: "group",
    });
    await manager.stop();
  });

  it("coalesces concurrent cold-channel backfills and repairs a warm channel after a failed single-row update", async () => {
    const value = await connectionFixture();
    const owner = crypto.randomUUID();
    const attemptId = await validatingConnectionAttempt(value, owner);
    let releaseColdMetadata: ((metadata: FeishuChatMetadata | undefined) => void) | undefined;
    const sharedLookup = new Promise<FeishuChatMetadata | undefined>((resolve) => {
      releaseColdMetadata = resolve;
    });
    const resolveChatMetadata = vi
      .fn<({ chatId }: { chatId: string }) => Promise<FeishuChatMetadata | undefined>>()
      .mockReturnValueOnce(sharedLookup)
      .mockReturnValueOnce(sharedLookup)
      .mockResolvedValue({ chatMode: "topic" });
    const fake = fakeConnectionAdapter({ appId: "cli_coalesce", resolveChatMetadata });
    fake.adapter.normalizeInbound = (envelope) => normalizeFeishuMessage(envelope);

    const cold1Id = crypto.randomUUID();
    const cold2Id = crypto.randomUUID();
    const failedWarmId = crypto.randomUUID();
    const repairWarmId = crypto.randomUUID();
    const heldWarmId = crypto.randomUUID();
    const postRepairWarmId = crypto.randomUUID();
    const dirty1Id = crypto.randomUUID();
    const dirty2Id = crypto.randomUUID();
    const dirty3Id = crypto.randomUUID();
    const late1Id = crypto.randomUUID();
    const late2Id = crypto.randomUUID();
    const late3Id = crypto.randomUUID();
    const inbox = {
      ingest: vi
        .fn()
        .mockResolvedValueOnce({ messageId: cold1Id, deliveryIds: ["d1"], duplicate: false })
        .mockResolvedValueOnce({ messageId: cold2Id, deliveryIds: ["d2"], duplicate: false })
        .mockResolvedValueOnce({ messageId: heldWarmId, deliveryIds: ["d5"], duplicate: false })
        .mockResolvedValueOnce({ messageId: failedWarmId, deliveryIds: ["d3"], duplicate: false })
        .mockResolvedValueOnce({ messageId: repairWarmId, deliveryIds: ["d4"], duplicate: false })
        .mockResolvedValueOnce({ messageId: postRepairWarmId, deliveryIds: ["d6"], duplicate: false })
        .mockResolvedValueOnce({ messageId: dirty1Id, deliveryIds: ["d7"], duplicate: false })
        .mockResolvedValueOnce({ messageId: dirty2Id, deliveryIds: ["d8"], duplicate: false })
        .mockResolvedValueOnce({ messageId: dirty3Id, deliveryIds: ["d9"], duplicate: false })
        .mockResolvedValueOnce({ messageId: late1Id, deliveryIds: ["d10"], duplicate: false })
        .mockResolvedValueOnce({ messageId: late2Id, deliveryIds: ["d11"], duplicate: false })
        .mockResolvedValueOnce({ messageId: late3Id, deliveryIds: ["d12"], duplicate: false }),
    };
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: inbox as never,
      instanceId: owner,
      imBindings: value.imBindings,
      createAdapter: () => fake.adapter,
    });
    await manager.activateAtomicAttempt({
      attemptId,
      ownerInstanceId: owner,
      agentId: value.agent.id,
      appId: "cli_coalesce",
      appSecret: "secret",
    });
    const [binding] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(eq(imBindings.agentId, value.agent.id));
    if (!binding) throw new Error("Expected activated Feishu binding");

    await connectionDatabase.database.insert(imMessages).values(
      [
        [cold1Id, "ev_c1", "om_c1"],
        [cold2Id, "ev_c2", "om_c2"],
      ].map(([id, providerEventId, externalMessageId]) => ({
        id: id as string,
        imBindingId: binding.id,
        providerEventId: providerEventId as string,
        channelId: "oc_cold",
        externalMessageId: externalMessageId as string,
        providerRevisionKey: "1",
        operation: "created" as const,
        direction: "inbound" as const,
        authorKind: "human" as const,
        authorExternalId: "ou_human",
        content: { version: 1 as const, fallbackText: externalMessageId as string, blocks: [], truncated: false },
        providerContext: { provider: "feishu" as const, chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      })),
    );

    const updateWhereSqls: string[] = [];
    let failNextImMessageUpdate = false;
    let holdNextImMessageUpdate = false;
    let holdAfterNextImMessageUpdateExec = false;
    let rejectHeldUpdate: ((reason?: unknown) => void) | undefined;
    let notifyHeldExecDone: (() => void) | undefined;
    let resolveHeldExecReturn: (() => void) | undefined;
    const realUpdate = connectionDatabase.database.update.bind(connectionDatabase.database);
    const updateSpy = vi.spyOn(connectionDatabase.database, "update").mockImplementation(((table: unknown) => {
      const builder = realUpdate(table as never);
      if (table !== imMessages) return builder;
      const realSet = builder.set.bind(builder);
      builder.set = ((values: unknown) => {
        const setBuilder = realSet(values as never);
        const realWhere = setBuilder.where.bind(setBuilder);
        setBuilder.where = ((condition: unknown) => {
          const query = realWhere(condition as never);
          updateWhereSqls.push(query.toSQL().sql);
          if (holdAfterNextImMessageUpdateExec) {
            holdAfterNextImMessageUpdateExec = false;
            return (async () => {
              const result = await query;
              notifyHeldExecDone?.();
              await new Promise<void>((resolve) => {
                resolveHeldExecReturn = resolve;
              });
              return result;
            })() as never;
          }
          if (holdNextImMessageUpdate) {
            holdNextImMessageUpdate = false;
            return new Promise<void>((_, reject) => {
              rejectHeldUpdate = reject;
            }).then(() => query) as never;
          }
          if (failNextImMessageUpdate) {
            failNextImMessageUpdate = false;
            return Promise.reject(new Error("transient update failure")) as never;
          }
          return query;
        }) as typeof setBuilder.where;
        return setBuilder;
      }) as typeof builder.set;
      return builder;
    }) as typeof connectionDatabase.database.update);

    try {
      const send = (eventId: string, messageId: string, createTime: number, chatId = "oc_cold") =>
        fake.getHandlers().message?.({
          messageId,
          chatId,
          chatType: "group",
          senderId: "ou_human",
          content: messageId,
          rawContentType: "text",
          resources: [],
          mentions: [],
          mentionAll: false,
          mentionedBot: false,
          createTime,
          raw: { header: { event_id: eventId, tenant_key: "tenant_1" } },
        } as never);

      await Promise.all([send("ev_c1", "om_c1", 1), send("ev_c2", "om_c2", 2)]);
      releaseColdMetadata?.({ chatMode: "topic" });

      await vi.waitFor(() => {
        expect(updateWhereSqls).toHaveLength(2);
      });
      expect(updateWhereSqls.filter((sql) => sql.includes('"channel_id" ='))).toHaveLength(1);
      expect(updateWhereSqls.filter((sql) => sql.includes('"im_messages"."id" ='))).toHaveLength(1);

      await connectionDatabase.database.insert(imMessages).values(
        [
          [failedWarmId, "ev_c3", "om_c3"],
          [repairWarmId, "ev_c4", "om_c4"],
          [heldWarmId, "ev_c5", "om_c5"],
          [postRepairWarmId, "ev_c6", "om_c6"],
        ].map(([id, providerEventId, externalMessageId]) => ({
          id: id as string,
          imBindingId: binding.id,
          providerEventId: providerEventId as string,
          channelId: "oc_cold",
          externalMessageId: externalMessageId as string,
          providerRevisionKey: "1",
          operation: "created" as const,
          direction: "inbound" as const,
          authorKind: "human" as const,
          authorExternalId: "ou_human",
          content: { version: 1 as const, fallbackText: externalMessageId as string, blocks: [], truncated: false },
          providerContext: { provider: "feishu" as const, chatType: "group" },
          occurredAt: connectionNow,
          receivedAt: connectionNow,
        })),
      );

      holdNextImMessageUpdate = true;
      await send("ev_c5", "om_c5", 3);
      await vi.waitFor(() => {
        expect(updateWhereSqls).toHaveLength(3);
      });

      failNextImMessageUpdate = true;
      await send("ev_c3", "om_c3", 4);
      await vi.waitFor(() => {
        expect(updateWhereSqls).toHaveLength(4);
      });

      await send("ev_c4", "om_c4", 5);
      await vi.waitFor(() => {
        expect(updateWhereSqls).toHaveLength(5);
      });
      expect(updateWhereSqls.at(-1)).toContain('"channel_id" =');

      const flushMicrotasks = async () => {
        for (let i = 0; i < 6; i += 1) await Promise.resolve();
      };

      rejectHeldUpdate?.(new Error("stale primary-key failure"));
      await flushMicrotasks();

      await send("ev_c6", "om_c6", 6);
      await vi.waitFor(() => {
        expect(updateWhereSqls).toHaveLength(6);
      });
      expect(updateWhereSqls.at(-1)).toContain('"im_messages"."id" =');

      await connectionDatabase.database.insert(imMessages).values({
        id: dirty1Id,
        imBindingId: binding.id,
        providerEventId: "ev_d1",
        channelId: "oc_dirty",
        externalMessageId: "om_d1",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "om_d1", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      });

      const dirty1ExecDone = new Promise<void>((resolve) => {
        notifyHeldExecDone = resolve;
      });
      holdAfterNextImMessageUpdateExec = true;
      await send("ev_d1", "om_d1", 7, "oc_dirty");
      await dirty1ExecDone;
      expect(updateWhereSqls).toHaveLength(7);
      expect(updateWhereSqls.at(-1)).toContain('"channel_id" =');

      await connectionDatabase.database.insert(imMessages).values({
        id: dirty2Id,
        imBindingId: binding.id,
        providerEventId: "ev_d2",
        channelId: "oc_dirty",
        externalMessageId: "om_d2",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "om_d2", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      });
      resolveChatMetadata.mockResolvedValueOnce(undefined);
      await send("ev_d2", "om_d2", 8, "oc_dirty");
      await flushMicrotasks();
      resolveHeldExecReturn?.();
      await flushMicrotasks();

      await connectionDatabase.database.insert(imMessages).values({
        id: dirty3Id,
        imBindingId: binding.id,
        providerEventId: "ev_d3",
        channelId: "oc_dirty",
        externalMessageId: "om_d3",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "om_d3", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      });
      await send("ev_d3", "om_d3", 9, "oc_dirty");
      await vi.waitFor(async () => {
        const [repairedDirty] = await connectionDatabase.database
          .select({ providerContext: imMessages.providerContext })
          .from(imMessages)
          .where(eq(imMessages.id, dirty2Id));
        expect(repairedDirty?.providerContext).toEqual({
          provider: "feishu",
          chatType: "group",
          chatMode: "topic",
        });
      });
      expect(updateWhereSqls.at(-1)).toContain('"channel_id" =');

      await connectionDatabase.database.insert(imMessages).values({
        id: late1Id,
        imBindingId: binding.id,
        providerEventId: "ev_l1",
        channelId: "oc_dirty_late",
        externalMessageId: "om_l1",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "om_l1", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      });

      const late1ExecDone = new Promise<void>((resolve) => {
        notifyHeldExecDone = resolve;
      });
      holdAfterNextImMessageUpdateExec = true;
      await send("ev_l1", "om_l1", 10, "oc_dirty_late");
      await late1ExecDone;
      expect(updateWhereSqls).toHaveLength(9);

      await connectionDatabase.database.insert(imMessages).values({
        id: late2Id,
        imBindingId: binding.id,
        providerEventId: "ev_l2",
        channelId: "oc_dirty_late",
        externalMessageId: "om_l2",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "om_l2", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      });

      let notifyLateLookupStarted: (() => void) | undefined;
      const lateLookupStarted = new Promise<void>((resolve) => {
        notifyLateLookupStarted = resolve;
      });
      let releaseLateLookup: ((metadata: FeishuChatMetadata | undefined) => void) | undefined;
      resolveChatMetadata.mockImplementationOnce(() => {
        notifyLateLookupStarted?.();
        return new Promise<FeishuChatMetadata | undefined>((resolve) => {
          releaseLateLookup = resolve;
        });
      });
      await send("ev_l2", "om_l2", 11, "oc_dirty_late");
      await lateLookupStarted;

      resolveHeldExecReturn?.();
      await flushMicrotasks();

      releaseLateLookup?.(undefined);
      await flushMicrotasks();

      await connectionDatabase.database.insert(imMessages).values({
        id: late3Id,
        imBindingId: binding.id,
        providerEventId: "ev_l3",
        channelId: "oc_dirty_late",
        externalMessageId: "om_l3",
        providerRevisionKey: "1",
        operation: "created",
        direction: "inbound",
        authorKind: "human",
        authorExternalId: "ou_human",
        content: { version: 1, fallbackText: "om_l3", blocks: [], truncated: false },
        providerContext: { provider: "feishu", chatType: "group" },
        occurredAt: connectionNow,
        receivedAt: connectionNow,
      });

      await send("ev_l3", "om_l3", 12, "oc_dirty_late");
      await vi.waitFor(async () => {
        const [repairedLate] = await connectionDatabase.database
          .select({ providerContext: imMessages.providerContext })
          .from(imMessages)
          .where(eq(imMessages.id, late2Id));
        expect(repairedLate?.providerContext).toEqual({
          provider: "feishu",
          chatType: "group",
          chatMode: "topic",
        });
      });
      expect(updateWhereSqls.at(-1)).toContain('"channel_id" =');
    } finally {
      updateSpy.mockRestore();
      await manager.stop();
    }
  });

  it("connects candidate bindings with bounded concurrency so a slow binding does not block other candidates", async () => {
    const value = await connectionFixture();
    const agentService = new AgentService(connectionDatabase.database);
    const totalBindings = 18;
    const bindingIds: string[] = [];

    for (let index = 0; index < totalBindings; index += 1) {
      const agent =
        index === 0
          ? value.agent
          : await agentService.createForAccount(value.bootstrap.userId, {
              name: `connection-agent-${index}`,
              displayName: `Connection Agent ${index}`,
              runtimeProvider: "codex",
              computerId: value.computer.id,
            });
      const bindingId = await value.imBindings.activateFeishu({
        agentId: agent.id,
        appId: `cli_conc_${index}`,
        appSecret: "secret",
        teamId: `tenant_conc_${index}`,
        botOpenId: `ou_conc_${index}`,
        grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
      });
      bindingIds.push(bindingId);
    }

    let releaseSlowBinding: (() => void) | undefined;
    const slowBindingGate = new Promise<void>((resolve) => {
      releaseSlowBinding = resolve;
    });
    let activeValidations = 0;
    let maxConcurrentValidations = 0;
    const completedAppIds: string[] = [];

    const instanceId = crypto.randomUUID();
    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId,
      imBindings: value.imBindings,
      maintenanceMs: 60_000,
      createAdapter: (input) => {
        const fake = fakeConnectionAdapter({
          appId: input.appId,
          botOpenId: input.appId.replace("cli_", "ou_"),
        });
        fake.adapter.validateBinding = vi.fn(async () => {
          activeValidations += 1;
          maxConcurrentValidations = Math.max(maxConcurrentValidations, activeValidations);
          try {
            if (input.appId === "cli_conc_0") {
              await slowBindingGate;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            completedAppIds.push(input.appId);
            return {
              externalAppId: input.appId,
              externalTeamId: input.teamId ?? "tenant_1",
              externalBotId: input.appId.replace("cli_", "ou_"),
            };
          } finally {
            activeValidations -= 1;
          }
        });
        return fake.adapter;
      },
    });

    try {
      manager.start();
      const maintainPromise = manager.maintain();

      // Even while cli_conc_0 is blocked, the remaining bindings should all complete via the other 15 workers.
      await vi.waitFor(() => {
        expect(completedAppIds).toHaveLength(totalBindings - 1);
      });
      expect(completedAppIds).not.toContain("cli_conc_0");
      expect(maxConcurrentValidations).toBeGreaterThan(1);
      expect(maxConcurrentValidations).toBeLessThanOrEqual(16);

      releaseSlowBinding?.();
      await maintainPromise;

      expect(completedAppIds).toHaveLength(totalBindings);
      const rows = await connectionDatabase.database.select().from(imBindings);
      expect(rows).toHaveLength(totalBindings);
      for (const row of rows) {
        expect(row.connectionOwnerInstanceId).toBe(instanceId);
        expect(row.observedConnectedAt).toBeInstanceOf(Date);
      }
    } finally {
      releaseSlowBinding?.();
      await manager.stop();
    }
  });

  it("skips overlapping scheduled maintenance ticks while a maintenance pass is already in flight", async () => {
    const value = await connectionFixture();
    await value.imBindings.activateFeishu({
      agentId: value.agent.id,
      appId: "cli_overlap",
      appSecret: "secret",
      teamId: "tenant_overlap",
      botOpenId: "ou_overlap",
      grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
    });

    let releaseValidation: (() => void) | undefined;
    let notifyValidationStarted: (() => void) | undefined;
    const validationStarted = new Promise<void>((resolve) => {
      notifyValidationStarted = resolve;
    });
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });

    const records: Array<Record<string, unknown>> = [];
    const perfLogger = createPerformanceLogger(
      () =>
        ({
          isLevelEnabled: () => true,
          debug: (payload: Record<string, unknown>) => records.push(payload),
          info: (payload: Record<string, unknown>) => records.push(payload),
          warn: (payload: Record<string, unknown>) => records.push(payload),
        }) as never,
    );

    const manager = new FeishuConnectionManager({
      database: connectionDatabase.database,
      inbox: { ingest: vi.fn() } as never,
      instanceId: crypto.randomUUID(),
      imBindings: value.imBindings,
      maintenanceMs: 25,
      createAdapter: (input) => {
        const fake = fakeConnectionAdapter({ appId: input.appId, botOpenId: "ou_overlap" });
        fake.adapter.validateBinding = vi.fn(async () => {
          notifyValidationStarted?.();
          await validationGate;
          return {
            externalAppId: input.appId,
            externalTeamId: "tenant_overlap",
            externalBotId: "ou_overlap",
          };
        });
        return fake.adapter;
      },
    });
    instrumentServerWorkers([["FeishuConnectionManager", manager]], perfLogger);

    try {
      // start() immediately schedules the first maintenance pass and starts the periodic timer.
      manager.start();
      await validationStarted;

      // Wait across multiple scheduler intervals while the first pass is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 90));

      const startedWhileInFlight = records.filter(
        (record) => record.operation === "FeishuConnectionManager.maintain" && record.outcome === "started",
      );
      expect(startedWhileInFlight).toHaveLength(1);

      releaseValidation?.();
      await manager.maintain();

      const completedAfterFirstPass = records.filter(
        (record) => record.operation === "FeishuConnectionManager.maintain" && record.outcome === "completed",
      );
      expect(completedAfterFirstPass.length).toBeGreaterThanOrEqual(1);
    } finally {
      releaseValidation?.();
      await manager.stop();
    }
  });
});
