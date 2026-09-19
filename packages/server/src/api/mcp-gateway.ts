import { MCP_GATEWAY_PATH, MCP_GATEWAY_REQUEST_MAX_BYTES, type McpGatewayErrorCode } from "@opentag/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
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
  invalid_request: 400,
  request_too_large: 413,
  protocol_unsupported: 400,
  tool_unknown: 404,
  tool_ambiguous: 409,
  catalog_unavailable: 503,
  result_too_large: 502,
  timeout: 504,
  unknown: 500,
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
  app.post(
    MCP_GATEWAY_PATH,
    { preHandler: authPreHandler, bodyLimit: MCP_GATEWAY_REQUEST_MAX_BYTES },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const context = request.mcpGatewayContext;
      /* v8 ignore next -- the preHandler always sets the context or throws. */
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

      const handlers = buildHandlers(options, execution.accountId, execution.agentId);
      try {
        const outcome = await dispatchGatewayRequest(rpc, handlers);
        if (outcome.kind === "accepted") return reply.status(202).send();
        return reply.status(outcome.status).send(outcome.body);
      } catch (error) {
        return sendGatewayFailure(reply, id, error, options);
      }
    },
  );
}

/**
 * Bind the gateway service to one authorized execution.
 *
 * A tool call's failures are converted here rather than propagated, because by this point the model
 * is mid-turn: an unreachable upstream Server or a revoked credential is information it can act on,
 * while a transport error would end the turn over a condition the user can fix. Failures of the
 * *catalogue* still propagate — a client that cannot list tools has nothing to act on.
 */
function buildHandlers(options: McpGatewayRoutesOptions, accountId: string, agentId: string): McpGatewayHandlers {
  return {
    listTools: () => options.service.catalog(accountId, agentId),
    callTool: async (name, args) => {
      try {
        const { result } = await options.service.callTool({
          accountId,
          agentId,
          name,
          ...(args ? { arguments: args } : {}),
        });
        return result;
      } catch (error) {
        const message = error instanceof McpServiceError ? error.message : "The MCP tool call failed";
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
  if (error instanceof SyntaxError) {
    return reply.status(400).send(jsonRpcError(id, RPC_PARSE_ERROR, "The request body is not valid JSON"));
  }
  options.logger?.error?.({ code: "MCP_GATEWAY_REQUEST_FAILED" }, "An MCP gateway request failed");
  return reply.status(500).send(jsonRpcError(id, RPC_INTERNAL_ERROR, "Internal error"));
}
