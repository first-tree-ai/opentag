import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentHostedTools, JsonValue } from "../../agent-runtime/types.js";
import { assertJsonValue } from "../../agent-runtime/validation.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MCP_PROTOCOL_VERSION = "2025-03-26";

export interface ClaudeCodeHostedToolBridge {
  readonly allowedTools: readonly string[];
  readonly configPath: string;
  close(): Promise<void>;
}

export async function startClaudeCodeHostedToolBridge(
  hostedTools: AgentHostedTools | undefined,
  runId: string,
  signal: AbortSignal,
): Promise<ClaudeCodeHostedToolBridge> {
  signal.throwIfAborted();
  const definitions = new Map((hostedTools?.definitions ?? []).map((definition) => [definition.name, definition]));
  if (hostedTools && definitions.size !== hostedTools.definitions.length) {
    throw new Error("Claude Code hosted tool definitions must have unique names");
  }

  const directory = await mkdtemp(join(tmpdir(), "opentag-claude-mcp-"));
  const configPath = join(directory, "mcp.json");
  let server: Server | undefined;
  try {
    let configuration: Record<string, unknown> = { mcpServers: {} };
    if (hostedTools && definitions.size > 0) {
      const token = randomBytes(32).toString("base64url");
      server = createServer((request, response) => {
        void handleRequest(server as Server, request, response, {
          definitions,
          hostedTools,
          runId,
          signal,
          token,
        }).catch(() => {
          /* v8 ignore next 2 -- only a socket failure after response headers can reach the destroy branch. */
          if (!response.headersSent) writeJson(response, 500, jsonRpcError(null, -32603, "Internal error"));
          else response.destroy();
        });
      });
      await listen(server);
      const address = server.address();
      /* v8 ignore start -- a successful TCP listen always exposes an AddressInfo object. */
      if (!address || typeof address === "string") {
        throw new Error("Claude Code hosted tool bridge did not bind a TCP port");
      }
      /* v8 ignore stop */
      configuration = {
        mcpServers: {
          opentag: {
            type: "http",
            url: `http://127.0.0.1:${address.port}/mcp`,
            headers: { Authorization: `Bearer ${token}` },
          },
        },
      };
    }
    await writeFile(configPath, `${JSON.stringify(configuration)}\n`, { encoding: "utf8", mode: 0o600 });
    /* v8 ignore start -- deterministic setup tests cannot induce an owned 0600 temp-file write failure. */
  } catch (error) {
    await Promise.allSettled([
      ...(server ? [closeServer(server)] : []),
      rm(directory, { recursive: true, force: true }),
    ]);
    throw error;
  }
  /* v8 ignore stop */

  let closePromise: Promise<void> | undefined;
  return {
    allowedTools: [...definitions.keys()].map((name) => `mcp__opentag__${name}`),
    configPath,
    close() {
      closePromise ??= Promise.allSettled([
        ...(server ? [closeServer(server)] : []),
        rm(directory, { recursive: true, force: true }),
      ]).then((results) => {
        /* v8 ignore start -- owned server/temp-directory cleanup failures are OS-level and not deterministically injectable. */
        const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
        if (failures.length > 0) throw new AggregateError(failures, "Claude Code hosted tool bridge cleanup failed");
        /* v8 ignore stop */
      });
      return closePromise;
    },
  };
}

interface RequestContext {
  readonly definitions: ReadonlyMap<string, AgentHostedTools["definitions"][number]>;
  readonly hostedTools: AgentHostedTools;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly token: string;
}

async function handleRequest(
  server: Server,
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  response.setHeader("Connection", "close");
  const address = server.address();
  /* v8 ignore next -- this owned server remains listening for the request lifetime. */
  const expectedHost = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
  if (
    request.method !== "POST" ||
    request.url !== "/mcp" ||
    request.headers.host !== expectedHost ||
    request.headers.authorization !== `Bearer ${context.token}`
  ) {
    writeJson(response, 404, jsonRpcError(null, -32600, "Invalid request"));
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBody(request));
  } catch {
    writeJson(response, 400, jsonRpcError(null, -32700, "Parse error"));
    return;
  }
  const rpc = record(body);
  if (rpc?.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
    writeJson(response, 400, jsonRpcError(null, -32600, "Invalid request"));
    return;
  }
  const id = validRpcId(rpc.id) ? rpc.id : null;
  if (rpc.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  if (rpc.method === "initialize") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "OpenTag", version: "1" },
      },
    });
    return;
  }
  if (rpc.method === "tools/list") {
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [...context.definitions.values()].map((definition) => ({
          name: definition.name,
          ...(definition.description ? { description: definition.description } : {}),
          inputSchema: definition.inputSchema,
        })),
      },
    });
    return;
  }
  if (rpc.method === "tools/call") {
    const params = record(rpc.params);
    const name = params?.name;
    if (typeof name !== "string" || !context.definitions.has(name)) {
      writeJson(response, 200, failedToolResult(id, "OpenTag hosted tool is unavailable."));
      return;
    }
    let input: JsonValue;
    try {
      const candidate = params?.arguments === undefined ? {} : params.arguments;
      assertJsonValue(candidate, "MCP tool arguments");
      input = candidate as JsonValue;
    } catch (error) {
      writeJson(response, 200, failedToolResult(id, (error as Error).message));
      return;
    }
    const result = await context.hostedTools.handler({
      runId: context.runId,
      toolCallId: rpcToolCallId(id),
      name,
      input,
      signal: context.signal,
    });
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id,
      result: {
        content: result.content,
        isError: !result.success,
        ...(result.error ? { structuredContent: { error: result.error } } : {}),
      },
    });
    return;
  }
  writeJson(response, 200, jsonRpcError(id, -32601, "Method not found"));
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    /* v8 ignore next -- port zero on loopback has no expected contention failure. */
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    /* v8 ignore next -- Node does not report a close error for this owned listening server. */
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("MCP request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    /* v8 ignore next -- malformed/oversized bodies are handled before transport-level request failure. */
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function jsonRpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function failedToolResult(id: string | number | null, text: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } };
}

function rpcToolCallId(id: string | number | null): string {
  if (typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 256) return id;
  if (typeof id === "number") return String(id);
  return randomUUID();
}

function validRpcId(value: unknown): value is string | number | null {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
