/**
 * Read the facts a catalog entry needs from a live remote MCP endpoint, by speaking the Streamable
 * HTTP transport directly: `initialize`, then `notifications/initialized` and a paged `tools/list`.
 *
 * The probe sends no credential. An anonymous answer proves `none`; a `401` carrying a Bearer
 * challenge classifies the endpoint as `oauth` or `bearer`; any other rejection is `unknown`, because
 * a 401 alone proves only that anonymous access failed. Every value that comes from the endpoint is
 * untrusted: `safeText` makes it a bounded single-line string before it reaches a YAML comment.
 * Node-only: it is not exported from the package entry, which the Web App imports.
 */
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";

/**
 * The probe speaks the modern stateless era first (`server/discover`), and falls back to the legacy
 * `initialize` handshake only when the body of a 400/404/405 is not a modern JSON-RPC error. This is
 * the decision `docs/design/mcp-server-integration.md` ("Downgrade to an older Server") specifies and
 * `packages/server/src/services/mcp/mcp-transport.ts` implements; the Server's copy cannot be imported
 * from here, so the small decision seam is repeated.
 */
const LEGACY_VERSIONS: readonly string[] = MCP_LEGACY_PROTOCOL_VERSIONS;
const SUPPORTED_VERSIONS: readonly string[] = MCP_SUPPORTED_PROTOCOL_VERSIONS;
/** MCP-registered codes only a modern Server emits; a generic `-32601` deliberately is not one. */
const RPC_HEADER_MISMATCH = -32020;
const RPC_MISSING_CLIENT_CAPABILITY = -32021;
const RPC_UNSUPPORTED_PROTOCOL_VERSION = -32022;
const MODERN_ERROR_CODES: readonly number[] = [
  RPC_HEADER_MISMATCH,
  RPC_MISSING_CLIENT_CAPABILITY,
  RPC_UNSUPPORTED_PROTOCOL_VERSION,
];
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
/** `2025-03-26` predates the `MCP-Protocol-Version` header, so a request in that revision sends none. */
const VERSION_HEADER_FREE = "2025-03-26";
const CLIENT_INFO = { name: "opentag-catalog-add", version: "1.0.0" };
const MAX_TOOLS = 256;
const MAX_PAGES = 20;
const MAX_DESCRIPTION = 500;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_TEXT = 160;

export type ProbeAuthKind = "none" | "oauth" | "bearer";
export type ProbeSideEffect = "none" | "write" | "destructive";

export interface McpProbeServerInfo {
  readonly name?: string;
  readonly title?: string;
  readonly version?: string;
}

export interface McpProbeTool {
  readonly name: string;
  readonly description?: string;
  /** From the tool's `readOnlyHint` / `destructiveHint` annotations; `write` when it declares neither. */
  readonly sideEffect: ProbeSideEffect;
}

export type McpProbeResult =
  | {
      readonly ok: true;
      /** `unknown`: the endpoint rejected anonymous access without a supported Bearer challenge. */
      readonly authKind: ProbeAuthKind | "unknown";
      readonly evidence: string;
      /** Present only when the endpoint answered `initialize` anonymously. */
      readonly serverInfo?: McpProbeServerInfo;
      readonly protocolVersion?: string;
      readonly protocolEra?: "modern" | "legacy";
      /** Empty unless `toolsComplete`: a partial inventory would understate the risk. */
      readonly tools: readonly McpProbeTool[];
      /** True when `tools/list` was actually requested; false when authorization stopped the probe first. */
      readonly toolsAttempted: boolean;
      /** False when `tools/list` failed, was malformed, or was cut off by a bound. */
      readonly toolsComplete: boolean;
    }
  | { readonly ok: false; readonly reason: string };

