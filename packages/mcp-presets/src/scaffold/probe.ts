/**
 * Read the facts a catalog entry needs from a live remote MCP endpoint, by speaking the Streamable
 * HTTP transport directly: `initialize`, then `notifications/initialized` and `tools/list`.
 *
 * The probe sends no credential. An anonymous answer proves `none`; a `401` classifies the endpoint as
 * `oauth` or `bearer` from its `WWW-Authenticate` challenge. Node-only: it is not exported from the
 * package entry, which the Web App imports.
 */
export const PROBE_PROTOCOL_VERSION = "2025-06-18";
const MAX_TOOL_NAMES = 50;

export type ProbeAuthKind = "none" | "oauth" | "bearer";

export interface McpProbeServerInfo {
  readonly name?: string;
  readonly title?: string;
  readonly version?: string;
}

export type McpProbeResult =
  | {
      readonly ok: true;
      readonly authKind: ProbeAuthKind;
      readonly evidence: string;
      /** Present only when the endpoint answered `initialize` anonymously. */
      readonly serverInfo?: McpProbeServerInfo;
      readonly protocolVersion?: string;
      readonly instructions?: string;
      readonly toolNames: readonly string[];
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

/** Pull the JSON-RPC message out of a JSON body or a `text/event-stream` body. */
export function parseRpcBody(contentType: string, body: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
    }
  } else {
    candidates.push(body);
  }
  for (const text of candidates) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && ("result" in parsed || "error" in parsed)) return parsed;
    } catch {
      // Not JSON: try the next SSE event.
    }
  }
  return undefined;
}

/** Classify an unauthenticated rejection. `oauth` needs evidence of an OAuth flow; otherwise a key. */
export function classifyChallenge(header: string | null): { kind: ProbeAuthKind; evidence: string } {
  const challenge = header?.trim() ?? "";
  if (/resource_metadata=|realm="?oauth|authorization_uri|as_uri/i.test(challenge)) {
    return { kind: "oauth", evidence: `401 with an OAuth challenge: ${challenge}` };
  }
  if (challenge.length > 0) {
    return { kind: "bearer", evidence: `401 with a non-OAuth challenge: ${challenge}` };
  }
  return { kind: "bearer", evidence: "401 without a WWW-Authenticate challenge" };
}

function rpcHeaders(sessionId?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId, "mcp-protocol-version": PROBE_PROTOCOL_VERSION }),
  };
}

/** Drop `undefined` members so optional result fields stay absent under `exactOptionalPropertyTypes`. */
function defined<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

type Post = (body: unknown, sessionId?: string) => Promise<Response>;

/** `tools/list` is informational: any failure yields an empty list rather than failing the probe. */
async function listToolNames(post: Post, sessionId: string | undefined): Promise<string[]> {
  try {
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
    const listed = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
    if (!listed.ok) return [];
    const body = parseRpcBody(listed.headers.get("content-type") ?? "", await listed.text());
    const tools = isRecord(body?.result) ? body.result.tools : undefined;
    if (!Array.isArray(tools)) return [];
    return tools
      .map((tool) => (isRecord(tool) ? str(tool.name) : undefined))
      .filter((name): name is string => name !== undefined)
      .slice(0, MAX_TOOL_NAMES);
  } catch {
    return [];
  }
}

function readServerInfo(result: Record<string, unknown>): McpProbeServerInfo {
  const info = isRecord(result.serverInfo) ? result.serverInfo : {};
  return defined<McpProbeServerInfo>({ name: str(info.name), title: str(info.title), version: str(info.version) });
}

export async function probeMcpEndpoint(url: string, options: ProbeOptions = {}): Promise<McpProbeResult> {
  const doFetch = options.fetch ?? fetch;
  const timeout = options.timeoutMs ?? 15_000;
  const post: Post = (body, sessionId) =>
    doFetch(url, {
      method: "POST",
      headers: rpcHeaders(sessionId),
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });

  let response: Response;
  try {
    response = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROBE_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "opentag-catalog-add", version: "1.0.0" },
      },
    });
  } catch (error) {
    return { ok: false, reason: `request failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (response.status === 401) {
    const { kind, evidence } = classifyChallenge(response.headers.get("www-authenticate"));
    return { ok: true, authKind: kind, evidence, toolNames: [] };
  }
  if (!response.ok) {
    return {
      ok: false,
      reason: `initialize answered HTTP ${response.status}; this is not a Streamable HTTP MCP endpoint`,
    };
  }

  const result = parseRpcBody(response.headers.get("content-type") ?? "", await response.text())?.result;
  if (!isRecord(result)) {
    return { ok: false, reason: "initialize answered 2xx but not with a JSON-RPC result" };
  }
  const toolNames = await listToolNames(post, response.headers.get("mcp-session-id") ?? undefined);
  return {
    ok: true,
    authKind: "none",
    evidence: "initialize answered anonymously",
    serverInfo: readServerInfo(result),
    ...defined<{ protocolVersion: string; instructions: string }>({
      protocolVersion: str(result.protocolVersion),
      instructions: str(result.instructions),
    }),
    toolNames,
  };
}
