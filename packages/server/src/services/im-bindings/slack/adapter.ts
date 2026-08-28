import { type NormalizedInboundImEvent, NormalizedInboundImEventSchema } from "@opentag/shared";
import { z } from "zod";
import { contentBlocksWithMentions } from "../mention-content.js";
import type {
  ImProviderAdapter,
  ProviderResourceInput,
  ReadableResource,
  VerifiedBotIdentity,
} from "../provider-adapter.js";

const SlackFileSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    mimetype: z.string().optional(),
    size: z.number().optional(),
  })
  .passthrough();

const SlackCanonicalMessageSchema = z
  .object({
    text: z.string().optional(),
    ts: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    bot_profile: z.object({ app_id: z.string().optional() }).passthrough().optional(),
    thread_ts: z.string().optional(),
    files: z.array(SlackFileSchema).optional(),
  })
  .passthrough();

const SlackMessageEventSchema = z
  .object({
    type: z.enum(["message", "app_mention"]),
    subtype: z.string().optional(),
    channel: z.string().min(1),
    channel_type: z.string().optional(),
    user: z.string().optional(),
    bot_id: z.string().optional(),
    bot_profile: z.object({ app_id: z.string().optional() }).passthrough().optional(),
    text: z.string().default(""),
    ts: z.string().min(1),
    deleted_ts: z.string().optional(),
    event_ts: z.string().optional(),
    thread_ts: z.string().optional(),
    message: SlackCanonicalMessageSchema.optional(),
    previous_message: SlackCanonicalMessageSchema.optional(),
    files: z.array(SlackFileSchema).optional(),
  })
  .passthrough();

export interface VerifiedSlackEnvelope {
  eventId: string;
  appId: string;
  teamId: string;
  botUserId: string;
  botId: string;
  event: unknown;
  eventTime?: number;
}

export interface SlackOAuthAccessResult {
  appId: string;
  teamId: string;
  enterpriseId: string | null;
  botUserId: string;
  botAccessToken: string;
}

export interface SlackApiClient {
  authTest(token: string): Promise<{ appId: string | null; teamId: string; botUserId: string; botId: string }>;
  inspectInstallation(token: string): Promise<SlackInstallationInspection>;
  oauthAccess(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<SlackOAuthAccessResult>;
  fetchResource(input: ProviderResourceInput & { token: string }): Promise<ReadableResource>;
}

export interface SlackInstallationInspection {
  appId: string | null;
  teamId: string;
  enterpriseId: string | null;
  botUserId: string;
  botId: string;
  grantedBotScopes: string[];
}

function slackTimestampToDate(value: string | undefined, fallbackSeconds?: number): Date {
  const seconds = value ? Number.parseFloat(value) : fallbackSeconds;
  return Number.isFinite(seconds) ? new Date((seconds ?? 0) * 1000) : new Date(0);
}

function conversationKind(channelType: string | undefined): "channel" | "dm" | "group_dm" {
  if (channelType === "im") return "dm";
  if (channelType === "mpim") return "group_dm";
  return "channel";
}

function mentionsFromText(text: string, priorityId?: string): Array<{ externalId: string; displayName: null }> {
  const ids = [...new Set([...text.matchAll(/<@([A-Z0-9]+)>/g)].flatMap((match) => (match[1] ? [match[1]] : [])))];
  if (priorityId && ids.includes(priorityId)) ids.splice(ids.indexOf(priorityId), 1);
  if (priorityId && text.includes(`<@${priorityId}>`)) ids.unshift(priorityId);
  return ids.slice(0, 256).map((externalId) => ({ externalId, displayName: null }));
}

function boundedText(value: string): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= 24 * 1024) return { text: value, truncated: false };
  return { text: new TextDecoder().decode(encoded.subarray(0, 24 * 1024)), truncated: true };
}

