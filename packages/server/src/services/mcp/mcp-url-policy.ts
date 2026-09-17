import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { MCP_ERROR_CODES } from "@opentag/shared";
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
async function resolveAllAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

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
export const MCP_DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MCP_DEFAULT_MAX_CONCURRENT_PER_ACCOUNT = 4;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function blocked(message: string, detail?: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.URL_BLOCKED, message, detail);
}

function invalid(message: string, detail?: Record<string, unknown>): McpServiceError {
  return new McpServiceError(MCP_ERROR_CODES.SERVER_URL_INVALID, message, detail);
}

/**
 * Non-public IPv4 ranges, as `[networkAddress, prefixLength]` in numeric form.
 *
 * A table rather than a chain of comparisons: the ranges are data, and adding one is a line rather
 * than a new branch. Anything matching any range is refused as a non-public destination.
 */
const BLOCKED_IPV4_RANGES: readonly (readonly [number, number])[] = [
  [0x00000000, 8], // 0/8 "this network"
  [0x0a000000, 8], // 10/8 private
  [0x64400000, 10], // 100.64/10 carrier-grade NAT
  [0x7f000000, 8], // 127/8 loopback
  [0xa9fe0000, 16], // 169.254/16 link-local, where cloud metadata lives
  [0xac100000, 12], // 172.16/12 private
  [0xc0000000, 24], // 192.0.0/24 IETF protocol assignments
  [0xc0a80000, 16], // 192.168/16 private
  [0xc6120000, 15], // 198.18/15 benchmarking
  [0xe0000000, 4], // 224/4 multicast
  [0xf0000000, 4], // 240/4 reserved, including 255.255.255.255
];

function ipv4ToNumber(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || part !== String(octet)) return undefined;
    value = (value << 8) | octet;
  }
  return value >>> 0;
}

function isBlockedIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  if (value === undefined) return true;
  return BLOCKED_IPV4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (value & mask) >>> 0 === network;
  });
}

/**
 * Non-public IPv6 destinations, as `[network as a 128-bit BigInt, prefix length, CIDR text]`.
 *
 * Only ranges with no public members are listed: `2001::/16` is deliberately absent because most of
 * it is routable, so only Teredo (`2001:0000::/32`) and the documentation block (`2001:db8::/32`)
 * are refused.
 *
 * The range lives as a BigInt rather than the leading 32 bits because a prefix shorter than 32 bits
 * is decided above them: `fc00::/7` is only correct if `fd00::` matches it too, which a truncated
 * network number cannot express.
 */
const BLOCKED_IPV6_RANGES: readonly (readonly [bigint, number, string])[] = [
  [ipv6RangeBase("::", 16), 16, "::/16"], // unspecified, loopback, and IPv4-mapped/NAT64 forms
  [ipv6RangeBase("64:ff9b::", 96), 32, "64:ff9b::/32"], // NAT64 well-known prefix
  [ipv6RangeBase("100::", 64), 64, "100::/64"], // discard-only
  [ipv6RangeBase("2001::", 32), 32, "2001::/32"], // Teredo
  [ipv6RangeBase("2001:db8::", 32), 32, "2001:db8::/32"], // documentation
  [ipv6RangeBase("fc00::", 7), 7, "fc00::/7"], // unique local
  [ipv6RangeBase("fe80::", 10), 10, "fe80::/10"], // link-local
  [ipv6RangeBase("ff00::", 8), 8, "ff00::/8"], // multicast
];

/** The 128-bit value of a CIDR base address, which the table above spells out in full. */
function ipv6RangeBase(address: string, prefix: number): bigint {
  const bits = ipv6Bits(address);
  if (bits === undefined) throw new Error(`Blocked IPv6 range ${address} is not a usable address`);
  return (bits >> BigInt(128 - prefix)) << BigInt(128 - prefix);
}

/**
 * The address as a 128-bit BigInt, or `undefined` when the spelling is not usable.
 *
 * BigInt rather than bitwise operators: JavaScript's `<<` and `|` coerce to 32 bits, so the
 * previous four-group packing discarded everything above the third group — `2001:db8::` read as
 * `::` and every address in the documentation block was judged by its *last* two groups instead of
 * its first. An address this cannot parse is treated as blocked by the caller, which is the safe
 * direction for a rule that decides what the Server may reach.
 */
/**
 * An IPv6 address's eight groups, or `undefined` when the spelling is not usable.
 *
 * Split out of {@link ipv6Bits} so each step stays readable: an IPv4 tail has to be folded into two
 * hex groups before the elision can be counted, and an address with no `::` must already be exactly
 * eight groups.
 */
function ipv6Groups(normalized: string): string[] | undefined {
  const [head, tail] = normalized.split("::");
  const headGroups = head === undefined || head === "" ? [] : head.split(":");
  if (tail === undefined) return headGroups.length === 8 ? headGroups : undefined;
  const tailGroups = tail === "" ? [] : tail.split(":");
  const elided = 8 - headGroups.length - tailGroups.length;
  // `::` must stand for at least one group; two elisions or an over-long address is unusable.
  if (elided < 1) return undefined;
  return [...headGroups, ...Array<string>(elided).fill("0"), ...tailGroups];
}

