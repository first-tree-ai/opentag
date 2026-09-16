/*
 * Server-only GitHub user-facing API transport for the management plane.
 *
 * Speaks the official GitHub App user-authorization protocol only: the OAuth token endpoint on
 * https://github.com (code exchange with PKCE, refresh-token grant) and the REST API on
 * https://api.github.com (/user, user installations, installation repositories). Origins are fixed
 * by construction — no caller can supply a URL, a Host, or extra headers — and every call is
 * bounded in time and response size, refuses redirects, and never reads an error body into an
 * exception. Errors carry a controlled code, an optional HTTP status, and an optional bounded
 * rate-limit hint — never upstream text, URLs, headers, or token material.
 *
 * The deployment's GitHub App must issue expiring user access tokens. A token response missing
 * `expires_in`, `refresh_token`, or `refresh_token_expires_in` is a configuration failure this
 * client refuses (GITHUB_TOKEN_LIFETIME_UNSUPPORTED) rather than persisting an unmaintainable
 * credential.
 */

const GITHUB_OAUTH_ORIGIN = "https://github.com";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "opentag-server-github-management";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const GITHUB_USER_INSTALLATIONS_PER_PAGE = 100;
export const GITHUB_INSTALLATION_REPOSITORIES_PER_PAGE = 100;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_LOGIN_LENGTH = 100;
const MAX_FULL_NAME_LENGTH = 255;
const MAX_BRANCH_LENGTH = 255;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const MAX_PAGE_ITEMS = 100;
const MAX_EXPIRY_SECONDS = 31_536_000; // one year: above every GitHub-documented token lifetime
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,18}$/;
const TOKEN_PATTERN = /^[-A-Za-z0-9._~+/]+=*$/;
const OAUTH_ERROR_PATTERN = /^[a-z_]{1,64}$/;
const PERMISSION_LEVELS = new Set(["read", "write"]);

export const GITHUB_API_CLIENT_ERROR_CODES = {
  OAUTH_EXCHANGE_REJECTED: "GITHUB_OAUTH_EXCHANGE_REJECTED",
  TOKEN_LIFETIME_UNSUPPORTED: "GITHUB_TOKEN_LIFETIME_UNSUPPORTED",
  CREDENTIAL_INVALID: "GITHUB_CREDENTIAL_INVALID",
  RATE_LIMITED: "GITHUB_RATE_LIMITED",
  UPSTREAM_UNAVAILABLE: "GITHUB_UPSTREAM_UNAVAILABLE",
  UPSTREAM_ERROR: "GITHUB_UPSTREAM_ERROR",
  RESPONSE_INVALID: "GITHUB_API_RESPONSE_INVALID",
  REQUEST_INVALID: "GITHUB_REQUEST_INVALID",
} as const;
export type GitHubApiClientErrorCode =
  (typeof GITHUB_API_CLIENT_ERROR_CODES)[keyof typeof GITHUB_API_CLIENT_ERROR_CODES];

export class GitHubApiClientError extends Error {
  constructor(
    readonly code: GitHubApiClientErrorCode,
    message: string,
    readonly details: { status?: number; retryAfterSeconds?: number } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GitHubApiClientError";
  }

  get status(): number | undefined {
    return this.details.status;
  }

  get retryAfterSeconds(): number | undefined {
    return this.details.retryAfterSeconds;
  }
}

/** The sealed-at-rest shape a successful exchange or refresh yields: both tokens and both expiries. */
export interface GitHubUserTokenMaterial {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
}

export interface GitHubAuthenticatedUser {
  id: string;
  login: string;
}

export interface GitHubUserInstallation {
  installationId: string;
  appId: string;
  accountLogin: string;
  accountType: "User" | "Organization";
  repositorySelection: "all" | "selected";
  permissions: Record<string, "read" | "write">;
  suspended: boolean;
}

export interface GitHubUserInstallationsPage {
  totalCount: number;
  installations: GitHubUserInstallation[];
}

export interface GitHubInstallationRepository {
  repositoryId: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  permissions: { admin: boolean; pull: boolean; push: boolean };
}

export interface GitHubInstallationRepositoriesPage {
  totalCount: number;
  repositorySelection: "all" | "selected";
  repositories: GitHubInstallationRepository[];
}

export interface GitHubApiClientOptions {
  clientId: string;
  clientSecret: string;
  /** Exact callback URL registered on the App; sent on authorize and verified again at exchange. */
  redirectUri: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

type RequestDeadline = {
  signal: AbortSignal;
  rejection: Promise<never>;
  failure: () => GitHubApiClientError | undefined;
  cancel: () => void;
  clear: () => void;
};

function requestError(message: string): GitHubApiClientError {
  return new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID, message);
}

function invalidResponse(message: string): GitHubApiClientError {
  return new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.RESPONSE_INVALID, message);
}

