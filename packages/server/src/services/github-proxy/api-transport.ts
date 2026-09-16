import { GitPublicationError } from "./git-packets.js";

export interface GitHubJsonResponse {
  status: number;
  headers: Record<string, string>;
  value: unknown;
}
/** Fixed-origin, bounded, non-retrying transport. Raw errors and credential-bearing redirects never escape. */
export class GitHubProxyApiTransport {
  constructor(readonly fetchImpl: typeof fetch = globalThis.fetch) {}
  async request(input: {
    token: string;
    method: string;
    path: string;
    body?: unknown;
    signal: AbortSignal;
  }): Promise<GitHubJsonResponse> {
    if (!input.path.startsWith("/") || input.path.startsWith("//")) throw new GitPublicationError("invalid_request");
    const response = await this.fetchImpl(`https://api.github.com${input.path}`, {
      method: input.method,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "opentag-github-proxy",
        "content-type": "application/json",
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(30_000)]),
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new GitPublicationError("unavailable");
    }
    const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" };
    for (const name of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"])
      if (response.headers.has(name)) headers[name] = response.headers.get(name) as string;
    const link = response.headers.get("link");
    if (
      link &&
      link.length <= 4096 &&
      !link
        .replace(/<https:\/\/api\.github\.com\/[^<>\s]+>; rel="(?:next|prev|first|last)"/g, "")
        .replaceAll(",", "")
        .trim()
    )
      headers.link = link;
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, headers, value: { message: "GitHub rejected the authorized operation" } };
    }
    const bytes = await readBoundedBody(response.body ?? emptyBody(), 4 * 1024 * 1024, input.signal);
    try {
      return { status: response.status, headers, value: bytes.length ? JSON.parse(bytes.toString("utf8")) : null };
    } catch {
      throw new GitPublicationError("unavailable");
    }
  }
}

export async function readBoundedBody(
  body: AsyncIterable<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > maximum) throw new GitPublicationError("resource_limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
export async function* emptyBody(): AsyncIterable<Uint8Array> {}
export async function* jsonBody(value: unknown): AsyncIterable<Uint8Array> {
  yield Buffer.from(JSON.stringify(value));
}
export function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitPublicationError("unavailable");
  return value as Record<string, unknown>;
}

/** Only authority fields are scrubbed. Ordinary URLs and user-authored text retain their meaning. */
export function sanitizeGitHubResponse(value: unknown, token: string): unknown {
  if (typeof value === "string") {
    if (value.includes(token)) throw new GitPublicationError("unavailable");
    if (/^https:\/\//.test(value)) {
      // Ordinary text (a PR body, a commit message) may merely start with "https://" without
      // being a parseable URL; it cannot carry URL-addressable credentials and passes through.
      // The token-content guard above remains the first and authoritative credential check.
      let url: URL | undefined;
      try {
        url = new URL(value);
      } catch {
        return value;
      }
      if (
        url.username ||
        url.password ||
        [...url.searchParams.keys()].some((key) => /token|signature|credential|x-amz-/i.test(key))
      )
        throw new GitPublicationError("unavailable");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeGitHubResponse(item, token));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !["token", "access_token", "refresh_token", "client_secret"].includes(key))
        .map(([key, item]) => [key, sanitizeGitHubResponse(item, token)]),
    );
  return value;
}
