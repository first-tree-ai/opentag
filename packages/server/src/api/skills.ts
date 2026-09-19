import {
  AGENT_SKILL_BUNDLE_TEMPLATE,
  AGENT_SKILL_TEMPLATE,
  AGENT_SKILLS_TEMPLATE,
  ListAgentSkillsResponseSchema,
  SkillDetailSchema,
  type SkillSource,
  UpdateSkillRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { SkillService } from "../services/skills/index.js";
import { parseRequest } from "./request-validation.js";
import { sendSkillBundle } from "./skill-bundle.js";
import { registerSkillUploadRoute } from "./skill-upload.js";

/**
 * The Account Skill surface: Web and the human CLI, authenticated by an Account session.
 *
 * A Skill is addressed under an Agent because it belongs to exactly one Agent. Uploads stream
 * through the shared octet-stream scope; every read response is re-parsed through the shared schema
 * and every bundle response is streamed with a no-store cache policy.
 */

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const AgentSkillParamsSchema = z.object({ agentId: z.string().uuid(), skillId: z.string().uuid() }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

/** A bearer token marks the human CLI; a browser session cookie marks the Web UI. */
function accountSkillSource(request: FastifyRequest): SkillSource {
  return request.headers.authorization?.startsWith("Bearer ") ? "cli_upload" : "web_upload";
}

export function registerSkillRoutes(
  app: FastifyInstance,
  skillService: SkillService,
  authService: UserAuthService,
  authOptions: UserAuthPreHandlerOptions = {},
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions);

  app.get(AGENT_SKILLS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = ListAgentSkillsResponseSchema.parse(
      await skillService.list(authenticatedUserId(request), agentId),
    );
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.get(AGENT_SKILL_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, skillId } = parseRequest(AgentSkillParamsSchema, request.params);
    const response = SkillDetailSchema.parse(await skillService.get(authenticatedUserId(request), agentId, skillId));
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.patch(AGENT_SKILL_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, skillId } = parseRequest(AgentSkillParamsSchema, request.params);
    const { enabled } = parseRequest(UpdateSkillRequestSchema, request.body);
    const response = SkillDetailSchema.parse(
      await skillService.setEnabled(authenticatedUserId(request), agentId, skillId, enabled),
    );
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.delete(AGENT_SKILL_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, skillId } = parseRequest(AgentSkillParamsSchema, request.params);
    await skillService.remove(authenticatedUserId(request), agentId, skillId);
    return reply.code(204).send();
  });

  app.get(AGENT_SKILL_BUNDLE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, skillId } = parseRequest(AgentSkillParamsSchema, request.params);
    const bundle = await skillService.openBundle(authenticatedUserId(request), agentId, skillId);
    return sendSkillBundle(reply, bundle);
  });

  registerSkillUploadRoute(app, {
    path: AGENT_SKILLS_TEMPLATE,
    authenticate: preHandler,
    upload: async (request, frame) => {
      const { agentId } = parseRequest(AgentParamsSchema, request.params);
      return SkillDetailSchema.parse(
        await skillService.upload(authenticatedUserId(request), agentId, {
          ...frame,
          source: accountSkillSource(request),
        }),
      );
    },
  });
}