function unavailable(message: string, options?: ErrorOptions): GitHubApiClientError {
  return new GitHubApiClientError(GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE, message, {}, options);
}

function parseDecimalId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && DECIMAL_ID_PATTERN.test(value)) return value;
  throw invalidResponse(`The GitHub API response ${field} is not a positive decimal identifier`);
}

function parseBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw invalidResponse(`The GitHub API response ${field} is missing or unbounded`);
  }
  return value;
}

function parseToken(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_TOKEN_LENGTH ||
    !TOKEN_PATTERN.test(value)
  ) {
    throw invalidResponse(`The GitHub API response ${field} is malformed`);
  }
  return value;
}

function parseLifetimeSeconds(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > MAX_EXPIRY_SECONDS) {
    throw new GitHubApiClientError(
      GITHUB_API_CLIENT_ERROR_CODES.TOKEN_LIFETIME_UNSUPPORTED,
      `The GitHub App does not issue a usable ${field}; enable expiring user access tokens on the App`,
    );
  }
  return value;
}

function parseIsoDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw invalidResponse("The GitHub API response timestamp is malformed");
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw invalidResponse("The GitHub API response timestamp is malformed");
  return new Date(ms);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePermissions(value: unknown): Record<string, "read" | "write"> {
  if (!isRecord(value)) throw invalidResponse("The GitHub API response permissions are malformed");
  const permissions: Record<string, "read" | "write"> = {};
  for (const [key, level] of Object.entries(value)) {
    if (typeof key !== "string" || key.length === 0 || key.length > 64) {
      throw invalidResponse("The GitHub API response permissions carry an unrecognized grant");
    }
    if (typeof level !== "string" || !PERMISSION_LEVELS.has(level)) {
      throw invalidResponse("The GitHub API response permissions carry an unrecognized grant");
    }
    permissions[key] = level as "read" | "write";
  }
  return permissions;
}

function parseInstallation(value: unknown): GitHubUserInstallation {
  if (!isRecord(value)) throw invalidResponse("The GitHub API response installation is malformed");
  const account = value.account;
  if (!isRecord(account)) throw invalidResponse("The GitHub API response installation account is malformed");
  const accountType = account.type;
  if (accountType !== "User" && accountType !== "Organization") {
    throw invalidResponse("The GitHub API response installation account type is unsupported");
  }
  const selection = value.repository_selection;
  if (selection !== "all" && selection !== "selected") {
    throw invalidResponse("The GitHub API response installation repository selection is malformed");
  }
  return {
    installationId: parseDecimalId(value.id, "installation id"),
    appId: parseDecimalId(value.app_id, "installation app id"),
    accountLogin: parseBoundedString(account.login, "installation account login", MAX_LOGIN_LENGTH),
    accountType,
    repositorySelection: selection,
    permissions: parsePermissions(value.permissions),
    suspended: parseIsoDate(value.suspended_at) !== null,
  };
}

function parseRepository(value: unknown): GitHubInstallationRepository {
  if (!isRecord(value)) throw invalidResponse("The GitHub API response repository is malformed");
  const permissions = value.permissions;
  if (
    !isRecord(permissions) ||
    typeof permissions.admin !== "boolean" ||
    typeof permissions.pull !== "boolean" ||
    typeof permissions.push !== "boolean"
  ) {
    throw invalidResponse("The GitHub API response repository permissions are malformed");
  }
  const defaultBranch = value.default_branch;
  return {
    repositoryId: parseDecimalId(value.id, "repository id"),
    fullName: parseBoundedString(value.full_name, "repository full name", MAX_FULL_NAME_LENGTH),
    private: value.private === true,
    defaultBranch:
      defaultBranch === null || defaultBranch === undefined
        ? null
        : parseBoundedString(defaultBranch, "repository default branch", MAX_BRANCH_LENGTH),
    permissions: { admin: permissions.admin, pull: permissions.pull, push: permissions.push },
  };
}

function parsePageItems<T>(value: unknown, field: string, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > MAX_PAGE_ITEMS) {
    throw invalidResponse(`The GitHub API response ${field} is not a bounded page`);
  }
  return value.map(parse);
}

function parseTotalCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw invalidResponse("The GitHub API response total_count is malformed");
  }
  return value;
}

/**
 * The bounded user-token transport for one configured App. The client secret leaves this class
 * only inside a request body to the fixed GitHub OAuth origin; it is never logged or serialized.
 */
