import {
  AgentAdminConfigSchema,
  AttachMCPServerRequestSchema,
  ListAgentMCPServersResponseSchema,
  ListAvailableMCPServersResponseSchema,
  MCPAgentServerSchema,
  RUNTIME_AGENT_MCP_SERVER_TEMPLATE,
  RUNTIME_AGENT_MCP_SERVERS_AVAILABLE_PATH,
  RUNTIME_AGENT_MCP_SERVERS_PATH,
  RUNTIME_AGENT_PATH,
  SESSION_CLI_PROOF_HEADER,
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
 */

export interface RuntimeAgentRoutesOptions {
  service: Pick<
    AgentSelfService,
    | "attachMcpServer"
    | "authenticate"
    | "detachMcpServer"
    | "getConfig"
    | "listAvailableMcpServers"
    | "listMcpServers"
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

  function authenticate(request: FastifyRequest) {
    const header = request.headers[SESSION_CLI_PROOF_HEADER];
    return service.authenticate(typeof header === "string" ? header : "");
  }
}
