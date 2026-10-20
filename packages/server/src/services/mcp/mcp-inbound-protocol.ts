import { MCP_LEGACY_PROTOCOL_VERSIONS, MCP_SUPPORTED_PROTOCOL_VERSIONS } from "@opentag/shared";
import { MCP_META_SERVER_INFO, MCP_RPC_INVALID_PARAMS, MCP_RPC_METHOD_NOT_FOUND } from "./mcp-transport.js";

/**
 * An inbound MCP server — the mirror of `mcp-transport.ts`, which is the outbound client.
 *
 * Two endpoints speak it: the per-Agent runtime gateway, and the anonymous catalog endpoint. Nothing
 * here belongs to either. What an endpoint serves arrives through `McpInboundHandlers`, including the
 * identity it reports and the revisions it answers, so one module can serve both without a second
 * copy of the protocol.
 *
 * Two eras exist, and an endpoint declares which it actually implements. The revision this
 * deployment speaks upstream is 2026-07-28, but the clients that will mount these endpoints are the
 * provider CLIs, and Claude Code's own in-process bridge still speaks `2025-03-26`. A modern-only
 * server would be unusable by the very client it exists for, so `initialize` is a first-class path
 * here even though the outbound side treats it as a fallback.
 *
 * A revision is advertised only when the endpoint honours it end to end. The modern one requires
 * per-request version metadata, mirrored HTTP headers, and a `resultType` on every result; an
 * endpoint that answers the modern handshake without those strands a conforming client mid-flow,
 * which is worse than not offering the revision at all.
 *
 * Replies are always a single JSON object. The specification also permits a request-scoped SSE
 * stream, but nothing either endpoint answers is incremental: a catalogue is one array and a tool
 * call is one result, both already bounded.
 */

export const MCP_INBOUND_INSTRUCTIONS_MAX_BYTES = 8 * 1024;

export interface McpInboundServerInfo {
  name: string;
  title: string;
  version: string;
}

export interface McpInboundRpcRequest {
  jsonrpc: "2.0";
  id?: unknown;
  method: string;
  params?: unknown;
}

export interface McpInboundHandlers {
  /** The identity this endpoint reports in `initialize` and `server/discover`. */
  serverInfo: McpInboundServerInfo;
  /**
   * The protocol revisions this endpoint answers, newest first.
   *
   * A revision absent here is neither echoed in `initialize` nor listed in `server/discover`, so a
   * client that negotiates from that list falls back to one the endpoint does implement.
   */
  supportedVersions: readonly string[];
  listTools(): Promise<{
    tools: { name: string; description: string | null; inputSchema: unknown }[];
    notes: string[];
  }>;
  callTool(name: string, args: Record<string, unknown> | undefined): Promise<unknown>;
}

/** What the route should do with one parsed JSON-RPC message. */
export type McpInboundReply =
  | { kind: "json"; status: number; body: unknown }
  /** A notification: acknowledged with no body, per the transport contract. */
  | { kind: "accepted" };

/**
 * Parse one inbound body into a JSON-RPC request.
 *
 * A batch is refused rather than half-supported: the real methods are catalogue reads and tool calls,
 * neither of which any provider CLI batches, and accepting an array would mean inventing a
 * partial-failure story for a case that does not arise.
 */
