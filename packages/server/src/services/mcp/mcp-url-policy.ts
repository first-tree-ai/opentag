import { checkOutboundUrl, isLoopbackHostname, MCP_ERROR_CODES } from "@opentag/shared";
import { withOutboundDeadline } from "../outbound/deadline.js";
import { classifyOutboundDestination, resolveAllAddresses } from "../outbound/destination-policy.js";
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
 * Invariant of one call: it settles within `timeoutMs` of entry, its connection is closed however it
 * ends, and it holds one concurrency slot for exactly as long as it runs. The deadline therefore
 * covers the address check as well as the request — see `#request` — and every rejection path
 * releases the body it refuses rather than leaving the peer writing into a socket nobody reads.
 *
 * Deliberately not attempted: pinning the validated address at the socket layer, which would also
 * close DNS rebinding (a name that resolves to a public address during validation and a private one
 * at connect time). The resolution check below is at least the half that stops the ordinary cases:
 * a public name that simply points at `127.0.0.1`, and the split-horizon names. See
 * `McpOutboundFetcher.#assertPublicDestination` for the upgrade path.
 */

/**
 * Every address a hostname holds, A and AAAA together.
 *
 * `all: true` because a single-record lookup would make the verdict depend on resolver order: a
 * name with one public and one private address must be refused, and checking only the first would
 * admit it whenever the public record came back first.
 */
/** The request never follows a redirect: a 3xx is a refusal, and its `Location` is never read. */
const REDIRECT_MODE = "manual" as const;

export interface McpOutboundPolicy {
  /**
   * Whether plain HTTP to a loopback host is allowed at all. The server sets this only from
   * `OPENTAG_MCP_ALLOW_LOOPBACK` and only in a non-hosted environment; in a hosted environment it
   * is always false. A hosted deployment's `127.0.0.1` is the server's own loopback, so allowing it
   * would hand every Account an internal port scanner.
   */
  allowLoopback: boolean;
  /** Per-operation deadline, covering the address check and the request it authorizes. */
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

function invalid(message: string, detail?: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.SERVER_URL_INVALID, message, detail);
}

/**
 * "No usable answer" — a missing peer, an expired deadline, or a cancelled call. The detail says
 * which, because the three are the same code and a different operator fix.
 */
function unreachable(detail?: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "The MCP endpoint could not be reached", detail);
}

/**
 * Whether a hostname names the local machine.
 *
 * Exported so a module that must accept loopback plain HTTP for the local fixture — without adopting
 * the whole outbound policy — can ask the same question the policy asks, instead of re-deriving the
 * `.localhost` tree, the trailing dot, and the literal forms and getting one of them wrong.
 */
export function isLoopbackHost(hostname: string): boolean {
  return isLoopbackHostname(hostname);
}

/**
 * Validate one outbound URL against every rule at once. Throws rather than returning a verdict so a
 * caller cannot forget to check the result.
 *
 * The rules themselves live in `@opentag/shared` (`mcp-outbound-url.ts`) because build-time tooling
 * must apply the same ones to the marketplace catalog without depending on a built Server. This
 * function only maps their verdict onto this feature's error vocabulary.
 */
