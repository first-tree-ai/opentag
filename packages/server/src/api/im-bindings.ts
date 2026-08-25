import {
  AGENT_FEISHU_SETUP_ATTEMPTS_TEMPLATE,
  AGENT_IM_BINDING_CONFIG_TEMPLATE,
  AGENT_IM_BINDING_HANDOFF_TEMPLATE,
  AGENT_IM_BINDING_TEMPLATE,
  AGENT_SLACK_CONFIGURATION_TEMPLATE,
  ConfigureSlackAppRequestSchema,
  CreateFeishuSetupAttemptRequestSchema,
  FEISHU_SETUP_ATTEMPT_TEMPLATE,
  FeishuSetupAttemptSchema,
  IM_BINDING_BY_ID_TEMPLATE,
  IM_BINDING_DIAGNOSTICS_TEMPLATE,
  ImBindingAdminDetailSchema,
  ImBindingDiagnosticsSchema,
  ImBindingHandoffStatusSchema,
  ImBindingSummarySchema,
  SlackAppConfigurationSchema,
  SlackConfigurationResultSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { FeishuSetupService } from "../services/im-bindings/feishu/index.js";
import type { ImBindingService } from "../services/im-bindings/index.js";
import type { SlackConfigurationService } from "../services/im-bindings/slack/index.js";
import { parseRequest } from "./request-validation.js";

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const ImBindingParamsSchema = z.object({ imBindingId: z.string().uuid() }).strict();
const AttemptParamsSchema = z.object({ attemptId: z.string().uuid() }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerImBindingRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  imBindings: ImBindingService,
  feishu: FeishuSetupService | undefined,
  slack: SlackConfigurationService | undefined,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });

  app.get(AGENT_IM_BINDING_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const imBinding = await imBindings.getForAgent(authenticatedUserId(request), agentId);
    return imBinding ? reply.code(200).send(ImBindingSummarySchema.parse(imBinding)) : reply.code(204).send();
  });

  app.get(AGENT_IM_BINDING_HANDOFF_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const handoff = await imBindings.getHandoffForAgent(authenticatedUserId(request), agentId);
    return handoff ? reply.code(200).send(ImBindingHandoffStatusSchema.parse(handoff)) : reply.code(204).send();
  });

  app.get(AGENT_IM_BINDING_CONFIG_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const imBinding = await imBindings.getConfigForAgent(authenticatedUserId(request), agentId);
    return imBinding ? reply.code(200).send(ImBindingAdminDetailSchema.parse(imBinding)) : reply.code(204).send();
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

  if (slack) {
    app.get(AGENT_SLACK_CONFIGURATION_TEMPLATE, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(AgentParamsSchema, request.params);
      const configuration = await slack.get(authenticatedUserId(request), agentId);
      return reply.code(200).send(SlackAppConfigurationSchema.parse(configuration));
    });

    app.put(AGENT_SLACK_CONFIGURATION_TEMPLATE, { preHandler }, async (request, reply) => {
      const { agentId } = parseRequest(AgentParamsSchema, request.params);
      const input = parseRequest(ConfigureSlackAppRequestSchema, request.body);
      const configured = await slack.configure(authenticatedUserId(request), agentId, input);
      return reply.code(200).send(SlackConfigurationResultSchema.parse(configured));
    });
  }

  app.post(`${IM_BINDING_BY_ID_TEMPLATE}/disable`, { preHandler }, async (request, reply) => {
    const { imBindingId } = parseRequest(ImBindingParamsSchema, request.params);
    await imBindings.disable(authenticatedUserId(request), imBindingId);
    return reply.code(204).send();
  });

  app.get(IM_BINDING_DIAGNOSTICS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { imBindingId } = parseRequest(ImBindingParamsSchema, request.params);
    return reply
      .code(200)
      .send(ImBindingDiagnosticsSchema.parse(await imBindings.diagnostics(authenticatedUserId(request), imBindingId)));
  });
}
