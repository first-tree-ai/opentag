import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MCP_GATEWAY_REQUEST_MAX_BYTES, MCP_GATEWAY_SERVER_NAME } from "@opentag/shared";
import { createLogger } from "../../observability/logger.js";

const logger = createLogger("provider-codex-mcp-relay");
const RELAY_PATH = "/mcp";
const FALLBACK_PROTOCOL_VERSION = "2025-03-26";
/** Headers a Streamable HTTP client sends that the gateway must see unchanged. */
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "mcp-protocol-version"] as const;

/**
 * The environment variable Codex reads the relay bearer from.
 *
 * The bearer is handed over through the App Server environment rather than its argument vector, and
 * the App Server's shell environment policy is an include-list, so commands the model runs never
 * inherit it.
 */
export const CODEX_MCP_RELAY_TOKEN_ENV = "OPENTAG_MCP_RELAY_TOKEN";

/** The execution-scoped Server MCP gateway endpoint; both fields are opaque to this module. */
export interface CodexMcpGatewayEndpoint {
  readonly url: string;
  readonly token: string;
}

export interface CodexMcpGatewayRelay {
  /** Loopback URL Codex mounts as a Streamable HTTP MCP server for the whole Session runtime. */
  readonly url: string;
  /** Session-local bearer Codex must present; worthless once the relay closes. */
  readonly token: string;
  /**
   * Point the relay at one execution's gateway, or detach it.
   *
   * Detached, the relay answers the MCP handshake itself with an empty catalogue, so the App Server
   * starts cleanly between executions and never holds a bearer that outlived its execution.
   */
  setUpstream(endpoint: CodexMcpGatewayEndpoint | undefined): void;
  close(): Promise<void>;
}

export interface CodexMcpGatewayRelayOptions {
  readonly fetch?: typeof fetch;
}

/**
 * The Codex `-c` override that mounts the relay as the only MCP server.
 *
 * The whole `mcp_servers` table is replaced, so servers from the user's own Codex configuration stay
 * excluded exactly as before. Gateway tools are pre-approved as a server, matching the Claude Code
 * allow rule: Codex otherwise rejects every MCP call under the `never` approval policy OpenTag runs.
 */
export function codexMcpGatewayServersOverride(relayUrl: string): string {
  const server = [
    `url = ${JSON.stringify(relayUrl)}`,
    `bearer_token_env_var = ${JSON.stringify(CODEX_MCP_RELAY_TOKEN_ENV)}`,
    `default_tools_approval_mode = "approve"`,
  ].join(", ");
  return `mcp_servers={ ${JSON.stringify(MCP_GATEWAY_SERVER_NAME)} = { ${server} } }`;
}

/**
 * A loopback MCP relay owned by one Codex Session runtime.
 *
 * Codex spawns its App Server once per Session from a frozen argument vector, while the gateway
 * bearer is minted per execution. The relay bridges the two: Codex holds a stable local URL and
 * bearer, and each request is forwarded with whichever execution bearer is attached at that moment.
 * The gateway is stateless, so replacing the upstream bearer between executions needs no MCP
 * session bookkeeping here.
 */
