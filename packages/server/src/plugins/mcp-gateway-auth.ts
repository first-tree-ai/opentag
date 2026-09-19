import type { FastifyReply, FastifyRequest } from "fastify";
import type { RuntimeMcpGatewayTokenStore } from "../runtime-credentials/mcp-gateway-token-store.js";
import { jsonRpcError } from "../services/mcp/mcp-gateway-protocol.js";

export interface McpGatewayAuthContext {
  executionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    mcpGatewayContext?: McpGatewayAuthContext;
  }
}

/**
 * Bearer authentication for the MCP gateway route.
 *
 * Its own preHandler rather than an extension of `user-auth.ts`: that file's Bearer branch hands the
 * token straight to Better Auth's session lookup, and `AuthenticatedUser` has nowhere to carry a
 * principal that is not a signed-in person. Teaching it a second credential family would also mean
 * every existing `request.authContext` reader silently inherits a caller that is an Agent process.
 *
 * The context carries only the execution id. Account and Agent are resolved from the live execution
 * record by the fence, so an expired or forged token can never name a subject of its own.
 */
export function createMcpGatewayAuthPreHandler(tokens: RuntimeMcpGatewayTokenStore) {
  return async function mcpGatewayAuthPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    /*
     * The refusal is sent here rather than thrown. The app's error handler answers in OpenTag's
     * `{ error: { code, category, … } }` envelope, which an MCP client cannot read; this route's
     * caller is a provider CLI speaking JSON-RPC, so its 401 has to look like JSON-RPC too. Sending
     * from the preHandler also short-circuits the route, so the handler never runs unauthenticated.
     */
    const deny = () =>
      reply.status(401).send(jsonRpcError(null, RPC_INVALID_REQUEST, "MCP gateway authentication is required"));
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return deny();
    const token = authorization.slice("Bearer ".length).trim();
    if (!token) return deny();
    // An unknown, an expired, and a revoked token are one answer on purpose: the caller learns only
    // that it may not proceed, never whether the token was ever real.
    const record = tokens.resolve(token);
    if (!record) return deny();
    request.mcpGatewayContext = { executionId: record.executionId };
  };
}

const RPC_INVALID_REQUEST = -32600;
