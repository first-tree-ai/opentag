import type { Readable } from "node:stream";
import {
  Client,
  createLarkChannel,
  Domain,
  EventDispatcher,
  type LarkChannel,
  LoggerLevel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { type NormalizedInboundImEvent, NormalizedInboundImEventSchema } from "@opentag/shared";
import type {
  ImProviderAdapter,
  ProviderResourceInput,
  ReadableResource,
  VerifiedBotIdentity,
} from "../provider-adapter.js";

interface FeishuRawEnvelope {
  header?: { event_id?: string; tenant_key?: string };
  event_id?: string;
  tenant_key?: string;
  event?: { sender?: { sender_type?: string; tenant_key?: string } };
  opentagOperation?: "created" | "edited" | "deleted";
  opentagConversationKind?: "unknown";
}

interface RawFeishuMessageEvent {
  event_id?: string;
  tenant_key?: string;
  sender: {
    sender_id?: { open_id?: string; user_id?: string };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; user_id?: string };
      mentioned_type?: string;
      name: string;
    }>;
  };
}

interface RawFeishuRecallEvent {
  event_id?: string;
  tenant_key?: string;
  message_id?: string;
  chat_id?: string;
  recall_time?: string;
}

export interface FeishuChannel {
  botIdentity?: { openId: string; name?: string };
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  on(handlers: {
    message?: (message: NormalizedMessage) => Promise<void> | void;
    reconnecting?: () => void;
    reconnected?: () => void;
    error?: (error: unknown) => void;
  }): () => void;
}

export interface FeishuHttpCapability {
  fetchResource(input: ProviderResourceInput): Promise<ReadableResource>;
}

export interface FeishuHttpClient {
  im: {
    v1: {
      messageResource: {
        get(input: unknown): Promise<{ getReadableStream(): Readable }>;
      };
    };
  };
}

export interface VerifiedFeishuEnvelope {
  appId: string;
  teamId: string | null;
  message: NormalizedMessage;
}

interface FeishuScopeListResponse {
  code?: number;
  msg?: string;
  data?: {
    scopes?: Array<{ scope_name: string; grant_status: number; scope_type?: "user" | "tenant" }>;
  };
}

const REDACTING_SDK_LOGGER = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
  trace: () => undefined,
};

export function feishuDomainForWorkspaceBrand(teamBrand?: "feishu" | "lark" | null): Domain {
  return teamBrand === "lark" ? Domain.Lark : Domain.Feishu;
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= 24 * 1024) return { text: value, truncated: false };
  return { text: new TextDecoder().decode(encoded.subarray(0, 24 * 1024)), truncated: true };
}

function parseRawContent(message: RawFeishuMessageEvent["message"]): {
  text: string;
  resources: NormalizedMessage["resources"];
} {
  let content: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(message.content) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      content = parsed as Record<string, unknown>;
  } catch {
    return { text: `[unsupported:${message.message_type}]`, resources: [] };
  }
  if (message.message_type === "text") {
    return { text: typeof content.text === "string" ? content.text : "", resources: [] };
  }
  const resourceKey =
    typeof content.image_key === "string"
      ? content.image_key
      : typeof content.file_key === "string"
        ? content.file_key
        : undefined;
  if (resourceKey) {
    const type = message.message_type === "image" ? "image" : message.message_type === "audio" ? "audio" : "file";
    return {
      text: `[${message.message_type}]`,
      resources: [
        {
          type,
          fileKey: resourceKey,
          fileName: typeof content.file_name === "string" ? content.file_name : undefined,
        },
      ],
    };
  }
  if (message.message_type === "post") {
    const strings: string[] = [];
    const visit = (value: unknown): void => {
      if (typeof value === "object" && value !== null) {
        if (Array.isArray(value)) {
          for (const item of value) visit(item);
        } else {
          for (const [key, child] of Object.entries(value)) {
            if ((key === "text" || key === "content") && typeof child === "string") strings.push(child);
            else visit(child);
          }
        }
      }
    };
    visit(content);
    return { text: strings.join("\n").trim(), resources: [] };
  }
  return { text: `[unsupported:${message.message_type}]`, resources: [] };
}

function rawReceiveToNormalized(raw: RawFeishuMessageEvent): NormalizedMessage {
  const parsed = parseRawContent(raw.message);
  const senderId = raw.sender.sender_id?.open_id ?? raw.sender.sender_id?.user_id ?? "system";
  return {
    messageId: raw.message.message_id,
    chatId: raw.message.chat_id,
    chatType: raw.message.chat_type === "p2p" ? "p2p" : "group",
    senderId,
    content: parsed.text,
    rawContentType: raw.message.message_type,
    resources: parsed.resources,
    mentions: (raw.message.mentions ?? []).map((mention) => ({
      key: mention.key,
      openId: mention.id.open_id,
      userId: mention.id.user_id,
      name: mention.name,
      isBot: mention.mentioned_type === "app",
    })),
    mentionAll: raw.message.content.includes("@_all"),
    mentionedBot: false,
    rootId: raw.message.root_id,
    threadId: raw.message.thread_id,
    replyToMessageId: raw.message.parent_id,
    createTime: Number(raw.message.create_time),
    raw: {
      event_id: raw.event_id,
      tenant_key: raw.tenant_key,
      event: { sender: { sender_type: raw.sender.sender_type, tenant_key: raw.sender.tenant_key } },
      opentagOperation: "created",
    } satisfies FeishuRawEnvelope,
  };
}

