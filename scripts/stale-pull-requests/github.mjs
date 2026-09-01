const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_USER_AGENT = "opentag-stale-pull-requests";
const RETRYABLE_STATUSES = new Set([403, 429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 60_000;

/** GraphQL error types that mean "try again", as opposed to "this query is wrong". */
const TRANSIENT_GRAPHQL_TYPES = new Set(["RATE_LIMITED", "SERVICE_UNAVAILABLE"]);

export class GitHubRequestError extends Error {
  constructor(message, { status, body, headers, retryable, cause }) {
    super(message, { cause });
    this.name = "GitHubRequestError";
    this.status = status;
    this.body = body;
    this.headers = headers;
    // Set when the status alone cannot classify the failure: a transport error
    // that never reached GitHub, or a 200 carrying a GraphQL errors array.
    this.retryable = retryable;
  }
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function retryAfterMillis(headers) {
  const retryAfter = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS);
  }
  return null;
}

/**
 * A 403 from GitHub is either "you may not do this" or "you are going too fast".
 * Only the latter is worth retrying. An exhausted quota says so in the remaining
 * header; a secondary (abuse) limit says so with `retry-after` and leaves the
 * quota untouched, so both signals have to be honoured.
 */
function isRateLimited(status, headers) {
  if (status === 429) {
    return true;
  }
  if (status !== 403) {
    return false;
  }
  return headers?.get?.("x-ratelimit-remaining") === "0" || typeof headers?.get?.("retry-after") === "string";
}

function retryDelayMillis(error, attempt) {
  const explicit = retryAfterMillis(error.headers);
  if (explicit !== null) {
    return explicit;
  }
  if (isRateLimited(error.status, error.headers)) {
    return MAX_RETRY_DELAY_MS;
  }
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function isRetryable(error) {
  if (!(error instanceof GitHubRequestError)) {
    return false;
  }
  if (typeof error.retryable === "boolean") {
    return error.retryable;
  }
  if (error.status === 403) {
    return isRateLimited(error.status, error.headers);
  }
  return RETRYABLE_STATUSES.has(error.status);
}

async function withRetry(operation, { retries, logger, sleepImpl }) {
  let attempt = 0;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isRetryable(error)) {
        throw error;
      }
      const delay = retryDelayMillis(error, attempt);
      logger.warn("Retrying GitHub request", { attempt: attempt + 1, delayMs: delay, status: error.status });
      await sleepImpl(delay);
      attempt += 1;
    }
  }
}

function isTransientGraphqlFailure(errors) {
  return errors.every(
    (entry) => TRANSIENT_GRAPHQL_TYPES.has(entry?.type) || /timed?\s?out/i.test(entry?.message ?? ""),
  );
}

/** GraphQL reports failures as HTTP 200 plus an `errors` array. */
export function assertNoGraphqlErrors(payload) {
  const errors = payload?.errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return;
  }
  throw new GitHubRequestError(`GitHub GraphQL query failed: ${errors.map((entry) => entry.message).join("; ")}`, {
    status: 200,
    body: payload,
    headers: null,
    retryable: isTransientGraphqlFailure(errors),
  });
}

async function readBody(response) {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Minimal GitHub client built on the platform `fetch`. The repository forbids
 * undeclared dependencies in `scripts/`, so there is no Octokit here; `fetchImpl`
 * and `sleepImpl` are injected so tests never touch the network or the clock.
 */
export function createGitHubClient({
  token,
  apiUrl = DEFAULT_API_URL,
  fetchImpl = fetch,
  sleepImpl = sleep,
  logger,
  retries = 3,
  userAgent = DEFAULT_USER_AGENT,
}) {
  if (typeof token !== "string" || token.length === 0) {
    throw new TypeError("A GitHub token is required; set GH_TOKEN in the workflow environment");
  }

  const baseHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "user-agent": userAgent,
    "x-github-api-version": "2022-11-28",
  };

  async function send(method, url, body) {
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: baseHeaders,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      // The request never reached GitHub, so nothing was applied and retrying
      // it is always safe, whatever the method.
      throw new GitHubRequestError(`${method} ${url} failed before a response arrived`, {
        status: null,
        body: null,
        headers: null,
        retryable: true,
        cause,
      });
    }
    const payload = await readBody(response);
    if (!response.ok) {
      throw new GitHubRequestError(`${method} ${url} failed with ${response.status}`, {
        status: response.status,
        body: payload,
        headers: response.headers,
      });
    }
    return payload;
  }

  /**
   * `options.retries` exists so a non-idempotent call can opt out: GitHub may
   * commit a comment and still answer 5xx, and a blind retry would post it twice.
   */
  async function rest(method, path, body, options = {}) {
    logger.debug("GitHub REST request", { method, path });
    return withRetry(() => send(method, `${apiUrl}${path}`, body), {
      retries: options.retries ?? retries,
      logger,
      sleepImpl,
    });
  }

  async function graphql(query, variables) {
    // The errors array is inspected inside the retried operation: GraphQL
    // answers a timeout with HTTP 200 and an errors array, which is exactly the
    // case worth retrying.
    return withRetry(
      async () => {
        const payload = await send("POST", `${apiUrl}/graphql`, { query, variables });
        assertNoGraphqlErrors(payload);
        return payload?.data ?? {};
      },
      { retries, logger, sleepImpl },
    );
  }

  return { graphql, rest };
}