/** Folds a trailing dotted-quad into the two hex groups it stands for, or returns the input as-is. */
function expandEmbeddedIpv4(normalized: string): string | undefined {
  const embeddedIpv4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1];
  if (!embeddedIpv4) return normalized;
  const ipv4 = ipv4ToNumber(embeddedIpv4);
  if (ipv4 === undefined) return undefined;
  const head = normalized.slice(0, normalized.length - embeddedIpv4.length);
  return `${head}${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
}

function ipv6Bits(address: string): bigint | undefined {
  const normalized =
    address
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .split("%", 1)[0] ?? "";
  const text = expandEmbeddedIpv4(normalized);
  if (text === undefined) return undefined;
  const groups = ipv6Groups(text);
  if (groups === undefined) return undefined;
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    value = (value << 16n) | BigInt(Number.parseInt(group, 16));
  }
  return value;
}

function isBlockedIpv6(address: string): boolean {
  const value = ipv6Bits(address);
  if (value === undefined) return true;
  return BLOCKED_IPV6_RANGES.some(([network, prefix]) => {
    const shift = BigInt(128 - prefix);
    return value >> shift === network >> shift;
  });
}

function isBlockedAddress(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isBlockedIpv4(bare);
  if (family === 6) return isBlockedIpv6(bare);
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  // A trailing dot is the absolute form of the same name, so `localhost.` is `localhost`.
  const bare = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (LOOPBACK_HOSTNAMES.has(bare)) return true;
  // The specification reserves the whole `.localhost` tree for loopback, so `foo.localhost` is too.
  if (bare.endsWith(".localhost")) return true;
  return isIP(bare) === 4 && bare.startsWith("127.");
}

/**
 * Validate one outbound URL against every rule at once. Throws rather than returning a verdict so a
 * caller cannot forget to check the result.
 *
 * A loopback plain-HTTP URL is admitted only when the policy allows loopback — the local
 * development case where a CLI points at a fixture Server on `127.0.0.1`. Every other private,
 * link-local, reserved, or non-public destination is refused with `MCP_URL_BLOCKED` regardless of
 * scheme, because an HTTPS URL to `169.254.169.254` reaches the metadata service just as well.
 */
export function assertOutboundUrl(rawUrl: string, policy: McpOutboundPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw invalid("The outbound URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw blocked("Only HTTPS outbound URLs are allowed", { scheme: url.protocol });
  }
  if (url.username || url.password) throw blocked("An outbound URL may not carry credentials");
  if (url.hash) throw blocked("An outbound URL may not carry a fragment");

  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:") {
    if (!loopback) throw blocked("Plain HTTP is only allowed for a loopback host");
    if (!policy.allowLoopback) {
      throw blocked("Loopback plain HTTP is disabled on this deployment", { host: url.hostname });
    }
  }
  if (loopback) {
    // Loopback is a private destination by definition; the only path that admits it is the explicit
    // development opt-in above, already enforced for `http:` and re-checked here for `https:`.
    if (!policy.allowLoopback) {
      throw blocked("Loopback destinations are disabled on this deployment", { host: url.hostname });
    }
    return url;
  }
  if (isBlockedAddress(url.hostname)) {
    throw blocked("The outbound URL resolves to a non-public address", { host: url.hostname });
  }
  return url;
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
    await this.#assertPublicDestination(url);
    if ((this.#inFlight.get(accountId) ?? 0) >= this.#maxConcurrentPerAccount) {
      throw new McpServiceError(
        MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE,
        "Too many concurrent MCP requests for this Account",
      );
    }
    this.#inFlight.set(accountId, (this.#inFlight.get(accountId) ?? 0) + 1);
    try {
      return await this.#perform(url, init);
    } finally {
      const remaining = (this.#inFlight.get(accountId) ?? 1) - 1;
      if (remaining <= 0) this.#inFlight.delete(accountId);
      else this.#inFlight.set(accountId, remaining);
    }
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
    const bare = url.hostname.replace(/^\[|\]$/g, "");
    // A literal was already judged by `assertOutboundUrl`, and a loopback literal only got here
    // because the deployment opted into loopback.
    if (isIP(bare) !== 0) return;
    if (isLoopbackHostname(bare)) return;
    let addresses: string[];
    try {
      addresses = await this.#resolveAddresses(bare);
    } catch (error) {
      // A name that does not resolve is an unreachable endpoint, not a blocked one: the caller's
      // URL is fine, the peer is missing. Reported as such so the UI says "could not be reached".
      throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "The MCP endpoint could not be reached", {
        cause: error instanceof Error ? error.name : typeof error,
        host: bare,
      });
    }
    if (addresses.length === 0) {
      throw new McpServiceError(MCP_ERROR_CODES.UPSTREAM_UNAVAILABLE, "The MCP endpoint could not be reached", {
        host: bare,
      });
    }
    for (const address of addresses) {
      if (isBlockedAddress(address)) {
        throw blocked("The outbound URL resolves to a non-public address", { host: bare });
      }
    }
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