function rawRecallToNormalized(raw: RawFeishuRecallEvent): NormalizedMessage | undefined {
  if (!raw.message_id || !raw.chat_id) return undefined;
  return {
    messageId: raw.message_id,
    chatId: raw.chat_id,
    chatType: "group",
    senderId: "system",
    content: "[deleted]",
    rawContentType: "deleted",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: Number(raw.recall_time ?? Date.now()),
    raw: {
      event_id: raw.event_id ?? `${raw.message_id}:${raw.recall_time ?? "unknown"}:recalled`,
      tenant_key: raw.tenant_key,
      opentagOperation: "deleted",
      opentagConversationKind: "unknown",
    } satisfies FeishuRawEnvelope,
  };
}

export function normalizeFeishuMessage(input: VerifiedFeishuEnvelope): NormalizedInboundImEvent[] {
  const raw = input.message.raw as FeishuRawEnvelope | undefined;
  const operation = raw?.opentagOperation ?? "created";
  const resources = input.message.resources.slice(0, 16).map((resource) => ({
    providerResourceKey: resource.fileKey,
    kind: resource.type === "sticker" ? ("image" as const) : resource.type,
    filename: resource.fileName?.slice(0, 512) ?? null,
    mediaType: null,
    sizeBytes: null,
  }));
  const mentions = input.message.mentions.slice(0, 256).flatMap((mention) => {
    const externalId = mention.openId ?? mention.userId;
    return externalId ? [{ externalId, displayName: mention.name ?? null }] : [];
  });
  const content = boundedText(input.message.content);
  return [
    NormalizedInboundImEventSchema.parse({
      providerEventId:
        raw?.header?.event_id ?? raw?.event_id ?? `${input.message.messageId}:${input.message.createTime}`,
      externalAppId: input.appId,
      externalTeamId:
        raw?.header?.tenant_key ?? raw?.tenant_key ?? raw?.event?.sender?.tenant_key ?? input.teamId ?? input.appId,
      providerContext: {
        provider: "feishu",
        ...(input.message.chatType ? { chatType: input.message.chatType } : {}),
        ...(input.message.threadId ? { threadId: input.message.threadId } : {}),
        ...(input.message.rootId ? { rootId: input.message.rootId } : {}),
        ...(input.message.replyToMessageId ? { parentId: input.message.replyToMessageId } : {}),
      },
      conversation: {
        externalId: input.message.chatId,
        kind:
          raw?.opentagConversationKind === "unknown" ? "unknown" : input.message.chatType === "p2p" ? "dm" : "channel",
      },
      message: {
        externalId: input.message.messageId,
        revisionKey: String(input.message.createTime),
        operation,
        threadKey: input.message.threadId ?? input.message.rootId ?? null,
        replyToExternalId: input.message.replyToMessageId ?? null,
        author: {
          externalId: input.message.senderId,
          kind: raw?.event?.sender?.sender_type === "app" ? "bot" : "human",
          displayName: input.message.senderName ?? null,
        },
        occurredAt: new Date(input.message.createTime),
        content: {
          version: 1,
          fallbackText: content.text,
          blocks: content.text
            ? [{ type: "text", text: content.text }]
            : [{ type: "unsupported", providerType: input.message.rawContentType }],
          truncated: content.truncated,
        },
        resources,
      },
      mentions,
    }),
  ];
}

export function createReliableFeishuDispatcher(
  onMessage: (message: NormalizedMessage) => Promise<void> | void,
): EventDispatcher {
  const dispatcher = new EventDispatcher({ logger: REDACTING_SDK_LOGGER, loggerLevel: LoggerLevel.error });
  dispatcher.register({
    "im.message.receive_v1": async (raw: RawFeishuMessageEvent) => {
      // Deliberately bypass LarkChannel's SafetyPipeline. EventDispatcher
      // awaits this promise, and WSClient maps rejection to a 500 ACK.
      await onMessage(rawReceiveToNormalized(raw));
    },
    "im.message.recalled_v1": async (raw: RawFeishuRecallEvent) => {
      const normalized = rawRecallToNormalized(raw);
      if (normalized) await onMessage(normalized);
    },
  });
  return dispatcher;
}

class ReliableFeishuChannel implements FeishuChannel {
  botIdentity?: { openId: string; name?: string };
  readonly #outbound: LarkChannel;
  readonly #wsClient: WSClient;
  #handlers: Parameters<FeishuChannel["on"]>[0] = {};
  readonly #ready: Promise<void>;
  #resolveReady: () => void = () => undefined;
  #rejectReady: (error: unknown) => void = () => undefined;

