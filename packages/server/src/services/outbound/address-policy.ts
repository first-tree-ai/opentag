import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The shared outbound address rules: what destination a deployment is willing to dial.
 *
 * The rules were written for the MCP feature and are extracted here because they are not about MCP.
 * Two callers now share them — the MCP outbound gate (`services/mcp/mcp-url-policy.ts`) and the
 * remote Skill source fetcher (`services/skills/source/source-fetcher.ts`) — and each keeps its own
 * vocabulary: this module returns a structured failure, and the caller turns it into the error type
 * its own domain already uses. That division is deliberate: a shared module that threw
 * `McpServiceError` would make one feature's error taxonomy another feature's dependency.
 *
 * What the rules cover, and what they deliberately do not, is unchanged from the MCP original:
 *
 * - Every address a hostname holds is judged (A and AAAA together), because a name with one public
 *   and one private address must be refused rather than admitted depending on resolver order.
 * - A request never follows a redirect: a 3xx is a refusal and its `Location` is never read, since
 *   the gate cannot approve a destination the peer chose.
 * - Pinning the validated address at the socket layer is still not attempted, so a name that
 *   resolves to a public address during validation and a private one at connect time (DNS
 *   rebinding) is not covered.
 */

/**
 * Every address a hostname holds, A and AAAA together.
 *
 * `all: true` because a single-record lookup would make the verdict depend on resolver order: a
 * name with one public and one private address must be refused, and checking only the first would
 * admit it whenever the public record came back first.
 */
export async function resolveAllAddresses(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** The request never follows a redirect: a 3xx is a refusal, and its `Location` is never read. */
export const REDIRECT_MODE = "manual" as const;

export interface OutboundAddressPolicy {
  /**
   * Whether plain HTTP to a loopback host is allowed at all. A deployment sets this only from an
   * explicit local-development opt-in, and never in a hosted environment: a hosted deployment's
   * `127.0.0.1` is the server's own loopback, so allowing it would hand every caller an internal
   * port scanner.
   */
  allowLoopback: boolean;
}

/**
 * Why a URL or a destination was refused.
 *
 * `invalid` and `blocked` are decisions about the URL the caller supplied; `unreachable` means the
 * URL is fine and the peer is missing — the distinction the MCP layer renders as
 * `MCP_SERVER_URL_INVALID`/`MCP_URL_BLOCKED` versus `MCP_UPSTREAM_UNAVAILABLE`.
 */
export type OutboundAddressFailure =
  | { kind: "invalid"; message: string }
  | { kind: "blocked"; message: string; detail?: Record<string, unknown> }
  | { kind: "unreachable"; host: string; cause?: string };

export type OutboundUrlVerdict = { ok: true; url: URL } | { ok: false; failure: OutboundAddressFailure };

/**
 * The address a caller should dial, when the URL named a host rather than a literal.
 *
 * A name can resolve differently a moment after it was judged, so a caller that wants the judgement
 * to hold has to connect to *this* address instead of resolving again. `family` is carried because
 * `net.connect`/`tls.connect` need it, and TLS still verifies the certificate against the hostname,
 * so pinning the address costs no identity check.
 */
export interface OutboundDestinationPin {
  address: string;
  family: number;
}

export type OutboundDestinationVerdict =
  | { ok: true; pin?: OutboundDestinationPin }
  | { ok: false; failure: OutboundAddressFailure };

function invalid(message: string): OutboundAddressFailure {
  return { kind: "invalid", message };
}

function blocked(message: string, detail?: Record<string, unknown>): OutboundAddressFailure {
  return { kind: "blocked", message, ...(detail === undefined ? {} : { detail }) };
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

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
  [ipv6RangeBase("fec0::", 10), 10, "fec0::/10"], // deprecated site-local, still unroutable
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

/**
 * The address as a 128-bit BigInt, or `undefined` when the spelling is not usable.
 *
 * BigInt rather than bitwise operators: JavaScript's `<<` and `|` coerce to 32 bits, so the
 * previous four-group packing discarded everything above the third group — `2001:db8::` read as
 * `::` and every address in the documentation block was judged by its *last* two groups instead of
 * its first. An address this cannot parse is treated as blocked by the caller, which is the safe
 * direction for a rule that decides what the deployment may reach.
 */
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

/** Whether an address literal is outside the public ranges, or is not a usable literal at all. */
export function isBlockedAddress(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  const family = isIP(bare);
  if (family === 4) return isBlockedIpv4(bare);
  if (family === 6) return isBlockedIpv6(bare);
  return false;
}

/**
 * Whether a hostname names the local machine.
 *
 * Exported so a module that must accept loopback plain HTTP for a local fixture — without adopting
 * the whole outbound policy — can ask the same question the policy asks, instead of re-deriving the
 * `.localhost` tree, the trailing dot, and the literal forms and getting one of them wrong.
 */
export function isLoopbackHost(hostname: string): boolean {
  return isLoopbackHostname(hostname);
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
 * Validate one outbound URL against every rule at once, returning a verdict rather than throwing so
 * each caller can raise its own error type.
 *
 * A loopback plain-HTTP URL is admitted only when the policy allows loopback — the local
 * development case where a CLI points at a fixture Server on `127.0.0.1`. Every other private,
 * link-local, reserved, or non-public destination is refused regardless of scheme, because an HTTPS
 * URL to `169.254.169.254` reaches the metadata service just as well.
 */
export function classifyOutboundUrl(rawUrl: string, policy: OutboundAddressPolicy): OutboundUrlVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, failure: invalid("The outbound URL is not a valid absolute URL") };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, failure: blocked("Only HTTPS outbound URLs are allowed", { scheme: url.protocol }) };
  }
  if (url.username || url.password) {
    return { ok: false, failure: blocked("An outbound URL may not carry credentials") };
  }
  if (url.hash) return { ok: false, failure: blocked("An outbound URL may not carry a fragment") };

  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:") {
    if (!loopback) return { ok: false, failure: blocked("Plain HTTP is only allowed for a loopback host") };
    if (!policy.allowLoopback) {
      return {
        ok: false,
        failure: blocked("Loopback plain HTTP is disabled on this deployment", { host: url.hostname }),
      };
    }
  }
  if (loopback) {
    // Loopback is a private destination by definition; the only path that admits it is the explicit
    // development opt-in above, already enforced for `http:` and re-checked here for `https:`.
    if (!policy.allowLoopback) {
      return {
        ok: false,
        failure: blocked("Loopback destinations are disabled on this deployment", { host: url.hostname }),
      };
    }
    return { ok: true, url };
  }
  if (isBlockedAddress(url.hostname)) {
    return {
      ok: false,
      failure: blocked("The outbound URL resolves to a non-public address", { host: url.hostname }),
    };
  }
  return { ok: true, url };
}

