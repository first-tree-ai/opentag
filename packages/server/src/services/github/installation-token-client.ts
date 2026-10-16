/** Server-only App JWT metadata transport. Repository execution uses scoped user tokens. */

import { createPrivateKey, type KeyObject, sign as rsaSign } from "node:crypto";
import { parseGitHubInstallation } from "./github-api-client.js";

import { type GitHubInstallationTokenClientOptions, GitHubInstallationTokenError } from "./installation-token-types.js";

export * from "./installation-token-types.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "opentag-server-github-installation-token-client";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const JWT_IAT_BACKDATE_SECONDS = 60;
const JWT_TTL_SECONDS = 600;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const MIN_RSA_MODULUS_BITS = 2_048;
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,18}$/;

type RequestDeadline = {
  signal: AbortSignal;
  rejection: Promise<never>;
  failure: () => GitHubInstallationTokenError | undefined;
  cancel: () => void;
  clear: () => void;
};

type SendOptions = {
  method: "GET";
  path: string;
  authorization: string;
  body?: string;
  signal?: AbortSignal;
};

function configError(message: string): GitHubInstallationTokenError {
  return new GitHubInstallationTokenError("GITHUB_APP_CONFIG_INVALID", message);
}

function requestError(message: string): GitHubInstallationTokenError {
  return new GitHubInstallationTokenError("GITHUB_REQUEST_INVALID", message);
}

function invalidResponseError(message: string): GitHubInstallationTokenError {
  return new GitHubInstallationTokenError("GITHUB_API_RESPONSE_INVALID", message);
}

function assertSuccessStatus(response: Response): void {
  const expected = 200;
  if (response.status !== expected) {
    throw invalidResponseError("The GitHub API returned an unexpected success status");
  }
}

function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem" });
  } catch {
    throw configError("The GitHub App private key is malformed or unsupported");
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw configError("The GitHub App private key must be an RSA key suitable for RS256");
  }
  const modulusBits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (modulusBits < MIN_RSA_MODULUS_BITS) {
    throw configError(`The GitHub App RSA key must be at least ${MIN_RSA_MODULUS_BITS} bits`);
  }
  return key;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function boundedSeconds(value: number): number {
  return Math.min(Math.max(0, Math.floor(value)), MAX_RETRY_AFTER_SECONDS);
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null || !/^\d{1,7}$/.test(value)) return undefined;
  return boundedSeconds(Number(value));
}

function parseRateLimitReset(headers: Headers, nowSeconds: number): number | undefined {
  const value = headers.get("x-ratelimit-reset");
  if (value === null || !/^\d{1,13}$/.test(value)) return undefined;
  const delta = Number(value) - nowSeconds;
  return delta > 0 ? boundedSeconds(delta) : undefined;
}

