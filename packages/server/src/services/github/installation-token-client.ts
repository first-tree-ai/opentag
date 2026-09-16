/*
 * Server-only GitHub App installation-token client.
 *
 * Mints and revokes GitHub App installation access tokens scoped to exactly one repository with a
 * minimal, explicit permission set. The App private key stays on the Server and the signed JWT
 * goes only to GitHub: this adapter has no public route, is not an authorization broker, and never falls
 * back to PATs, user tokens, or ambient credentials. Errors deliberately carry no upstream URLs,
 * headers, bodies, key material, JWTs, or tokens — only a controlled code, an optional HTTP
 * status, and a bounded rate-limit classification.
 */

import { createPrivateKey, type KeyObject, sign as rsaSign } from "node:crypto";

import {
  type GitHubInstallationTokenClientOptions,
  GitHubInstallationTokenError,
  type GitHubInstallationTokenPermissions,
  type MintedGitHubInstallationToken,
  type MintGitHubInstallationTokenInput,
} from "./installation-token-types.js";

export * from "./installation-token-types.js";

const GITHUB_API_BASE_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "opentag-server-github-installation-token-client";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 65_536;
const JWT_IAT_BACKDATE_SECONDS = 60;
const JWT_TTL_SECONDS = 600;
const RENEWAL_SAFETY_WINDOW_MS = 5 * 60 * 1_000;
const MAX_EXPIRY_HORIZON_MS = 24 * 60 * 60 * 1_000;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const MIN_RSA_MODULUS_BITS = 2_048;
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,18}$/;
const TOKEN_PATTERN = /^[-A-Za-z0-9._~+/]+=*$/;
const PERMISSION_LEVELS = new Map<string, number>([
  ["read", 1],
  ["write", 2],
]);
const PERMISSION_KEYS = new Set(["contents", "pull_requests"]);

type RequestDeadline = {
  signal: AbortSignal;
  rejection: Promise<never>;
  failure: () => GitHubInstallationTokenError | undefined;
  cancel: () => void;
  clear: () => void;
};

type SendOptions = {
  method: "POST" | "DELETE";
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

function assertSuccessStatus(response: Response, method: SendOptions["method"]): void {
  if (response.status !== (method === "POST" ? 201 : 204)) {
    throw invalidResponseError("The GitHub API returned an unexpected success status");
  }
}

function tokenValidationError(message: string): GitHubInstallationTokenError {
  return new GitHubInstallationTokenError("GITHUB_TOKEN_VALIDATION_FAILED", message);
}

function parseDecimalId(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL_ID_PATTERN.test(value)) {
    throw requestError(`${field} must be a positive decimal identifier`);
  }
  return value;
}

function parseRepositoryId(value: unknown): number {
  const text = parseDecimalId(value, "repositoryId");
  const id = Number(text);
  if (!Number.isSafeInteger(id)) {
    throw requestError("repositoryId is outside the safe integer range");
  }
  return id;
}

function validatePermissions(input: unknown): GitHubInstallationTokenPermissions {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw requestError("permissions must be an object with an explicit contents level");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PERMISSION_KEYS.has(key)) throw requestError("permissions contains an unsupported key");
  }
  const contents = record.contents;
  if (contents !== "read" && contents !== "write") {
    throw requestError("permissions.contents must be read or write");
  }
  const pullRequests = record.pull_requests;
  if (pullRequests !== undefined && pullRequests !== "read" && pullRequests !== "write") {
    throw requestError("permissions.pull_requests must be read or write");
  }
  return pullRequests === undefined ? { contents } : { contents, pull_requests: pullRequests };
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

function extractToken(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const token = (payload as Record<string, unknown>).token;
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) return undefined;
  return token;
}

function assertRepositoryScope(repositories: unknown, repositoryId: number): void {
  if (repositories === undefined) {
    throw tokenValidationError("The GitHub API returned a token without repository scoping");
  }
  if (!Array.isArray(repositories)) {
    throw invalidResponseError("The GitHub API response repository list is malformed");
  }
  if (repositories.length !== 1) {
    throw tokenValidationError("The GitHub API returned a token scoped to unexpected repositories");
  }
  const entry: unknown = repositories[0];
  if (typeof entry !== "object" || entry === null) {
    throw invalidResponseError("The GitHub API response repository entry is malformed");
  }
  const id = (entry as Record<string, unknown>).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw invalidResponseError("The GitHub API response repository id is not a safe integer");
  }
  if (id !== repositoryId) {
    throw tokenValidationError("The GitHub API returned a token scoped to a different repository");
  }
}