export function parseInboundRequest(body: unknown): McpInboundRpcRequest | undefined {
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
function replyId(request: McpInboundRpcRequest): string | number | null {
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
export async function dispatchInboundRequest(
  request: McpInboundRpcRequest,
  handlers: McpInboundHandlers,
): Promise<McpInboundReply> {
  // No id means a notification. Nothing either endpoint receives requires action, but the contract says
  // acknowledge rather than answer, and a reply to a notification is itself a protocol violation.
  if (request.id === undefined) return { kind: "accepted" };
  const id = replyId(request);
  const method = METHODS.get(request.method);
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
  request: McpInboundRpcRequest,
  handlers: McpInboundHandlers,
  id: string | number | null,
) => Promise<McpInboundReply>;

/**
 * The methods this endpoint answers.
 *
 * A `Map` rather than an object: an object would answer `constructor`, `toString`, and the rest of
 * `Object.prototype` with inherited members, so `"constructor"` would be dispatched as a method
 * instead of being refused. The supported set is one readable list, and an unknown method — inherited
 * name or not — has exactly one answer.
 *
 * Everything absent here — `resources/*`, `prompts/*`, elicitation, sampling — is deliberately not
 * implemented, and the capabilities this endpoint advertises say so.
 */
const METHODS = new Map<string, MethodHandler>([
  ["initialize", async (request, handlers, id) => ok(id, await initializeResult(handlers, request))],
  ["server/discover", async (_request, handlers, id) => ok(id, await discoverResult(handlers))],
  ["ping", async (_request, _handlers, id) => ok(id, {})],
  [
    "tools/list",
    async (_request, handlers, id) => {
      const catalog = await handlers.listTools();
      // No `nextCursor`: the catalogue is already bounded and served whole, so there is never a further
      // page. Emitting a cursor we would then have to honour would describe state the endpoint does not
      // keep.
      return ok(id, { tools: catalog.tools.map(toWireTool) });
    },
  ],
  [
    "tools/call",
    async (request, handlers, id) => {
      const params = isRecord(request.params) ? request.params : undefined;
      const name = params && typeof params.name === "string" ? params.name : undefined;
      if (!name) {
        return { kind: "json", status: 200, body: jsonRpcError(id, MCP_RPC_INVALID_PARAMS, "A tool name is required") };
      }
      const args = params && isRecord(params.arguments) ? params.arguments : undefined;
      return ok(id, await handlers.callTool(name, args));
    },
  ],
]);

function ok(id: string | number | null, result: unknown): McpInboundReply {
  return { kind: "json", status: 200, body: jsonRpcResult(id, result) };
}

/**
 * The newest revision an endpoint speaks, from the shared list's own newest-first order.
 *
 * The fallback matters: a handler that speaks none of the shared revisions still has to answer, and
 * the legacy handshake is the one every client of these endpoints understands.
 */
function newestSupported(handlers: McpInboundHandlers): string {
  return (
    MCP_SUPPORTED_PROTOCOL_VERSIONS.find((version) => handlers.supportedVersions.includes(version)) ??
    MCP_LEGACY_PROTOCOL_VERSIONS[0]
  );
}

/** The newest *legacy* revision, which is what the legacy handshake may negotiate to. */
function newestLegacySupported(handlers: McpInboundHandlers): string {
  return (
    MCP_LEGACY_PROTOCOL_VERSIONS.find((version) => handlers.supportedVersions.includes(version)) ??
    newestSupported(handlers)
  );
}

/**
 * The legacy handshake result.
 *
 * The version echoed back is the one the client asked for when this endpoint speaks it, and the
 * newest legacy version otherwise. Echoing an unsupported request verbatim would strand the session:
 * the client would then stamp a version on every subsequent request that the endpoint never agreed to.
 * The modern revision is never the answer here — a handshake cannot negotiate a revision that needs
 * request metadata this response does not establish.
 */
async function initializeResult(handlers: McpInboundHandlers, request: McpInboundRpcRequest): Promise<unknown> {
  const params = isRecord(request.params) ? request.params : undefined;
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
  const supported = requested !== undefined && handlers.supportedVersions.includes(requested);
  const catalog = await handlers.listTools();
  return {
    protocolVersion: supported && requested !== undefined ? requested : newestLegacySupported(handlers),
    capabilities: { tools: {} },
    serverInfo: handlers.serverInfo,
    ...instructionsOf(catalog.notes),
  };
}

/**
 * The discovery result: this endpoint's whole supported set, plus identity under its `_meta` key.
 *
 * An endpoint that does not implement the modern revision still answers, listing only what it does
 * implement. Discovery is how a negotiating client learns that, so refusing to answer would leave it
 * with nothing to fall back from.
 */
async function discoverResult(handlers: McpInboundHandlers): Promise<unknown> {
  const catalog = await handlers.listTools();
  return {
    supportedVersions: [...handlers.supportedVersions],
    protocolVersion: newestSupported(handlers),
    capabilities: { tools: {} },
    _meta: { [MCP_META_SERVER_INFO]: handlers.serverInfo },
    ...instructionsOf(catalog.notes),
  };
}

/**
 * Turn the endpoint's notes into the MCP `instructions` string.
 *
 * This is the only channel through which a model can learn that something it was told about is
 * missing. Without it, a revoked credential and a Server that never had any tools look identical
 * from inside the turn — the tool is simply absent, and the model invents a reason.
 */
function instructionsOf(notes: readonly string[]): { instructions?: string } {
  if (notes.length === 0) return {};
  const text = notes.join("\n");
  if (Buffer.byteLength(text, "utf8") <= MCP_INBOUND_INSTRUCTIONS_MAX_BYTES) return { instructions: text };
  /*
   * Cut by bytes, because the bound is in bytes. `slice` counts UTF-16 units, so a note in any
   * non-ASCII script could still exceed the limit the check had just applied. Truncating the encoded
   * form and decoding with the fatal-free default drops a trailing partial sequence rather than
   * emitting a broken one.
   */
  const encoded = Buffer.from(text, "utf8").subarray(0, MCP_INBOUND_INSTRUCTIONS_MAX_BYTES - 3);
  return { instructions: `${new TextDecoder().decode(encoded)}…` };
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