function classifyHttpError(response: Response, nowSeconds: number): GitHubInstallationTokenError {
  const status = response.status;
  const retryAfterSeconds =
    parseRetryAfter(response.headers) ??
    (response.headers.get("x-ratelimit-remaining") === "0"
      ? parseRateLimitReset(response.headers, nowSeconds)
      : undefined);
  if (status === 401) {
    return new GitHubInstallationTokenError(
      "GITHUB_APP_AUTH_FAILED",
      "The GitHub API rejected the GitHub App credentials",
      {
        status,
      },
    );
  }
  const isRateLimited =
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" || parseRetryAfter(response.headers) !== undefined));
  if (isRateLimited) {
    return new GitHubInstallationTokenError("GITHUB_API_RATE_LIMITED", "The GitHub API rate limit was exceeded", {
      status,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  return new GitHubInstallationTokenError(
    "GITHUB_API_HTTP_ERROR",
    `The GitHub API request failed with status ${status}`,
    { status, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
  );
}

export class GitHubInstallationTokenClient {
  readonly #appId: string;
  readonly #clientId: string;
  readonly #privateKey: KeyObject;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GitHubInstallationTokenClientOptions) {
    if (typeof options.appId !== "string" || !DECIMAL_ID_PATTERN.test(options.appId)) {
      throw configError("The GitHub App ID must be a positive decimal identifier");
    }
    if (
      typeof options.clientId !== "string" ||
      options.clientId.length === 0 ||
      options.clientId.length > 255 ||
      options.clientId.trim() !== options.clientId
    ) {
      throw configError("The GitHub App OAuth client ID must be a nonempty identifier");
    }
    this.#appId = options.appId;
    this.#clientId = options.clientId;
    this.#privateKey = parsePrivateKey(options.privateKey);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
  }

  /** Resolve the configured App's public install page without issuing an installation token. */
  async installationUrl(signal?: AbortSignal): Promise<string> {
    const payload = await this.#send({
      method: "GET",
      path: "/app",
      authorization: `Bearer ${this.#createJwt()}`,
      signal,
    });
    if (typeof payload !== "object" || payload === null) {
      throw invalidResponseError("The GitHub App metadata is malformed");
    }
    const { id, slug, client_id: clientId } = payload as Record<string, unknown>;
    if (
      !Number.isSafeInteger(id) ||
      String(id) !== this.#appId ||
      clientId !== this.#clientId ||
      typeof slug !== "string" ||
      slug.length > 100 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(slug)
    ) {
      throw invalidResponseError("The GitHub App metadata does not match the configured App");
    }
    return `https://github.com/apps/${slug}/installations/new`;
  }

  /** App JWT lookup proves the configured App is installed on this exact repository. */
  async repositoryInstallation(fullName: string, signal?: AbortSignal) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName) || fullName.includes(".."))
      throw requestError("Invalid repository name");
    const installation = parseGitHubInstallation(
      await this.#send({
        method: "GET",
        path: `/repos/${fullName}/installation`,
        authorization: `Bearer ${this.#createJwt()}`,
        signal,
      }),
    );
    if (installation.appId !== this.#appId) throw invalidResponseError("The installation belongs to another App");
    return installation;
  }

  #createJwt(): string {
    const issuedAt = Math.floor(this.#now().getTime() / 1_000) - JWT_IAT_BACKDATE_SECONDS;
    const signingInput = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
      iat: issuedAt,
      exp: issuedAt + JWT_TTL_SECONDS,
      iss: this.#appId,
    })}`;
    const signature = rsaSign("RSA-SHA256", Buffer.from(signingInput, "utf8"), this.#privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  }

  #startDeadline(callerSignal?: AbortSignal): RequestDeadline {
    const controller = new AbortController();
    let failure: GitHubInstallationTokenError | undefined;
    let rejectRejection: (error: unknown) => void = () => undefined;
    const rejection = new Promise<never>((_resolve, reject) => {
      rejectRejection = reject;
    });
    // The rejection is raced wherever it matters; this handler covers the paths that throw the
    // stored failure before ever racing, so it can never surface as unhandled.
    void rejection.catch(() => undefined);
    const fail = (error: GitHubInstallationTokenError) => {
      if (failure) return;
      failure = error;
      rejectRejection(error);
      if (!controller.signal.aborted) controller.abort(error);
    };
    const onCallerAbort = () =>
      fail(new GitHubInstallationTokenError("GITHUB_API_ABORTED", "The GitHub API request was cancelled"));
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(
      () =>
        fail(new GitHubInstallationTokenError("GITHUB_API_TIMEOUT", "The GitHub API request exceeded its time limit")),
      REQUEST_TIMEOUT_MS,
    );
    timer.unref?.();
    return {
      signal: controller.signal,
      rejection,
      failure: () => failure,
      cancel: () => {
        if (!controller.signal.aborted) controller.abort();
      },
      clear: () => {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onCallerAbort);
      },
    };
  }

  async #send(options: SendOptions): Promise<unknown> {
    const deadline = this.#startDeadline(options.signal);
    try {
      const preflightFailure = deadline.failure();
      if (preflightFailure) throw preflightFailure;
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        authorization: options.authorization,
        "user-agent": USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
      };
      if (options.body !== undefined) headers["content-type"] = "application/json";
      const response = await Promise.race([
        this.#fetch(`${GITHUB_API_BASE_URL}${options.path}`, {
          method: options.method,
          headers,
          body: options.body,
          redirect: "error",
          signal: deadline.signal,
        }),
        deadline.rejection,
      ]);
      const inFlightFailure = deadline.failure();
      if (inFlightFailure) throw inFlightFailure;
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new GitHubInstallationTokenError(
          "GITHUB_API_REDIRECT_REJECTED",
          "The GitHub API attempted to redirect the request",
        );
      }
      if (!response.ok) {
        // The error body is never read: it is untrusted and cannot be assumed safe.
        void response.body?.cancel().catch(() => undefined);
        throw classifyHttpError(response, Math.floor(this.#now().getTime() / 1_000));
      }
      assertSuccessStatus(response);
      return await this.#readJson(response, deadline);
    } catch (error) {
      if (error instanceof GitHubInstallationTokenError) throw error;
      const failure = deadline.failure();
      if (failure) throw failure;
      throw new GitHubInstallationTokenError("GITHUB_API_NETWORK_ERROR", "The GitHub API request failed");
    } finally {
      deadline.cancel();
      deadline.clear();
    }
  }

  async #readJson(response: Response, deadline: RequestDeadline): Promise<unknown> {
    const body = response.body;
    if (body === null) return undefined;
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline.rejection]);
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          deadline.cancel();
          throw new GitHubInstallationTokenError(
            "GITHUB_API_RESPONSE_TOO_LARGE",
            "The GitHub API response exceeded the response size limit",
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      void reader.cancel().catch(() => undefined);
      throw error;
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (text.trim() === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw invalidResponseError("The GitHub API response was not valid JSON");
    }
  }
}
