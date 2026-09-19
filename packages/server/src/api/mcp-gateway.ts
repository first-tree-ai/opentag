import { MCP_GATEWAY_PATH, MCP_GATEWAY_REQUEST_MAX_BYTES, type McpGatewayErrorCode } from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { createServiceLoggerPort } from "../observability/index.js";
import { createMcpGatewayAuthPreHandler } from "../plugins/mcp-gateway-auth.js";
import { McpGatewayError, type McpGatewayExecutionAuthorizer } from "../runtime-credentials/mcp-gateway-execution.js";
import type { RuntimeMcpGatewayTokenStore } from "../runtime-credentials/mcp-gateway-token-store.js";
import { McpServiceError } from "../services/mcp/errors.js";
import {
  dispatchGatewayRequest,
  jsonRpcError,
  type McpGatewayHandlers,
  parseGatewayRequest,
  toolErrorResult,
} from "../services/mcp/mcp-gateway-protocol.js";
import type { McpGatewayService } from "../services/mcp/mcp-gateway-service.js";

export interface McpGatewayRoutesOptions {
  tokens: RuntimeMcpGatewayTokenStore;
  authorizer: McpGatewayExecutionAuthorizer;
  service: McpGatewayService;
  logger?: ReturnType<typeof createServiceLoggerPort>;
}

/** Deterministic status per bounded gateway code; the JSON-RPC envelope stays the only body. */
const ERROR_STATUS: Record<McpGatewayErrorCode, number> = {
  unauthenticated: 401,
  execution_unknown: 404,
  execution_closed: 409,
  scope_denied: 403,
  timeout: 504,
};

/** JSON-RPC parse/invalid-request codes, used before a method is even known. */
const RPC_PARSE_ERROR = -32700;
const RPC_INVALID_REQUEST = -32600;
const RPC_INTERNAL_ERROR = -32603;

/**
 * The single inbound MCP endpoint.
 *
 * Authentication proves which execution is calling; the fence then re-derives the Account and Agent
 * from the live execution record on every request. Nothing in the request body is ever read as an
 * identity claim — the body names a tool, and that tool is resolved only within what this Agent has
 * bound.
 */
export function registerMcpGatewayRoutes(app: FastifyInstance, options: McpGatewayRoutesOptions): void {
  const authPreHandler = createMcpGatewayAuthPreHandler(options.tokens);
  /*
   * Registered in its own encapsulated scope so the route can carry its own error handler. The app's
   * handler answers in OpenTag's `{ error: { code, category } }` envelope, which is right for every
   * other route and unreadable to the only caller this one has. Without the scope, a body Fastify's
   * JSON parser rejects would escape as that envelope — the one failure the route cannot intercept
   * itself, because it happens before the handler runs.
   */
  app.register(async (scope) => {
    scope.setErrorHandler(async (error, _request, reply) => sendGatewayFailure(reply, null, error, options));
    /*
     * The Streamable HTTP client may open a GET for a server-initiated stream. This gateway has
     * none — every reply is a single JSON body — so the honest answer is "not allowed here", not
     * Fastify's route-not-found, which reads as the endpoint being absent entirely.
     */
    scope.get(MCP_GATEWAY_PATH, async (_request, reply) =>
      reply
        .status(405)
        .header("Allow", "POST")
        .header("Cache-Control", "no-store")
        .send(jsonRpcError(null, RPC_INVALID_REQUEST, "The MCP gateway accepts POST only")),
    );
    scope.post(
      MCP_GATEWAY_PATH,
      { preHandler: authPreHandler, bodyLimit: MCP_GATEWAY_REQUEST_MAX_BYTES },
      (request, reply) => handleGatewayRequest(request, reply, options),
    );
  });
}

