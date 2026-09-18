/*
 * Account-facing MCP management routes.
 *
 * Two scopes, and the URL says which: Server definitions and the aggregate view live on the Account
 * pool (`/api/v1/mcp-servers`), while every mount, override, authorization, and probe is addressed
 * under the Agent that owns it (`/api/v1/agents/:agentId/mcp-servers/...`). That is not decoration:
 * authorization is strictly per Agent, so a Server-scoped authorization route would have no way to
 * say whose credential it was writing.
 *
 * Every route requires an authenticated Account through the shared user-auth preHandler. Responses
 * are the shared safe DTOs only: no bearer key, no ciphertext or key ID, no OAuth state or PKCE
 * material, and no access or refresh token. A caller learns only whether a credential exists.
 */

import {
  AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE,
  AGENT_MCP_AUTHORIZATION_TEMPLATE,
  AGENT_MCP_PROBE_TEMPLATE,
  AGENT_MCP_SERVER_TEMPLATE,
  AGENT_MCP_SERVERS_TEMPLATE,
  AttachMCPServerRequestSchema,
  CreateMCPServerRequestSchema,
  ListAgentMCPServersResponseSchema,
  ListAvailableMCPServersResponseSchema,
  ListMCPServersResponseSchema,
  MCP_OAUTH_CALLBACK_PATH,
  MCP_SERVER_BY_ID_TEMPLATE,
  MCP_SERVERS_PATH,
  MCPProbeResponseSchema,
  MCPServerDetailSchema,
  MCPServerSchema,
  SetMCPAuthorizationRequestSchema,
  StartMCPOAuthRequestSchema,
  StartMCPOAuthResponseSchema,
  UpdateMCPBindingRequestSchema,
  UpdateMCPServerRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import { setMcpOAuthContextCookie } from "../services/auth/browser-cookies.js";
import { generateSecret, type UserAuthService } from "../services/auth/index.js";
import type { McpAuthorizationService, McpOAuthFlowService, McpServerService } from "../services/mcp/index.js";
import { parseRequest } from "./request-validation.js";

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const ServerParamsSchema = z.object({ mcpServerId: z.string().uuid() }).strict();
const AgentServerParamsSchema = z.object({ agentId: z.string().uuid(), mcpServerId: z.string().uuid() }).strict();

export interface McpServerRoutesOptions {
  authOptions?: UserAuthPreHandlerOptions;
  authorization: McpAuthorizationService;
  flows: McpOAuthFlowService;
  secureCookies: boolean;
  servers: McpServerService;
}

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerMcpServerRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: McpServerRoutesOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, options.authOptions ?? {});
  const { authorization, flows, servers } = options;

  // ------------------------------------------------------------ Account pool

  app.get(MCP_SERVERS_PATH, { preHandler }, async (request, reply) => {
    const response = ListMCPServersResponseSchema.parse({
      servers: await servers.listServers(authenticatedUserId(request)),
    });
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(MCP_SERVERS_PATH, { preHandler }, async (request, reply) => {
    const input = parseRequest(CreateMCPServerRequestSchema, request.body);
    const server = await servers.createServer(authenticatedUserId(request), input);
    return reply.code(201).send(MCPServerSchema.parse(server));
  });

  app.get(MCP_SERVER_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    const response = MCPServerDetailSchema.parse(
      await servers.getServerDetail(authenticatedUserId(request), mcpServerId),
    );
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.patch(MCP_SERVER_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    const input = parseRequest(UpdateMCPServerRequestSchema, request.body);
    const server = await servers.updateServer(authenticatedUserId(request), mcpServerId, input);
    return reply.code(200).send(MCPServerSchema.parse(server));
  });

  app.delete(MCP_SERVER_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    await servers.deleteServer(authenticatedUserId(request), mcpServerId);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ Per-Agent mounts

  app.get(AGENT_MCP_SERVERS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = ListAgentMCPServersResponseSchema.parse({
      servers: await servers.listAgentServers(authenticatedUserId(request), agentId),
    });
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.get(`${AGENT_MCP_SERVERS_TEMPLATE}/available`, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = ListAvailableMCPServersResponseSchema.parse({
      servers: await servers.listAvailableServers(authenticatedUserId(request), agentId),
    });
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(AGENT_MCP_SERVERS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const input = parseRequest(AttachMCPServerRequestSchema, request.body);
    const mounted = await servers.attachServer(authenticatedUserId(request), agentId, input.mcpServerId, input.enabled);
    return reply.code(201).send(mounted);
  });

  app.patch(AGENT_MCP_SERVER_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, mcpServerId } = parseRequest(AgentServerParamsSchema, request.params);
    const input = parseRequest(UpdateMCPBindingRequestSchema, request.body);
    const mounted = await servers.updateBinding(authenticatedUserId(request), agentId, mcpServerId, input);
    return reply.code(200).send(mounted);
  });

  app.delete(AGENT_MCP_SERVER_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, mcpServerId } = parseRequest(AgentServerParamsSchema, request.params);
    await servers.detachServer(authenticatedUserId(request), agentId, mcpServerId);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------ Per-Agent authorization

  app.put(AGENT_MCP_AUTHORIZATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, mcpServerId } = parseRequest(AgentServerParamsSchema, request.params);
    const input = parseRequest(SetMCPAuthorizationRequestSchema, request.body);
    await authorization.setBearerOrNone(authenticatedUserId(request), agentId, mcpServerId, {
      kind: input.kind,
      ...(input.bearerKey === undefined ? {} : { bearerKey: input.bearerKey }),
    });
    // The write landed; the probe runs backstage so a 10-second upstream call does not block this
    // response. `probeState` on the row is what tells the caller a result is still coming.
    void authorization.probe(authenticatedUserId(request), agentId, mcpServerId).catch(() => undefined);
    return reply.code(200).send(await servers.readAgentServer(authenticatedUserId(request), agentId, mcpServerId));
  });

  app.delete(AGENT_MCP_AUTHORIZATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, mcpServerId } = parseRequest(AgentServerParamsSchema, request.params);
    const userId = authenticatedUserId(request);
    await authorization.revoke(userId, agentId, mcpServerId);
    return reply.code(200).send(await servers.readAgentServer(userId, agentId, mcpServerId));
  });

  app.post(AGENT_MCP_AUTHORIZATION_OAUTH_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, mcpServerId } = parseRequest(AgentServerParamsSchema, request.params);
    const input = parseRequest(StartMCPOAuthRequestSchema, request.body ?? {});
    /*
     * The browser is handed a secret at start and must present it at the callback. Without this the
     * flow would be redeemable by anyone holding the `authorizationUrl`, because the state alone
     * cannot tell the initiating browser from one the URL was forwarded to.
     */
    const flowSecret = generateSecret(32);
    const started = await flows.start(
      authenticatedUserId(request),
      agentId,
      mcpServerId,
      input.scopes ?? [],
      flowSecret,
    );
    setMcpOAuthContextCookie(reply, flowSecret, {
      path: MCP_OAUTH_CALLBACK_PATH,
      secure: options.secureCookies,
    });
    return reply.code(200).send(
      StartMCPOAuthResponseSchema.parse({
        authorizationUrl: started.authorizationUrl,
        expiresAt: started.expiresAt.toISOString(),
      }),
    );
  });

  app.post(AGENT_MCP_PROBE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, mcpServerId } = parseRequest(AgentServerParamsSchema, request.params);
    const userId = authenticatedUserId(request);
    await servers.requireAgentBinding(userId, agentId, mcpServerId);
    const outcome = await authorization.probe(userId, agentId, mcpServerId);
    return reply.code(200).send(
      MCPProbeResponseSchema.parse({
        ...outcome,
      }),
    );
  });
}
