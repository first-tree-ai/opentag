import { randomUUID } from "node:crypto";
import {
  MCP_AUTH_REJECTION_SUMMARY,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  type MCPErrorCode,
  type MCPProtocolEra,
} from "@opentag/shared";
import { boundedMcpSummary, MCP_ERROR_CODES, McpServiceError } from "./errors.js";
import type { McpFetchResponse, McpOutboundFetcher } from "./mcp-url-policy.js";

/**
 * The Streamable HTTP client for MCP 2026-07-28 plus the downgrade detection that keeps older
 * Servers usable.
 *
 * The modern protocol is stateless and per-request: there is no `initialize` handshake, no
 * `notifications/initialized`, and no session header. Every request carries its protocol version
 * twice — in the `MCP-Protocol-Version` HTTP header and in the body's `_meta` — and the two must
 * agree exactly or the Server answers `400 HeaderMismatch`. `server/discover` is how a client learns
 * a Server's supported versions, capabilities, identity, and instructions in one round trip.
 *
 * A response is either a single JSON object or a request-scoped SSE stream; both are supported.
 * Anything a reader cannot take as an answer to the request — an empty body, an HTML page, a JSON
 * value that is not an object, a stream that never carried the response — is a protocol failure,
 * never an empty result.
 */

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface McpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface McpJsonRpcResult {
  result?: unknown;
  error?: McpJsonRpcError;
  id?: string | number | null;
}

/** The JSON-RPC error code a Server uses when the request's protocol version is unacceptable. */
export const MCP_RPC_HEADER_MISMATCH = -32020;
export const MCP_RPC_MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;
export const MCP_RPC_METHOD_NOT_FOUND = -32601;
export const MCP_RPC_INVALID_PARAMS = -32602;

/** The declared protocol version and client capabilities every modern request's `_meta` carries. */
export const MCP_META_PROTOCOL_VERSION = "io.modelcontextprotocol/protocolVersion";
export const MCP_META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
export const MCP_META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
export const MCP_META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";

/** The required `Accept` value: both content types, exactly as the specification words it. */
export const MCP_ACCEPT_HEADER = "application/json, text/event-stream";

const NOTIFICATION_STATUS = 202;
const NO_CONTENT_STATUS = 204;

export class McpTransportError extends McpServiceError {
  readonly status: number | undefined;
  readonly rpcError: McpJsonRpcError | undefined;

  constructor(
    code: MCPErrorCode,
    message: string,
    status?: number,
    rpcError?: McpJsonRpcError,
    detail?: Record<string, unknown>,
  ) {
    super(code, message, detail);
    this.name = "McpTransportError";
    this.status = status;
    this.rpcError = rpcError;
  }

  /** A modern JSON-RPC error body, which is how a modern Server announces a version mismatch. */
  get isModernJsonRpcError(): boolean {
    return this.rpcError !== undefined;
  }

  /** The versions a modern Server listed as supported, when it told us. */
  get supportedVersions(): readonly string[] {
    const data = this.rpcError?.data;
    if (typeof data !== "object" || data === null) return [];
    const supported = (data as { supported?: unknown }).supported;
    if (!Array.isArray(supported)) return [];
    return supported.filter((value): value is string => typeof value === "string");
  }
}

export interface McpTransportOptions {
  /** The only permitted way to reach the network; see `mcp-url-policy.ts`. */
  fetcher: McpOutboundFetcher;
  /** Reported to the Server as this client's identity. */
  clientInfo?: { name: string; version: string };
  /** Sent as `Mcp-Name`-independent metadata on every request. */
  protocolVersion?: string;
}

export interface McpCallOptions {
  /** `params.name` for `tools/call`; required by the transport headers for those methods. */
  name?: string;
  /** Extra request headers beyond the authorization set (used for `Mcp-Param-*` extensions). */
  headers?: Record<string, string>;
  /**
   * The version `initialize` negotiated, for a legacy call.
   *
   * Only the legacy path sets this: `2025-06-18` and `2025-11-25` want `MCP-Protocol-Version` on
   * every request after the handshake, while `2025-03-26` predates the header and must not receive
   * one. The modern path stamps its own version unconditionally.
   */
  negotiatedVersion?: string;
  signal?: AbortSignal;
}

/**
 * Encode one transport header value. A non-ASCII value, and any ASCII value that merely *looks like*
 * the sentinel, must both be Base64 encoded, otherwise a value could be mistaken for an encoding.
 */