async function handleGatewayRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: McpGatewayRoutesOptions,
): Promise<unknown> {
  reply.header("Cache-Control", "no-store");
  /*
   * An abandoned request must not keep its upstream call — and its concurrency slot — alive for the
   * full tool deadline, which is now two minutes.
   *
   * Listening on the *response*, not the request. `IncomingMessage` emits `close` once its body has
   * been consumed, and Fastify has already parsed the body before this handler runs — a listener
   * attached here would be registered after the event had fired and would never run. `reply.raw`
   * emits `close` when the socket actually goes, and `writableEnded` distinguishes a client that
   * disappeared from a response this route finished sending.
   */
  const aborted = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableEnded) aborted.abort();
  });
  const context = request.mcpGatewayContext;
  /* v8 ignore next -- the preHandler always sets the context or answers. */
  if (!context) throw new McpGatewayError("unauthenticated", "MCP gateway authentication is required");
  const rpc = parseGatewayRequest(request.body);
  if (!rpc) {
    return reply.status(400).send(jsonRpcError(null, RPC_INVALID_REQUEST, "Invalid JSON-RPC request"));
  }
  const id = typeof rpc.id === "string" || typeof rpc.id === "number" ? rpc.id : null;

  let execution: Awaited<ReturnType<McpGatewayExecutionAuthorizer["authorize"]>>;
  try {
    execution = await options.authorizer.authorize({ executionId: context.executionId });
  } catch (error) {
    return sendGatewayFailure(reply, id, error, options);
  }

  const handlers = buildHandlers(options, execution.accountId, execution.agentId, aborted.signal);
  try {
    const outcome = await dispatchGatewayRequest(rpc, handlers);
    if (outcome.kind === "accepted") return reply.status(202).send();
    return reply.status(outcome.status).send(outcome.body);
  } catch (error) {
    return sendGatewayFailure(reply, id, error, options);
  }
}

/**
 * Bind the gateway service to one authorized execution.
 *
 * A tool call's failures are converted here rather than propagated, because by this point the model
 * is mid-turn: an unreachable upstream Server or a revoked credential is information it can act on,
 * while a transport error would end the turn over a condition the user can fix. Failures of the
 * *catalogue* still propagate — a client that cannot list tools has nothing to act on.
 */
function buildHandlers(
  options: McpGatewayRoutesOptions,
  accountId: string,
  agentId: string,
  signal: AbortSignal,
): McpGatewayHandlers {
  return {
    listTools: () => options.service.catalog(accountId, agentId),
    callTool: async (name, args) => {
      try {
        const { result } = await options.service.callTool({
          accountId,
          agentId,
          name,
          signal,
          ...(args ? { arguments: args } : {}),
        });
        return result;
      } catch (error) {
        // An abort is the caller's own doing, not something to describe back to it as a tool failure.
        const message = signal.aborted
          ? "The MCP tool call was cancelled"
          : error instanceof McpServiceError
            ? error.message
            : "The MCP tool call failed";
        options.logger?.warn?.({ code: "MCP_GATEWAY_TOOL_CALL_FAILED", agentId }, "An MCP gateway tool call failed");
        return toolErrorResult(message);
      }
    },
  };
}

function sendGatewayFailure(
  reply: FastifyReply,
  id: string | number | null,
  error: unknown,
  options: McpGatewayRoutesOptions,
): unknown {
  if (error instanceof McpGatewayError) {
    return reply.status(ERROR_STATUS[error.code]).send(jsonRpcError(id, RPC_INVALID_REQUEST, error.message));
  }
  if (error instanceof McpServiceError) {
    return reply.status(502).send(jsonRpcError(id, RPC_INTERNAL_ERROR, error.message));
  }
  /*
   * Fastify's own content-type failures — an unparseable body, an empty one, one past the size
   * bound. They are raised before the handler runs, so this is the only place they can be turned
   * back into JSON-RPC. The family is matched by prefix and the status taken from the error itself,
   * as the app's own handler does, rather than enumerating codes that shift between Fastify versions.
   */
  const code = (error as { code?: string } | null)?.code;
  if (error instanceof SyntaxError || (typeof code === "string" && code.startsWith("FST_ERR_CTP_"))) {
    const status = (error as { statusCode?: number }).statusCode;
    const bounded = typeof status === "number" && status >= 400 && status < 500 ? status : 400;
    return reply.status(bounded).send(jsonRpcError(id, RPC_PARSE_ERROR, "The request body could not be read"));
  }
  options.logger?.error?.({ code: "MCP_GATEWAY_REQUEST_FAILED" }, "An MCP gateway request failed");
  return reply.status(500).send(jsonRpcError(id, RPC_INTERNAL_ERROR, "Internal error"));
}
