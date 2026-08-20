import {
  AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE,
  AGENT_INTEGRATION_TEMPLATE,
  CreateFeishuSetupAttemptRequestSchema,
  FEISHU_SETUP_ATTEMPT_TEMPLATE,
  FeishuSetupAttemptSchema,
  INTEGRATION_BY_ID_TEMPLATE,
  INTEGRATION_DIAGNOSTICS_TEMPLATE,
  IntegrationDiagnosticsSchema,
  IntegrationSummarySchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { FeishuSetupService } from "../services/integrations/feishu/index.js";
import type { IntegrationService } from "../services/integrations/index.js";
import { parseRequest } from "./request-validation.js";

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const IntegrationParamsSchema = z.object({ integrationId: z.string().uuid() }).strict();
const AttemptParamsSchema = z.object({ attemptId: z.string().uuid() }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerIntegrationRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  integrations: IntegrationService,
  feishu: FeishuSetupService | undefined,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.get(AGENT_INTEGRATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const integration = await integrations.getForAgent(authenticatedUserId(request), agentId);
    return integration ? reply.code(200).send(IntegrationSummarySchema.parse(integration)) : reply.code(204).send();
  });

  if (feishu) {
    app.post(AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(AgentParamsSchema, request.params);
      const input = parseRequest(CreateFeishuSetupAttemptRequestSchema, request.body ?? {});
      const attempt = await feishu.createOrReuse(authenticatedUserId(request), agentId, input.intent);
      return reply.code(201).send(FeishuSetupAttemptSchema.parse(attempt));
    });

    app.get(FEISHU_SETUP_ATTEMPT_TEMPLATE, { preHandler }, async (request, reply) => {
      const { attemptId } = parseRequest(AttemptParamsSchema, request.params);
      return reply
        .code(200)
        .send(FeishuSetupAttemptSchema.parse(await feishu.get(authenticatedUserId(request), attemptId)));
    });

    app.post(`${FEISHU_SETUP_ATTEMPT_TEMPLATE}/cancel`, { preHandler }, async (request, reply) => {
      const { attemptId } = parseRequest(AttemptParamsSchema, request.params);
      return reply
        .code(200)
        .send(FeishuSetupAttemptSchema.parse(await feishu.cancel(authenticatedUserId(request), attemptId)));
    });
  }

  app.post(`${INTEGRATION_BY_ID_TEMPLATE}/disable`, { preHandler }, async (request, reply) => {
    const { integrationId } = parseRequest(IntegrationParamsSchema, request.params);
    await integrations.disable(authenticatedUserId(request), integrationId);
    return reply.code(204).send();
  });

  app.get(INTEGRATION_DIAGNOSTICS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { integrationId } = parseRequest(IntegrationParamsSchema, request.params);
    return reply
      .code(200)
      .send(
        IntegrationDiagnosticsSchema.parse(await integrations.diagnostics(authenticatedUserId(request), integrationId)),
      );
  });
}
