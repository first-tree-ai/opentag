import {
  AGENT_IM_FEEDBACK_TEMPLATE,
  IM_FEEDBACK_ACTIONS_TEMPLATE,
  IM_FEEDBACK_DESTINATION_TEMPLATE,
  IM_FEEDBACK_TEMPLATE,
  ImFeedbackActionRequestSchema,
  ImFeedbackListSchema,
  ImFeedbackViewSchema,
} from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ImFeedbackActionsService } from "../services/im/im-feedback-actions.js";
import { parseRequest } from "./request-validation.js";

const Params = z.object({ feedbackId: z.string().uuid() }).strict();
export function registerImFeedbackRoutes(
  app: FastifyInstance,
  auth: UserAuthService,
  service: ImFeedbackActionsService,
  options: UserAuthPreHandlerOptions,
) {
  const preHandler = createUserAuthPreHandler(auth, options);
  app.get(AGENT_IM_FEEDBACK_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(z.object({ agentId: z.string().uuid() }).strict(), request.params);
    const { cursor } = parseRequest(z.object({ cursor: z.string().uuid().optional() }).strict(), request.query);
    const accountId = request.authContext?.me.user.id;
    if (!accountId) return reply.code(401).send();
    return reply
      .header("Cache-Control", "no-store")
      .send(ImFeedbackListSchema.parse(await service.listForAccount(accountId, agentId, cursor)));
  });
  app.get(IM_FEEDBACK_TEMPLATE, { preHandler }, async (request, reply) => {
    const { feedbackId } = parseRequest(Params, request.params);
    const accountId = request.authContext?.me.user.id;
    if (!accountId) return reply.code(401).send();
    return reply
      .header("Cache-Control", "no-store")
      .send(ImFeedbackViewSchema.parse(await service.getForAccount(accountId, feedbackId)));
  });
  app.get(IM_FEEDBACK_DESTINATION_TEMPLATE, { preHandler }, async (request, reply) => {
    const { feedbackId } = parseRequest(Params, request.params);
    const accountId = request.authContext?.me.user.id;
    if (!accountId) return reply.code(401).send();
    return reply.header("Cache-Control", "no-store").send(await service.destinationForAccount(accountId, feedbackId));
  });
  app.post(IM_FEEDBACK_ACTIONS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { feedbackId } = parseRequest(Params, request.params);
    const input = parseRequest(ImFeedbackActionRequestSchema, request.body);
    const accountId = request.authContext?.me.user.id;
    if (!accountId) return reply.code(401).send();
    return reply
      .header("Cache-Control", "no-store")
      .code(202)
      .send(ImFeedbackViewSchema.parse(await service.submitForAccount(accountId, feedbackId, input)));
  });
}
