import { z } from "zod";
import { runtimeByteString as byteString, runtimeUtf8Length } from "./runtime-config.js";

/**
 * Tavily web tools v1 wire authority (OpenTag side).
 *
 * Chain: Pi extension → trusted Runner/Client gateway (local Unix socket where supported; the
 * native Cloud sandbox uses the verified dedicated sandbox-exec duplex pipe, never a mounted
 * parent socket) → OpenTag Server (`POST /api/v1/runtime/web/search|fetch`, machine-token
 * authenticated, execution-fenced) → existing Router (`POST /v1/web/search|fetch`, tenant Bearer
 * key held only by the Server). Every object here is strict: unknown fields are rejected at each
 * hop and never forwarded. Nothing in this module carries a supplier key, a Router tenant id, or
 * a tenant key — those never cross the OpenTag wire.
 */

export const WEB_TOOLS_PROTOCOL_VERSION = 1 as const;

/** Fixed Server routes the trusted Runner calls. Callers cannot select another target. */
export const RUNTIME_WEB_SEARCH_PATH = "/api/v1/runtime/web/search" as const;
export const RUNTIME_WEB_FETCH_PATH = "/api/v1/runtime/web/fetch" as const;

/** Fixed trusted-gateway paths the Pi extension calls on the per-execution Unix socket. */
export const WEB_GATEWAY_SEARCH_PATH = "/web/search" as const;
export const WEB_GATEWAY_FETCH_PATH = "/web/fetch" as const;

/**
 * Remaining end-to-end budget header. Reconstructed by each trusted hop from its own clock,
 * never forwarded verbatim, and never part of the semantic request digest.
 */
export const WEB_TIMEOUT_HEADER = "x-web-timeout-ms" as const;

export const WEB_REQUEST_MAX_BYTES = 16 * 1024;
export const WEB_SEARCH_QUERY_MAX_CODEPOINTS = 400;
export const WEB_SEARCH_LIMIT_DEFAULT = 5;
export const WEB_SEARCH_LIMIT_MAX = 10;
export const WEB_SEARCH_DOMAINS_MAX = 10;
export const WEB_DOMAIN_MAX_BYTES = 253;
/** Router accepts 1..64 characters (English names such as `portuguese` are valid). */
export const WEB_LANGUAGE_MAX_CODEPOINTS = 64;
export const WEB_PUBLISHED_AT_MAX_BYTES = 128;
export const WEB_FETCH_URLS_MAX = 3;
export const WEB_URL_MAX_BYTES = 4 * 1024;
export const WEB_SEARCH_TIMEOUT_CAP_MS = 15_000;
export const WEB_FETCH_TIMEOUT_CAP_MS = 45_000;

/** Server↔Router and Runner↔Server serialized response bounds. */
export const WEB_SEARCH_RESPONSE_MAX_BYTES = 1024 * 1024;
export const WEB_FETCH_RESPONSE_MAX_BYTES = 3 * 1024 * 1024;

/** Model-facing budgets enforced by the Pi extension. */
export const WEB_TOOL_PREVIEW_PAGE_MAX_BYTES = 12 * 1024;
export const WEB_TOOL_RESULT_MAX_BYTES = 48 * 1024;
/** Per-page stored extracted-content bound (matches the Router response bound). */
export const WEB_PAGE_BODY_MAX_BYTES = 1024 * 1024;

/**
 * Idempotency namespace: the Server derives `opentag.web.v1:<executionId>:<toolCallId>`, which
 * is stable across retransmits of one logical tool call, printable ASCII, and ≤ 200 bytes.
 */
export const WEB_IDEMPOTENCY_NAMESPACE = "opentag.web.v1" as const;
export const WEB_IDEMPOTENCY_KEY_MAX_BYTES = 200;

export const WebToolDepthSchema = z.enum(["basic", "advanced"]);
export type WebToolDepth = z.infer<typeof WebToolDepthSchema>;

export const WebToolTimeRangeSchema = z.enum(["day", "week", "month", "year"]);
export type WebToolTimeRange = z.infer<typeof WebToolTimeRangeSchema>;

const isoDateTime = z.string().datetime({ offset: true });
const uuid = z.string().uuid();
const protocolVersion = z.literal(WEB_TOOLS_PROTOCOL_VERSION);

