import {
  AgentAdminConfigSchema,
  AttachMCPServerRequestSchema,
  CreateSelfMCPServerRequestSchema,
  ListAgentMCPServersResponseSchema,
  ListAvailableMCPServersResponseSchema,
  MCPAgentServerSchema,
  RUNTIME_AGENT_MCP_SERVER_CREDENTIALS_TEMPLATE,
  RUNTIME_AGENT_MCP_SERVER_DEFINITION_TEMPLATE,
  RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH,
  RUNTIME_AGENT_MCP_SERVER_OAUTH_START_TEMPLATE,
  RUNTIME_AGENT_MCP_SERVER_OAUTH_STATUS_TEMPLATE,
  RUNTIME_AGENT_MCP_SERVER_TEMPLATE,
  RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH,
  RUNTIME_AGENT_MCP_SERVERS_PATH,
  RUNTIME_AGENT_PATH,
  SESSION_CLI_PROOF_HEADER,
  SelfMCPOAuthStatusSchema,
  SetSelfMCPCredentialRequestSchema,
  StartMCPOAuthRequestSchema,
  StartMCPOAuthResponseSchema,
  UpdateSelfAgentRequestSchema,
  UpdateSelfMCPBindingRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AgentSelfService } from "../services/agents/index.js";
import { parseRequest } from "./request-validation.js";

/**
 * The Agent self-configuration surface, authenticated by the Session CLI proof.
 *
 * No route takes an Agent id: the Agent is always the one the proof resolves to. Proof validation
 * happens inside the service before any request body is interpreted.
 *
 * The MCP routes are split by what they address. `/mcp-servers` and `/mcp-servers/available` read
 * the mounts; `/mcp-servers/definitions` registers a new definition and mounts it; `/:mcpServerId`
 * addresses one mount; `/:mcpServerId/definition` drops both the mount and, when nothing else mounts
 * it, the definition. Credentials and OAuth live under the mount they belong to, because a
 * credential is per Agent and a Server-scoped credential route could not say whose it was.
 */

export interface RuntimeAgentRoutesOptions {
  service: Pick<
    AgentSelfService,
    | "attachMcpServer"
    | "authenticate"
    | "createMcpServer"
    | "deleteMcpServer"
    | "detachMcpServer"
    | "getConfig"
    | "getMcpOAuthStatus"
    | "listAvailableMcpServers"
    | "listMcpServers"
    | "setMcpBearerKey"
    | "startMcpOAuth"
    | "updateConfig"
    | "updateMcpBinding"
  >;
}

const ServerParamsSchema = z.object({ mcpServerId: z.string().uuid() }).strict();

export function registerRuntimeAgentRoutes(app: FastifyInstance, options: RuntimeAgentRoutesOptions): void {
  const { service } = options;

  app.get(RUNTIME_AGENT_PATH, async (request, reply) => {
    const response = AgentAdminConfigSchema.parse(await service.getConfig(await authenticate(request)));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.patch(RUNTIME_AGENT_PATH, async (request, reply) => {
    const scope = await authenticate(request);
    const input = parseRequest(UpdateSelfAgentRequestSchema, request.body);
    const response = AgentAdminConfigSchema.parse(await service.updateConfig(scope, input));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.get(RUNTIME_AGENT_MCP_SERVERS_PATH, async (request, reply) => {
    const response = ListAgentMCPServersResponseSchema.parse({
      servers: await service.listMcpServers(await authenticate(request)),
    });
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.get(RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH, async (request, reply) => {
    const response = ListAvailableMCPServersResponseSchema.parse({
      servers: await service.listAvailableMcpServers(await authenticate(request)),
    });
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(RUNTIME_AGENT_MCP_SERVER_DEFINITIONS_PATH, async (request, reply) => {
    const scope = await authenticate(request);
    const input = parseRequest(CreateSelfMCPServerRequestSchema, request.body);
    const response = MCPAgentServerSchema.parse(await service.createMcpServer(scope, input));
    return reply.header("Cache-Control", "no-store").code(201).send(response);
  });

  app.post(RUNTIME_AGENT_MCP_SERVERS_PATH, async (request, reply) => {
    const scope = await authenticate(request);
    const input = parseRequest(AttachMCPServerRequestSchema, request.body);
    const response = MCPAgentServerSchema.parse(await service.attachMcpServer(scope, input.mcpServerId, input.enabled));
    return reply.header("Cache-Control", "no-store").code(201).send(response);
  });

  app.patch(RUNTIME_AGENT_MCP_SERVER_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    const input = parseRequest(UpdateSelfMCPBindingRequestSchema, request.body);
    const response = MCPAgentServerSchema.parse(await service.updateMcpBinding(scope, mcpServerId, input));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.delete(RUNTIME_AGENT_MCP_SERVER_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    await service.detachMcpServer(scope, mcpServerId);
    return reply.header("Cache-Control", "no-store").code(204).send();
  });

  app.delete(RUNTIME_AGENT_MCP_SERVER_DEFINITION_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    await service.deleteMcpServer(scope, mcpServerId);
    return reply.header("Cache-Control", "no-store").code(204).send();
  });

  app.post(RUNTIME_AGENT_MCP_SERVER_CREDENTIALS_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    const input = parseRequest(SetSelfMCPCredentialRequestSchema, request.body);
    const response = MCPAgentServerSchema.parse(await service.setMcpBearerKey(scope, mcpServerId, input.apiKey));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.post(RUNTIME_AGENT_MCP_SERVER_OAUTH_START_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    const input = parseRequest(StartMCPOAuthRequestSchema, request.body ?? {});
    const response = StartMCPOAuthResponseSchema.parse(await service.startMcpOAuth(scope, mcpServerId, input));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  app.get(RUNTIME_AGENT_MCP_SERVER_OAUTH_STATUS_TEMPLATE, async (request, reply) => {
    const scope = await authenticate(request);
    const { mcpServerId } = parseRequest(ServerParamsSchema, request.params);
    const response = SelfMCPOAuthStatusSchema.parse(await service.getMcpOAuthStatus(scope, mcpServerId));
    return reply.header("Cache-Control", "no-store").code(200).send(response);
  });

  function authenticate(request: FastifyRequest) {
    const header = request.headers[SESSION_CLI_PROOF_HEADER];
    return service.authenticate(typeof header === "string" ? header : "");
  }
}