export interface ProbeOptions {
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** A bounded, single-line, JSON-escaped rendering of an untrusted string, safe after a `#`. */
export function safeText(value: string, max = MAX_SAFE_TEXT): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
  const flat = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max)}...` : flat);
}

/**
 * The payload of each SSE event: its `data:` lines joined with newlines, per the SSE framing rules.
 * While the stream is still open (`complete` false) the last, unterminated frame is left alone.
 */
function sseEventPayloads(body: string, complete: boolean): string[] {
  const frames = body.replace(/\r\n?/g, "\n").split("\n\n");
  if (!complete) frames.pop();
  return frames
    .map((frame) =>
      frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
        .join("\n"),
    )
    .filter((payload) => payload.length > 0);
}

/**
 * The RPC message with the given id, from a JSON body, a JSON batch, or an SSE body. `complete` is
 * false for a body that may still be arriving.
 */
export function parseRpcBody(
  contentType: string,
  body: string,
  id: number,
  complete = true,
): Record<string, unknown> | undefined {
  const candidates = contentType.includes("text/event-stream") ? sseEventPayloads(body, complete) : [body];
  for (const text of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // Not JSON.
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isRecord(message) && message.id === id && ("result" in message || "error" in message)) return message;
    }
  }
  return undefined;
}

/**
 * Read the response for request `id`. An event stream is consumed incrementally and cancelled as soon
 * as the matching result arrives, because a server may keep the stream open after answering.
 */
async function readRpcMessage(response: Response, id: number): Promise<Record<string, unknown> | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || response.body === null) {
    return parseRpcBody(contentType, await response.text(), id);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (buffer.length < MAX_STREAM_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const message = parseRpcBody(contentType, buffer, id, false);
      if (message !== undefined) return message;
    }
    return parseRpcBody(contentType, buffer, id);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Classify an unauthenticated rejection. Only Bearer evidence is classified; the rest is `unknown`. */
export function classifyChallenge(header: string | null): { kind: ProbeAuthKind | "unknown"; evidence: string } {
  const challenge = header?.trim() ?? "";
  const shown = challenge.length > 0 ? safeText(challenge) : "none";
  if (!/^bearer(\s|$)/i.test(challenge)) {
    return { kind: "unknown", evidence: `401 without a Bearer challenge (WWW-Authenticate: ${shown})` };
  }
  if (/resource_metadata=|realm="?oauth|authorization_uri|as_uri/i.test(challenge)) {
    return { kind: "oauth", evidence: `401 with an OAuth challenge: ${shown}` };
  }
  return { kind: "bearer", evidence: `401 with a Bearer challenge: ${shown}` };
}

function readTool(tool: unknown): McpProbeTool | undefined {
  if (!isRecord(tool)) return undefined;
  const name = str(tool.name);
  if (name === undefined || !/^[A-Za-z0-9_.-]+$/.test(name) || name.length > 128) return undefined;
  const annotations = isRecord(tool.annotations) ? tool.annotations : {};
  let sideEffect: ProbeSideEffect = "write";
  if (annotations.readOnlyHint === true) sideEffect = "none";
  else if (annotations.destructiveHint === true) sideEffect = "destructive";
  const description = str(tool.description)?.replace(/\s+/g, " ").slice(0, MAX_DESCRIPTION);
  return { name, sideEffect, ...(description === undefined ? {} : { description }) };
}

/** One request in an established era; the era decides the headers and the body shape. */
type Call = (id: number, method: string, params: Record<string, unknown>) => Promise<Response>;

interface Session {
  readonly era: "modern" | "legacy";
  readonly version: string;
  readonly call: Call;
  /** The legacy `notifications/initialized`; the modern era has no handshake to finish. */
  readonly afterInitialize?: () => Promise<unknown>;
  readonly serverInfo: McpProbeServerInfo;
}

/** `nextCursor` is absent (or `null`), or a non-empty string; anything else fails the page. */
function readCursor(value: unknown): { cursor?: string } | undefined {
  if (value === undefined || value === null) return {};
  return typeof value === "string" && value.length > 0 ? { cursor: value } : undefined;
}

/** Read one `tools/list` page; `undefined` means the page failed or was malformed. */
async function readToolsPage(
  session: Session,
  id: number,
  cursor: string | undefined,
): Promise<{ tools: unknown[]; nextCursor?: string } | undefined> {
  const listed = await session.call(id, "tools/list", cursor === undefined ? {} : { cursor });
  if (!listed.ok) return undefined;
  const result = (await readRpcMessage(listed, id))?.result;
  if (!isRecord(result) || !Array.isArray(result.tools)) return undefined;
  const next = readCursor(result.nextCursor);
  if (next === undefined) return undefined;
  return { tools: result.tools, ...(next.cursor === undefined ? {} : { nextCursor: next.cursor }) };
}

/**
 * Page `tools/list` to exhaustion. Risk is the strongest effect of ANY tool, so a failed, malformed,
 * or truncated listing is reported as incomplete rather than returned as a partial inventory.
 */
async function listTools(session: Session): Promise<{ tools: McpProbeTool[]; complete: boolean }> {
  const incomplete = { tools: [], complete: false };
  try {
    await session.afterInitialize?.();
    const tools = new Map<string, McpProbeTool>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await readToolsPage(session, 2 + page, cursor);
      if (body === undefined) return incomplete;
      for (const raw of body.tools) {
        const tool = readTool(raw);
        if (tool === undefined) return incomplete;
        tools.set(tool.name, tool);
      }
      if (tools.size > MAX_TOOLS) return incomplete;
      if (body.nextCursor === undefined) return { tools: [...tools.values()], complete: true };
      cursor = body.nextCursor;
    }
    return incomplete;
  } catch {
    return incomplete;
  }
}

function pickServerInfo(info: unknown): McpProbeServerInfo {
  const record = isRecord(info) ? info : {};
  const fields = { name: str(record.name), title: str(record.title), version: str(record.version) };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** A modern result puts the identity under `_meta`; a legacy `initialize` result under `serverInfo`. */
function readServerInfo(result: Record<string, unknown>, era: "modern" | "legacy"): McpProbeServerInfo {
  if (era === "legacy") return pickServerInfo(result.serverInfo);
  const meta = isRecord(result._meta) ? result._meta : {};
  return pickServerInfo(meta[META_SERVER_INFO] ?? result[META_SERVER_INFO]);
}

type Fetcher = (body: unknown, headers: Record<string, string>) => Promise<Response>;

function modernCall(send: Fetcher, version: string): Call {
  return (id, method, params) =>
    send(
      {
        jsonrpc: "2.0",
        id,
        method,
        params: {
          ...params,
          _meta: { [META_VERSION]: version, [META_CAPABILITIES]: {}, [META_CLIENT_INFO]: CLIENT_INFO },
        },
      },
      { "mcp-protocol-version": version, "mcp-method": method },
    );
}

/** The JSON-RPC error for request 1 in a failure body, read through the same JSON/SSE seam as a success. */
async function rpcErrorOf(response: Response): Promise<{ code: number; data?: unknown } | undefined> {
  try {
    const error = (await readRpcMessage(response, 1))?.error;
    return isRecord(error) && typeof error.code === "number" ? { code: error.code, data: error.data } : undefined;
  } catch {
    return undefined;
  }
}

/** Newest version from a modern server's `supported` list that this probe speaks, if any. */
function pickSupported(data: unknown): string | undefined {
  const supported = isRecord(data) && Array.isArray(data.supported) ? data.supported : [];
  return SUPPORTED_VERSIONS.find((version) => supported.includes(version));
}

type DiscoverOutcome =
  | { kind: "session"; session: Session }
  | { kind: "auth"; response: Response }
  | { kind: "legacy" }
  | { kind: "failed"; reason: string };

/** A modern peer rejected the request: retry once with a version it advertised, or fail. Never downgrade. */
function retryOrFail(
  send: Fetcher,
  error: { code: number; data?: unknown },
  version: string,
  retried: boolean,
): Promise<DiscoverOutcome> {
  const next = error.code === RPC_UNSUPPORTED_PROTOCOL_VERSION ? pickSupported(error.data) : undefined;
  if (!MODERN_ERROR_CODES.includes(error.code) || next === undefined || retried) {
    return Promise.resolve({
      kind: "failed",
      reason: `server/discover was rejected at protocol ${version} (JSON-RPC ${error.code})`,
    });
  }
  return discoverModern(send, next, true);
}

/**
 * `server/discover`. Legacy fallback is confined to a 400/404/405 whose body is not a modern JSON-RPC
 * error; a 2xx error or malformed success fails instead of downgrading.
 */
async function discoverModern(send: Fetcher, version: string, retried = false): Promise<DiscoverOutcome> {
  const call = modernCall(send, version);
  const response = await call(1, "server/discover", {});
  if (response.status === 401) return { kind: "auth", response };
  if ([400, 404, 405].includes(response.status)) {
    const error = await rpcErrorOf(response);
    return error === undefined || !MODERN_ERROR_CODES.includes(error.code)
      ? { kind: "legacy" }
      : retryOrFail(send, error, version, retried);
  }
  if (!response.ok) return { kind: "failed", reason: `server/discover answered HTTP ${response.status}` };
  const message = await readRpcMessage(response, 1);
  const error = isRecord(message?.error) ? message.error : undefined;
  if (error !== undefined) {
    return retryOrFail(
      send,
      { code: typeof error.code === "number" ? error.code : 0, data: error.data },
      version,
      retried,
    );
  }
  if (!isRecord(message?.result))
    return { kind: "failed", reason: "server/discover answered 2xx but not with a JSON-RPC result" };
  return {
    kind: "session",
    session: {
      era: version === MCP_MODERN_PROTOCOL_VERSION ? "modern" : "legacy",
      version,
      call,
      serverInfo: readServerInfo(message.result, "modern"),
    },
  };
}

/** The legacy `initialize` handshake. A 400 retries the next older version. */
async function initializeLegacy(send: Fetcher): Promise<Exclude<DiscoverOutcome, { kind: "legacy" }>> {
  let response: Response | undefined;
  for (const version of LEGACY_VERSIONS) {
    response = await send(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO },
      },
      {},
    );
    if (response.status !== 400) break;
  }
  if (response === undefined) return { kind: "failed", reason: "no protocol version was attempted" };
  if (response.status === 401) return { kind: "auth", response };
  if (!response.ok) {
    return {
      kind: "failed",
      reason: `initialize answered HTTP ${response.status}; this is not a Streamable HTTP MCP endpoint`,
    };
  }
  const result = (await readRpcMessage(response, 1))?.result;
  if (!isRecord(result)) return { kind: "failed", reason: "initialize answered 2xx but not with a JSON-RPC result" };

  const version = str(result.protocolVersion);
  if (version === undefined || !LEGACY_VERSIONS.includes(version)) {
    return { kind: "failed", reason: `initialize negotiated unsupported protocol version ${version ?? "(none)"}` };
  }
  const sessionId = response.headers.get("mcp-session-id") ?? undefined;
  const sessionHeaders = {
    ...(version === VERSION_HEADER_FREE ? {} : { "mcp-protocol-version": version }),
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
  };
  return {
    kind: "session",
    session: {
      era: "legacy",
      version,
      serverInfo: readServerInfo(result, "legacy"),
      call: (id, method, params) => send({ jsonrpc: "2.0", id, method, params }, sessionHeaders),
      afterInitialize: () => send({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders),
    },
  };
}

export async function probeMcpEndpoint(url: string, options: ProbeOptions = {}): Promise<McpProbeResult> {
  const doFetch = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  const send: Fetcher = (body, headers) =>
    doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });

  try {
    const discovered = await discoverModern(send, MCP_MODERN_PROTOCOL_VERSION);
    const outcome = discovered.kind === "legacy" ? await initializeLegacy(send) : discovered;
    if (outcome.kind === "failed") return { ok: false, reason: outcome.reason };
    if (outcome.kind === "auth") {
      const { kind, evidence } = classifyChallenge(outcome.response.headers.get("www-authenticate"));
      return { ok: true, authKind: kind, evidence, tools: [], toolsComplete: false, toolsAttempted: false };
    }
    const { session } = outcome;
    const listed = await listTools(session);
    return {
      ok: true,
      authKind: "none",
      evidence: `${session.afterInitialize === undefined ? "server/discover" : "initialize"} answered anonymously (protocol ${session.version})`,
      serverInfo: session.serverInfo,
      protocolVersion: session.version,
      protocolEra: session.era,
      tools: listed.tools,
      toolsComplete: listed.complete,
      toolsAttempted: true,
    };
  } catch (error) {
    return { ok: false, reason: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
