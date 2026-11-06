/** Fixed-origin GitHub REST transport for Context Tree using the Agent's MCP OAuth credential. */

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "opentag-server-context-tree";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 4_096;
const MAX_LOGIN_LENGTH = 100;
const MAX_FULL_NAME_LENGTH = 255;
const MAX_BRANCH_LENGTH = 255;
const MAX_RETRY_AFTER_SECONDS = 3_600;
const DECIMAL_ID_PATTERN = /^[1-9]\d{0,18}$/;
const TOKEN_PATTERN = /^[-A-Za-z0-9._~+/]+=*$/;

export const GITHUB_API_CLIENT_ERROR_CODES = {
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
    readonly details: {
      status?: number;
      retryAfterSeconds?: number;
      transportCode?: "request_timeout" | "request_cancelled";
    } = {},
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

export interface GitHubAuthenticatedUser {
  id: string;
  login: string;
}

export interface GitHubRepository {
  repositoryId: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  permissions: { admin: boolean; pull: boolean; push: boolean };
}

export interface GitHubApiClientOptions {
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

function unavailable(
  message: string,
  options?: ErrorOptions,
  transportCode?: "request_timeout" | "request_cancelled",
): GitHubApiClientError {
  return new GitHubApiClientError(
    GITHUB_API_CLIENT_ERROR_CODES.UPSTREAM_UNAVAILABLE,
    message,
    transportCode === undefined ? {} : { transportCode },
    options,
  );
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

function parseRepository(value: unknown): GitHubRepository {
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

/** Uses caller-provided access tokens; OAuth exchange and refresh belong to MCP. */
export class GitHubApiClient {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;

  constructor(options: GitHubApiClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
  }

  /** The GitHub-attested user identity and required repo scope behind a user access token. */
  async getAuthenticatedUser(input: {
    accessToken: string;
    signal?: AbortSignal;
    requireRepositoryScope?: boolean;
  }): Promise<GitHubAuthenticatedUser> {
    const payload = await this.#sendApi(
      "GET",
      "/user",
      input.accessToken,
      input.signal,
      input.requireRepositoryScope !== false,
    );
    if (!isRecord(payload)) throw invalidResponse("The GitHub API user response is malformed");
    const type = payload.type;
    if (type !== "User") throw invalidResponse("The GitHub API user response is not a user");
    return {
      id: parseDecimalId(payload.id, "user id"),
      login: parseBoundedString(payload.login, "user login", MAX_LOGIN_LENGTH),
    };
  }

  /** Exact target lookup with the user token: GitHub enforces the user/OAuth scope intersection. */
  async getRepository(input: {
    accessToken: string;
    fullName: string;
    signal?: AbortSignal;
  }): Promise<GitHubRepository> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.fullName) || input.fullName.includes(".."))
      throw requestError("Invalid repository name");
    return parseRepository(await this.#sendApi("GET", `/repos/${input.fullName}`, input.accessToken, input.signal));
  }

  /** Creates an empty private repository; an existing repository is never reused or modified. */
  async createPrivateRepository(input: {
    accessToken: string;
    fullName: string;
    githubLogin: string;
    signal?: AbortSignal;
  }): Promise<GitHubRepository> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.fullName) || input.fullName.includes(".."))
      throw requestError("Invalid repository name");
    const [owner, name] = input.fullName.split("/");
    const path = owner?.toLowerCase() === input.githubLogin.toLowerCase() ? "/user/repos" : `/orgs/${owner}/repos`;
    const repository = parseRepository(
      await this.#sendApi("POST", path, input.accessToken, input.signal, true, {
        name,
        private: true,
        auto_init: false,
      }),
    );
    if (!repository.private || repository.fullName.toLowerCase() !== input.fullName.toLowerCase())
      throw invalidResponse("GitHub did not create the requested private repository");
    return repository;
  }

  /** Omitting branch uses GitHub's default; omitting sha prevents replacing an existing file. */
  async initializeContextTree(input: {
    accessToken: string;
    fullName: string;
    content: string;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.fullName) || input.fullName.includes(".."))
      throw requestError("Invalid repository name");
    await this.#sendApi("PUT", `/repos/${input.fullName}/contents/NODE.md`, input.accessToken, input.signal, true, {
      message: "docs: initialize context tree",
      content: Buffer.from(input.content).toString("base64"),
    });
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
    const onCallerAbort = () => fail(unavailable("The GitHub request was cancelled", undefined, "request_cancelled"));
    if (callerSignal) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
    const timer = setTimeout(
      () => fail(unavailable("The GitHub request exceeded its time limit", undefined, "request_timeout")),
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

  async #sendApi(
    method: "GET" | "POST" | "PUT",
    path: string,
    accessToken: string,
    signal?: AbortSignal,
    requireRepositoryScope = false,
    body?: unknown,
  ): Promise<unknown> {
    return this.#send({
      method,
      url: `${GITHUB_API_ORIGIN}${path}`,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${parseToken(accessToken, "access token")}`,
        "user-agent": USER_AGENT,
        "x-github-api-version": GITHUB_API_VERSION,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      signal,
      requireRepositoryScope,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(method === "GET" ? {} : { expectedStatus: 201 }),
    });
  }

  async #send(options: {
    method: "GET" | "POST" | "PUT";
    url: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    expectedStatus?: number;
    requireRepositoryScope?: boolean;
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
      if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
        throw invalidResponse("The GitHub token endpoint returned an unexpected success status");
      }
      const payload = await this.#readJson(response, deadline);
      if (options.requireRepositoryScope) assertRepositoryScopeHeader(response.headers);
      return payload;
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

function assertRepositoryScopeHeader(headers: Headers): void {
  const header = headers.get("x-oauth-scopes");
  if (header === null || header.length > 10_100) throw invalidResponse("The OAuth scope header is missing or invalid");
  const scopes = header
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes.length > 100 || scopes.some((scope) => scope.length > 100 || !/^[a-z_]+(?::[a-z_]+)*$/.test(scope)))
    throw invalidResponse("The OAuth scope header is malformed");
  assertRepositoryScope(scopes);
}

function assertRepositoryScope(value: unknown): void {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((scope) => typeof scope !== "string" || scope.length > 100) ||
    !value.includes("repo")
  )
    throw new GitHubApiClientError(
      GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID,
      "The OAuth credential does not grant repo scope",
    );
}