export class GitHubApiClient {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #redirectUri: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GitHubApiClientOptions) {
    if (typeof options.clientId !== "string" || options.clientId.length === 0 || options.clientId.length > 255) {
      throw new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID,
        "The GitHub App client ID is invalid",
      );
    }
    if (
      typeof options.clientSecret !== "string" ||
      options.clientSecret.length === 0 ||
      options.clientSecret.length > 255
    ) {
      throw new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID,
        "The GitHub App client secret is invalid",
      );
    }
    const redirect = new URL(options.redirectUri);
    if (redirect.protocol !== "https:" && redirect.hostname !== "127.0.0.1" && redirect.hostname !== "localhost") {
      throw new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.REQUEST_INVALID,
        "The GitHub App OAuth callback URL is invalid",
      );
    }
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#redirectUri = options.redirectUri;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Exchanges an authorization code exactly once. GitHub reports a rejected exchange as HTTP 200
   * with an error payload, so success and rejection are distinguished by the parsed body, never by
   * status alone. A rejection is definitive: the code is dead and must not be re-presented.
   */
  async exchangeCodeForUserToken(input: {
    code: string;
    codeVerifier: string;
    signal?: AbortSignal;
  }): Promise<GitHubUserTokenMaterial> {
    if (typeof input.code !== "string" || input.code.length === 0 || input.code.length > 4096) {
      throw requestError("The authorization code is invalid");
    }
    if (
      typeof input.codeVerifier !== "string" ||
      input.codeVerifier.length < 43 ||
      input.codeVerifier.length > 128 ||
      !/^[A-Za-z0-9._~-]+$/.test(input.codeVerifier)
    ) {
      throw requestError("The PKCE code verifier is invalid");
    }
    const payload = await this.#sendOAuth(
      {
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code: input.code,
        redirect_uri: this.#redirectUri,
        code_verifier: input.codeVerifier,
      },
      input.signal,
    );
    return this.#parseTokenPayload(payload);
  }

  /**
   * The refresh-token grant. GitHub rotates the refresh token on every successful exchange, so an
   * exchange whose outcome is unknown must never be replayed by the caller — the store-level CAS
   * decides what happens next, this client only classifies.
   */
  async refreshUserToken(input: { refreshToken: string; signal?: AbortSignal }): Promise<GitHubUserTokenMaterial> {
    const payload = await this.#sendOAuth(
      {
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        grant_type: "refresh_token",
        refresh_token: parseToken(input.refreshToken, "refresh token"),
      },
      input.signal,
    );
    return this.#parseTokenPayload(payload);
  }

  /** The GitHub-attested user identity behind a user access token. */
  async getAuthenticatedUser(input: { accessToken: string; signal?: AbortSignal }): Promise<GitHubAuthenticatedUser> {
    const payload = await this.#sendApi("GET", "/user", input.accessToken, input.signal);
    if (!isRecord(payload)) throw invalidResponse("The GitHub API user response is malformed");
    const type = payload.type;
    if (type !== "User") throw invalidResponse("The GitHub API user response is not a user");
    return {
      id: parseDecimalId(payload.id, "user id"),
      login: parseBoundedString(payload.login, "user login", MAX_LOGIN_LENGTH),
    };
  }

  /** One page of the authenticated user's installations of the App this token belongs to. */
  async listUserInstallations(input: {
    accessToken: string;
    page: number;
    signal?: AbortSignal;
  }): Promise<GitHubUserInstallationsPage> {
    const page = parsePageNumber(input.page);
    const payload = await this.#sendApi(
      "GET",
      `/user/installations?per_page=${GITHUB_USER_INSTALLATIONS_PER_PAGE}&page=${page}`,
      input.accessToken,
      input.signal,
    );
    if (!isRecord(payload)) throw invalidResponse("The GitHub API installations response is malformed");
    return {
      totalCount: parseTotalCount(payload.total_count),
      installations: parsePageItems(payload.installations, "installations", parseInstallation),
    };
  }

  /** One page of repositories the user can reach through one installation. */
  async listInstallationRepositories(input: {
    accessToken: string;
    installationId: string;
    page: number;
    signal?: AbortSignal;
  }): Promise<GitHubInstallationRepositoriesPage> {
    if (typeof input.installationId !== "string" || !DECIMAL_ID_PATTERN.test(input.installationId)) {
      throw requestError("The installation ID is invalid");
    }
    const page = parsePageNumber(input.page);
    const payload = await this.#sendApi(
      "GET",
      `/user/installations/${input.installationId}/repositories?per_page=${GITHUB_INSTALLATION_REPOSITORIES_PER_PAGE}&page=${page}`,
      input.accessToken,
      input.signal,
    );
    if (!isRecord(payload)) throw invalidResponse("The GitHub API repositories response is malformed");
    const selection = payload.repository_selection;
    if (selection !== "all" && selection !== "selected") {
      throw invalidResponse("The GitHub API repositories selection is malformed");
    }
    return {
      totalCount: parseTotalCount(payload.total_count),
      repositorySelection: selection,
      repositories: parsePageItems(payload.repositories, "repositories", parseRepository),
    };
  }

  #parseTokenPayload(payload: unknown): GitHubUserTokenMaterial {
    if (!isRecord(payload)) throw invalidResponse("The GitHub OAuth token response is malformed");
    if (payload.error !== undefined) {
      // GitHub's bounded error slug is the only detail kept; the description text is untrusted.
      const slug =
        typeof payload.error === "string" && OAUTH_ERROR_PATTERN.test(payload.error) ? payload.error : "oauth_error";
      throw new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.OAUTH_EXCHANGE_REJECTED,
        `GitHub rejected the OAuth exchange (${slug})`,
      );
    }
    const nowMs = this.#now().getTime();
    const accessExpiresIn = parseLifetimeSeconds(payload.expires_in, "access token expiry");
    const refreshExpiresIn = parseLifetimeSeconds(payload.refresh_token_expires_in, "refresh token expiry");
    return {
      accessToken: parseToken(payload.access_token, "access token"),
      refreshToken: parseToken(payload.refresh_token, "refresh token"),
      accessExpiresAt: new Date(nowMs + accessExpiresIn * 1_000),
      refreshExpiresAt: new Date(nowMs + refreshExpiresIn * 1_000),
    };
  }

  #startDeadline(callerSignal?: AbortSignal): RequestDeadline {
    const controller = new AbortController();
    let failure: GitHubApiClientError | undefined;
    let rejectRejection: (error: unknown) => void = () => undefined;
    const rejection = new Promise<never>((_resolve, reject) => {
      rejectRejection = reject;
    });
    void rejection.catch(() => undefined);
    const fail = (error: GitHubApiClientError) => {
      if (failure) return;
      failure = error;
      rejectRejection(error);
      if (!controller.signal.aborted) controller.abort(error);
    };
    const onCallerAbort = () => fail(unavailable("The GitHub request was cancelled"));
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => fail(unavailable("The GitHub request exceeded its time limit")), REQUEST_TIMEOUT_MS);
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

  async #sendOAuth(body: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
    return this.#send({
      method: "POST",
      url: `${GITHUB_OAUTH_ORIGIN}/login/oauth/access_token`,
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
      signal,
    });
  }

  async #sendApi(method: "GET", path: string, accessToken: string, signal?: AbortSignal): Promise<unknown> {
    return this.#send({
      method,
      url: `${GITHUB_API_ORIGIN}${path}`,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${parseToken(accessToken, "access token")}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
      },
      signal,
    });
  }

  async #send(options: {
    method: "GET" | "POST";
    url: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const deadline = this.#startDeadline(options.signal);
    try {
      const preflightFailure = deadline.failure();
      if (preflightFailure) throw preflightFailure;
      const response = await Promise.race([
        this.#fetch(options.url, {
          method: options.method,
          headers: options.headers,
          body: options.body,
          redirect: "error",
          signal: deadline.signal,
        }),
        deadline.rejection,
      ]);
      const inFlightFailure = deadline.failure();
      if (inFlightFailure) throw inFlightFailure;
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new GitHubApiClientError(
          GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR,
          "The GitHub endpoint attempted to redirect the request",
        );
      }
      if (!response.ok) {
        // The error body is never read: it is untrusted and cannot be assumed safe.
        void response.body?.cancel().catch(() => undefined);
        throw this.#classifyHttpError(response);
      }
      return await this.#readJson(response, deadline);
    } catch (error) {
      if (error instanceof GitHubApiClientError) throw error;
      const failure = deadline.failure();
      if (failure) throw failure;
      throw unavailable("The GitHub request failed", { cause: error });
    } finally {
      deadline.cancel();
      deadline.clear();
    }
  }

  #classifyHttpError(response: Response): GitHubApiClientError {
    const status = response.status;
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    const retryAfterSeconds =
      parseRetryAfter(response.headers) ??
      (response.headers.get("x-ratelimit-remaining") === "0"
        ? parseRateLimitReset(response.headers, nowSeconds)
        : undefined);
    if (status === 401) {
      return new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID,
        "GitHub rejected the presented credential",
        { status },
      );
    }
    const isRateLimited =
      status === 429 ||
      (status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || parseRetryAfter(response.headers) !== undefined));
    if (isRateLimited) {
      return new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED,
        "The GitHub rate limit was exceeded",
        {
          status,
          ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
        },
      );
    }
    if (status >= 500) {
      return new GitHubApiClientError(
        GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
        `The GitHub endpoint is unavailable (status ${status})`,
        { status, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
      );
    }
    return new GitHubApiClientError(
      GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_ERROR,
      `The GitHub request failed with status ${status}`,
      { status, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) },
    );
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
          throw invalidResponse("The GitHub response exceeded the response size limit");
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
      throw invalidResponse("The GitHub response was not valid JSON");
    }
  }
}

function parsePageNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw requestError("The page number is invalid");
  }
  return value;
}
