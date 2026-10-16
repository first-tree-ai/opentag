import {
  AGENT_SLACK_CONFIGURATION_TEMPLATE,
  SaveSlackConfigurationRequestSchema,
  SlackAutoSetupRequestSchema,
  SlackAutoSetupResponseSchema,
  SlackConfigurationResultSchema,
  SlackConfigurationViewSchema,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { SlackAutoSetupService } from "../services/agents/slack-auto-setup-service.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { SlackConfigurationService } from "../services/im-bindings/slack/index.js";
import { parseRequest } from "./request-validation.js";

export interface SlackConfigurationRouteOptions {
  service: SlackConfigurationService;
  publicOrigin: string;
  officialSigningSecret?: string;
  autoSetup?: Pick<SlackAutoSetupService, "run">;
}

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();

export function registerSlackConfigurationRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: SlackConfigurationRouteOptions,
  authOptions: UserAuthPreHandlerOptions = {},
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions);
  app.post(`${AGENT_SLACK_CONFIGURATION_TEMPLATE}/auto`, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const userId = request.authContext?.me.user.id;
    if (!userId) throw new Error("Authenticated user context is missing");
    if (!options.autoSetup)
      return reply
        .header("cache-control", "no-store")
        .send(SlackAutoSetupResponseSchema.parse({ status: "failed", code: "capability_missing" }));
    const result = await options.autoSetup.run(
      userId,
      agentId,
      parseRequest(SlackAutoSetupRequestSchema, request.body),
    );
    return reply.header("cache-control", "no-store").send(SlackAutoSetupResponseSchema.parse(result));
  });
  app.get(AGENT_SLACK_CONFIGURATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const userId = request.authContext?.me.user.id;
    if (!userId) throw new Error("Authenticated user context is missing");
    const view = await options.service.view(userId, agentId, options.publicOrigin, options.officialSigningSecret);
    return reply.header("cache-control", "no-store").send(SlackConfigurationViewSchema.parse(view));
  });
  app.post(AGENT_SLACK_CONFIGURATION_TEMPLATE, { preHandler, bodyLimit: 16 * 1024 }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const input = parseRequest(SaveSlackConfigurationRequestSchema, request.body);
    const userId = request.authContext?.me.user.id;
    if (!userId) throw new Error("Authenticated user context is missing");
    const result = await options.service.configureToken(userId, agentId, input);
    return reply.header("cache-control", "no-store").code(200).send(SlackConfigurationResultSchema.parse(result));
  });
}
