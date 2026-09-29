import { MCP_ERROR_CODES } from "@opentag/shared";
import {
  classifyOutboundDestination,
  classifyOutboundUrl,
  type OutboundAddressFailure,
  type OutboundAddressPolicy,
  REDIRECT_MODE,
  resolveAllAddresses,
} from "../outbound/address-policy.js";
import { McpServiceError } from "./errors.js";

/**
 * The single outbound HTTP gate for the whole MCP feature.
 *
 * Every URL this feature dials is validated here — not just the configured MCP endpoint. The
 * discovery chain takes several URLs straight from the peer's responses: a `WWW-Authenticate`
 * challenge's `resource_metadata`, a Protected Resource Metadata document's
 * `authorization_servers[]` and `resource`, an Authorization Server metadata document's
 * `authorization_endpoint` / `token_endpoint` / `registration_endpoint` / `jwks_uri`, and a CIMD
 * document URL. A malicious or hijacked MCP Server could otherwise direct this server at a
 * link-local metadata service or an internal address.
 *
 * `mcp-transport.ts`, `mcp-oauth.ts`, and `mcp-probe.ts` must not call `fetch` themselves; they take
 * `fetchOutbound` from here, which keeps the gate unavoidable by construction. A regression test
 * scans those three files for a direct `fetch(` call.
 *
 * The address rules themselves live in `services/outbound/address-policy.ts`, because they are not
 * about MCP: the remote Skill source fetcher applies the same ones. This module keeps the MCP
 * vocabulary — the error codes and the wording the MCP surface has always used — over that shared
 * verdict, so nothing about MCP's observable behaviour changed when the rules moved.
 */

export { isLoopbackHost } from "../outbound/address-policy.js";

export interface McpOutboundPolicy extends OutboundAddressPolicy {
  /** Per-request deadline. */
  timeoutMs?: number;
  /** Maximum response body size, enforced while reading so a huge body cannot exhaust memory. */
  maxResponseBytes?: number;
  /** Maximum concurrent outbound requests for one Account, shared across every discovery hop. */
  maxConcurrentPerAccount?: number;
}

export interface McpFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface McpFetchResponse {
  status: number;
  headers: Headers;
  /** Raw body text, already bounded and size-checked. */
  text: string;
}

export const MCP_DEFAULT_TIMEOUT_MS = 10_000;
/**
 * The deadline and budget for a *runtime tool call*, which is a different operation from a probe.
 *
 * A probe is a bounded read the Server issues on its own schedule, so ten seconds is generous. A
 * tool call is whatever the upstream tool does — a search, a database query, code execution, a
 * browser action — and routinely outlives that. Sharing the probe's deadline turned every such tool
 * into a generic failure the model could not act on.
 *
 * The budget is separate for the same reason: a background probe or a token refresh must not be
 * able to exhaust the slots a live turn needs, and Claude Code issues tool calls in parallel.
 * Separation comes from using a second fetcher instance — `#inFlight` is per instance.
 */
export const MCP_RUNTIME_TIMEOUT_MS = 120_000;
export const MCP_RUNTIME_MAX_CONCURRENT_PER_ACCOUNT = 8;
export const MCP_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MCP_DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 4;

function blocked(message: string, detail?: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.URL_BLOCKED, message, detail);
}

function invalid(message: string): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.SERVER_URL_INVALID, message);
}

function unreachable(detail: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "The MCP endpoint could not be reached", detail);
}

/** Renders one shared address verdict as the MCP error the surface has always raised. */
function errorForFailure(failure: OutboundAddressFailure): McpServiceError {
  switch (failure.kind) {
    case "invalid":
      return invalid(failure.message);
    case "blocked":
      return blocked(failure.message, failure.detail);
    case "unreachable":
      return unreachable({
        ...(failure.cause === undefined ? {} : { cause: failure.cause }),
        host: failure.host,
      });
  }
}

/**
 * Validate one outbound URL and return it, throwing the MCP error the caller renders. A loopback
 * plain-HTTP URL is admitted only when the policy allows loopback — the local development case
 * where a CLI points at a fixture Server on `127.0.0.1`.
 */
export function assertOutboundUrl(rawUrl: string, policy: McpOutboundPolicy): URL {
  const verdict = classifyOutboundUrl(rawUrl, policy);
  if (verdict.ok) return verdict.url;
  throw errorForFailure(verdict.failure);
}