/**
 * Refuse a hostname that resolves to a private address.
 *
 * `classifyOutboundUrl` can only judge what the URL spells, and a hostname spells nothing about
 * where it points: `localtest.me` is public DNS that answers `127.0.0.1`, `metadata.google.internal`
 * is a split-horizon name, and a renamed `*.localhost` still lands on loopback. Since a probe or a
 * fetch stores and displays whatever answers, admitting these would make the gate's promise
 * ("non-public destinations are refused") untrue for the common case of a name rather than a
 * literal.
 *
 * Every A and AAAA record is checked, not just the first: a name with one public and one private
 * address would otherwise be admitted or refused depending on resolver order.
 *
 * The verdict carries the address to dial. A caller that ignores it (the MCP fetcher does, and says
 * so) keeps `resolve-then-dial` and the rebinding gap with it; a caller that uses it — the Skill
 * source transport and its git tunnel — closes that gap.
 */
export async function classifyOutboundDestination(
  url: URL,
  resolveAddresses: (hostname: string) => Promise<string[]> = resolveAllAddresses,
): Promise<OutboundDestinationVerdict> {
  const bare = url.hostname.replace(/^\[|\]$/g, "");
  // A literal was already judged by the URL rules, and a loopback literal only got here because the
  // deployment opted into loopback. A literal needs no pin: the URL already names the address.
  if (isIP(bare) !== 0) return { ok: true };
  if (isLoopbackHostname(bare)) return { ok: true };
  let addresses: string[];
  try {
    addresses = await resolveAddresses(bare);
  } catch (error) {
    // A name that does not resolve is an unreachable endpoint, not a blocked one: the caller's URL
    // is fine, the peer is missing. Reported as such so the UI says "could not be reached".
    return {
      ok: false,
      failure: { kind: "unreachable", host: bare, cause: error instanceof Error ? error.name : typeof error },
    };
  }
  const [first] = addresses;
  if (first === undefined) return { ok: false, failure: { kind: "unreachable", host: bare } };
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      return {
        ok: false,
        failure: blocked("The outbound URL resolves to a non-public address", { host: bare }),
      };
    }
  }
  return { ok: true, pin: { address: first, family: isIP(first) === 6 ? 6 : 4 } };
}
