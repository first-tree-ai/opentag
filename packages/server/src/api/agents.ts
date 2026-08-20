import {
  AGENT_BY_ID_TEMPLATE,
  AGENT_CONFIG_TEMPLATE,
  AgentAdminConfigSchema,
  AgentDetailSchema,
  CreateAgentRequestSchema,
  ListAgentsResponseSchema,
  TEAM_AGENTS_TEMPLATE,
  UpdateAgentRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

const TeamParamsSchema = z.object({ teamId: z.string().uuid() }).strict();
const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  agentService: AgentService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.post(TEAM_AGENTS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    const input = parseRequest(CreateAgentRequestSchema, request.body);
    const response = AgentAdminConfigSchema.parse(
      await agentService.createForTeam(authenticatedUserId(request), teamId, input),
    );
    return reply.code(201).send(response);
  });

  app.get(TEAM_AGENTS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { teamId } = parseRequest(TeamParamsSchema, request.params);
    const response = ListAgentsResponseSchema.parse(
      await agentService.listForTeam(authenticatedUserId(request), teamId),
    );
    return reply.code(200).send(response);
  });

  app.get(AGENT_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = AgentDetailSchema.parse(await agentService.getById(authenticatedUserId(request), agentId));
    return reply.code(200).send(response);
  });

  app.get(AGENT_CONFIG_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = AgentAdminConfigSchema.parse(
      await agentService.getConfigById(authenticatedUserId(request), agentId),
    );
    return reply.code(200).send(response);
  });

  app.patch(AGENT_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const input = parseRequest(UpdateAgentRequestSchema, request.body);
    const response = AgentAdminConfigSchema.parse(
      await agentService.updateById(authenticatedUserId(request), agentId, input),
    );
    return reply.code(200).send(response);
  });

  app.delete(AGENT_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    await agentService.deleteById(authenticatedUserId(request), agentId);
    return reply.code(204).send();
  });
}
