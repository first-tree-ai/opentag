import type { Readable } from "node:stream";
import {
  Client,
  createLarkChannel,
  Domain,
  defaultHttpInstance,
  EventDispatcher,
  type HttpInstance,
  type HttpRequestOptions,
  type LarkChannel,
  LoggerLevel,
  type NormalizedMessage,
  WSClient,
} from "@larksuiteoapi/node-sdk";
import { type NormalizedInboundImEvent, NormalizedInboundImEventSchema, truncateImText } from "@opentag/shared";
import {
  emitRootSpan,
  imAttrs,
  outcomeAttrs,
  type PerformanceLogger,
  traceExternalCall,
} from "../../../observability/index.js";
import { ExternalCallPolicy } from "../../im/external-call-policy.js";
import { type BotProfile, httpsAvatar } from "../bot-profile.js";
import { contentBlocksWithMentions } from "../mention-content.js";
import type {
  ImProviderAdapter,
  ProviderResourceInput,
  ReadableResource,
  VerifiedBotIdentity,
} from "../provider-adapter.js";
import { setFeishuFailureReaction } from "./failure-reaction.js";
import { feishuMessageContent } from "./message-content.js";

export type FeishuChatMode = "group" | "topic" | "p2p";
export type FeishuGroupMessageType = "chat" | "thread";

export interface FeishuChatMetadata {
  chatMode?: FeishuChatMode;
  groupMessageType?: FeishuGroupMessageType;
}

interface FeishuRawEnvelope {
  header?: { event_id?: string; tenant_key?: string };
  event_id?: string;
  tenant_key?: string;
  event?: { sender?: { sender_type?: string; tenant_key?: string } };
  opentagOperation?: "created" | "edited" | "deleted";
  opentagConversationKind?: "unknown";
  opentagSenderOpenId?: string;
  opentagContentTruncated?: boolean;
  opentagChatMode?: FeishuChatMode;
  opentagGroupMessageType?: FeishuGroupMessageType;
}

interface RawFeishuMessageEvent {
  header?: { event_id?: string; tenant_key?: string };
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
  header?: { event_id?: string; tenant_key?: string };
  event_id?: string;
  tenant_key?: string;
  message_id?: string;
  chat_id?: string;
  recall_time?: string;
}

export interface FeishuChannel {
  botIdentity?: { openId: string; name?: string };
  connect(signal?: AbortSignal): Promise<void>;
  disconnect(): Promise<void>;
  on(handlers: {
    message?: (message: NormalizedMessage) => Promise<void> | void;
    reconnecting?: () => void;
    reconnected?: () => void;
    error?: (error: unknown) => void;
  }): () => void;
}

export interface FeishuHttpCapability {
  fetchResource(input: ProviderResourceInput, signal?: AbortSignal): Promise<ReadableResource>;
  resolveSenderName?(input: { chatId: string; senderOpenId: string }): Promise<string | undefined>;
  resolveChatMetadata?(input: { chatId: string }, signal?: AbortSignal): Promise<FeishuChatMetadata | undefined>;
}