/** Router rejects raw control characters (and space) before URL parsing; WHATWG strips them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the Router contract rejects raw control characters before URL parsing.
const RAW_URL_CONTROL_RE = /[\u0000-\u0020\u007f]/;
/** Public dotted DNS name, at least two labels, 253-byte bound (mirrors the Router grammar). */
const ASCII_DOMAIN_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NUMERIC_HOST_RE = /^[0-9.]+$/;
const HEX_LABEL_RE = /^0x[0-9a-f]+$/;

/** ES2024 `String.prototype.isWellFormed` without depending on the newer lib target. */
function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
/** Well-known non-public DNS suffixes (RFC 2606/6762 plus common intranet TLDs). */
const INTERNAL_HOST_SUFFIXES = new Set([
  "localhost",
  "local",
  "internal",
  "lan",
  "corp",
  "home",
  "intranet",
  "test",
  "example",
  "invalid",
  "localdomain",
]);

/* --------------------------------- targets --------------------------------- */

/**
 * Static public-target check: http/https only, no embedded credentials, and a literal IP host
 * must be a public address. The raw string is checked for control characters before WHATWG URL
 * parsing (which silently strips them), and un-UTF-8-encodable strings are rejected instead of
 * being substituted. Hostname destinations are not resolved here — this is not DNS-rebinding
 * protection; the Router re-checks its own host policy. Rejects loopback, private, link-local,
 * CGNAT, multicast, documentation, and other reserved literal ranges for both IPv4 and IPv6
 * (including IPv4-mapped IPv6).
 */
export function parseWebTargetUrl(raw: string): URL | undefined {
  if (raw.length === 0 || runtimeUtf8Length(raw) > WEB_URL_MAX_BYTES) return undefined;
  if (!isWellFormedUnicode(raw) || RAW_URL_CONTROL_RE.test(raw)) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.username || url.password) return undefined;
  const hostname = url.hostname;
  if (!hostname) return undefined;
  const literal = decodeLiteralIp(hostname);
  if (literal) return isPublicLiteralAddress(literal) ? url : undefined;
  // Non-literal hosts are already IDNA/punycode-normalized lowercase by WHATWG.
  return isPublicDnsHostname(hostname) ? url : undefined;
}

/** Public dotted DNS name for a URL target; a trailing dot or single label is not accepted. */
function isPublicDnsHostname(hostname: string): boolean {
  if (hostname.endsWith(".")) return false;
  if (runtimeUtf8Length(hostname) > WEB_DOMAIN_MAX_BYTES) return false;
  if (NUMERIC_HOST_RE.test(hostname)) return false;
  for (const label of hostname.split(".")) {
    if (HEX_LABEL_RE.test(label)) return false;
  }
  if (!ASCII_DOMAIN_RE.test(hostname)) return false;
  const suffix = hostname.slice(hostname.lastIndexOf(".") + 1);
  return !INTERNAL_HOST_SUFFIXES.has(suffix);
}

/** Documented normalization for fetch dedup/result matching: lowercase scheme+host, drop the default port and the fragment. */
export function normalizeWebTargetUrl(raw: string): string | undefined {
  const url = parseWebTargetUrl(raw);
  if (!url) return undefined;
  url.hash = "";
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  return url.toString();
}

type Ipv4 = [number, number, number, number];
type Ipv6 = [number, number, number, number, number, number, number, number];
type LiteralAddress = { version: 4; parts: Ipv4 } | { version: 6; groups: Ipv6 };

/** Fixed-length tuple from already-validated values; the defaults never trigger. */
function toIpv4(values: number[]): Ipv4 {
  const [a = -1, b = -1, c = -1, d = -1] = values;
  return [a, b, c, d];
}

function toIpv6(values: number[]): Ipv6 {
  const [a = -1, b = -1, c = -1, d = -1, e = -1, f = -1, g = -1, h = -1] = values;
  return [a, b, c, d, e, f, g, h];
}

function decodeLiteralIp(hostname: string): LiteralAddress | undefined {
  const v4 = parseIpv4(hostname);
  if (v4) return { version: 4, parts: v4 };
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (!unbracketed.includes(":")) return undefined;
  const v6 = parseIpv6(unbracketed);
  return v6 ? { version: 6, groups: v6 } : undefined;
}

function parseIpv4(hostname: string): Ipv4 | undefined {
  if (!/^[0-9.]+$/.test(hostname)) return undefined;
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  const values: number[] = [];
  for (const part of parts) {
    const value = Number(part);
    // Reject non-canonical spellings (leading zeros) so octal/short forms never alias.
    if (!Number.isInteger(value) || value < 0 || value > 255 || String(value) !== part) return undefined;
    values.push(value);
  }
  return toIpv4(values);
}

