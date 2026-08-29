import {
  AGENT_BY_ID_TEMPLATE,
  AGENT_COMPUTER_REBIND_TEMPLATE,
  AGENT_CONFIG_TEMPLATE,
  AGENT_REACTIVATE_TEMPLATE,
  AGENT_SUSPEND_TEMPLATE,
  AGENT_USAGE_TEMPLATE,
  AGENT_USAGE_WINDOW_DAYS,
  AgentAdminConfigSchema,
  AgentDetailSchema,
  AgentUsageDetailSchema,
  AgentUsageWindowDaysSchema,
  CreateAgentRequestSchema,
  ListAgentsResponseSchema,
  RebindAgentComputerRequestSchema,
  UpdateAgentRequestSchema,
  WORKSPACE_AGENTS_TEMPLATE,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { AgentService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

const WorkspaceParamsSchema = z.object({ workspaceId: z.string().uuid() }).strict();
const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const AgentUsageQuerySchema = z
  .object({ days: z.coerce.number().pipe(AgentUsageWindowDaysSchema).default(AGENT_USAGE_WINDOW_DAYS) })
  .strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerAgentRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  agentService: AgentService,
  authOptions?: UserAuthPreHandlerOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions ?? {});

  app.post(WORKSPACE_AGENTS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    const input = parseRequest(CreateAgentRequestSchema, request.body);
    const response = AgentAdminConfigSchema.parse(
      await agentService.createForWorkspace(authenticatedUserId(request), workspaceId, input),
    );
    return reply.code(201).send(response);
  });

  app.get(WORKSPACE_AGENTS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { workspaceId } = parseRequest(WorkspaceParamsSchema, request.params);
    const response = ListAgentsResponseSchema.parse(
      await agentService.listForWorkspace(authenticatedUserId(request), workspaceId),
    );
    return reply.code(200).send(response);
  });

  app.get(AGENT_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = AgentDetailSchema.parse(await agentService.getById(authenticatedUserId(request), agentId));
    return reply.code(200).send(response);
  });

  app.get(AGENT_USAGE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const { days } = parseRequest(AgentUsageQuerySchema, request.query);
    const response = AgentUsageDetailSchema.parse(
      await agentService.getUsageById(authenticatedUserId(request), agentId, days),
    );
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

  app.post(AGENT_SUSPEND_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = AgentAdminConfigSchema.parse(
      await agentService.suspendById(authenticatedUserId(request), agentId),
    );
    return reply.code(200).send(response);
  });

  app.post(AGENT_REACTIVATE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = AgentAdminConfigSchema.parse(
      await agentService.reactivateById(authenticatedUserId(request), agentId),
    );
    return reply.code(200).send(response);
  });

  app.post(AGENT_COMPUTER_REBIND_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const { computerId } = parseRequest(RebindAgentComputerRequestSchema, request.body);
    const response = AgentAdminConfigSchema.parse(
      await agentService.rebindById(authenticatedUserId(request), agentId, computerId),
    );
    return reply.code(200).send(response);
  });

  app.delete(AGENT_BY_ID_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    await agentService.deleteById(authenticatedUserId(request), agentId);
    return reply.code(204).send();
  });
}