export function encodeHeaderValue(value: string): string {
  // Every UTF-16 code unit in the printable-ASCII range, which is what may travel raw.
  const isPrintableAscii = /^[\u0020-\u007e]*$/.test(value);
  if (isPrintableAscii && !value.startsWith("=?base64?")) return value;
  return `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

export function decodeHeaderValue(value: string): string {
  const match = /^=\?base64\?(.+)\?=$/.exec(value);
  return match?.[1] ? Buffer.from(match[1], "base64").toString("utf8") : value;
}

export class McpTransport {
  readonly #clientInfo: { name: string; version: string };
  readonly #fetcher: McpOutboundFetcher;
  readonly #protocolVersion: string;
  /**
   * The legacy revision this transport's `initialize` negotiated, if any.
   *
   * Resolved when the handshake returns, which is before any notification can be sent, so
   * `notifyLegacy` speaks the same revision as the request that follows it without either caller
   * having to resolve it early and pass it.
   */
  #negotiatedLegacyVersion: string | undefined;

  constructor(options: McpTransportOptions) {
    this.#clientInfo = options.clientInfo ?? { name: "opentag", version: "1" };
    this.#fetcher = options.fetcher;
    this.#protocolVersion = options.protocolVersion ?? MCP_MODERN_PROTOCOL_VERSION;
  }

  get protocolVersion(): string {
    return this.#protocolVersion;
  }

  /**
   * One modern JSON-RPC call. The url must already be approved by the policy; the fetcher re-checks
   * it, so a caller that forgot still cannot reach a blocked destination.
   */
  async call(
    accountId: string,
    url: string,
    method: string,
    params: Record<string, unknown> | undefined,
    authHeaders: Record<string, string>,
    options: McpCallOptions = {},
  ): Promise<unknown> {
    const id = randomUUID();
    const headers: Record<string, string> = {
      ...authHeaders,
      accept: MCP_ACCEPT_HEADER,
      "content-type": "application/json",
      "MCP-Protocol-Version": this.#protocolVersion,
      "Mcp-Method": encodeHeaderValue(method),
    };
    const name = options.name ?? paramsName(params);
    if (name !== undefined) headers["Mcp-Name"] = encodeHeaderValue(name);
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value;

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined
        ? {}
        : {
            params: {
              ...params,
              _meta: {
                [MCP_META_PROTOCOL_VERSION]: this.#protocolVersion,
                [MCP_META_CLIENT_CAPABILITIES]: {},
                [MCP_META_CLIENT_INFO]: this.#clientInfo,
                ...(isRecord(params._meta) ? params._meta : {}),
              },
            },
          }),
    });

    const response = await this.#fetcher.fetchOutbound(accountId, url, {
      method: "POST",
      headers,
      body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#interpret(accountId, url, method, id, response);
  }

  /**
   * One legacy JSON-RPC call, after `initialize` negotiated a pre-modern version.
   *
   * The legacy era is not one protocol. `2025-03-26` carries the version in the session alone, but
   * `2025-06-18` and `2025-11-25` — the newest legacy version this client advertises first — expect
   * `MCP-Protocol-Version` on every request after the handshake, and the specification says a missing
   * header defaults to `2025-03-26`. Sending the *modern* version (what {@link call} does) made a
   * strict server answer `400 Unsupported protocol version`; sending none happened to work only
   * because the SDK defaults, so a strict 2025-11-25 server would still refuse it.
   *
   * The negotiated version is therefore sent when the peer's era requires it, and omitted for
   * `2025-03-26`, which predates the header and would reject an unexpected one.
   */
  async callLegacy(
    accountId: string,
    url: string,
    method: string,
    params: Record<string, unknown> | undefined,
    authHeaders: Record<string, string>,
    options: McpCallOptions = {},
  ): Promise<unknown> {
    const id = randomUUID();
    const headers: Record<string, string> = {
      ...authHeaders,
      accept: MCP_ACCEPT_HEADER,
      "content-type": "application/json",
      ...legacyVersionHeaders(options.negotiatedVersion),
    };
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value;
    const response = await this.#fetcher.fetchOutbound(accountId, url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return this.#interpret(accountId, url, method, id, response);
  }

  /**
   * The legacy `initialize` handshake, used only after the modern path proved the Server is older.
   * The legacy protocol is session-based, so the session header from the response is returned.
   */
  async initialize(
    accountId: string,
    url: string,
    authHeaders: Record<string, string>,
    options: McpCallOptions = {},
  ): Promise<{ sessionId?: string; result: unknown }> {
    const id = randomUUID();
    const headers: Record<string, string> = {
      ...authHeaders,
      accept: MCP_ACCEPT_HEADER,
      "content-type": "application/json",
    };
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = value;
    const response = await this.#fetcher.fetchOutbound(accountId, url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: legacyVersionProbe(),
          capabilities: {},
          clientInfo: this.#clientInfo,
        },
      }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const result = await this.#interpret(accountId, url, "initialize", id, response);
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    /*
     * Only a version from the legacy list may be spoken on the legacy path: the supported set
     * includes the modern revision, and stamping it on a handshake-based session is the confusion
     * `#probeLegacy` and `#callLegacy` guard against.
     */
    const named = isRecord(result) ? result.protocolVersion : undefined;
    this.#negotiatedLegacyVersion =
      typeof named === "string" && MCP_LEGACY_PROTOCOL_VERSIONS.includes(named as never) ? named : undefined;
    return { ...(sessionId ? { sessionId } : {}), result };
  }

  /**
   * A legacy session-scoped notification (`notifications/initialized`).
   *
   * It closes the handshake, so a refusal is not ignorable: a notification carries no `id` and never
   * reaches {@link #interpret}, which leaves this status check as the only one it gets. Without it a
   * peer that answered `400`, `401` or `500` to the notification was still sent the `tools/call` or
   * `tools/list` that followed, and the refusal surfaced later as a confusing tool failure or as a
   * healthy-looking empty probe.
   *
   * The status maps through the same {@link upstreamFailure} as every other failed response, so the
   * reason stays bounded and credential-free: that summary is built from the status alone, never
   * from the peer's body. The fetcher has already read and bounded that body before returning, and
   * this method never interprets or exposes it. Status summaries therefore describe responses the
   * fetcher returned; a redirect or an oversized body fails inside the fetcher first, as its own
   * bounded error.
   */
  async notifyLegacy(
    accountId: string,
    url: string,
    method: string,
    authHeaders: Record<string, string>,
    sessionId?: string,
    options: McpCallOptions = {},
  ): Promise<void> {
    const response = await this.#fetcher.fetchOutbound(accountId, url, {
      method: "POST",
      headers: {
        ...authHeaders,
        accept: MCP_ACCEPT_HEADER,
        "content-type": "application/json",
        /* The notification speaks the revision the handshake negotiated, resolved by `initialize`:
         * `callLegacy` and `legacyVersionHeaders` hold the why, including the `2025-03-26` omission. */
        ...legacyVersionHeaders(options.negotiatedVersion ?? this.#negotiatedLegacyVersion),
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
        ...(options.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (response.status < 200 || response.status >= 300) throw upstreamFailure(response.status);
  }

  async #interpret(
    accountId: string,
    url: string,
    method: string,
    id: string,
    response: McpFetchResponse,
  ): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === NOTIFICATION_STATUS || response.status === NO_CONTENT_STATUS) {
      /*
       * `202` and `204` mean "acknowledged, nothing to answer", which the protocol defines for a
       * notification only. A request method answered this way delivered no result at all: `tools/call`,
       * `tools/list`, and `initialize` each require one, and accepting the acknowledgement reported a
       * Server that answered nothing as a success.
       */
      if (isNotificationMethod(method)) return undefined;
      throw invalidResponse(method, response.status, "an acknowledgement instead of a response");
    }

    if (contentType.includes("text/event-stream")) {
      return interpretSseResponse(response, method, parseSseResponse(response.text, id));
    }
    if (response.status === 404) {
      throw new McpTransportError(
        MCP_ERROR_CODES.TRANSPORT_UNSUPPORTED,
        "The MCP endpoint does not implement this method",
        response.status,
        rpcErrorOf(tryParseJson(response.text)),
      );
    }
    const parsed = tryParseJson(response.text);
    /*
     * A 2xx response that carries no JSON at all — an empty body, an HTML error page from a CDN or
     * a proxy, a truncated object — is a broken answer, not an empty result. Returning `undefined`
     * here made a probe report `probeState: "succeeded"` with zero tools and no error, and let a
     * gateway `tools/call` answer with a JSON-RPC envelope carrying no `result` at all, which
     * strands the client waiting for one. A JSON value that is not an object (an array, a string, a
     * number, `null`) is neither a JSON-RPC response nor a bare result object, so it fails the same
     * way.
     */
    if (parsed === undefined || !isRecord(parsed)) {
      throw unreadableBody(response, method, parsed === undefined);
    }
    const split = splitEnvelope(parsed);
    /*
     * A JSON-RPC error body is preserved as-is: it is how a modern Server reports an unsupported
     * protocol version, and the caller branches on its code to retry rather than downgrade. A member
     * that cannot be read is a protocol failure instead, so no caller has to defend against a body.
     */
    throwErrorMember(split.member, response.status, method);
    /*
     * A non-2xx status with a JSON body that is *not* a JSON-RPC envelope is a failure, not a result.
     * Without this, a gateway answering `401 {"message":"Unauthorized"}` or `500 {"detail":"…"}`
     * parsed as an object, carried no JSON-RPC `error`, and was returned as `payload.result` — which
     * the probe recorded as `probeState: "succeeded"` with zero tools and no error. The probe exists
     * to be evidence that the credential and the Server agree, so reporting a rejected credential as
     * a healthy empty Server is the one answer it must never give.
     */
    if (!isSuccess(response.status)) throw upstreamFailure(response.status);
    void accountId;
    void url;
    return unwrap(split.payload, response.status, method);
  }
}

