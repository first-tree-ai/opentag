import { Readable } from "node:stream";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { z } from "zod";
import type { ProviderResourceInput, ReadableResource } from "../provider-adapter.js";
import type { SlackApiClient, SlackInstallationInspection } from "./adapter.js";

export const SLACK_WEB_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
} satisfies WebClientOptions;

export class DefaultSlackApiClient implements SlackApiClient {
  readonly #createClient: (token: string) => WebClient;
  readonly #fetch: typeof fetch;

  constructor(
    createClient?: (token: string) => WebClient,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.#createClient = createClient ?? ((token) => new WebClient(token, SLACK_WEB_CLIENT_OPTIONS));
    this.#fetch = fetchImpl;
  }

  async authTest(token: string): Promise<{ appId: string | null; teamId: string; botUserId: string; botId: string }> {
    const result = await this.#createClient(token).auth.test();
    if (typeof result.team_id !== "string" || typeof result.user_id !== "string" || typeof result.bot_id !== "string") {
      throw new Error("SLACK_AUTH_IDENTITY_INCOMPLETE");
    }
    return {
      appId: typeof result.app_id === "string" ? result.app_id : null,
      teamId: result.team_id,
      botUserId: result.user_id,
      botId: result.bot_id,
    };
  }

  async inspectInstallation(token: string): Promise<SlackInstallationInspection> {
    const response = await this.#fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
      redirect: "error",
    });
    if (!response.ok) throw new Error("SLACK_AUTH_UPSTREAM_UNAVAILABLE");
    const result = z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
        app_id: z.string().optional(),
        team_id: z.string().optional(),
        enterprise_id: z.string().nullable().optional(),
        user_id: z.string().optional(),
        bot_id: z.string().optional(),
      })
      .passthrough()
      .parse(await response.json());
    if (!result.ok) throw new Error(result.error === "invalid_auth" ? "SLACK_AUTH_INVALID" : "SLACK_AUTH_REJECTED");
    if (!result.team_id || !result.user_id || !result.bot_id) {
      throw new Error("SLACK_AUTH_IDENTITY_INCOMPLETE");
    }
    const grantedBotScopes = [
      ...new Set(
        (response.headers.get("x-oauth-scopes") ?? "")
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
      ),
    ].sort();
    return {
      appId: result.app_id ?? null,
      teamId: result.team_id,
      enterpriseId: result.enterprise_id ?? null,
      botUserId: result.user_id,
      botId: result.bot_id,
      grantedBotScopes,
    };
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
