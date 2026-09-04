import {
  AGENT_BY_ID_TEMPLATE,
  AGENT_COMPUTER_REBIND_TEMPLATE,
  AGENT_CONFIG_TEMPLATE,
  AGENT_REACTIVATE_TEMPLATE,
  AGENT_RUNTIME_TEST_TEMPLATE,
  AGENT_SETUP_REFRESH_TEMPLATE,
  AGENT_SETUP_TEMPLATE,
  AGENT_SUSPEND_TEMPLATE,
  AGENT_USAGE_TEMPLATE,
  AGENT_USAGE_WINDOW_DAYS,
  AgentAdminConfigSchema,
  AgentDetailSchema,
  AgentRuntimeTestRequestSchema,
  AgentRuntimeTestResponseSchema,
  AgentSetupSnapshotSchema,
  AgentUsageDetailSchema,
  AgentUsageWindowDaysSchema,
  RebindAgentComputerRequestSchema,
  UpdateAgentRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { AgentRuntimeTestService, AgentService, AgentSetupService } from "../services/agents/index.js";
import type { UserAuthService } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const AgentUsageQuerySchema = z
  .object({ days: z.coerce.number().pipe(AgentUsageWindowDaysSchema).default(AGENT_USAGE_WINDOW_DAYS) })
  .strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

function requestDisconnectSignal(
  request: FastifyRequest,
  reply: FastifyReply,
): { dispose(): void; signal: AbortSignal } {
  const controller = new AbortController();
  const abortIfDisconnected = () => {
    if (controller.signal.aborted || reply.sent || reply.raw.writableEnded) return;
    controller.abort();
  };
  if (request.raw.aborted || reply.raw.destroyed) abortIfDisconnected();
  request.raw.once("aborted", abortIfDisconnected);
  reply.raw.once("close", abortIfDisconnected);
  return {
    signal: controller.signal,
    dispose: () => {
      request.raw.off("aborted", abortIfDisconnected);
      reply.raw.off("close", abortIfDisconnected);
    },
  };
}

export function registerAgentRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  agentService: AgentService,
  authOptions?: UserAuthPreHandlerOptions,
  runtimeTest?: AgentRuntimeTestService,
  agentSetup?: AgentSetupService,
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions ?? {});

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

  if (agentSetup) {
    app.get(AGENT_SETUP_TEMPLATE, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(AgentParamsSchema, request.params);
      const snapshot = AgentSetupSnapshotSchema.parse(
        await agentSetup.getSetupById(authenticatedUserId(request), agentId),
      );
      reply.header("Cache-Control", "no-store");
      return reply.code(200).send(snapshot);
    });

    app.post(AGENT_SETUP_REFRESH_TEMPLATE, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(AgentParamsSchema, request.params);
      await agentSetup.refreshPreparationById(authenticatedUserId(request), agentId);
      return reply.header("Cache-Control", "no-store").code(204).send();
    });
  }

  if (!runtimeTest) return;

  app.post(AGENT_RUNTIME_TEST_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const input = parseRequest(AgentRuntimeTestRequestSchema, request.body);
    const disconnect = requestDisconnectSignal(request, reply);
    try {
      const response = AgentRuntimeTestResponseSchema.parse(
        await runtimeTest.test(authenticatedUserId(request), agentId, input, disconnect.signal),
      );
      return reply.code(200).send(response);
    } finally {
      disconnect.dispose();
    }
  });
}
