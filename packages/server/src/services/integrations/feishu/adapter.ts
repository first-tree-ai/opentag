import type { Readable } from "node:stream";
import {
  Client,
  createLarkChannel,
  Domain,
  EventDispatcher,
  type LarkChannel,
  LarkChannelError,
  LoggerLevel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import {
  type NormalizedInboundImEvent,
  NormalizedInboundImEventSchema,
  type ProviderWriteResult,
} from "@opentag/shared";
import type {
  ImProviderAdapter,
  ProviderReactionInput,
  ProviderResourceInput,
  ProviderSendInput,
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
  send: LarkChannel["send"];
  addReaction: LarkChannel["addReaction"];
}

export interface FeishuHttpCapability {
  send(input: ProviderSendInput): Promise<ProviderWriteResult>;
  react(input: ProviderReactionInput): Promise<ProviderWriteResult>;
  fetchResource(input: ProviderResourceInput): Promise<ReadableResource>;
}

export interface FeishuHttpClient {
  im: {
    v1: {
      message: {
        create(input: unknown): Promise<FeishuMessageWriteResponse>;
        reply(input: unknown): Promise<FeishuMessageWriteResponse>;
      };
      messageReaction: {
        create(input: unknown): Promise<FeishuApiResponse>;
      };
      messageResource: {
        get(input: unknown): Promise<{ getReadableStream(): Readable }>;
      };
    };
  };
}

interface FeishuApiResponse {
  code?: number;
}

interface FeishuMessageWriteResponse extends FeishuApiResponse {
  data?: { message_id?: string; create_time?: string };
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

export function feishuDomainForTeamBrand(teamBrand?: "feishu" | "lark" | null): Domain {
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

export function mapFeishuError(error: unknown): ProviderWriteResult {
  if (!(error instanceof LarkChannelError)) {
    const record = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : undefined;
    const response =
      typeof record?.response === "object" && record.response !== null
        ? (record.response as Record<string, unknown>)
        : undefined;
    const data =
      typeof response?.data === "object" && response.data !== null
        ? (response.data as Record<string, unknown>)
        : typeof record?.data === "object" && record.data !== null
          ? (record.data as Record<string, unknown>)
          : undefined;
    const code =
      typeof data?.code === "number" ? data.code : typeof record?.code === "number" ? record.code : undefined;
    const apiFailure = mapKnownFeishuApiFailure(code);
    if (apiFailure) return apiFailure;
    const status =
      typeof response?.status === "number"
        ? response.status
        : typeof record?.status === "number"
          ? record.status
          : undefined;
    if (status === 429) return { ok: false, category: "rate_limited", code: "feishu_rate_limited" };
    if (status === 401 || status === 403) {
      return { ok: false, category: "credential", code: "feishu_permission_denied" };
    }
    if (status === 400) return { ok: false, category: "deterministic", code: "feishu_invalid_request" };
    if (status === 404) return { ok: false, category: "deterministic", code: "feishu_invalid_target" };
    if (code !== undefined) return { ok: false, category: "unknown", code: "feishu_api_error" };
    return { ok: false, category: "unknown", code: "feishu_unknown" };
  }
  if (error.code === "rate_limited") return { ok: false, category: "rate_limited", code: error.code };
  if (error.code === "permission_denied") {
    return { ok: false, category: "credential", code: error.code };
  }
  if (error.code === "not_connected") return { ok: false, category: "transient", code: error.code };
  if (["format_error", "target_revoked", "ssrf_blocked"].includes(error.code)) {
    return { ok: false, category: "deterministic", code: error.code };
  }
  return { ok: false, category: "unknown", code: error.code };
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

  send(...args: Parameters<LarkChannel["send"]>): ReturnType<LarkChannel["send"]> {
    return this.#outbound.send(...args);
  }

  addReaction(...args: Parameters<LarkChannel["addReaction"]>): ReturnType<LarkChannel["addReaction"]> {
    return this.#outbound.addReaction(...args);
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
    const domain = feishuDomainForTeamBrand(input.teamBrand);
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

  async listGrantedTeamScopes(): Promise<string[]> {
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

  async send(input: ProviderSendInput): Promise<ProviderWriteResult> {
    return this.#http.send(input);
  }

  async react(input: ProviderReactionInput): Promise<ProviderWriteResult> {
    return this.#http.react(input);
  }

  async fetchResource(input: ProviderResourceInput): Promise<ReadableResource> {
    return this.#http.fetchResource(input);
  }
}

function mapKnownFeishuApiFailure(code: number | undefined): ProviderWriteResult | undefined {
  if (code === undefined || code === 0) return undefined;
  if (code === 99991400) return { ok: false, category: "rate_limited", code: "feishu_rate_limited" };
  if ([99991401, 99991663, 99991664, 99991668, 99991672, 99991677, 230006, 230027].includes(code)) {
    return { ok: false, category: "credential", code: "feishu_permission_denied" };
  }
  if ([230017, 230020, 230030].includes(code)) {
    return { ok: false, category: "deterministic", code: "feishu_invalid_target" };
  }
  if ([230001, 230002, 230012].includes(code)) {
    return { ok: false, category: "deterministic", code: "feishu_invalid_request" };
  }
  return undefined;
}

export function mapFeishuApiFailure(code: number | undefined): ProviderWriteResult | undefined {
  const known = mapKnownFeishuApiFailure(code);
  if (known || code === undefined || code === 0) return known;
  return { ok: false, category: "unknown", code: "feishu_api_error" };
}

export function createFeishuHttpCapability(client: FeishuHttpClient): FeishuHttpCapability {
  return {
    async send(input) {
      try {
        const content = JSON.stringify({ text: input.fallbackText });
        const replyTarget = input.replyToExternalId ?? input.threadKey;
        const response = replyTarget
          ? await client.im.v1.message.reply({
              data: {
                content,
                msg_type: "text",
                reply_in_thread: Boolean(input.threadKey),
                ...(input.requestId ? { uuid: input.requestId } : {}),
              },
              path: { message_id: replyTarget },
            })
          : await client.im.v1.message.create({
              data: {
                receive_id: input.conversationExternalId,
                msg_type: "text",
                content,
                ...(input.requestId ? { uuid: input.requestId } : {}),
              },
              params: { receive_id_type: "chat_id" },
            });
        const failure = mapFeishuApiFailure(response.code);
        if (failure) return failure;
        if (!response.data?.message_id) return { ok: false, category: "unknown", code: "feishu_api_error" };
        const occurredAt = response.data.create_time ? new Date(Number(response.data.create_time)) : new Date();
        return { ok: true, externalMessageId: response.data.message_id, occurredAt };
      } catch (error) {
        return mapFeishuError(error);
      }
    },
    async react(input) {
      try {
        const response = await client.im.v1.messageReaction.create({
          data: { reaction_type: { emoji_type: input.emoji } },
          path: { message_id: input.messageExternalId },
        });
        const failure = mapFeishuApiFailure(response.code);
        if (failure) return failure;
        return { ok: true, externalMessageId: input.messageExternalId, occurredAt: new Date() };
      } catch (error) {
        return mapFeishuError(error);
      }
    },
    async fetchResource(input) {
      const response = await client.im.v1.messageResource.get({
        path: { message_id: input.messageExternalId, file_key: input.providerResourceKey },
        params: { type: input.kind === "image" ? "image" : "file" },
      });
      return { stream: response.getReadableStream() };
    },
  };
}