export interface FeishuHttpClient {
  im: {
    v1: {
      chats?: {
        get(
          input: { path: { chat_id: string } },
          options?: { signal?: AbortSignal },
        ): Promise<{
          code?: number;
          msg?: string;
          data?: { chat_mode?: string; group_message_type?: string };
        }>;
      };
      chatMembers: {
        get(input: {
          path: { chat_id: string };
          params: {
            member_id_type: "open_id";
            page_size: number;
            page_token?: string;
          };
        }): Promise<{
          code?: number;
          msg?: string;
          data?: {
            items?: Array<{ member_id?: string; name?: string }>;
            page_token?: string;
            has_more?: boolean;
          };
        }>;
      };
      messageResource: {
        get(input: unknown, options?: { signal?: AbortSignal }): Promise<{ getReadableStream(): Readable }>;
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

const DEDUPLICATION_TTL_MS = 10 * 60 * 1000;
const DEDUPLICATION_MAX_ENTRIES = 10_000;

type FeishuRawInboundEvent = RawFeishuMessageEvent | RawFeishuRecallEvent;

function providerEventIdentity(raw: FeishuRawInboundEvent): {
  keys: string[];
  providerEventId: string | null;
  externalMessageId: string | null;
} | null {
  const providerEventId = raw.header?.event_id ?? raw.event_id ?? null;
  const tenantKey = raw.header?.tenant_key ?? raw.tenant_key ?? ("sender" in raw ? raw.sender.tenant_key : null);
  if ("message" in raw) {
    const externalMessageId = raw.message.message_id;
    const scope = `${tenantKey ?? "unknown"}:${raw.message.chat_id}`;
    const messageKey = `message:${scope}:${externalMessageId}:${raw.message.create_time}`;
    if (providerEventId) {
      return { keys: [`event:${scope}:${providerEventId}`, messageKey], providerEventId, externalMessageId };
    }
    return {
      keys: [messageKey],
      providerEventId: null,
      externalMessageId,
    };
  }
  const externalMessageId = raw.message_id ?? null;
  if (!externalMessageId && !providerEventId) return null;
  const scope = `${tenantKey ?? "unknown"}:${raw.chat_id ?? "unknown"}`;
  const messageKey = `recall:${scope}:${externalMessageId}:${raw.recall_time ?? "unknown"}`;
  if (providerEventId) {
    return { keys: [`event:${scope}:${providerEventId}`, messageKey], providerEventId, externalMessageId };
  }
  return {
    keys: [messageKey],
    providerEventId: null,
    externalMessageId,
  };
}

function createFeishuInboundDeduplicator() {
  const entries = new Map<string, { expiresAt: number; promise?: Promise<void> }>();

  const prune = (now: number): void => {
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > DEDUPLICATION_MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return async (raw: FeishuRawInboundEvent, onMessage: () => Promise<void>): Promise<void> => {
    const identity = providerEventIdentity(raw);
    if (!identity) return onMessage();
    const now = Date.now();
    prune(now);
    const existing = identity.keys.map((key) => entries.get(key)).find((entry) => entry !== undefined);
    if (existing) {
      emitRootSpan("feishu.inbound.deduplicated", {
        ...imAttrs({
          provider: "feishu",
          providerEventId: identity.providerEventId,
          externalMessageId: identity.externalMessageId,
          duplicate: true,
        }),
        ...outcomeAttrs("duplicate"),
      });
      if (existing.promise) await existing.promise;
      return;
    }
    const promise = onMessage();
    const entry = { expiresAt: now + DEDUPLICATION_TTL_MS, promise };
    for (const key of identity.keys) entries.set(key, entry);
    try {
      await promise;
    } catch (error) {
      for (const key of identity.keys) {
        const current = entries.get(key);
        if (current?.promise === promise) entries.delete(key);
      }
      throw error;
    } finally {
      for (const key of identity.keys) {
        const current = entries.get(key);
        if (current?.promise === promise) entries.set(key, { expiresAt: current.expiresAt });
      }
    }
  };
}

export function feishuDomainForWorkspaceBrand(teamBrand?: "feishu" | "lark" | null): Domain {
  return teamBrand === "lark" ? Domain.Lark : Domain.Feishu;
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const text = truncateImText(value, 24 * 1024);
  return { text, truncated: text !== value };
}

function feishuChatMode(value: unknown): FeishuChatMode | undefined {
  return value === "group" || value === "topic" || value === "p2p" ? value : undefined;
}

function feishuGroupMessageType(value: unknown): FeishuGroupMessageType | undefined {
  return value === "chat" || value === "thread" ? value : undefined;
}

function rawReceiveToNormalized(raw: RawFeishuMessageEvent): NormalizedMessage {
  const parsed = feishuMessageContent(raw.message.message_type, raw.message.content, raw.message.mentions);
  const senderId = raw.sender.sender_id?.open_id ?? raw.sender.sender_id?.user_id ?? "system";
  const eventId = raw.header?.event_id ?? raw.event_id;
  const tenantKey = raw.header?.tenant_key ?? raw.tenant_key ?? raw.sender.tenant_key;
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
      event_id: eventId,
      tenant_key: tenantKey,
      event: { sender: { sender_type: raw.sender.sender_type, tenant_key: raw.sender.tenant_key } },
      opentagOperation: "created",
      opentagSenderOpenId: raw.sender.sender_id?.open_id,
      opentagContentTruncated: parsed.truncated,
      ...(raw.message.chat_type === "p2p" ? { opentagChatMode: "p2p" as const } : {}),
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
      event_id: raw.header?.event_id ?? raw.event_id ?? `${raw.message_id}:${raw.recall_time ?? "unknown"}:recalled`,
      tenant_key: raw.header?.tenant_key ?? raw.tenant_key,
      opentagOperation: "deleted",
      opentagConversationKind: "unknown",
    } satisfies FeishuRawEnvelope,
  };
}

function contentWasTruncated(message: NormalizedMessage): boolean {
  const raw = message.raw as FeishuRawEnvelope | undefined;
  return raw?.opentagContentTruncated === true || message.resources.length > 16;
}

function normalizedChatMode(
  message: NormalizedMessage,
  raw: FeishuRawEnvelope | undefined,
): FeishuChatMode | undefined {
  const explicit = feishuChatMode(raw?.opentagChatMode);
  if (explicit) return explicit;
  if (raw?.opentagConversationKind === "unknown") return undefined;
  return message.chatType === "p2p" ? "p2p" : undefined;
}

function normalizedProviderContext(
  message: NormalizedMessage,
  raw: FeishuRawEnvelope | undefined,
): NormalizedInboundImEvent["providerContext"] {
  const chatMode = normalizedChatMode(message, raw);
  const groupMessageType = feishuGroupMessageType(raw?.opentagGroupMessageType);
  return {
    provider: "feishu",
    ...(message.chatType ? { chatType: message.chatType } : {}),
    ...(chatMode ? { chatMode } : {}),
    ...(groupMessageType ? { groupMessageType } : {}),
    ...(message.threadId ? { threadId: message.threadId } : {}),
    ...(message.rootId ? { rootId: message.rootId } : {}),
    ...(message.replyToMessageId ? { parentId: message.replyToMessageId } : {}),
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
  const contentBlocks = feishuContentBlocks(input.message, content.text);
  return [
    NormalizedInboundImEventSchema.parse({
      providerEventId:
        raw?.header?.event_id ?? raw?.event_id ?? `${input.message.messageId}:${input.message.createTime}`,
      externalAppId: input.appId,
      externalTeamId:
        raw?.header?.tenant_key ?? raw?.tenant_key ?? raw?.event?.sender?.tenant_key ?? input.teamId ?? input.appId,
      providerContext: normalizedProviderContext(input.message, raw),
      conversation: {
        externalId: input.message.chatId,
        kind:
          raw?.opentagConversationKind === "unknown" ? "unknown" : input.message.chatType === "p2p" ? "dm" : "channel",
      },
      message: {
        externalId: input.message.messageId,
        revisionKey: String(input.message.createTime),
        operation,
        // Only a real Feishu thread defines a Thread Session. A quote reply in an ordinary group carries
        // root_id/parent_id without thread_id and stays in the channel Session with its reply target.
        threadKey: input.message.threadId ?? null,
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
          blocks: contentBlocks,
          truncated: content.truncated || contentWasTruncated(input.message),
        },
        resources,
      },
      mentions,
    }),
  ];
}

/**
 * Return the provider envelope event ID when one was supplied. Normalization retains a deterministic
 * fallback in `providerEventId` for the inbox semantic key, but that fallback is not a delivery receipt.
 */
export function feishuEnvelopeEventId(event: NormalizedInboundImEvent): string | null {
  const messageId = event.message.externalId;
  const occurredAt = event.message.occurredAt.getTime();
  const syntheticCreatedId = `${messageId}:${occurredAt}`;
  const syntheticRecallId = `${messageId}:${occurredAt}:recalled`;
  return event.providerEventId === syntheticCreatedId || event.providerEventId === syntheticRecallId
    ? null
    : event.providerEventId;
}

export function createReliableFeishuDispatcher(
  onMessage: (message: NormalizedMessage) => Promise<void> | void,
  onCardAction?: (event: unknown) => Promise<unknown>,
): EventDispatcher {
  const dispatcher = new EventDispatcher({ logger: REDACTING_SDK_LOGGER, loggerLevel: LoggerLevel.error });
  const deduplicate = createFeishuInboundDeduplicator();
  dispatcher.register({
    "card.action.trigger": async (event: unknown) =>
      (await onCardAction?.(event)) ?? { toast: { type: "error", content: "This approval is unavailable." } },
    "im.message.receive_v1": async (raw: RawFeishuMessageEvent) => {
      // Deliberately bypass LarkChannel's SafetyPipeline. EventDispatcher
      // awaits this promise, and WSClient maps rejection to a 500 ACK.
      await deduplicate(raw, async () => onMessage(rawReceiveToNormalized(raw)));
    },
    "im.message.recalled_v1": async (raw: RawFeishuRecallEvent) => {
      const normalized = rawRecallToNormalized(raw);
      if (normalized) await deduplicate(raw, async () => onMessage(normalized));
    },
  });
  return dispatcher;
}

class ReliableFeishuChannel implements FeishuChannel {
  botIdentity?: { openId: string; name?: string };
  readonly #outbound: LarkChannel;
  readonly #wsClient: WSClient;
  readonly #dispatcher: EventDispatcher;
  #handlers: Parameters<FeishuChannel["on"]>[0] = {};
  readonly #ready: Promise<void>;
  #resolveReady: () => void = () => undefined;
  #rejectReady: (error: unknown) => void = () => undefined;
  #started = false;
  #closed = false;

  constructor(input: {
    appId: string;
    appSecret: string;
    domain: Domain;
    onCardAction?: (event: unknown) => Promise<unknown>;
  }) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    // SDK callbacks can reject readiness after a failed or cancelled connect has already returned.
    void this.#ready.catch(() => undefined);
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
    this.#dispatcher = createReliableFeishuDispatcher(async (message) => {
      const handler = this.#handlers.message;
      if (!handler) throw new Error("FEISHU_ADMISSION_NOT_READY");
      await handler(message);
    }, input.onCardAction);
    this.#wsClient = new WSClient({
      appId: input.appId,
      appSecret: input.appSecret,
      domain: input.domain,
      logger: REDACTING_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
      autoReconnect: true,
      source: "opentag",
      handshakeTimeoutMs: 15_000,
      onReady: () => {
        if (!this.#closed) this.#resolveReady();
      },
      onError: (error) => this.#onConnectionError(error),
      onReconnecting: () => this.#handlers.reconnecting?.(),
      onReconnected: () => this.#handlers.reconnected?.(),
    });
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new Error("FEISHU_CHANNEL_CLOSED");
    if (signal?.aborted) throw signal.reason ?? new Error("FEISHU_CONNECT_ABORTED");
    const state = { cancelled: false };
    let onAbort: (() => void) | undefined;
    try {
      if (!this.#started) {
        this.#started = true;
        void this.#wsClient
          .start({ eventDispatcher: this.#dispatcher })
          .catch((error: unknown) => this.#onConnectionError(error));
      }
      const connectPromise = this.#connectAndWaitReady(state, signal);
      if (!signal) {
        await connectPromise;
        return;
      }
      await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) => {
          onAbort = () => {
            this.#quarantineAbortedConnect(state);
            reject(signal.reason ?? new Error("FEISHU_CONNECT_ABORTED"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      await this.disconnect().catch(() => undefined);
      throw error;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  #onConnectionError(error: unknown): void {
    // The cause keeps the gateway's refusal code for connection-failure classification.
    this.#rejectReady(new Error("FEISHU_CONNECTION_ERROR", { cause: error }));
    this.#handlers.error?.(error);
  }

  async #connectAndWaitReady(state: { cancelled: boolean }, signal?: AbortSignal): Promise<void> {
    const outboundPromise = this.#outbound.connect();
    void outboundPromise.then(
      async () => {
        if (state.cancelled || this.#closed || signal?.aborted) {
          this.botIdentity = undefined;
          await this.#outbound.disconnect().catch(() => undefined);
        }
      },
      () => undefined,
    );
    await outboundPromise;
    if (state.cancelled || this.#closed || signal?.aborted) {
      await this.#failAbortedConnect(signal);
    }
    await this.#ready;
    if (state.cancelled || this.#closed || signal?.aborted) {
      await this.#failAbortedConnect(signal);
    }
    this.botIdentity = this.#outbound.botIdentity;
  }

  async #failAbortedConnect(signal?: AbortSignal): Promise<never> {
    this.botIdentity = undefined;
    await this.disconnect().catch(() => undefined);
    throw signal?.reason ?? new Error("FEISHU_CONNECT_ABORTED");
  }

  #quarantineAbortedConnect(state: { cancelled: boolean }): void {
    state.cancelled = true;
    void this.disconnect().catch(() => undefined);
  }

  async disconnect(): Promise<void> {
    this.#closed = true;
    this.botIdentity = undefined;
    this.#rejectReady(new Error("FEISHU_CHANNEL_CLOSED"));
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

export function createFeishuHttpInstance(signal?: AbortSignal): HttpInstance {
  const instance = defaultHttpInstance as unknown as HttpInstance;
  const withSignal = <D>(options: HttpRequestOptions<D> | undefined): HttpRequestOptions<D> =>
    ({ ...(options ?? {}), ...(signal ? { signal } : {}) }) as HttpRequestOptions<D>;
  return {
    request: (options) => instance.request(withSignal(options)),
    get: (url, options) => instance.get(url, withSignal(options)),
    delete: (url, options) => instance.delete(url, withSignal(options)),
    head: (url, options) => instance.head(url, withSignal(options)),
    options: (url, options) => instance.options(url, withSignal(options)),
    post: async (url, data, options) => {
      const response = await instance.post(url, data, withSignal(options));
      // The SDK converts HTTP-200 token failures to a plain Error, losing the structured code.
      // Preserve only that code at the transport boundary; never retain credentials or raw messages.
      if (/\/open-apis\/auth\/v3\/(?:tenant|app)_access_token\/internal$/.test(url)) {
        const code = (response as { code?: unknown } | undefined)?.code;
        if (typeof code === "number" && code !== 0) {
          throw Object.assign(new Error("FEISHU_TOKEN_REQUEST_FAILED"), { code });
        }
      }
      return response;
    },
    put: (url, data, options) => instance.put(url, data, withSignal(options)),
    patch: (url, data, options) => instance.patch(url, data, withSignal(options)),
  } as HttpInstance;
}

export interface FeishuBotProbe {
  profile?: BotProfile;
  openId: string;
  /** Provider-reported bot activation status; `null` when the platform omits it. */
  activateStatus: number | null;
}

export class FeishuAdapter implements ImProviderAdapter<VerifiedFeishuEnvelope> {
  readonly provider = "feishu" as const;
  readonly #appId: string;
  readonly #channel: FeishuChannel | undefined;
  readonly #client: Client;
  readonly #reactionClient: (signal: AbortSignal) => Client;
  readonly #http: FeishuHttpCapability;
  readonly #scopeList: () => Promise<FeishuScopeListResponse>;
  readonly #teamId: string | null;
  readonly #policy: ExternalCallPolicy;
  readonly #perfLogger: PerformanceLogger | undefined;

  constructor(input: {
    onCardAction?: (event: unknown) => Promise<unknown>;
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand?: "feishu" | "lark" | null;
    channel?: FeishuChannel | null;
    http?: FeishuHttpCapability;
    scopeList?: () => Promise<FeishuScopeListResponse>;
    /* type-only */ policy?: ExternalCallPolicy;
    performanceLogger?: PerformanceLogger;
  }) {
    this.#appId = input.appId;
    this.#teamId = input.teamId;
    this.#policy =
      input.policy ??
      new ExternalCallPolicy({
        allowedHosts: ["open.feishu.cn", "open.larksuite.com"],
      });
    this.#perfLogger = input.performanceLogger ?? this.#policy.performanceLogger;
    const domain = feishuDomainForWorkspaceBrand(input.teamBrand);
    const clientOptions = {
      appId: input.appId,
      appSecret: input.appSecret,
      domain,
      logger: REDACTING_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
      httpInstance: createFeishuHttpInstance(),
    };
    this.#client = new Client(clientOptions);
    this.#reactionClient = (signal) => new Client({ ...clientOptions, httpInstance: createFeishuHttpInstance(signal) });
    this.#scopeList = input.scopeList ?? (() => this.#client.application.v6.scope.list({}));
    this.#http =
      input.http ??
      createFeishuHttpCapability(
        this.#client as unknown as FeishuHttpClient,
        (signal) =>
          new Client({
            ...clientOptions,
            httpInstance: createFeishuHttpInstance(signal),
          }) as unknown as FeishuHttpClient,
      );
    this.#channel =
      input.channel === null
        ? undefined
        : (input.channel ??
          new ReliableFeishuChannel({
            appId: input.appId,
            appSecret: input.appSecret,
            domain,
            onCardAction: input.onCardAction,
          }));
  }

  async setFailureReaction(input: { channelId: string; externalMessageId: string; failed: boolean }): Promise<void> {
    await this.#policy.run(
      "feishu.message.failure-reaction",
      (signal) =>
        setFeishuFailureReaction(
          this.#reactionClient(signal).im.v1.messageReaction,
          this.#appId,
          input.externalMessageId,
          input.failed,
        ),
      { circuitKey: `feishu:message-reactions:${this.#appId}`, maxAttempts: 1, timeoutMs: 8_000 },
    );
  }

  get channel(): FeishuChannel {
    if (!this.#channel) throw new Error("FEISHU_INBOUND_CHANNEL_UNAVAILABLE");
    return this.#channel;
  }

  async validateBinding(signal?: AbortSignal): Promise<VerifiedBotIdentity> {
    const channel = this.channel;
    await traceExternalCall(
      this.#perfLogger,
      {
        provider: "feishu",
        operation: "external.feishu.channel.connect",
      },
      () => channel.connect(signal),
      { fallbackErrorCode: "FEISHU_CONNECT_FAILED" },
    );
    const bot = channel.botIdentity;
    if (!bot) throw new Error("FEISHU_BOT_IDENTITY_MISSING");
    return { externalAppId: this.#appId, externalTeamId: this.#teamId ?? this.#appId, externalBotId: bot.openId };
  }

  async listGrantedWorkspaceScopes(): Promise<string[]> {
    const response = await this.#scopeList();
    if (response.code !== undefined && response.code !== 0) {
      throw Object.assign(new Error("FEISHU_SCOPE_VALIDATION_FAILED"), { code: response.code });
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

  /**
   * Reads the official Bot info endpoint without touching the message channel. The durable-candidate
   * check uses this to tell an installed-but-not-enabled App apart from missing tenant scopes, and a
   * candidate must never open a socket just to answer that question.
   */
  async probeBotIdentity(): Promise<FeishuBotProbe> {
    const response = await this.#client.request<{
      code?: number;
      bot?: { open_id?: string; activate_status?: number; app_name?: string; avatar_url?: string };
    }>({ url: "/open-apis/bot/v3/info", method: "GET" });
    if (response.code !== undefined && response.code !== 0) {
      throw Object.assign(new Error("FEISHU_BOT_INFO_FAILED"), { code: response.code });
    }
    const openId = response.bot?.open_id;
    if (!openId) {
      throw Object.assign(new Error("FEISHU_BOT_IDENTITY_MISSING"), { code: "FEISHU_BOT_IDENTITY_MISSING" });
    }
    return {
      openId,
      activateStatus: response.bot?.activate_status ?? null,
      profile: {
        displayName: response.bot?.app_name?.slice(0, 255) || null,
        avatarUrl: httpsAvatar(response.bot?.avatar_url),
      },
    };
  }

  normalizeInbound(input: VerifiedFeishuEnvelope): NormalizedInboundImEvent[] {
    return normalizeFeishuMessage(input);
  }

  async fetchResource(input: ProviderResourceInput): Promise<ReadableResource> {
    return this.#policy.run("feishu.resource.fetch", (signal) => this.#http.fetchResource(input, signal), {
      circuitKey: `feishu:resource:${this.#appId}`,
      maxAttempts: 1,
    });
  }

  async resolveSenderName(input: { chatId: string; senderOpenId: string }): Promise<string | undefined> {
    const resolveSenderName = this.#http.resolveSenderName;
    if (!resolveSenderName) return undefined;
    return this.#policy.run("feishu.sender-name.resolve", () => resolveSenderName(input), {
      circuitKey: `feishu:sender-name:${this.#appId}`,
      maxAttempts: 1,
      timeoutMs: FEISHU_SENDER_NAME_POLICY_TIMEOUT_MS,
    });
  }

  async resolveChatMetadata(input: { chatId: string }): Promise<FeishuChatMetadata | undefined> {
    const resolveChatMetadata = this.#http.resolveChatMetadata;
    if (!resolveChatMetadata) return undefined;
    return this.#policy.run("feishu.chat-mode.resolve", (signal) => resolveChatMetadata(input, signal), {
      circuitKey: `feishu:chat-mode:${this.#appId}`,
      maxAttempts: 1,
      timeoutMs: FEISHU_CHAT_MODE_POLICY_TIMEOUT_MS,
    });
  }
}

const FEISHU_SENDER_NAME_TTL_MS = 60 * 60 * 1000;
const FEISHU_MISSING_SENDER_NAME_TTL_MS = 5 * 60 * 1000;
const FEISHU_SENDER_NAME_CACHE_MAX_ENTRIES = 10_000;
/**
 * The lookup is a paginated HTTPS scan of `chatMembers.get` at 100 members per page, so the budget
 * must cover several provider round trips: at about 300 ms per page a 1 s budget reached only the
 * first three pages and left every sender beyond them without a display name. The lookup runs
 * detached from inbound processing, so this budget never delays message persistence.
 */
const FEISHU_SENDER_NAME_LOOKUP_TIMEOUT_MS = 4_000;
/** Invariant: the policy deadline outlives the lookup deadline, so the lookup reports its own timeout. */
const FEISHU_SENDER_NAME_POLICY_TIMEOUT_MS = 5_000;

const FEISHU_CHAT_MODE_TTL_MS = 60 * 60 * 1000;
const FEISHU_MISSING_CHAT_MODE_TTL_MS = 5 * 60 * 1000;
const FEISHU_FAILED_CHAT_MODE_TTL_MS = 30 * 1000;
const FEISHU_CHAT_MODE_CACHE_MAX_ENTRIES = 10_000;
const FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS = 4_000;
const FEISHU_CHAT_MODE_POLICY_TIMEOUT_MS = 5_000;

export function feishuSenderOpenId(message: NormalizedMessage): string | null {
  const raw = message.raw as FeishuRawEnvelope | undefined;
  return raw?.opentagSenderOpenId ?? null;
}

interface FeishuSenderNameCacheEntry {
  expiresAt: number;
  name: string | undefined;
}

interface FeishuOpenIdNameCacheEntry {
  expiresAt: number;
  name: string;
}

interface FeishuChatScanCursor {
  nextPageToken: string;
  expiresAt: number;
}

interface FeishuSenderNameWaiter {
  senderOpenId: string;
  resolve: (name: string | undefined) => void;
  reject: (error: unknown) => void;
}

interface PendingFeishuChatScan {
  retired: boolean;
  cursorInvalidated: boolean;
  waiters: Set<FeishuSenderNameWaiter>;
}

async function fetchFeishuChatMembersPage(
  client: FeishuHttpClient,
  chatId: string,
  pageToken: string | undefined,
): Promise<{
  items: Array<{ member_id?: string; name?: string }>;
  nextPageToken: string | undefined;
}> {
  const response = await client.im.v1.chatMembers.get({
    path: { chat_id: chatId },
    params: {
      member_id_type: "open_id",
      page_size: 100,
      ...(pageToken ? { page_token: pageToken } : {}),
    },
  });
  if (response.code !== undefined && response.code !== 0) {
    throw new Error("FEISHU_SENDER_NAME_LOOKUP_FAILED");
  }
  return {
    items: response.data?.items ?? [],
    nextPageToken: response.data?.has_more ? response.data.page_token : undefined,
  };
}

function withFeishuSenderNameTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("FEISHU_SENDER_NAME_LOOKUP_TIMEOUT")),
      FEISHU_SENDER_NAME_LOOKUP_TIMEOUT_MS,
    );
    timer.unref();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function evictOldestEntries<K, V>(map: Map<K, V>, maxEntries: number, onEvict?: (key: K) => void): void {
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
    onEvict?.(oldest);
  }
}

