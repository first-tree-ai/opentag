import { Readable } from "node:stream";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import type { ProviderResourceInput, ReadableResource } from "../provider-adapter.js";
import type { SlackApiClient } from "./adapter.js";

export const SLACK_WEB_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
} satisfies WebClientOptions;

export class DefaultSlackApiClient implements SlackApiClient {
  readonly #createClient: (token: string) => WebClient;

  constructor(createClient?: (token: string) => WebClient) {
    this.#createClient = createClient ?? ((token) => new WebClient(token, SLACK_WEB_CLIENT_OPTIONS));
  }

  async authTest(token: string): Promise<{ appId: string; teamId: string; botUserId: string; botId: string }> {
    const result = await this.#createClient(token).auth.test();
    if (
      typeof result.app_id !== "string" ||
      typeof result.team_id !== "string" ||
      typeof result.user_id !== "string" ||
      typeof result.bot_id !== "string"
    ) {
      throw new Error("SLACK_AUTH_IDENTITY_INCOMPLETE");
    }
    return { appId: result.app_id, teamId: result.team_id, botUserId: result.user_id, botId: result.bot_id };
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
