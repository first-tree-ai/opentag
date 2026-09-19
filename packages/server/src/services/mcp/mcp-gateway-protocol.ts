import {
  MCP_GATEWAY_SERVER_NAME,
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_MODERN_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from "@opentag/shared";
import { MCP_META_SERVER_INFO, MCP_RPC_INVALID_PARAMS, MCP_RPC_METHOD_NOT_FOUND } from "./mcp-transport.js";

/**
 * The inbound MCP server the gateway presents — the mirror of `mcp-transport.ts`, which is the
 * outbound client.
 *
 * Two eras are answered, not one. The revision this deployment speaks upstream is 2026-07-28, but
 * the clients that will mount this endpoint are the provider CLIs, and Claude Code's own in-process
 * bridge still speaks `2025-03-26`. A modern-only gateway would be unusable by the very client it
 * exists for, so `initialize` is a first-class path here even though the outbound side treats it as
 * a fallback.
 *
 * Replies are always a single JSON object. The specification also permits a request-scoped SSE
 * stream, but nothing the gateway answers is incremental: a catalogue is one array and a tool call
 * is one result, both already bounded.
 */

export const MCP_GATEWAY_INSTRUCTIONS_MAX_BYTES = 8 * 1024;

export interface McpGatewayRpcRequest {
  jsonrpc: "2.0";
  id?: unknown;
  method: string;
  params?: unknown;
}

export interface McpGatewayHandlers {
  listTools(): Promise<{
    tools: { name: string; description: string | null; inputSchema: unknown }[];
    notes: string[];
  }>;
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown>;
}

/** What the route should do with one parsed JSON-RPC message. */
export type McpGatewayReply =
  | { kind: "json"; status: number; body: unknown }
  /** A notification: acknowledged with no body, per the transport contract. */
  | { kind: "accepted" };

const SERVER_INFO = { name: MCP_GATEWAY_SERVER_NAME, version: "1", title: "OpenTag MCP" };

/**
 * Parse one inbound body into a JSON-RPC request.
 *
 * A batch is refused rather than half-supported: the gateway's two real methods are a catalogue read
 * and a tool call, neither of which any provider CLI batches, and accepting an array would mean
 * inventing a partial-failure story for a case that does not arise.
 */
export function parseGatewayRequest(body: unknown): McpGatewayRpcRequest | undefined {
  if (!isRecord(body)) return undefined;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") return undefined;
  return {
    jsonrpc: "2.0",
    ...("id" in body ? { id: body.id } : {}),
    method: body.method,
    ...("params" in body ? { params: body.params } : {}),
  };
}

/** A JSON-RPC id may be a string or a number; anything else is answered against a null id. */
function replyId(request: McpGatewayRpcRequest): string | number | null {
  const id = request.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function jsonRpcResult(id: string | number | null, result: unknown): unknown {
  return { jsonrpc: "2.0", id, result };
}

/**
 * The body of a failed tool call: a *result* carrying `isError`, not a JSON-RPC error.
 *
 * This is the difference between a model that retries with better arguments and a model whose turn
 * ends. A transport error is a statement that the conversation broke; an upstream MCP Server saying
 * "that issue does not exist" is ordinary tool output, and the model should read it.
 */
export function toolErrorResult(message: string): unknown {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Dispatch one request.
 *
 * `initialize` and `server/discover` are answered from the same facts; only their shapes differ,
 * because the legacy handshake reports one negotiated version while the modern discovery reports
 * the whole supported set and lets the client choose.
 */
export async function dispatchGatewayRequest(
  request: McpGatewayRpcRequest,
  handlers: McpGatewayHandlers,
): Promise<McpGatewayReply> {
  // No id means a notification. Nothing the gateway receives requires action, but the contract says
  // acknowledge rather than answer, and a reply to a notification is itself a protocol violation.
  if (request.id === undefined) return { kind: "accepted" };
  const id = replyId(request);
  const method = METHODS[request.method];
  if (!method) {
    return {
      kind: "json",
      status: 404,
      body: jsonRpcError(id, MCP_RPC_METHOD_NOT_FOUND, `Unknown method "${request.method}"`),
    };
  }
  return method(request, handlers, id);
}

type MethodHandler = (
  request: McpGatewayRpcRequest,
  handlers: McpGatewayHandlers,
  id: string | number | null,
) => Promise<McpGatewayReply>;

/**
 * The methods this gateway answers.
 *
 * A table rather than a chain of comparisons, so the supported set is one readable list and an
 * unknown method has exactly one answer. Everything absent here — `resources/*`, `prompts/*`,
 * elicitation, sampling — is deliberately not implemented, and the capabilities this gateway
 * advertises say so.
 */
const METHODS: Record<string, MethodHandler> = {
  initialize: async (request, handlers, id) => ok(id, await initializeResult(handlers, request)),
  "server/discover": async (_request, handlers, id) => ok(id, await discoverResult(handlers)),
  ping: async (_request, _handlers, id) => ok(id, {}),
  "tools/list": async (_request, handlers, id) => {
    const catalog = await handlers.listTools();
    // No `nextCursor`: the catalogue is already bounded and served whole, so there is never a further
    // page. Emitting a cursor we would then have to honour would describe state the gateway does not
    // keep.
    return ok(id, { tools: catalog.tools.map(toWireTool) });
  },
  "tools/call": async (request, handlers, id) => {
    const params = isRecord(request.params) ? request.params : undefined;
    const name = params && typeof params.name === "string" ? params.name : undefined;
    if (!name) {
      return { kind: "json", status: 200, body: jsonRpcError(id, MCP_RPC_INVALID_PARAMS, "A tool name is required") };
    }
    const args = params && isRecord(params.arguments) ? params.arguments : undefined;
    return ok(id, await handlers.callTool(name, args));
  },
};

function ok(id: string | number | null, result: unknown): McpGatewayReply {
  return { kind: "json", status: 200, body: jsonRpcResult(id, result) };
}

/**
 * The legacy handshake result.
 *
 * The version echoed back is the one the client asked for when this deployment speaks it, and the
 * newest legacy version otherwise. Echoing an unsupported request verbatim would strand the session:
 * the client would then stamp a version on every subsequent request that the gateway never agreed to.
 */
async function initializeResult(handlers: McpGatewayHandlers, request: McpGatewayRpcRequest): Promise<unknown> {
  const params = isRecord(request.params) ? request.params : undefined;
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
  const supported =
    requested !== undefined && (MCP_SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested);
  const catalog = await handlers.listTools();
  return {
    protocolVersion: supported && requested !== undefined ? requested : MCP_LEGACY_PROTOCOL_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    ...instructionsOf(catalog.notes),
  };
}

/** The modern discovery result: the whole supported set, plus identity under its `_meta` key. */
async function discoverResult(handlers: McpGatewayHandlers): Promise<unknown> {
  const catalog = await handlers.listTools();
  return {
    supportedVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
    protocolVersion: MCP_MODERN_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    _meta: { [MCP_META_SERVER_INFO]: SERVER_INFO },
    ...instructionsOf(catalog.notes),
  };
}

/**
 * Turn the catalogue's notes into the MCP `instructions` string.
 *
 * This is the only channel through which a model can learn that a Server it was told about is
 * missing. Without it a revoked credential and a Server that never had any tools look identical
 * from inside the turn — the tool is simply absent, and the model invents a reason.
 */
function instructionsOf(notes: readonly string[]): { instructions?: string } {
  if (notes.length === 0) return {};
  const text = notes.join("\n");
  const bounded =
    Buffer.byteLength(text, "utf8") > MCP_GATEWAY_INSTRUCTIONS_MAX_BYTES
      ? `${text.slice(0, MCP_GATEWAY_INSTRUCTIONS_MAX_BYTES)}…`
      : text;
  return { instructions: bounded };
}

/**
 * The wire shape of one tool.
 *
 * `inputSchema` is required by the specification and several clients reject a tool without one, so a
 * snapshot that stored none gets the permissive empty object schema rather than being dropped.
 */
function toWireTool(tool: { name: string; description: string | null; inputSchema: unknown }): unknown {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: tool.inputSchema ?? { type: "object" },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