export function normalizeSlackEnvelope(envelope: VerifiedSlackEnvelope): NormalizedInboundImEvent[] {
  const parsed = SlackMessageEventSchema.safeParse(envelope.event);
  if (!parsed.success) return [];
  const event = parsed.data;
  if (event.subtype && !["message_changed", "message_deleted", "bot_message"].includes(event.subtype)) return [];
  const operation =
    event.subtype === "message_deleted" ? "deleted" : event.subtype === "message_changed" ? "edited" : "created";
  const nested = operation === "edited" ? event.message : operation === "deleted" ? event.previous_message : undefined;
  const canonical = nested ?? event;
  const messageId = nested?.ts ?? (operation === "deleted" ? event.deleted_ts : undefined) ?? event.ts;
  const text = canonical.text ?? "";
  const bounded = boundedText(operation === "deleted" ? "[deleted]" : text);
  const mentions = mentionsFromText(text, envelope.botUserId);
  const isSelf =
    canonical.user === envelope.botUserId ||
    canonical.bot_id === envelope.botId ||
    canonical.bot_profile?.app_id === envelope.appId;
  const authorId =
    canonical.user ??
    (canonical.bot_profile?.app_id === envelope.appId ? envelope.botUserId : undefined) ??
    canonical.bot_id ??
    "system";
  const resources = (canonical.files ?? []).slice(0, 16).map((file) => ({
    providerResourceKey: file.id,
    kind: file.mimetype?.startsWith("image/") ? ("image" as const) : ("file" as const),
    filename: file.name?.slice(0, 512) ?? null,
    mediaType: file.mimetype?.slice(0, 255) ?? null,
    sizeBytes: file.size ?? null,
  }));
  return [
    NormalizedInboundImEventSchema.parse({
      providerEventId: envelope.eventId,
      externalAppId: envelope.appId,
      externalTeamId: envelope.teamId,
      providerContext: {
        provider: "slack",
        ...(event.channel_type ? { channelType: event.channel_type } : {}),
        ...(canonical.thread_ts ? { threadTs: canonical.thread_ts } : {}),
      },
      conversation: { externalId: event.channel, kind: conversationKind(event.channel_type) },
      message: {
        externalId: messageId,
        revisionKey: event.event_ts ?? `${operation}:${messageId}`,
        operation,
        threadKey: canonical.thread_ts ?? null,
        replyToExternalId: null,
        author: {
          externalId: authorId,
          kind: canonical.bot_id || canonical.bot_profile ? "bot" : canonical.user ? "human" : "system",
          isSelf,
        },
        occurredAt: slackTimestampToDate(event.event_ts ?? event.ts, envelope.eventTime),
        content: {
          version: 1,
          fallbackText: bounded.text,
          blocks: contentBlocksWithMentions(
            bounded.text,
            mentions.map(({ externalId }) => ({
              token: `<@${externalId}>`,
              externalId,
              label: `<@${externalId}>`,
            })),
          ),
          truncated: bounded.truncated,
        },
        resources,
      },
      mentions,
    }),
  ];
}

export class SlackAdapter implements ImProviderAdapter<VerifiedSlackEnvelope> {
  readonly provider = "slack" as const;
  readonly #api: SlackApiClient;
  readonly #appId: string;
  readonly #botUserId: string;
  readonly #botId: string;
  readonly #teamId: string;
  readonly #token: string;

  constructor(input: {
    api: SlackApiClient;
    token: string;
    appId: string;
    teamId: string;
    botUserId: string;
    botId: string;
  }) {
    this.#api = input.api;
    this.#token = input.token;
    this.#appId = input.appId;
    this.#teamId = input.teamId;
    this.#botUserId = input.botUserId;
    this.#botId = input.botId;
  }

  async validateBinding(): Promise<VerifiedBotIdentity> {
    const identity = await this.#api.authTest(this.#token);
    if (
      (identity.appId !== null && identity.appId !== this.#appId) ||
      identity.teamId !== this.#teamId ||
      identity.botUserId !== this.#botUserId ||
      identity.botId !== this.#botId
    ) {
      throw new Error("SLACK_BINDING_IDENTITY_MISMATCH");
    }
    return { externalAppId: this.#appId, externalTeamId: identity.teamId, externalBotId: identity.botUserId };
  }

  normalizeInbound(input: VerifiedSlackEnvelope): NormalizedInboundImEvent[] {
    return normalizeSlackEnvelope(input);
  }

  fetchResource(input: ProviderResourceInput): Promise<ReadableResource> {
    return this.#api.fetchResource({ ...input, token: this.#token });
  }
}