function parseIpv6(hostname: string): Ipv6 | undefined {
  // A zone identifier is never a public destination.
  if (hostname.length === 0 || hostname.includes("%")) return undefined;
  return parseIpv6Groups(hostname);
}

function parseIpv6Groups(address: string): Ipv6 | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const head = parseIpv6Half(halves[0] ?? "");
  const tail = halves.length === 2 ? parseIpv6Half(halves[1] ?? "") : undefined;
  if (!head || (halves.length === 2 && !tail)) return undefined;
  if (halves.length === 1) return head.length === 8 ? toIpv6(head) : undefined;
  const missing = 8 - head.length - (tail?.length ?? 0);
  if (missing < 1) return undefined;
  return toIpv6([...head, ...Array<number>(missing).fill(0), ...(tail ?? [])]);
}

function parseIpv6Half(half: string): number[] | undefined {
  if (half === "") return [];
  const groups = half.split(":");
  const values: number[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.includes(".")) {
      // An IPv4 tail counts as two groups and must be last.
      if (index !== groups.length - 1) return undefined;
      const v4 = parseIpv4(group);
      if (!v4) return undefined;
      values.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
    values.push(Number.parseInt(group, 16));
  }
  return values;
}

function isPublicLiteralAddress(literal: LiteralAddress): boolean {
  if (literal.version === 4) return isPublicIpv4(literal.parts);
  const groups = literal.groups;
  if (isIpv4MappedGroups(groups)) {
    const g6 = groups[6];
    const g7 = groups[7];
    return isPublicIpv4(toIpv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]));
  }
  return !isReservedIpv6(groups);
}

/** IPv4-mapped and IPv4-compatible IPv6 inherit the IPv4 rules. */
function isIpv4MappedGroups([g0, g1, g2, g3, g4, g5]: Ipv6): boolean {
  return g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0);
}

function isReservedIpv6(groups: Ipv6): boolean {
  const [first] = groups;
  if (groups.every((group) => group === 0)) return true; // ::
  if (groups[7] === 1 && groups.slice(0, 7).every((group) => group === 0)) return true; // ::1
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return isReservedIpv6Assignment(groups);
}

