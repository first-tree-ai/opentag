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
/** Newest first. A server negotiates down in its `initialize` result; a 400 retries the next one. */
export const PROBE_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
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
      /** Empty unless `toolsComplete`: a partial inventory would understate the risk. */
      readonly tools: readonly McpProbeTool[];
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

/** The RPC message with the given id, from a JSON body, a JSON batch, or a (partial) SSE body. */
export function parseRpcBody(contentType: string, body: string, id: number): Record<string, unknown> | undefined {
  const candidates = contentType.includes("text/event-stream")
    ? body
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
    : [body];
  for (const text of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue; // Not JSON, or an SSE event still in flight.
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
      const message = parseRpcBody(contentType, buffer, id);
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

type Post = (body: unknown, extra?: { version?: string; sessionId?: string }) => Promise<Response>;

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

/** Read one `tools/list` page; `undefined` means the page failed or was malformed. */
async function readToolsPage(
  post: Post,
  id: number,
  extra: { version: string; sessionId?: string },
  cursor: string | undefined,
): Promise<{ tools: unknown[]; nextCursor?: string } | undefined> {
  const listed = await post(
    { jsonrpc: "2.0", id, method: "tools/list", params: cursor === undefined ? {} : { cursor } },
    extra,
  );
  if (!listed.ok) return undefined;
  const result = (await readRpcMessage(listed, id))?.result;
  if (!isRecord(result) || !Array.isArray(result.tools)) return undefined;
  const nextCursor = str(result.nextCursor);
  return { tools: result.tools, ...(nextCursor === undefined ? {} : { nextCursor }) };
}

/**
 * Page `tools/list` to exhaustion. Risk is the strongest effect of ANY tool, so a failed, malformed,
 * or truncated listing is reported as incomplete rather than returned as a partial inventory.
 */
async function listTools(
  post: Post,
  extra: { version: string; sessionId?: string },
): Promise<{ tools: McpProbeTool[]; complete: boolean }> {
  const incomplete = { tools: [], complete: false };
  try {
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, extra);
    const tools = new Map<string, McpProbeTool>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await readToolsPage(post, 2 + page, extra, cursor);
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

function readServerInfo(result: Record<string, unknown>): McpProbeServerInfo {
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  const fields = { name: str(info.name), title: str(info.title), version: str(info.version) };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export async function probeMcpEndpoint(url: string, options: ProbeOptions = {}): Promise<McpProbeResult> {
  const doFetch = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  const post: Post = (body, extra) =>
    doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(extra?.version === undefined ? {} : { "mcp-protocol-version": extra.version }),
        ...(extra?.sessionId === undefined ? {} : { "mcp-session-id": extra.sessionId }),
      },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });

  let response: Response | undefined;
  try {
    for (const version of PROBE_PROTOCOL_VERSIONS) {
      response = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: version,
          capabilities: {},
          clientInfo: { name: "opentag-catalog-add", version: "1.0.0" },
        },
      });
      if (response.status !== 400) break;
    }
    if (response === undefined) return { ok: false, reason: "no protocol version was attempted" };

    if (response.status === 401) {
      const { kind, evidence } = classifyChallenge(response.headers.get("www-authenticate"));
      return { ok: true, authKind: kind, evidence, tools: [], toolsComplete: false };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: `initialize answered HTTP ${response.status}; this is not a Streamable HTTP MCP endpoint`,
      };
    }
    const result = (await readRpcMessage(response, 1))?.result;
    if (!isRecord(result)) return { ok: false, reason: "initialize answered 2xx but not with a JSON-RPC result" };

    const protocolVersion = str(result.protocolVersion) ?? "2025-06-18";
    const sessionId = response.headers.get("mcp-session-id") ?? undefined;
    const listed = await listTools(post, {
      version: protocolVersion,
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    return {
      ok: true,
      authKind: "none",
      evidence: "initialize answered anonymously",
      serverInfo: readServerInfo(result),
      protocolVersion,
      tools: listed.tools,
      toolsComplete: listed.complete,
    };
  } catch (error) {
    return { ok: false, reason: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}
