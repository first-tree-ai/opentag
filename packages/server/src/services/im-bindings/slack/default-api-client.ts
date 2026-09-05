import { Readable } from "node:stream";
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { z } from "zod";
import { ExternalCallPolicy } from "../../im/external-call-policy.js";
import type { ProviderResourceInput, ReadableResource } from "../provider-adapter.js";
import type { SlackApiClient, SlackInstallationInspection, SlackOAuthAccessResult } from "./adapter.js";

const SLACK_AUTH_TEST_TIMEOUT_MS = 10_000;
const SLACK_WEB_CLIENT_TIMEOUT_MS = 15_000;

export const SLACK_WEB_CLIENT_OPTIONS = {
  retryConfig: { retries: 0 },
  rejectRateLimitedCalls: true,
  timeout: SLACK_WEB_CLIENT_TIMEOUT_MS,
} satisfies WebClientOptions;

function mergeAbortSignals(signal: AbortSignal | undefined, init: RequestInit | undefined): RequestInit | undefined {
  if (!signal) return init;
  return { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal };
}

export class DefaultSlackApiClient implements SlackApiClient {
  readonly #createClient: (token: string, signal?: AbortSignal) => WebClient;
  readonly #fetch: typeof fetch;
  readonly #policy: ExternalCallPolicy;

  constructor(
    createClient?: (token: string, signal?: AbortSignal) => WebClient,
    fetchImpl?: typeof fetch,
    policy?: ExternalCallPolicy,
  ) {
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#createClient =
      createClient ??
      ((token, signal) =>
        new WebClient(token, {
          ...SLACK_WEB_CLIENT_OPTIONS,
          fetch: (input, init) => this.#fetch(input, mergeAbortSignals(signal, init)),
        }));
    this.#policy =
      policy ??
      new ExternalCallPolicy({
        allowedHosts: ["slack.com", "files.slack.com"],
        transport: (input, init) => this.#fetch(input, init),
      });
  }

  async authTest(token: string): Promise<{ appId: string | null; teamId: string; botUserId: string; botId: string }> {
    const result = await this.#policy.run(
      "slack.auth.test",
      (signal) => this.#createClient(token, signal).auth.test(),
      {
        circuitKey: "slack:auth.test",
        maxAttempts: 1,
      },
    );
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

  async oauthAccess(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
  }): Promise<SlackOAuthAccessResult> {
    let response: Response;
    try {
      response = await this.#policy.fetch(
        "https://slack.com/api/oauth.v2.access",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: input.clientId,
            client_secret: input.clientSecret,
            code: input.code,
            redirect_uri: input.redirectUri,
          }).toString(),
          signal: AbortSignal.timeout(SLACK_AUTH_TEST_TIMEOUT_MS),
        },
        { circuitKey: "slack:oauth.access", maxAttempts: 1, timeoutMs: SLACK_AUTH_TEST_TIMEOUT_MS },
      );
    } catch {
      throw new Error("SLACK_AUTH_UPSTREAM_UNAVAILABLE");
    }
    if (!response.ok) throw new Error("SLACK_AUTH_UPSTREAM_UNAVAILABLE");
    const result = z
      .object({
        ok: z.boolean(),
        error: z.string().optional(),
        access_token: z.string().optional(),
        token_type: z.string().optional(),
        app_id: z.string().optional(),
        bot_user_id: z.string().optional(),
        enterprise_id: z.string().nullable().optional(),
        team: z.object({ id: z.string().optional() }).passthrough().optional(),
        enterprise: z.object({ id: z.string().optional() }).passthrough().nullable().optional(),
      })
      .passthrough()
      .parse(await response.json());
    if (!result.ok) {
      throw new Error(result.error === "invalid_code" ? "SLACK_AUTH_INVALID" : "SLACK_AUTH_REJECTED", {
        cause: result.error ?? "unknown_error",
      });
    }
    if (
      result.token_type !== "bot" ||
      !result.access_token ||
      !result.app_id ||
      !result.bot_user_id ||
      !result.team?.id
    ) {
      throw new Error("SLACK_AUTH_IDENTITY_INCOMPLETE");
    }
    return {
      appId: result.app_id,
      teamId: result.team.id,
      enterpriseId: result.enterprise?.id ?? result.enterprise_id ?? null,
      botUserId: result.bot_user_id,
      botAccessToken: result.access_token,
    };
  }

  async inspectInstallation(token: string): Promise<SlackInstallationInspection> {
    let response: Response;
    try {
      const admittedUrl = this.#policy.admitUrl("https://slack.com/api/auth.test");
      response = await this.#policy.fetch(
        admittedUrl,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "",
          signal: AbortSignal.timeout(SLACK_AUTH_TEST_TIMEOUT_MS),
        },
        { circuitKey: "slack:auth.test.http", maxAttempts: 1, timeoutMs: SLACK_AUTH_TEST_TIMEOUT_MS },
      );
    } catch {
      // Network failures and timeouts carry no credential detail worth surfacing.
      throw new Error("SLACK_AUTH_UPSTREAM_UNAVAILABLE");
    }
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
    const info = await this.#policy.run(
      "slack.files.info",
      (signal) => this.#createClient(input.token, signal).files.info({ file: input.providerResourceKey }),
      { circuitKey: "slack:files.info", maxAttempts: 1 },
    );
    const url = info.file?.url_private_download ?? info.file?.url_private;
    if (!url) throw new Error("SLACK_RESOURCE_UNAVAILABLE");
    const admittedUrl = this.#policy.admitUrl(url);
    const response = await this.#policy.fetch(
      admittedUrl,
      { headers: { authorization: `Bearer ${input.token}` } },
      { circuitKey: "slack:resource.download", maxAttempts: 1 },
    );
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