function assertPermissionGrantContained(key: string, value: unknown, requestedLevels: Record<string, number>): void {
  const level = typeof value === "string" ? PERMISSION_LEVELS.get(value) : undefined;
  if (level === undefined) {
    throw tokenValidationError("The GitHub API returned a token with an unrecognized permission level");
  }
  const allowed =
    key === "metadata"
      ? PERMISSION_LEVELS.get("read")
      : Object.hasOwn(requestedLevels, key)
        ? requestedLevels[key]
        : undefined;
  if (allowed === undefined || level > allowed) {
    throw tokenValidationError("The GitHub API returned a token with broader permissions than requested");
  }
}

function assertPermissionsContained(permissions: unknown, requestedLevels: Record<string, number>): void {
  if (permissions === undefined) {
    throw tokenValidationError("The GitHub API returned a token without a permission grant");
  }
  if (typeof permissions !== "object" || permissions === null || Array.isArray(permissions)) {
    throw invalidResponseError("The GitHub API response permissions are malformed");
  }
  const granted = permissions as Record<string, unknown>;
  for (const key of Object.keys(requestedLevels)) {
    if (!Object.hasOwn(granted, key)) {
      throw tokenValidationError("The GitHub API returned a token missing a requested permission");
    }
  }
  for (const [key, value] of Object.entries(granted)) {
    assertPermissionGrantContained(key, value, requestedLevels);
  }
}

function parseExpiry(value: unknown, nowMs: number): Date {
  if (typeof value !== "string") {
    throw invalidResponseError("The GitHub API response is missing a token expiry");
  }
  const expiryMs = Date.parse(value);
  if (!Number.isFinite(expiryMs)) {
    throw invalidResponseError("The GitHub API response token expiry is malformed");
  }
  const lifetimeMs = expiryMs - nowMs;
  if (lifetimeMs < RENEWAL_SAFETY_WINDOW_MS || lifetimeMs > MAX_EXPIRY_HORIZON_MS) {
    throw tokenValidationError("The GitHub API returned a token with an unusable expiry");
  }
  return new Date(expiryMs);
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
  readonly #privateKey: KeyObject;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GitHubInstallationTokenClientOptions) {
    if (typeof options.appId !== "string" || !DECIMAL_ID_PATTERN.test(options.appId)) {
      throw configError("The GitHub App ID must be a positive decimal identifier");
    }
    this.#appId = options.appId;
    this.#privateKey = parsePrivateKey(options.privateKey);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
  }

  async mint(input: MintGitHubInstallationTokenInput): Promise<MintedGitHubInstallationToken> {
    const installationId = parseDecimalId(input.installationId, "installationId");
    const repositoryId = parseRepositoryId(input.repositoryId);
    const permissions = validatePermissions(input.permissions);
    const requestedLevels: Record<string, number> = { contents: PERMISSION_LEVELS.get(permissions.contents) ?? 0 };
    if (permissions.pull_requests !== undefined) {
      requestedLevels.pull_requests = PERMISSION_LEVELS.get(permissions.pull_requests) ?? 0;
    }

    const payload = await this.#send({
      method: "POST",
      path: `/app/installations/${installationId}/access_tokens`,
      authorization: `Bearer ${this.#createJwt()}`,
      body: JSON.stringify({ repository_ids: [repositoryId], permissions }),
      signal: input.signal,
    });

    const token = extractToken(payload);
    try {
      if (token === undefined) {
        throw invalidResponseError("The GitHub API response did not include an installation token");
      }
      if (typeof payload !== "object" || payload === null) {
        throw invalidResponseError("The GitHub API response is malformed");
      }
      const record = payload as Record<string, unknown>;
      assertRepositoryScope(record.repositories, repositoryId);
      assertPermissionsContained(record.permissions, requestedLevels);
      const expiresAt = parseExpiry(record.expires_at, this.#now().getTime());
      return { token, expiresAt };
    } catch (error) {
      // A token that failed validation must not be left usable: revoke it best-effort without
      // ever replacing the original failure.
      if (token !== undefined) await this.revoke(token).catch(() => undefined);
      throw error;
    }
  }

  async revoke(token: string, signal?: AbortSignal): Promise<void> {
    if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH || !TOKEN_PATTERN.test(token)) {
      throw requestError("The installation token to revoke is invalid");
    }
    await this.#send({ method: "DELETE", path: "/installation/token", authorization: `Bearer ${token}`, signal });
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
      assertSuccessStatus(response, options.method);
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
