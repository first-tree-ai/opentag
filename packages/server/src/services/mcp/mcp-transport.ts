import { randomUUID } from "node:crypto";
import {
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
    return { ...(sessionId ? { sessionId } : {}), result };
  }

  /** A legacy session-scoped notification (`notifications/initialized`). */
  async notifyLegacy(
    accountId: string,
    url: string,
    method: string,
    authHeaders: Record<string, string>,
    sessionId?: string,
  ): Promise<void> {
    await this.#fetcher.fetchOutbound(accountId, url, {
      method: "POST",
      headers: {
        ...authHeaders,
        accept: MCP_ACCEPT_HEADER,
        "content-type": "application/json",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method }),
    });
  }

  async #interpret(
    accountId: string,
    url: string,
    method: string,
    id: string,
    response: McpFetchResponse,
  ): Promise<unknown> {
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === NOTIFICATION_STATUS || response.status === NO_CONTENT_STATUS) return undefined;

    if (contentType.includes("text/event-stream")) {
      const payload = parseSseResponse(response.text, id);
      if (payload === undefined) return undefined;
      return unwrap(payload, response.status);
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
    if (parsed === undefined) {
      if (response.status >= 200 && response.status < 300) return undefined;
      throw upstreamFailure(response.status);
    }
    const { payload, error } = splitEnvelope(parsed);
    /*
     * A JSON-RPC error body is preserved as-is: it is how a modern Server reports an unsupported
     * protocol version, and the caller branches on its code to retry rather than downgrade.
     */
    if (error) {
      throw new McpTransportError(
        MCP_ERROR_CODES.UPSTREAM_ERROR,
        boundedMcpSummary(error.message || "The MCP Server returned a JSON-RPC error"),
        response.status,
        error,
        { method },
      );
    }
    void accountId;
    void url;
    return unwrap(payload, response.status);
  }
}

function unwrap(payload: McpJsonRpcResult, status: number): unknown {
  if (payload.error !== undefined) {
    throw new McpTransportError(
      MCP_ERROR_CODES.UPSTREAM_ERROR,
      boundedMcpSummary(payload.error.message || "The MCP Server returned a JSON-RPC error"),
      status,
      payload.error,
      { status },
    );
  }
  return payload.result;
}

function upstreamFailure(status: number): McpTransportError {
  const message =
    status === 401 || status === 403
      ? "The MCP Server refused this credential"
      : `The MCP Server returned HTTP ${status}`;
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
  return splitEnvelope(parsed).error;
}

/** Accept both a bare result object and a JSON-RPC envelope; the specification allows either shape. */
function splitEnvelope(parsed: unknown): { payload: McpJsonRpcResult; error?: McpJsonRpcError } {
  if (!isRecord(parsed)) return { payload: { result: parsed } };
  if (!("jsonrpc" in parsed) && !("result" in parsed) && !("error" in parsed)) {
    return { payload: { result: parsed } };
  }
  const error = isRecord(parsed.error)
    ? {
        code: typeof parsed.error.code === "number" ? parsed.error.code : MCP_RPC_INVALID_PARAMS,
        message: typeof parsed.error.message === "string" ? parsed.error.message : "",
        data: parsed.error.data,
      }
    : undefined;
  return { payload: parsed as McpJsonRpcResult, ...(error ? { error } : {}) };
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
 * any other body at those statuses is a peer that predates the modern model.
 */
export function detectEraFromRpcError(status: number, error: McpJsonRpcError | undefined): McpEraDetection {
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
