import { Readable } from "node:stream";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import type { ProviderResourceInput, ReadableResource } from "../provider-adapter.js";
import type { SlackApiClient } from "./adapter.js";

function slackError(error: unknown): { ok: false; error: string; retryAfterSeconds?: number } {
  if (typeof error === "object" && error !== null) {
    const data = "data" in error && typeof error.data === "object" && error.data !== null ? error.data : undefined;
    const code = data && "error" in data && typeof data.error === "string" ? data.error : undefined;
    const retryAfter = "retryAfter" in error && typeof error.retryAfter === "number" ? error.retryAfter : undefined;
    return { ok: false, error: code ?? "slack_unknown", ...(retryAfter ? { retryAfterSeconds: retryAfter } : {}) };
  }
  return { ok: false, error: "slack_unknown" };
}

export const SLACK_WEB_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
} satisfies WebClientOptions;

export class DefaultSlackApiClient implements SlackApiClient {
  readonly #createClient: (token: string) => WebClient;

  constructor(createClient?: (token: string) => WebClient) {
    this.#createClient = createClient ?? ((token) => new WebClient(token, SLACK_WEB_CLIENT_OPTIONS));
  }

  async authTest(token: string): Promise<{ appId: string; teamId: string; botUserId: string }> {
    const result = await this.#createClient(token).auth.test();
    if (typeof result.app_id !== "string" || typeof result.team_id !== "string" || typeof result.user_id !== "string") {
      throw new Error("SLACK_AUTH_IDENTITY_INCOMPLETE");
    }
    return { appId: result.app_id, teamId: result.team_id, botUserId: result.user_id };
  }

  async postMessage(input: { token: string; channel: string; text: string; threadTs?: string }) {
    try {
      const result = await this.#createClient(input.token).chat.postMessage({
        channel: input.channel,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      });
      return { ok: result.ok === true, ts: result.ts };
    } catch (error) {
      return slackError(error);
    }
  }

  async addReaction(input: { token: string; channel: string; timestamp: string; emoji: string }) {
    try {
      const result = await this.#createClient(input.token).reactions.add({
        channel: input.channel,
        timestamp: input.timestamp,
        name: input.emoji,
      });
      return { ok: result.ok === true };
    } catch (error) {
      return slackError(error);
    }
  }

  async fetchResource(input: ProviderResourceInput & { token: string }): Promise<ReadableResource> {
    const info = await this.#createClient(input.token).files.info({ file: input.providerResourceKey });
    const url = info.file?.url_private_download ?? info.file?.url_private;
    if (!url) throw new Error("SLACK_RESOURCE_UNAVAILABLE");
    const response = await fetch(url, { headers: { authorization: `Bearer ${input.token}` }, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`SLACK_RESOURCE_HTTP_${response.status}`);
    const contentLength = response.headers.get("content-length");
    const sizeBytes = contentLength ? Number(contentLength) : undefined;
    if (sizeBytes !== undefined && (!Number.isSafeInteger(sizeBytes) || sizeBytes > 25 * 1024 * 1024)) {
      throw new Error("SLACK_RESOURCE_TOO_LARGE");
    }
    return {
      stream: Readable.fromWeb(response.body),
      filename: info.file?.name,
      mediaType: info.file?.mimetype,
      sizeBytes,
    };
  }
}