function readValidLruEntry<K, V extends { expiresAt: number }>(map: Map<K, V>, key: K, now: number): V | undefined {
  const cached = map.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= now) {
    map.delete(key);
    return undefined;
  }
  map.delete(key);
  map.set(key, cached);
  return cached;
}

function createCachedFeishuSenderNameResolver(
  client: FeishuHttpClient,
): (input: { chatId: string; senderOpenId: string }) => Promise<string | undefined> {
  const senderNames = new Map<string, FeishuSenderNameCacheEntry>();
  const senderNamesByOpenId = new Map<string, FeishuOpenIdNameCacheEntry>();
  const chatScanCursors = new Map<string, FeishuChatScanCursor>();
  const pendingChatScans = new Map<string, PendingFeishuChatScan>();

  const cacheKey = (chatId: string, senderOpenId: string): string => `${chatId}:${senderOpenId}`;

  const rememberOpenId = (senderOpenId: string, name: string, now: number): void => {
    senderNamesByOpenId.delete(senderOpenId);
    senderNamesByOpenId.set(senderOpenId, {
      expiresAt: now + FEISHU_SENDER_NAME_TTL_MS,
      name,
    });
    evictOldestEntries(senderNamesByOpenId, FEISHU_SENDER_NAME_CACHE_MAX_ENTRIES);
  };

  const invalidateChatCursor = (chatId: string): void => {
    chatScanCursors.delete(chatId);
    const pendingScan = pendingChatScans.get(chatId);
    if (pendingScan) {
      pendingScan.cursorInvalidated = true;
      pendingChatScans.delete(chatId);
    }
  };

  const remember = (chatId: string, senderOpenId: string, name: string | undefined, now: number): void => {
    const key = cacheKey(chatId, senderOpenId);
    senderNames.delete(key);
    senderNames.set(key, {
      expiresAt: now + (name ? FEISHU_SENDER_NAME_TTL_MS : FEISHU_MISSING_SENDER_NAME_TTL_MS),
      name,
    });
    evictOldestEntries(senderNames, FEISHU_SENDER_NAME_CACHE_MAX_ENTRIES, (oldest) => {
      const separator = oldest.lastIndexOf(":");
      if (separator > 0) {
        invalidateChatCursor(oldest.slice(0, separator));
      }
    });
    if (name) {
      rememberOpenId(senderOpenId, name, now);
    }
  };

  const rememberCursor = (
    chatId: string,
    scan: PendingFeishuChatScan,
    nextPageToken: string,
    expiresAt: number,
  ): void => {
    if (scan.cursorInvalidated) return;
    chatScanCursors.delete(chatId);
    chatScanCursors.set(chatId, { nextPageToken, expiresAt });
    evictOldestEntries(chatScanCursors, FEISHU_SENDER_NAME_CACHE_MAX_ENTRIES);
  };

  const clearCursor = (chatId: string, scan: PendingFeishuChatScan): void => {
    if (!scan.cursorInvalidated) {
      chatScanCursors.delete(chatId);
    }
  };

  const readOpenIdCached = (senderOpenId: string, now: number): string | undefined =>
    readValidLruEntry(senderNamesByOpenId, senderOpenId, now)?.name;

  const readChatCached = (
    chatId: string,
    senderOpenId: string,
    now: number,
  ): { hit: true; name: string | undefined } | { hit: false } => {
    const cached = readValidLruEntry(senderNames, cacheKey(chatId, senderOpenId), now);
    return cached ? { hit: true, name: cached.name } : { hit: false };
  };

  const readCached = (
    chatId: string,
    senderOpenId: string,
    now: number,
  ): { hit: true; name: string | undefined } | { hit: false } => {
    const chatCached = readChatCached(chatId, senderOpenId, now);
    if (chatCached.hit) {
      return { hit: true, name: chatCached.name ?? readOpenIdCached(senderOpenId, now) };
    }
    const openIdName = readOpenIdCached(senderOpenId, now);
    return openIdName !== undefined ? { hit: true, name: openIdName } : { hit: false };
  };

  const takeInitialScanCursor = (
    chatId: string,
    now: number,
  ): { pageToken: string | undefined; cursorExpiresAt: number } => {
    const existing = readValidLruEntry(chatScanCursors, chatId, now);
    chatScanCursors.delete(chatId);
    return {
      pageToken: existing?.nextPageToken,
      cursorExpiresAt: existing?.expiresAt ?? now + FEISHU_MISSING_SENDER_NAME_TTL_MS,
    };
  };

  const cachePageMembers = (chatId: string, items: Array<{ member_id?: string; name?: string }>, now: number): void => {
    for (const member of items) {
      const name = member.name?.trim();
      if (member.member_id && name) {
        remember(chatId, member.member_id, name, now);
      }
    }
  };

  const resolveMatchedWaiters = (chatId: string, scan: PendingFeishuChatScan, now: number): void => {
    for (const waiter of scan.waiters) {
      const chatHit = readChatCached(chatId, waiter.senderOpenId, now);
      if (chatHit.hit && chatHit.name !== undefined) {
        scan.waiters.delete(waiter);
        waiter.resolve(chatHit.name);
      }
    }
  };

  const resolveRemainingWaitersAtScanEnd = (chatId: string, scan: PendingFeishuChatScan, now: number): void => {
    for (const waiter of scan.waiters) {
      scan.waiters.delete(waiter);
      const resolved = readCached(chatId, waiter.senderOpenId, now);
      if (!resolved.hit) {
        remember(chatId, waiter.senderOpenId, undefined, now);
      }
      waiter.resolve(resolved.hit ? resolved.name : undefined);
    }
  };

  const failChatScan = (chatId: string, scan: PendingFeishuChatScan, error: unknown): void => {
    if (scan.retired) return;
    clearCursor(chatId, scan);
    if (pendingChatScans.get(chatId) === scan) {
      pendingChatScans.delete(chatId);
    }
    for (const waiter of scan.waiters) {
      scan.waiters.delete(waiter);
      waiter.reject(error);
    }
  };

  const retireWaiter = (chatId: string, scan: PendingFeishuChatScan, waiter: FeishuSenderNameWaiter): void => {
    scan.waiters.delete(waiter);
    if (scan.waiters.size === 0) {
      scan.retired = true;
      if (pendingChatScans.get(chatId) === scan) {
        pendingChatScans.delete(chatId);
      }
    }
  };

  const runChatScan = async (chatId: string, scan: PendingFeishuChatScan): Promise<void> => {
    const initial = takeInitialScanCursor(chatId, Date.now());
    let pageToken = initial.pageToken;
    try {
      do {
        const page = await fetchFeishuChatMembersPage(client, chatId, pageToken);
        if (scan.retired) return;
        const now = Date.now();
        cachePageMembers(chatId, page.items, now);
        resolveMatchedWaiters(chatId, scan, now);
        pageToken = page.nextPageToken;
        if (pageToken) {
          rememberCursor(chatId, scan, pageToken, initial.cursorExpiresAt);
        } else {
          clearCursor(chatId, scan);
          resolveRemainingWaitersAtScanEnd(chatId, scan, now);
        }
      } while (pageToken && scan.waiters.size > 0);
      if (pendingChatScans.get(chatId) === scan) {
        pendingChatScans.delete(chatId);
      }
    } catch (error) {
      failChatScan(chatId, scan, error);
    }
  };

  return async (input) => {
    const now = Date.now();
    const cached = readCached(input.chatId, input.senderOpenId, now);
    if (cached.hit) return cached.name;

    let scan = pendingChatScans.get(input.chatId);
    const shouldStartScan = !scan;
    if (!scan) {
      scan = {
        retired: false,
        cursorInvalidated: false,
        waiters: new Set(),
      };
      pendingChatScans.set(input.chatId, scan);
    }
    const activeScan = scan;
    let waiter!: FeishuSenderNameWaiter;
    const waiterPromise = new Promise<string | undefined>((resolve, reject) => {
      waiter = {
        senderOpenId: input.senderOpenId,
        resolve,
        reject,
      };
      activeScan.waiters.add(waiter);
    });
    if (shouldStartScan) {
      void runChatScan(input.chatId, activeScan);
    }
    try {
      return await withFeishuSenderNameTimeout(waiterPromise);
    } catch (error) {
      retireWaiter(input.chatId, activeScan, waiter);
      throw error;
    }
  };
}