  constructor(input: { appId: string; appSecret: string; domain: Domain }) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#outbound = createLarkChannel({
      appId: input.appId,
      appSecret: input.appSecret,
      transport: "webhook",
      domain: input.domain,
      logger: REDACTING_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
      outbound: { retry: { maxAttempts: 1 } },
      source: "opentag",
    });
    const dispatcher = createReliableFeishuDispatcher(async (message) => {
      const handler = this.#handlers.message;
      if (!handler) throw new Error("FEISHU_ADMISSION_NOT_READY");
      await handler(message);
    });
    this.#wsClient = new WSClient({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.domain,
      logger: REDACTING_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
      autoReconnect: true,
      source: "opentag",
      handshakeTimeoutMs: 15_000,
      onReady: () => this.#resolveReady(),
      onError: (error) => {
        this.#rejectReady(new Error("FEISHU_CONNECTION_ERROR"));
        this.#handlers.error?.(error);
      },
      onReconnecting: () => this.#handlers.reconnecting?.(),
      onReconnected: () => this.#handlers.reconnected?.(),
    });
    void this.#wsClient.start({ eventDispatcher: dispatcher });
  }

  async connect(): Promise<void> {
    await this.#outbound.connect();
    this.botIdentity = this.#outbound.botIdentity;
    await this.#ready;
  }

  async disconnect(): Promise<void> {
    this.#wsClient.close({ force: true });
    await this.#outbound.disconnect();
  }

  on(handlers: Parameters<FeishuChannel["on"]>[0]): () => void {
    this.#handlers = handlers;
    return () => {
      if (this.#handlers === handlers) this.#handlers = {};
    };
  }
}

export class FeishuAdapter implements ImProviderAdapter<VerifiedFeishuEnvelope> {
  readonly provider = "feishu" as const;
  readonly #appId: string;
  readonly #channel: FeishuChannel | undefined;
  readonly #client: Client;
  readonly #http: FeishuHttpCapability;
  readonly #scopeList: () => Promise<FeishuScopeListResponse>;
  readonly #teamId: string | null;

  constructor(input: {
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand?: "feishu" | "lark" | null;
    channel?: FeishuChannel | null;
    http?: FeishuHttpCapability;
    scopeList?: () => Promise<FeishuScopeListResponse>;
  }) {
    this.#appId = input.appId;
    this.#teamId = input.teamId;
    const domain = feishuDomainForWorkspaceBrand(input.teamBrand);
    this.#client = new Client({
      appId: input.appId,
      appSecret: input.appSecret,
      domain,
      logger: REDACTING_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
    });
    this.#scopeList = input.scopeList ?? (() => this.#client.application.v6.scope.list({}));
    this.#channel =
      input.channel === null
        ? undefined
        : (input.channel ?? new ReliableFeishuChannel({ appId: input.appId, appSecret: input.appSecret, domain }));
    this.#http = input.http ?? createFeishuHttpCapability(this.#client as unknown as FeishuHttpClient);
  }

  get channel(): FeishuChannel {
    if (!this.#channel) throw new Error("FEISHU_INBOUND_CHANNEL_UNAVAILABLE");
    return this.#channel;
  }

  async validateBinding(): Promise<VerifiedBotIdentity> {
    const channel = this.channel;
    await channel.connect();
    const bot = channel.botIdentity;
    if (!bot) throw new Error("FEISHU_BOT_IDENTITY_MISSING");
    return { externalAppId: this.#appId, externalTeamId: this.#teamId ?? this.#appId, externalBotId: bot.openId };
  }

  async listGrantedWorkspaceScopes(): Promise<string[]> {
    const response = await this.#scopeList();
    if (response.code !== undefined && response.code !== 0) {
      throw new Error("FEISHU_SCOPE_VALIDATION_FAILED");
    }
    if (!response.data?.scopes) throw new Error("FEISHU_SCOPE_VALIDATION_FAILED");
    return [
      ...new Set(
        response.data.scopes
          .filter((scope) => scope.grant_status === 1 && scope.scope_type !== "user")
          .map((scope) => scope.scope_name),
      ),
    ].sort();
  }

  normalizeInbound(input: VerifiedFeishuEnvelope): NormalizedInboundImEvent[] {
    return normalizeFeishuMessage(input);
  }

  async fetchResource(input: ProviderResourceInput): Promise<ReadableResource> {
    return this.#http.fetchResource(input);
  }
}

export function createFeishuHttpCapability(client: FeishuHttpClient): FeishuHttpCapability {
  return {
    async fetchResource(input) {
      const response = await client.im.v1.messageResource.get({
        path: { message_id: input.messageExternalId, file_key: input.providerResourceKey },
        params: { type: input.kind === "image" ? "image" : "file" },
      });
      return { stream: response.getReadableStream() };
    },
  };
}