export function assertOutboundUrl(rawUrl: string, policy: McpOutboundPolicy): URL {
  const result = checkOutboundUrl(rawUrl, { allowLoopback: policy.allowLoopback });
  if ("failure" in result) {
    const { kind, message, detail } = result.failure;
    throw kind === "invalid" ? invalid(message, detail) : blocked(message, detail);
  }
  return result.url;
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
     * A call the caller cancelled before entry is refused here. `fetch` would refuse to start it
     * too, but only after a body was assembled and a slot taken, and the answer would say the peer
     * was unreachable when nothing was ever sent.
     */
    if (init.signal?.aborted === true) throw unreachable({ cause: "aborted" });
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
      return await this.#request(url, init);
    } finally {
      const remaining = (this.#inFlight.get(accountId) ?? 1) - 1;
      if (remaining <= 0) this.#inFlight.delete(accountId);
      else this.#inFlight.set(accountId, remaining);
    }
  }

  /**
   * The address check and the request, under one deadline and one cancellation.
   *
   * The budget covers the resolver too, which is the whole point: a lookup the Account asked for is
   * part of the call, so it cannot be free of the deadline that bounds it, and a held resolver must
   * not keep a concurrency slot for the transport's whole budget. The slot is released by
   * `fetchOutbound` when this settles, which is at the deadline rather than after the resolver.
   */
  #request(url: URL, init: McpFetchInit): Promise<McpFetchResponse> {
    return withOutboundDeadline(
      {
        timeoutMs: this.#timeoutMs,
        ...(init.signal === undefined ? {} : { signal: init.signal }),
        failure: (reason) => unreachable({ cause: reason }),
      },
      async (deadline) => {
        await this.#assertPublicDestination(url);
        // The resolver cannot be interrupted, so it may answer after this call already failed. No
        // request may follow it: that would spend the Account's slot on a call nobody is waiting for.
        deadline.throwIfEnded();
        return this.#perform(url, init, deadline.signal);
      },
    );
  }

  /**
   * Refuse a hostname that resolves to a private address.
   *
   * `assertOutboundUrl` can only judge what the URL spells, and a hostname spells nothing about where
   * it points: `localtest.me` is public DNS that answers `127.0.0.1`, `metadata.google.internal` is a
   * split-horizon name, and a renamed `*.localhost` still lands on loopback. Since the probe stores
   * and displays whatever answers — instructions, capabilities, and tool lists — plus any extra
   * headers the Account configured, admitting these made the gate's promise ("non-public
   * destinations are refused") untrue for the common case of a name rather than a literal.
   *
   * Every A and AAAA record is checked, not just the first: a name with one public and one private
   * address would otherwise be admitted or refused depending on resolver order.
   *
   * ponytail: resolve-then-dial, so a record that changes between this lookup and the connection
   * (DNS rebinding) is not covered. Closing that needs the connection pinned to the validated
   * address, which Node's `fetch` cannot express without adding an undici `Agent` with a custom
   * `connect.lookup`. Add it when a deployment faces a hostile resolver rather than a hostile Server.
   */
  async #assertPublicDestination(url: URL): Promise<void> {
    /*
     * The resolution rules are shared with the Skill source transport, so there is one answer to
     * "does this name point somewhere private". This method only renders that answer in MCP's own
     * vocabulary; the verdict's pin is deliberately unused here, which is the rebinding gap the note
     * above describes.
     */
    const verdict = await classifyOutboundDestination(url, this.#resolveAddresses);
    if (verdict.ok) return;
    if (verdict.failure.kind === "unreachable") {
      throw unreachable({
        ...(verdict.failure.cause === undefined ? {} : { cause: verdict.failure.cause }),
        host: verdict.failure.host,
      });
    }
    throw blocked("The outbound URL resolves to a non-public address", { host: verdict.failure.host });
  }

  async #perform(url: URL, init: McpFetchInit, signal: AbortSignal): Promise<McpFetchResponse> {
    try {
      const response = await this.#fetch(url, {
        method: init.method ?? "GET",
        headers: init.headers,
        body: init.body,
        redirect: REDIRECT_MODE,
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        // Never read or dial `Location`: the gate cannot approve a destination the peer chose.
        await discardBody(response);
        throw blocked("The MCP endpoint returned a redirect");
      }
      const text = await readBoundedBody(response, this.#maxResponseBytes);
      return { status: response.status, headers: response.headers, text };
    } catch (error) {
      if (error instanceof McpServiceError) throw error;
      throw unreachable({ cause: error instanceof Error ? error.name : typeof error });
    }
  }
}

/**
 * Close a response body this call will not read.
 *
 * An unread body keeps the connection — and everything the peer is still sending — alive until the
 * peer stops or the process does. The caller has already refused the answer, so there is nothing to
 * wait for: cancelling the stream closes the socket, while draining it would bill this deployment
 * for the bytes of a body it decided not to use.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or errored: nothing is left to release.
  }
}

/**
 * Read at most `limit` bytes. The declared `Content-Length` is checked first so an oversized body is
 * refused without buffering it, and the stream is abandoned once the running total exceeds the bound
 * in case the declaration lied. Both refusals close the body rather than read it, for the reason in
 * {@link discardBody}.
 */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) {
    await discardBody(response);
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
