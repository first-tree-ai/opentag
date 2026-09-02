import { Readable } from "node:stream";
import {
  Domain,
  type EventDispatcher,
  type LarkChannel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { FEISHU_REQUIRED_TENANT_SCOPES } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../admin/bootstrap.js";
import { computers, imBindings, imMessages } from "../db/schema/index.js";
import { AgentService } from "../services/agents/index.js";
import { ApplicationCipher } from "../services/crypto.js";
import {
  createFeishuHttpCapability,
  createReliableFeishuDispatcher,
  FeishuAdapter,
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
      "first\nsecond",
      "[unsupported:sticker]",
    ]);
    expect(received[1]?.resources[0]).toMatchObject({ fileKey: "img_1", fileName: "image.png" });
    expect(received[2]?.resources[0]).toMatchObject({ fileKey: "file_1" });
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
      await expect(adapter.validateBinding()).resolves.toEqual({
        externalAppId: "cli_default",
        externalTeamId: "cli_default",
        externalBotId: "ou_default",
      });
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
    await expect(
      http.fetchResource({ messageExternalId: "om_1", providerResourceKey: "file_1", kind: "file" }),
    ).resolves.toMatchObject({ stream: expect.any(Readable) });
    expect(get).toHaveBeenCalledTimes(1);

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

      await vi.advanceTimersByTimeAsync(1_000);
      await timedOut;
      await expect(http.resolveSenderName?.({ chatId: "oc_1", senderOpenId: "ou_sender" })).resolves.toBe("Mia Zhang");
      expect(getChatMembers).toHaveBeenCalledTimes(2);
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
    listGrantedWorkspaceScopes: vi.fn().mockResolvedValue(input.scopes ?? FEISHU_REQUIRED_TENANT_SCOPES),
    normalizeInbound: vi.fn().mockReturnValue([]),
    resolveSenderName: vi.fn(input.resolveSenderName ?? (async () => undefined)),
  };
  return {
    adapter: adapter as unknown as FeishuAdapter,
    channel,
    getHandlers: () => handlers,
    resolveSenderName: adapter.resolveSenderName,
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
    expect(verified).toMatchObject({ appId: "cli_conn", teamId: "tenant_1", botOpenId: "ou_bot", teamBrand: "lark" });
    const [row] = await connectionDatabase.database
      .select()
      .from(imBindings)
      .where(
        eq(
          imBindings.id,
          (
            await value.imBindings.getFeishuConnectionMaterial(
              (await value.imBindings.listFeishuConnectionIds(undefined))[0] ?? "",
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
    );
    expect(receipts.claim).toHaveBeenCalledWith({
      bindingId: expect.any(String),
      credentialGeneration: expect.any(Number),
      eventId: "ev_conn",
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
    const createAdapter = vi.fn().mockReturnValueOnce(first.adapter).mockReturnValueOnce(second.adapter);
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
});
