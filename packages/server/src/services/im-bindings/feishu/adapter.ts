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
import { emitRootSpan, imAttrs, outcomeAttrs } from "../../../observability/index.js";
import { ExternalCallPolicy } from "../../im/external-call-policy.js";
import { contentBlocksWithMentions } from "../mention-content.js";
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
  opentagSenderOpenId?: string;
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
  resolveSenderName?(input: { chatId: string; senderOpenId: string }): Promise<string | undefined>;
}

export interface FeishuHttpClient {
  im: {
    v1: {
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
  if (message.message_type === "post") return { text: postText(content, message.mentions), resources: [] };
  return { text: `[unsupported:${message.message_type}]`, resources: [] };
}

type RawFeishuMention = NonNullable<RawFeishuMessageEvent["message"]["mentions"]>[number];

/**
 * The plain text of a rich-text message, read from its documented shape: paragraphs of tagged
 * elements under `content`, at the top level or under a locale key. Feishu also sends the same
 * paragraphs as markdown under `content_v2`; that copy is read only when the tagged form has no
 * text, so a message is never repeated. Runs of one paragraph stay on one line, and an `@` element
 * becomes its mention key, the same placeholder a plain-text message carries.
 */
function postText(content: Record<string, unknown>, mentions: readonly RawFeishuMention[] = []): string {
  const tagged = paragraphsText(postParagraphs(content, "content"), mentions);
  return tagged || paragraphsText(postParagraphs(content, "content_v2"), mentions);
}

function postParagraphs(content: Record<string, unknown>, key: "content" | "content_v2"): unknown[] {
  if (Array.isArray(content[key])) return content[key];
  for (const value of Object.values(content)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const nested = (value as Record<string, unknown>)[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function paragraphsText(paragraphs: readonly unknown[], mentions: readonly RawFeishuMention[]): string {
  return paragraphs
    .map((paragraph) => (Array.isArray(paragraph) ? paragraph : [paragraph]))
    .map((paragraph) => paragraph.map((element) => elementText(element, mentions)).join(""))
    .join("\n")
    .trim();
}

function elementText(element: unknown, mentions: readonly RawFeishuMention[]): string {
  if (typeof element !== "object" || element === null) return "";
  const { tag, text, user_id, user_name } = element as Record<string, unknown>;
  if (tag === "at") {
    const mention = mentions.find((candidate) => candidate.id.open_id === user_id || candidate.id.user_id === user_id);
    if (mention) return mention.key;
    return typeof user_name === "string" && user_name ? `@${user_name}` : "";
  }
  return typeof text === "string" ? text : "";
}

function rawReceiveToNormalized(raw: RawFeishuMessageEvent): NormalizedMessage {
  const parsed = parseRawContent(raw.message);
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
  const contentBlocks = contentBlocksWithMentions(
    content.text,
    input.message.mentions.slice(0, 256).flatMap((mention) => {
      const externalId = mention.openId ?? mention.userId;
      return externalId
        ? [{ token: mention.key, externalId, label: mention.name ? `@${mention.name}` : mention.key }]
        : [];
    }),
  );
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
          blocks: content.text ? contentBlocks : [{ type: "unsupported", providerType: input.message.rawContentType }],
          truncated: content.truncated,
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
): EventDispatcher {
  const dispatcher = new EventDispatcher({ logger: REDACTING_SDK_LOGGER, loggerLevel: LoggerLevel.error });
  const deduplicate = createFeishuInboundDeduplicator();
  dispatcher.register({
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
  readonly #policy: ExternalCallPolicy;

  constructor(input: {
    appId: string;
    appSecret: string;
    teamId: string | null;
    teamBrand?: "feishu" | "lark" | null;
    channel?: FeishuChannel | null;
    http?: FeishuHttpCapability;
    scopeList?: () => Promise<FeishuScopeListResponse>;
    /* type-only */ policy?: ExternalCallPolicy;
  }) {
    this.#appId = input.appId;
    this.#teamId = input.teamId;
    this.#policy = input.policy ?? new ExternalCallPolicy();
    const domain = feishuDomainForWorkspaceBrand(input.teamBrand);
    this.#client = new Client({
      appId: input.appId,
      appSecret: input.appSecret,
      domain,
      logger: REDACTING_SDK_LOGGER,
      loggerLevel: LoggerLevel.error,
    });
    this.#scopeList = input.scopeList ?? (() => this.#client.application.v6.scope.list({}));
    this.#http = input.http ?? createFeishuHttpCapability(this.#client as unknown as FeishuHttpClient);
    this.#channel =
      input.channel === null
        ? undefined
        : (input.channel ?? new ReliableFeishuChannel({ appId: input.appId, appSecret: input.appSecret, domain }));
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
    return this.#policy.run("feishu.resource.fetch", () => this.#http.fetchResource(input), {
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
}

const FEISHU_SENDER_NAME_TTL_MS = 60 * 60 * 1000;
const FEISHU_MISSING_SENDER_NAME_TTL_MS = 5 * 60 * 1000;
const FEISHU_SENDER_NAME_CACHE_MAX_ENTRIES = 10_000;
const FEISHU_SENDER_NAME_LOOKUP_TIMEOUT_MS = 1_000;
const FEISHU_SENDER_NAME_POLICY_TIMEOUT_MS = 1_500;

export function feishuSenderOpenId(message: NormalizedMessage): string | null {
  const raw = message.raw as FeishuRawEnvelope | undefined;
  return raw?.opentagSenderOpenId ?? null;
}

async function fetchFeishuSenderName(
  client: FeishuHttpClient,
  input: { chatId: string; senderOpenId: string },
  observeMember: (member: { member_id?: string; name?: string }) => void,
): Promise<string | undefined> {
  let pageToken: string | undefined;
  do {
    const response = await client.im.v1.chatMembers.get({
      path: { chat_id: input.chatId },
      params: {
        member_id_type: "open_id",
        page_size: 100,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error("FEISHU_SENDER_NAME_LOOKUP_FAILED");
    }
    const members = response.data?.items ?? [];
    for (const member of members) observeMember(member);
    const sender = members.find((member) => member.member_id === input.senderOpenId);
    const name = sender?.name?.trim();
    if (name) return name;
    pageToken = response.data?.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return undefined;
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

function createCachedFeishuSenderNameResolver(
  client: FeishuHttpClient,
): (input: { chatId: string; senderOpenId: string }) => Promise<string | undefined> {
  const senderNames = new Map<string, { expiresAt: number; name: string | undefined }>();
  const pendingSenderNames = new Map<string, Promise<string | undefined>>();

  const cacheKey = (chatId: string, senderOpenId: string): string => `${chatId}:${senderOpenId}`;
  const remember = (chatId: string, senderOpenId: string, name: string | undefined, now: number): void => {
    const key = cacheKey(chatId, senderOpenId);
    senderNames.delete(key);
    senderNames.set(key, {
      expiresAt: now + (name ? FEISHU_SENDER_NAME_TTL_MS : FEISHU_MISSING_SENDER_NAME_TTL_MS),
      name,
    });
    while (senderNames.size > FEISHU_SENDER_NAME_CACHE_MAX_ENTRIES) {
      const oldest = senderNames.keys().next().value;
      if (oldest === undefined) break;
      senderNames.delete(oldest);
    }
  };

  return async (input) => {
    const key = cacheKey(input.chatId, input.senderOpenId);
    const now = Date.now();
    const cached = senderNames.get(key);
    if (cached && cached.expiresAt > now) {
      senderNames.delete(key);
      senderNames.set(key, cached);
      return cached.name;
    }
    if (cached) senderNames.delete(key);
    const pending = pendingSenderNames.get(key);
    if (pending) return pending;

    const lookup = withFeishuSenderNameTimeout(
      fetchFeishuSenderName(client, input, (member) => {
        const name = member.name?.trim();
        if (member.member_id && name) remember(input.chatId, member.member_id, name, now);
      }),
    ).then((name) => {
      if (!senderNames.has(key)) remember(input.chatId, input.senderOpenId, name, now);
      return name;
    });
    pendingSenderNames.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (pendingSenderNames.get(key) === lookup) pendingSenderNames.delete(key);
    }
  };
}

export function createFeishuHttpCapability(client: FeishuHttpClient): FeishuHttpCapability {
  const resolveSenderName = createCachedFeishuSenderNameResolver(client);
  return {
    async fetchResource(input) {
      const response = await client.im.v1.messageResource.get({
        path: { message_id: input.messageExternalId, file_key: input.providerResourceKey },
        params: { type: input.kind === "image" ? "image" : "file" },
      });
      return { stream: response.getReadableStream() };
    },
    resolveSenderName,
  };
}