function isReservedIpv6Assignment(groups: Ipv6): boolean {
  const [first, second, third, fourth] = groups;
  if (first === 0x0064 && second === 0xff9b && third === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (first === 0x0100 && second === 0 && third === 0 && fourth === 0) return true; // 100::/64 discard-only
  if (first === 0x2002) return true; // 2002::/16 6to4
  if (first === 0x3fff && (second & 0xf000) === 0) return true; // 3fff::/20 documentation
  if (first !== 0x2001) return false;
  if (second === 0x0db8) return true; // 2001:db8::/32 documentation
  return isReservedProtocolAssignment(groups);
}

/** 2001::/23 IETF protocol assignments, minus the publicly assigned exceptions. */
function isReservedProtocolAssignment(groups: Ipv6): boolean {
  const [, second, third] = groups;
  if ((second & 0xfe00) !== 0) return false;
  const publicException =
    (second === 1 &&
      third === 0 &&
      groups[3] === 0 &&
      groups[4] === 0 &&
      groups[5] === 0 &&
      groups[6] === 0 &&
      (groups[7] === 1 || groups[7] === 2)) ||
    second === 3 ||
    (second === 4 && third === 0x0112) ||
    (second & 0xfff0) === 0x0020 ||
    (second & 0xfff0) === 0x0030;
  return !publicException;
}

function isPublicIpv4(parts: Ipv4): boolean {
  return !isNonPublicIpv4(parts) && !isReservedIpv4(parts);
}

function isNonPublicIpv4([a, b]: Ipv4): boolean {
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  return a >= 224; // multicast + reserved (240/4, 255.255.255.255)
}

function isReservedIpv4([a, b, c, d]: Ipv4): boolean {
  // 192.0.0.0/24 is IETF protocol assignments except the two globally reachable anycast hosts.
  if (a === 192 && b === 0 && c === 0) return d !== 9 && d !== 10;
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 TEST-NET-2
  return a === 203 && b === 0 && c === 113; // 203.0.113.0/24 TEST-NET-3
}

/**
 * Public domain entry for search scoping: a plain host name, never a URL, wildcard, or
 * credential. Mirrors the Router grammar: lowercase, IDNA, trailing dots stripped, at least two
 * labels, 253-byte bound. Literal IP hosts and internal-style single labels are not accepted.
 */
export function parseWebDomain(raw: string): string | undefined {
  const lowered = normalizeWebDomainInput(raw);
  if (!lowered) return undefined;
  let url: URL;
  try {
    url = new URL(`https://${lowered}`);
  } catch {
    return undefined;
  }
  if (url.port || url.username || url.password) return undefined;
  const host = url.hostname;
  if (!host || decodeLiteralIp(host)) return undefined;
  if (runtimeUtf8Length(host) > WEB_DOMAIN_MAX_BYTES || !ASCII_DOMAIN_RE.test(host)) return undefined;
  return host;
}

/** Lowercase/IDNA input normalization shared by domain validation, mirroring the Router. */
function normalizeWebDomainInput(raw: string): string | undefined {
  if (raw.length === 0 || runtimeUtf8Length(raw) > WEB_DOMAIN_MAX_BYTES) return undefined;
  if (!isWellFormedUnicode(raw)) return undefined;
  const lowered = raw.toLowerCase();
  if (lowered !== raw.trim().toLowerCase()) return undefined;
  if (lowered.includes("*") || lowered.includes("@")) return undefined;
  // A bare host name never contains URL structure; IDNA names normalize to their punycode form.
  if (/[/:?#\\%]/.test(lowered)) return undefined;
  const stripped = lowered.replace(/\.+$/, "");
  return stripped.length > 0 ? stripped : undefined;
}

/* ------------------------------- parameters ------------------------------- */

const querySchema = z
  .string()
  .min(1)
  .superRefine((value, context) => {
    if (!isWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "The query must be valid Unicode" });
      return;
    }
    if ([...value].length > WEB_SEARCH_QUERY_MAX_CODEPOINTS) {
      context.addIssue({ code: "custom", message: "The query exceeds the 400-codepoint limit" });
    }
  });

const domainSchema = byteString(WEB_DOMAIN_MAX_BYTES, "A domain exceeds the 253-byte limit", 1).superRefine(
  (value, context) => {
    if (!parseWebDomain(value)) {
      context.addIssue({ code: "custom", message: "A domain must be a public host name" });
    }
  },
);

// Router accepts 1..64-character language strings (Tavily accepts English names such as
// `portuguese`), so this stays a bounded non-control string rather than a BCP-47 grammar.
const languageSchema = z.string().superRefine((value, context) => {
  if (!isWellFormedUnicode(value)) {
    context.addIssue({ code: "custom", message: "The language must be valid Unicode" });
    return;
  }
  if ([...value].length < 1 || [...value].length > WEB_LANGUAGE_MAX_CODEPOINTS) {
    context.addIssue({ code: "custom", message: "The language must be 1..64 characters" });
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the language field is a bounded non-control string.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    context.addIssue({ code: "custom", message: "The language must not contain control characters" });
  }
});

const targetUrlSchema = byteString(WEB_URL_MAX_BYTES, "A URL exceeds the 4 KiB limit", 1).superRefine(
  (value, context) => {
    if (!parseWebTargetUrl(value)) {
      context.addIssue({
        code: "custom",
        message: "A URL must be a public http(s) target without credentials or a non-public literal address",
      });
    }
  },
);

/** Business parameters shared by every hop; unknown fields are rejected. */
export const WebSearchParamsSchema = z
  .object({
    query: querySchema,
    limit: z.number().int().min(1).max(WEB_SEARCH_LIMIT_MAX).default(WEB_SEARCH_LIMIT_DEFAULT),
    domains: z.array(domainSchema).min(1).max(WEB_SEARCH_DOMAINS_MAX).optional(),
    timeRange: WebToolTimeRangeSchema.optional(),
    language: languageSchema.optional(),
    depth: WebToolDepthSchema.default("basic"),
  })
  .strict();
export type WebSearchParams = z.infer<typeof WebSearchParamsSchema>;

export const WebFetchParamsSchema = z
  .object({
    urls: z.array(targetUrlSchema).min(1).max(WEB_FETCH_URLS_MAX),
    depth: WebToolDepthSchema.default("basic"),
  })
  .strict();
export type WebFetchParams = z.infer<typeof WebFetchParamsSchema>;

/* ------------------------------ gateway plane ------------------------------ */

/** Extension → trusted gateway. The gateway injects the execution identity itself. */
export const WebGatewaySearchRequestSchema = z
  .object({ protocolVersion, toolCallId: uuid })
  .extend(WebSearchParamsSchema.shape)
  .strict();
export type WebGatewaySearchRequest = z.infer<typeof WebGatewaySearchRequestSchema>;

export const WebGatewayFetchRequestSchema = z
  .object({ protocolVersion, toolCallId: uuid })
  .extend(WebFetchParamsSchema.shape)
  .strict();
export type WebGatewayFetchRequest = z.infer<typeof WebGatewayFetchRequestSchema>;

/* ------------------------------- server plane ------------------------------ */

/** Trusted Runner → Server. Identity fields are fence-checked, never trusted as claims. */
export const WebSearchExecutionRequestSchema = z
  .object({ protocolVersion, executionId: uuid, toolCallId: uuid })
  .extend(WebSearchParamsSchema.shape)
  .strict();
export type WebSearchExecutionRequest = z.infer<typeof WebSearchExecutionRequestSchema>;

export const WebFetchExecutionRequestSchema = z
  .object({ protocolVersion, executionId: uuid, toolCallId: uuid })
  .extend(WebFetchParamsSchema.shape)
  .strict();
export type WebFetchExecutionRequest = z.infer<typeof WebFetchExecutionRequestSchema>;

/** Server → Router business payload: parameters only, no identity, tenant, or timeout fields. */
export const RouterWebSearchRequestSchema = WebSearchParamsSchema;
export const RouterWebFetchRequestSchema = WebFetchParamsSchema;

/* --------------------------------- results --------------------------------- */

export const WebSearchResultItemSchema = z
  .object({
    sourceId: byteString(128, "A source id exceeds the 128-byte limit", 1),
    title: byteString(2048, "A result title exceeds the 2 KiB limit"),
    url: byteString(WEB_URL_MAX_BYTES, "A result URL exceeds the 4 KiB limit", 1),
    snippet: byteString(8192, "A result snippet exceeds the 8 KiB limit"),
    publishedAt: byteString(WEB_PUBLISHED_AT_MAX_BYTES, "A published timestamp exceeds the 128-byte limit").optional(),
  })
  .strict();
export type WebSearchResultItem = z.infer<typeof WebSearchResultItemSchema>;

export const WebSearchResultSchema = z
  .object({
    requestId: byteString(128, "The request id exceeds the 128-byte limit", 1),
    status: z.literal("ok"),
    retrievedAt: isoDateTime,
    effectiveDepth: WebToolDepthSchema,
    results: z.array(WebSearchResultItemSchema).max(25),
  })
  .strict();
export type WebSearchResult = z.infer<typeof WebSearchResultSchema>;

/**
 * Wire fetch item. `artifactPath`/`artifactSaved`/`sha256` are extension-local additions made
 * only after a verified file write; they are never part of the Server/Router payload.
 */
export const WebFetchItemSuccessSchema = z
  .object({
    status: z.enum(["ok", "partial"]),
    url: byteString(WEB_URL_MAX_BYTES, "A fetch URL exceeds the 4 KiB limit", 1),
    finalUrl: byteString(WEB_URL_MAX_BYTES, "A final URL exceeds the 4 KiB limit").nullable(),
    contentKind: z.literal("extracted"),
    completeness: z.literal("unknown"),
    content: byteString(WEB_PAGE_BODY_MAX_BYTES, "A page body exceeds the 1 MiB limit"),
    sourceFetchedAt: byteString(64, "A source fetch timestamp exceeds the 64-byte limit").nullable(),
    previewTruncated: z.boolean(),
    artifactTruncated: z.boolean(),
    upstreamTruncated: z.boolean().nullable(),
  })
  .strict();
export type WebFetchItemSuccess = z.infer<typeof WebFetchItemSuccessSchema>;

export const WebFetchItemFailureSchema = z
  .object({
    status: z.literal("failed"),
    url: byteString(WEB_URL_MAX_BYTES, "A fetch URL exceeds the 4 KiB limit", 1),
    code: byteString(64, "A failure code exceeds the 64-byte limit", 1),
    retryable: z.boolean(),
  })
  .strict();
export type WebFetchItemFailure = z.infer<typeof WebFetchItemFailureSchema>;

export const WebFetchItemSchema = z.union([WebFetchItemSuccessSchema, WebFetchItemFailureSchema]);
export type WebFetchItem = z.infer<typeof WebFetchItemSchema>;

export const WebFetchResultSchema = z
  .object({
    requestId: byteString(128, "The request id exceeds the 128-byte limit", 1),
    status: z.enum(["ok", "partial", "failed"]),
    retrievedAt: isoDateTime,
    effectiveDepth: WebToolDepthSchema,
    results: z.array(WebFetchItemSchema).max(WEB_FETCH_URLS_MAX),
  })
  .strict();
export type WebFetchResult = z.infer<typeof WebFetchResultSchema>;

/* --------------------------------- errors ---------------------------------- */

export const WEB_TOOL_ERROR_CODES = [
  "invalid_request",
  "unauthenticated",
  "web_disabled",
  "execution_unknown",
  "execution_closed",
  "credential_scope_denied",
  "idempotency_conflict",
  "insufficient_credit",
  "request_in_progress",
  "request_uncertain",
  "rate_limited",
  "timeout",
  "aborted",
  "upstream_unavailable",
  "upstream_error",
  "provider_protocol_error",
  "response_too_large",
  "result_unavailable",
  "unknown",
] as const;
export const WebToolErrorCodeSchema = z.enum(WEB_TOOL_ERROR_CODES);
export type WebToolErrorCode = z.infer<typeof WebToolErrorCodeSchema>;

/** Bounded, redacted error envelope on every hop; upstream bodies are never echoed. */
export const WebToolErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: WebToolErrorCodeSchema,
        message: byteString(512, "The error message exceeds the 512-byte limit", 1),
        retryable: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type WebToolErrorEnvelope = z.infer<typeof WebToolErrorEnvelopeSchema>;

/** Existing Router GatewayError envelope (OpenAI-style), parsed defensively and never re-echoed. */
export const RouterGatewayErrorSchema = z
  .object({
    error: z
      .object({
        message: byteString(1024, "The Router error message exceeds the 1 KiB limit"),
        type: byteString(128, "The Router error type exceeds the 128-byte limit"),
        param: byteString(256, "The Router error parameter exceeds the 256-byte limit").nullish(),
        code: byteString(128, "The Router error code exceeds the 128-byte limit").nullish(),
        request_id: byteString(128, "The Router request id exceeds the 128-byte limit").optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type RouterGatewayError = z.infer<typeof RouterGatewayErrorSchema>;

/* ------------------------------ idempotency -------------------------------- */

/** Stable derived Idempotency-Key for one logical tool call; retransmits reuse it verbatim. */
export function deriveWebIdempotencyKey(input: { executionId: string; toolCallId: string }): string {
  const key = `${WEB_IDEMPOTENCY_NAMESPACE}:${input.executionId}:${input.toolCallId}`;
  if (runtimeUtf8Length(key) > WEB_IDEMPOTENCY_KEY_MAX_BYTES || !/^[\x20-\x7e]+$/.test(key)) {
    throw new Error("The derived web idempotency key violates the Router bounds");
  }
  return key;
}

/**
 * Remaining-budget rule shared by every hop: an absent budget means the operation's hard cap,
 * a finite positive budget is capped, and an explicitly invalid budget (0, negative, NaN,
 * Infinity, non-integer) fails closed to zero so it can never restart a full cap.
 */
export function capWebTimeoutMs(operation: "search" | "fetch", requestedMs: number | undefined): number {
  const cap = operation === "search" ? WEB_SEARCH_TIMEOUT_CAP_MS : WEB_FETCH_TIMEOUT_CAP_MS;
  if (requestedMs === undefined) return cap;
  if (!Number.isSafeInteger(requestedMs) || requestedMs < 1) return 0;
  return Math.min(requestedMs, cap);
}

/**
 * Strict header parse: at most seven ASCII digits and a positive value. `undefined` means the
 * header was absent; a malformed header also returns `undefined` so the caller rejects it as
 * invalid_request instead of turning it into a fresh full budget.
 */
export function parseWebTimeoutHeader(raw: string | undefined, operation: "search" | "fetch"): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,7}$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return capWebTimeoutMs(operation, value);
}

/* --------------------------- execution services ---------------------------- */

export const RUNTIME_WEB_SERVICE = "web" as const;
export const RuntimeWebServiceScopeSchema = z.enum(["web:search", "web:fetch"]);
export type RuntimeWebServiceScope = z.infer<typeof RuntimeWebServiceScopeSchema>;

/*
 * The execution-service request and grant schemas live in `./execution-services.ts`. They were
 * defined here while `web` was the only service; they are shared across every service now, so
 * keeping them in this module would have made each new service import from the web-tools contract.
 */

/** The scope each fixed route requires. */
export function webServiceScopeForOperation(operation: "search" | "fetch"): RuntimeWebServiceScope {
  return operation === "search" ? "web:search" : "web:fetch";
}