async function fetchFeishuChatMetadata(
  client: FeishuHttpClient,
  input: { chatId: string },
  signal: AbortSignal,
): Promise<FeishuChatMetadata | undefined> {
  const chats = client.im.v1.chats;
  if (!chats) return undefined;
  const response = await chats.get({ path: { chat_id: input.chatId } }, { signal });
  if (response.code !== undefined && response.code !== 0) {
    throw new Error("FEISHU_CHAT_MODE_LOOKUP_FAILED");
  }
  const chatMode = feishuChatMode(response.data?.chat_mode?.trim());
  const groupMessageType = feishuGroupMessageType(response.data?.group_message_type?.trim());
  if (!chatMode && !groupMessageType) return undefined;
  return {
    ...(chatMode ? { chatMode } : {}),
    ...(groupMessageType ? { groupMessageType } : {}),
  };
}

function withFeishuChatModeTimeout<T>(
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onParentAbort = (): void => {
    controller.abort(parentSignal?.reason ?? new Error("FEISHU_CHAT_MODE_LOOKUP_ABORTED"));
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error("FEISHU_CHAT_MODE_LOOKUP_TIMEOUT");
      controller.abort(error);
      reject(error);
    }, FEISHU_CHAT_MODE_LOOKUP_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([run(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  });
}

function createCachedFeishuChatMetadataResolver(
  client: FeishuHttpClient,
  createClientForSignal: (signal: AbortSignal) => FeishuHttpClient = () => client,
): (input: { chatId: string }, signal?: AbortSignal) => Promise<FeishuChatMetadata | undefined> {
  const chatMetadata = new Map<string, { expiresAt: number; metadata: FeishuChatMetadata | undefined }>();
  const pendingChatMetadata = new Map<string, Promise<FeishuChatMetadata | undefined>>();

  const remember = (
    chatId: string,
    metadata: FeishuChatMetadata | undefined,
    now: number,
    ttlMs = metadata?.chatMode ? FEISHU_CHAT_MODE_TTL_MS : FEISHU_MISSING_CHAT_MODE_TTL_MS,
  ): void => {
    chatMetadata.delete(chatId);
    chatMetadata.set(chatId, {
      expiresAt: now + ttlMs,
      metadata,
    });
    while (chatMetadata.size > FEISHU_CHAT_MODE_CACHE_MAX_ENTRIES) {
      const oldest = chatMetadata.keys().next().value;
      if (oldest === undefined) break;
      chatMetadata.delete(oldest);
    }
  };

  return async (input, signal) => {
    const key = input.chatId;
    const now = Date.now();
    const cached = chatMetadata.get(key);
    if (cached && cached.expiresAt > now) {
      chatMetadata.delete(key);
      chatMetadata.set(key, cached);
      return cached.metadata;
    }
    if (cached) chatMetadata.delete(key);
    const pending = pendingChatMetadata.get(key);
    if (pending) return pending;

    const lookup = withFeishuChatModeTimeout(signal, (lookupSignal) =>
      fetchFeishuChatMetadata(createClientForSignal(lookupSignal), input, lookupSignal),
    ).then(
      (metadata) => {
        remember(key, metadata, Date.now());
        return metadata;
      },
      (error: unknown) => {
        remember(key, undefined, Date.now(), FEISHU_FAILED_CHAT_MODE_TTL_MS);
        throw error;
      },
    );
    pendingChatMetadata.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (pendingChatMetadata.get(key) === lookup) pendingChatMetadata.delete(key);
    }
  };
}

