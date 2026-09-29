/**
 * The pure outbound-URL rules for MCP endpoints.
 *
 * Two callers need exactly the same verdict: the Server's outbound gate
 * (`packages/server/src/services/mcp/mcp-url-policy.ts`), which refuses to dial a destination, and
 * build-time tooling, which must reject a bad endpoint before it ships in the marketplace catalog.
 * Keeping the rules here means neither can drift from the other.
 *
 * This module is deliberately dependency-free and Node-free: it ships in the browser build and is
 * loaded by a type-stripping Node script, so it may use no Node builtin — in particular no `isIP`
 * from `node:net`.
 *
 * Name resolution is *not* here. A hostname that merely resolves to a private address is refused at
 * request time by the Server's fetcher, which is the only layer that can resolve.
 */

/** The policy inputs these rules depend on. */
export interface McpOutboundUrlPolicy {
  /**
   * Whether loopback destinations are permitted at all. True only for the local development
   * fixture; a hosted deployment's `127.0.0.1` is the Server's own loopback.
   */
  allowLoopback: boolean;
}

/**
 * Why a URL is not a permitted outbound destination. `invalid` is reported separately from `blocked`
 * because a malformed URL is the caller's input error, not a refused destination.
 */
export type McpOutboundUrlFailureKind = "invalid" | "blocked";

export interface McpOutboundUrlFailure {
  kind: McpOutboundUrlFailureKind;
  message: string;
  detail?: Record<string, unknown>;
}

/** The parsed URL, or the reason it was refused. */
export type McpOutboundUrlResult = { url: URL } | { failure: McpOutboundUrlFailure };

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
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

/** The dotted-quad's numeric value, or `undefined` when the spelling is not a strict IPv4 literal. */
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
 * Non-public IPv6 destinations, as `[network as a 128-bit BigInt, prefix length]`.
 *
 * Only ranges with no public members are listed: `2001::/16` is deliberately absent because most of
 * it is routable, so only Teredo (`2001:0000::/32`) and the documentation block (`2001:db8::/32`)
 * are refused.
 *
 * The range lives as a BigInt rather than the leading 32 bits because a prefix shorter than 32 bits
 * is decided above them: `fc00::/7` is only correct if `fd00::` matches it too, which a truncated
 * network number cannot express.
 */
const BLOCKED_IPV6_RANGES: readonly (readonly [bigint, number])[] = [
  [ipv6RangeBase("::", 16), 16], // unspecified, loopback, and IPv4-mapped/NAT64 forms
  [ipv6RangeBase("64:ff9b::", 96), 32], // NAT64 well-known prefix
  [ipv6RangeBase("100::", 64), 64], // discard-only
  [ipv6RangeBase("2001::", 32), 32], // Teredo
  [ipv6RangeBase("2001:db8::", 32), 32], // documentation
  [ipv6RangeBase("fc00::", 7), 7], // unique local
  [ipv6RangeBase("fec0::", 10), 10], // deprecated site-local, still unroutable
  [ipv6RangeBase("fe80::", 10), 10], // link-local
  [ipv6RangeBase("ff00::", 8), 8], // multicast
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
 * BigInt rather than bitwise operators: JavaScript's `<<` and `|` coerce to 32 bits, so a four-group
 * packing discards everything above the third group — `2001:db8::` would read as `::` and every
 * address in the documentation block would be judged by its *last* two groups instead of its first.
 * An address this cannot parse is treated as blocked by the caller, which is the safe direction for
 * a rule that decides what the Server may reach.
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

/**
 * Whether the text is an IPv6 literal, decided without `node:net`.
 *
 * A colon is required first so a dotted-quad is never fed to the IPv6 parser, and an address the
 * parser cannot read is not treated as a literal — which sends it to name resolution instead, the
 * same place `isIP() === 0` sent it.
 */
function isIpv6Literal(address: string): boolean {
  return address.includes(":") && ipv6Bits(address) !== undefined;
}

/**
 * Whether the text is an IP literal of either family.
 *
 * The Server's fetcher uses this to decide whether a host still needs resolution: a literal was
 * already judged by {@link checkOutboundUrl}.
 */
export function isIpLiteral(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  return ipv4ToNumber(bare) !== undefined || isIpv6Literal(bare);
}

/** Whether an address belongs to a non-public range. A literal that cannot be parsed is blocked. */
export function isBlockedAddress(hostname: string): boolean {
  const bare = stripBrackets(hostname);
  const familyV4 = ipv4ToNumber(bare) !== undefined;
  if (familyV4) return isBlockedIpv4(bare);
  if (isIpv6Literal(bare)) return isBlockedIpv6(bare);
  return false;
}

/**
 * Whether a hostname names the local machine.
 *
 * A trailing dot is the absolute form of the same name, so `localhost.` is `localhost`, and the
 * specification reserves the whole `.localhost` tree for loopback, so `foo.localhost` is too.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = stripBrackets(hostname).toLowerCase().replace(/\.$/, "");
  if (LOOPBACK_HOSTNAMES.has(bare)) return true;
  if (bare.endsWith(".localhost")) return true;
  return isBlockedIpv4Range127(bare);
}

/** `127.0.0.0/8`, the loopback range a dotted-quad can spell. */
function isBlockedIpv4Range127(bare: string): boolean {
  return ipv4ToNumber(bare) !== undefined && bare.startsWith("127.");
}

/**
 * Validate one outbound URL against every rule at once, returning the parsed URL or the reason it
 * was refused.
 *
 * A loopback plain-HTTP URL is admitted only when the policy allows loopback — the local
 * development case where a CLI points at a fixture Server on `127.0.0.1`. Every other private,
 * link-local, reserved, or non-public destination is refused regardless of scheme, because an HTTPS
 * URL to `169.254.169.254` reaches the metadata service just as well.
 */
export function checkOutboundUrl(rawUrl: string, policy: McpOutboundUrlPolicy): McpOutboundUrlResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return refused("invalid", "The outbound URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return refused("blocked", "Only HTTPS outbound URLs are allowed", { scheme: url.protocol });
  }
  if (url.username || url.password) return refused("blocked", "An outbound URL may not carry credentials");
  if (url.hash) return refused("blocked", "An outbound URL may not carry a fragment");

  const loopback = isLoopbackHostname(url.hostname);
  if (url.protocol === "http:") {
    if (!loopback) return refused("blocked", "Plain HTTP is only allowed for a loopback host");
    if (!policy.allowLoopback) {
      return refused("blocked", "Loopback plain HTTP is disabled on this deployment", { host: url.hostname });
    }
  }
  if (loopback) {
    // Loopback is a private destination by definition; the only path that admits it is the explicit
    // development opt-in above, already enforced for `http:` and re-checked here for `https:`.
    if (!policy.allowLoopback) {
      return refused("blocked", "Loopback destinations are disabled on this deployment", { host: url.hostname });
    }
    return { url };
  }
  if (isBlockedAddress(url.hostname)) {
    return refused("blocked", "The outbound URL resolves to a non-public address", { host: url.hostname });
  }
  return { url };
}

function refused(
  kind: McpOutboundUrlFailureKind,
  message: string,
  detail?: Record<string, unknown>,
): McpOutboundUrlResult {
  return { failure: { kind, message, detail } };
}