export interface McpOutboundFetchOptions extends McpOutboundPolicy {
  fetch?: typeof globalThis.fetch;
  /**
   * Resolves a hostname to every address it holds. Injectable so a test can assert the policy
   * without a network, and so a deployment can supply a resolver with different search domains.
   */
  resolveAddresses?: (hostname: string) => Promise<string[]>;
}

/**
 * The only way the MCP feature performs an outbound request. Validates the URL, applies the
 * per-Account concurrency limit, does not follow redirects, bounds the deadline, and bounds the body
 * it is willing to read. A 3xx is reported to the caller as a blocked URL — the `Location` header is
 * never read, so a redirect cannot be used to reach a destination the gate would have refused.
 */
export class McpOutboundFetcher {
  readonly #fetch: typeof globalThis.fetch;
  readonly #inFlight = new Map<string, number>();
  readonly #maxConcurrentPerAccount: number;
  readonly #maxResponseBytes: number;
  readonly #policy: McpOutboundPolicy;
  readonly #resolveAddresses: (hostname: string) => Promise<string[]>;
  readonly #timeoutMs: number;

  constructor(options: McpOutboundFetchOptions = { allowLoopback: false }) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxConcurrentPerAccount = options.maxConcurrentPerAccount ?? MCP_DEFAULT_MAX_CONCURRENT_PER_ACCOUNT;
    this.#maxResponseBytes = options.maxResponseBytes ?? MCP_DEFAULT_MAX_RESPONSE_BYTES;
    this.#policy = { allowLoopback: options.allowLoopback };
    this.#resolveAddresses = options.resolveAddresses ?? resolveAllAddresses;
    this.#timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  }

  /** The policy this fetcher enforces, for callers that must validate a URL before dialing it. */
  get policy(): McpOutboundPolicy {
    return this.#policy;
  }

  async fetchOutbound(accountId: string, rawUrl: string, init: McpFetchInit = {}): Promise<McpFetchResponse> {
    const url = assertOutboundUrl(rawUrl, this.#policy);
    /*
     * The counter is taken before resolving, not after. A DNS lookup is a network round trip the
     * Account asked for, so a hostile Server answering with many distinct names could otherwise spend
     * as many concurrent lookups as it liked while the counter sat at zero.
     */
    if ((this.#inFlight.get(accountId) ?? 0) >= this.#maxConcurrentPerAccount) {
      throw new McpServiceError(
        MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
        "Too many concurrent MCP requests for this Account",
      );
    }
    this.#inFlight.set(accountId, (this.#inFlight.get(accountId) ?? 0) + 1);
    try {
      await this.#assertPublicDestination(url);
      return await this.#perform(url, init);
    } finally {
      const remaining = (this.#inFlight.get(accountId) ?? 1) - 1;
      if (remaining <= 0) this.#inFlight.delete(accountId);
      else this.#inFlight.set(accountId, remaining);
    }
  }

  /** Refuses a hostname that resolves to a private address; see the shared address policy. */
  async #assertPublicDestination(url: URL): Promise<void> {
    const verdict = await classifyOutboundDestination(url, this.#resolveAddresses);
    if (!verdict.ok) throw errorForFailure(verdict.failure);
  }

  async #perform(url: URL, init: McpFetchInit): Promise<McpFetchResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const externalAbort = () => controller.abort();
    init.signal?.addEventListener("abort", externalAbort, { once: true });
    try {
      const response = await this.#fetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: REDIRECT_MODE,
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        // Never read or dial `Location`: the gate cannot approve a destination the peer chose.
        throw blocked("The MCP endpoint returned a redirect");
      }
      const text = await readBoundedBody(response, this.#maxResponseBytes);
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (error instanceof McpServiceError) throw error;
      throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "The MCP endpoint could not be reached", {
        cause: error instanceof Error ? error.name : typeof error,
      });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", externalAbort);
    }
  }
}

/**
 * Read at most `limit` bytes. The declared `Content-Length` is checked first so an oversized body is
 * refused without buffering it, and the stream is abandoned once the running total exceeds the bound
 * in case the declaration lied.
 */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_ERROR, "The MCP response body is too large");
  }
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_ERROR, "The MCP response body is too large");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
