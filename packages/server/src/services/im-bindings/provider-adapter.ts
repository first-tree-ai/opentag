import type { Readable } from "node:stream";
import type { NormalizedInboundImEvent } from "@opentag/shared";
import type { ImStatusReaction } from "../../db/schema/im-messages.js";

export interface ProviderStatusReactionInput {
  channelId: string;
  messageExternalId: string;
  status: ImStatusReaction;
}

export interface VerifiedBotIdentity {
  externalAppId: string;
  externalTeamId: string;
  externalBotId: string;
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
  fetchResource(input: ProviderResourceInput): Promise<ReadableResource>;
  setStatusReaction?(input: ProviderStatusReactionInput): Promise<void>;
}
