import type { Readable } from "node:stream";
import type { NormalizedInboundImEvent, ProviderWriteResult } from "@opentag/shared";

export interface VerifiedBotIdentity {
  externalAppId: string;
  externalTeamId: string;
  externalBotId: string;
}

export interface ProviderSendInput {
  requestId?: string;
  conversationExternalId: string;
  fallbackText: string;
  threadKey?: string;
  replyToExternalId?: string;
  providerExtension?: unknown;
}

export interface ProviderReactionInput {
  conversationExternalId: string;
  messageExternalId: string;
  emoji: string;
}

export interface ProviderResourceInput {
  messageExternalId: string;
  providerResourceKey: string;
  kind: "image" | "file" | "audio" | "video";
}

export interface ReadableResource {
  stream: Readable;
  mediaType?: string;
  filename?: string;
  sizeBytes?: number;
}

export interface ImProviderAdapter<TVerifiedEnvelope> {
  readonly provider: "feishu" | "slack";
  validateBinding(input: unknown): Promise<VerifiedBotIdentity>;
  normalizeInbound(input: TVerifiedEnvelope): NormalizedInboundImEvent[];
  send(input: ProviderSendInput): Promise<ProviderWriteResult>;
  react(input: ProviderReactionInput): Promise<ProviderWriteResult>;
  fetchResource(input: ProviderResourceInput): Promise<ReadableResource>;
}