/**
 * The result of a payload that already passed {@link throwErrorMember}.
 *
 * An envelope with neither `result` nor `error` is not an answer: an absent `result` key is not the
 * same as a present one — `"result": null` is a legitimate answer, and a body that omits the key is
 * indistinguishable from a truncated one.
 */
function unwrap(payload: McpJsonRpcResult, status: number, method: string): unknown {
  if (!("result" in payload)) {
    throw invalidResponse(method, status, "a response that is not a JSON-RPC response");
  }
  return payload.result;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * The failure for a body that is neither a JSON-RPC response nor a bare result object. A non-2xx
 * status keeps the plain upstream failure it already had; every other case is a protocol failure
 * that names the shape, because the body itself may carry an upstream stack trace or a credential.
 */
function unreadableBody(response: McpFetchResponse, method: string, unparsed: boolean): McpTransportError {
  if (!isSuccess(response.status)) return upstreamFailure(response.status);
  if (unparsed && isBlank(response.text)) return invalidResponse(method, response.status, "an empty response");
  return invalidResponse(
    method,
    response.status,
    unparsed ? "a response that is not valid JSON" : "a response that is not a JSON-RPC response",
  );
}

/**
 * A body the client cannot read as an answer. The HTTP status is the real one, so a caller that
 * classifies failures still reports what the peer sent rather than inventing a status; the reason
 * is a fixed phrase, so no upstream text — an HTML error page, a stack trace — reaches a message.
 */
function invalidResponse(method: string, status: number, reason: string): McpTransportError {
  return new McpTransportError(MCP_ERROR_CODES.UPSTREAM_ERROR, `The MCP Server returned ${reason}`, status, undefined, {
    method,
    status,
  });
}

/**
 * Interpret a `text/event-stream` response.
 *
 * Extracted from `#interpret` so the three rules it shares with the JSON branch stay readable
 * there: a JSON-RPC error is preserved so the caller can branch on its code, a stream that carried
 * no answer to the request is a protocol failure, and any other non-2xx status is a failure rather
 * than a result — otherwise a rejected credential reads as a healthy empty Server.
 */
function interpretSseResponse(
  response: McpFetchResponse,
  method: string,
  payload: McpJsonRpcResult | undefined,
): unknown {
  if (payload === undefined) {
    /*
     * A stream that ended without an answer to this request is a broken answer at any status. A
     * request-scoped stream exists to carry the response for the request that opened it, so
     * accepting an empty stream — no frames, only notifications, or only other ids — reported a
     * Server that answered nothing as a successful empty result.
     */
    if (!isSuccess(response.status)) throw upstreamFailure(response.status);
    throw invalidResponse(method, response.status, "a response stream with no answer to this request");
  }
  /*
   * Validate the error member before reading it. A stream carrying `"error": null` used to throw a
   * raw `TypeError` out of the transport instead of a controlled failure.
   */
  throwErrorMember(errorMemberOf(payload), response.status, method);
  if (!isSuccess(response.status)) throw upstreamFailure(response.status);
  return unwrap(payload, response.status, method);
}

/** The protocol defines any method under `notifications/` as needing no response at all. */
function isNotificationMethod(method: string): boolean {
  return method.startsWith("notifications/");
}

function upstreamFailure(status: number): McpTransportError {
  const message =
    status === 401 || status === 403 ? MCP_AUTH_REJECTION_SUMMARY : `The MCP Server returned HTTP ${status}`;
  return new McpTransportError(MCP_ERROR_CODES.UPSTREAM_ERROR, message, status, undefined, { status });
}

function paramsName(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  const name = params.name ?? params.uri;
  return typeof name === "string" ? name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParseJson(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function rpcErrorOf(parsed: unknown): McpJsonRpcError | undefined {
  if (!isRecord(parsed)) return undefined;
  const { member } = splitEnvelope(parsed);
  return member.kind === "error" ? member.error : undefined;
}

/** How a response's `error` member reads: absent, a usable error, or a present but unreadable one. */
type ErrorMember = { kind: "absent" } | { kind: "error"; error: McpJsonRpcError } | { kind: "malformed" };

/**
 * Read a response's `error` member.
 *
 * A present `error` must be an object with a numeric `code` and, when it carries one, a string
 * `message`. The body used to be trusted member by member, which threw a raw `TypeError` out of
 * `.message` for `"error": null` and silently rewrote a `code` of the wrong type to `-32602` — a
 * verdict the downgrade rules then read as the Server's own. An omitted `message` keeps the fixed
 * summary, because nothing branches on it; `code` is what a caller branches on, so it is required.
 */
function errorMemberOf(payload: McpJsonRpcResult): ErrorMember {
  if (!("error" in payload)) return { kind: "absent" };
  const raw: unknown = payload.error;
  if (!isRecord(raw)) return { kind: "malformed" };
  const { code, message, data } = raw;
  if (typeof code !== "number") return { kind: "malformed" };
  if (message !== undefined && typeof message !== "string") return { kind: "malformed" };
  return { kind: "error", error: { code, message: message ?? "", data } };
}

/**
 * Throw for an `error` member. A usable error keeps its own code and message so a caller can branch
 * on it — that is how a modern Server reports an unsupported protocol version — while a malformed
 * one is a protocol failure with a fixed message, never a `TypeError` and never a result.
 */
function throwErrorMember(member: ErrorMember, status: number, method: string): void {
  if (member.kind === "malformed") throw invalidResponse(method, status, "a malformed JSON-RPC error");
  if (member.kind === "absent") return;
  throw new McpTransportError(
    MCP_ERROR_CODES.UPSTREAM_ERROR,
    boundedMcpSummary(member.error.message || "The MCP Server returned a JSON-RPC error"),
    status,
    member.error,
    { method },
  );
}

/** A response body read into the shape the interpretation rules share. */
interface McpSplitEnvelope {
  payload: McpJsonRpcResult;
  member: ErrorMember;
}

/** Accept both a bare result object and a JSON-RPC envelope; the specification allows either shape. */
function splitEnvelope(parsed: unknown): McpSplitEnvelope {
  if (!isRecord(parsed)) return { payload: { result: parsed }, member: { kind: "absent" } };
  if (!("jsonrpc" in parsed) && !("result" in parsed) && !("error" in parsed)) {
    return { payload: { result: parsed }, member: { kind: "absent" } };
  }
  const payload = parsed as McpJsonRpcResult;
  return { payload, member: errorMemberOf(payload) };
}

/**
 * Read an SSE response until the response matching our request id arrives, skipping notifications and
 * unrelated ids. Returns `undefined` when the stream ended without one.
 */
export function parseSseResponse(text: string, requestId: string): McpJsonRpcResult | undefined {
  for (const frame of text.split(/\r?\n\r?\n/)) {
    for (const payload of sseFramePayloads(frame)) {
      if (!isRecord(payload)) continue;
      // A frame without an `id` is a notification, which is never this call's answer.
      if (!("id" in payload) || String(payload.id) !== requestId) continue;
      if ("result" in payload || "error" in payload) return splitEnvelope(payload).payload;
    }
  }
  return undefined;
}

/** The JSON values a single SSE frame carries; a frame may join its data lines or carry a batch. */
function sseFramePayloads(frame: string): unknown[] {
  const dataLines = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (dataLines.length === 0) return [];
  const parsed = tryParseJson(dataLines.join("\n"));
  if (parsed === undefined) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * Pick the version to speak from a Server's advertised set. The newest version this client knows
 * wins; a Server that advertises none this client supports is a protocol failure, never a silent
 * downgrade to something else.
 */
export function negotiateProtocolVersion(supported: readonly string[]): string {
  if (supported.includes(MCP_MODERN_PROTOCOL_VERSION)) return MCP_MODERN_PROTOCOL_VERSION;
  for (const candidate of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
    if (supported.includes(candidate)) return candidate;
  }
  throw new McpTransportError(
    MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED,
    "The MCP Server supports no protocol version this client speaks",
    undefined,
    undefined,
    { supported: supported.slice(0, 8) },
  );
}

function legacyVersionProbe(): string {
  return MCP_LEGACY_PROTOCOL_VERSIONS[0];
}

/**
 * The version header a legacy request needs, if any.
 *
 * `2025-03-26` predates `MCP-Protocol-Version` entirely, so it gets none; every later legacy version
 * expects the negotiated value on each request after the handshake.
 */
function legacyVersionHeaders(negotiated: string | undefined): Record<string, string> {
  if (negotiated === undefined || negotiated === "2025-03-26") return {};
  return { "MCP-Protocol-Version": negotiated };
}

/**
 * Decide the era from a response status and body, exactly as the specification's interoperability
 * rule words it. On `400`/`404`/`405` the body is inspected first:
 *
 * - A recognizable modern JSON-RPC error means the peer is a modern Server; the caller retries with
 *   a version from `supported` and must **not** downgrade.
 * - Anything else means the peer predates this client, so `initialize` is the only way forward.
 */
export type McpEraDetection = { era: "modern"; retryWithVersions: readonly string[] } | { era: "legacy" };

/**
 * The MCP-registered error codes only a modern Server emits. A generic JSON-RPC error is not one of
 * them: an older Server also answers `-32601` for a method it does not know, so treating that as a
 * modern signal would retry forever instead of falling back once.
 *
 * Zoom's MCP Server shows the other half of that: it answers `server/discover` with `-32601` at a
 * status outside 400/404/405 (the body lists `server/discover` as valid, yet rejects it). The status
 * gate alone read that as a modern peer and never reached `initialize`, so `-32601` decides the era
 * on its own in `detectEraFromRpcError`. Use that only on a read such as `server/discover`: the
 * gateway excludes `-32601` from its replay rule because a `tools/call` can raise it from inside the
 * tool.
 */
const MODERN_ERA_ERROR_CODES = new Set([
  MCP_RPC_HEADER_MISMATCH,
  MCP_RPC_MISSING_REQUIRED_CLIENT_CAPABILITY,
  MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION,
]);

export function detectEraFromFailure(status: number, bodyText: string): McpEraDetection {
  return detectEraFromRpcError(status, rpcErrorOf(tryParseJson(bodyText)));
}

/**
 * The same rule, for a caller that already parsed the envelope. A `400`/`404`/`405` whose body is a
 * recognizable modern JSON-RPC error is a modern peer telling us to retry with a different version;
 * any other body at those statuses is a peer that predates the modern model. `-32601` is legacy at
 * any status, because a peer that does not know the discovery method predates it.
 */
export function detectEraFromRpcError(status: number, error: McpJsonRpcError | undefined): McpEraDetection {
  if (error?.code === MCP_RPC_METHOD_NOT_FOUND) return { era: "legacy" };
  if (status !== 400 && status !== 404 && status !== 405) return { era: "modern", retryWithVersions: [] };
  if (!error || !MODERN_ERA_ERROR_CODES.has(error.code)) return { era: "legacy" };
  if (error.code !== MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION) return { era: "modern", retryWithVersions: [] };
  const supported = (error.data as { supported?: unknown } | undefined)?.supported;
  const versions = Array.isArray(supported)
    ? supported.filter((value): value is string => typeof value === "string")
    : [];
  return { era: "modern", retryWithVersions: versions };
}

/** Whether a failure invalidates a cached origin era (specification: re-detect when the cache assumption fails). */
export function invalidatesProtocolEra(error: unknown): boolean {
  if (!(error instanceof McpTransportError)) return false;
  if (error.code === MCP_ERROR_CODES.PROTOCOL_UNSUPPORTED) return true;
  if (error.code === MCP_ERROR_CODES.TRANSPORT_UNSUPPORTED) return true;
  const rpcCode = error.rpcError?.code;
  return rpcCode === MCP_RPC_UNSUPPORTED_PROTOCOL_VERSION || rpcCode === MCP_RPC_METHOD_NOT_FOUND;
}
/** A cached era's spellings, for a probe that already knows which era the origin speaks. */
export const MCP_ERAS: readonly MCPProtocolEra[] = ["modern", "legacy"];