export function createFeishuHttpCapability(
  client: FeishuHttpClient,
  createClientForSignal: (signal: AbortSignal) => FeishuHttpClient = () => client,
): FeishuHttpCapability {
  const resolveSenderName = createCachedFeishuSenderNameResolver(client);
  const resolveChatMetadata = createCachedFeishuChatMetadataResolver(client, createClientForSignal);
  return {
    async fetchResource(input, signal) {
      const activeClient = signal ? createClientForSignal(signal) : client;
      const payload = {
        path: { message_id: input.messageExternalId, file_key: input.providerResourceKey },
        params: { type: input.kind === "image" ? "image" : "file" },
      };
      const response = signal
        ? await activeClient.im.v1.messageResource.get(payload, { signal })
        : await activeClient.im.v1.messageResource.get(payload);
      return { stream: response.getReadableStream() };
    },
    resolveSenderName,
    resolveChatMetadata,
  };
}

function feishuContentBlocks(message: NormalizedMessage, text: string) {
  return contentBlocksWithMentions(
    text,
    message.mentions.slice(0, 256).flatMap((mention) => {
      const externalId = mention.openId ?? mention.userId;
      return externalId
        ? [{ token: mention.key, externalId, label: mention.name ? `@${mention.name}` : mention.key }]
        : [];
    }),
  );
}