export async function startCodexMcpGatewayRelay(
  options: CodexMcpGatewayRelayOptions = {},
): Promise<CodexMcpGatewayRelay> {
  const fetchUpstream = options.fetch ?? fetch;
  const token = randomBytes(32).toString("base64url");
  const expectedAuthorization = Buffer.from(`Bearer ${token}`, "utf8");
  let upstream: CodexMcpGatewayEndpoint | undefined;
  const server: Server = createServer((request, response) => {
    void handleRequest(request, response, {
      expectedAuthorization,
      fetchUpstream,
      upstream: () => upstream,
    }).catch((error: unknown) => {
      logger.warn({ code: "relay_request_failed", error: String(error) }, "Codex MCP relay request failed");
      /* v8 ignore next 2 -- only a socket failure after response headers can reach the destroy branch. */
      if (!response.headersSent) writeJson(response, 502, jsonRpcError(null, -32603, "MCP relay failure"));
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  /* v8 ignore start -- a successful TCP listen always exposes an AddressInfo object. */
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Codex MCP relay did not bind a TCP port");
  }
  /* v8 ignore stop */
  const url = `http://127.0.0.1:${address.port}${RELAY_PATH}`;
  logger.debug({ port: address.port }, "Codex MCP relay listening");
  let closePromise: Promise<void> | undefined;
  return {
    url,
    token,
    setUpstream(endpoint) {
      upstream = endpoint;
    },
    close() {
      upstream = undefined;
      closePromise ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

interface RelayContext {
  readonly expectedAuthorization: Buffer;
  readonly fetchUpstream: typeof fetch;
  readonly upstream: () => CodexMcpGatewayEndpoint | undefined;
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: RelayContext): Promise<void> {
  response.setHeader("Cache-Control", "no-store");
  if (request.url !== RELAY_PATH) {
    writeJson(response, 404, jsonRpcError(null, -32600, "Not found"));
    return;
  }
  if (!authorized(request.headers.authorization, context.expectedAuthorization)) {
    logger.debug({ code: "relay_unauthenticated" }, "Codex MCP relay rejected an unauthenticated request");
    writeJson(response, 401, jsonRpcError(null, -32600, "Unauthorized"));
    return;
  }
  if (request.method !== "POST") {
    // Like the gateway, the relay has no server-initiated stream to offer.
    response.setHeader("Allow", "POST");
    writeJson(response, 405, jsonRpcError(null, -32600, "The MCP relay accepts POST only"));
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(request);
  } catch {
    writeJson(response, 413, jsonRpcError(null, -32600, "MCP request is too large"));
    return;
  }
  const upstream = context.upstream();
  if (upstream) {
    await forward(request, response, body, upstream, context.fetchUpstream);
    return;
  }
  answerDetached(response, body);
}

async function forward(
  request: IncomingMessage,
  response: ServerResponse,
  body: Buffer,
  upstream: CodexMcpGatewayEndpoint,
  fetchUpstream: typeof fetch,
): Promise<void> {
  const aborted = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) aborted.abort();
  });
  const headers: Record<string, string> = { authorization: `Bearer ${upstream.token}` };
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetchUpstream(upstream.url, {
      method: "POST",
      headers,
      body: new Uint8Array(body),
      redirect: "error",
      signal: aborted.signal,
    });
  } catch (error) {
    logger.warn(
      { code: "relay_upstream_unreachable", error: String(error) },
      "Codex MCP relay could not reach the MCP gateway",
    );
    writeJson(response, 502, jsonRpcError(requestId(body), -32603, "The OpenTag MCP gateway is unreachable"));
    return;
  }
  const payload = Buffer.from(await upstreamResponse.arrayBuffer());
  if (upstreamResponse.status >= 400) {
    logger.warn(
      { code: "relay_upstream_rejected", status: upstreamResponse.status },
      "The MCP gateway rejected a relayed Codex request",
    );
  }
  const contentType = upstreamResponse.headers.get("content-type");
  response.writeHead(upstreamResponse.status, contentType ? { "Content-Type": contentType } : {});
  response.end(payload);
}

/**
 * Answer the MCP handshake locally while no execution is attached.
 *
 * Codex connects when a thread starts or resumes, which can happen outside any execution. A failed
 * handshake would leave the server marked failed; an empty catalogue keeps it healthy until the next
 * execution attaches a gateway and reloads it.
 */
function answerDetached(response: ServerResponse, body: Buffer): void {
  let rpc: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    rpc =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    rpc = undefined;
  }
  if (!rpc || typeof rpc.method !== "string") {
    writeJson(response, 400, jsonRpcError(null, -32600, "Invalid JSON-RPC request"));
    return;
  }
  const id = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : undefined;
  if (id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const params = rpc.params !== null && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
  switch (rpc.method) {
    case "initialize":
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof params.protocolVersion === "string" ? params.protocolVersion : FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_GATEWAY_SERVER_NAME, version: "1" },
        },
      });
      return;
    case "ping":
      writeJson(response, 200, { jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      writeJson(response, 200, { jsonrpc: "2.0", id, result: { tools: [] } });
      return;
    case "tools/call":
      writeJson(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          isError: true,
          content: [{ type: "text", text: "OpenTag MCP tools are available only during an active turn." }],
        },
      });
      return;
    default:
      writeJson(response, 200, jsonRpcError(id, -32601, "Method not found"));
  }
}

function authorized(header: string | undefined, expected: Buffer): boolean {
  if (typeof header !== "string") return false;
  const actual = Buffer.from(header, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestId(body: Buffer): string | number | null {
  try {
    const id = (JSON.parse(body.toString("utf8")) as { id?: unknown } | null)?.id;
    return typeof id === "string" || typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MCP_GATEWAY_REQUEST_MAX_BYTES) {
        reject(new Error("MCP request is too large"));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => resolve(Buffer.concat(chunks)));
    request.once("error", reject);
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
