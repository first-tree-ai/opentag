import {
  ACCOUNT_SKILLS_PATH,
  AGENT_SKILLS_TEMPLATE,
  AgentSkillAssignmentRequestSchema,
  AgentSkillsResponseSchema,
  ListSkillsResponseSchema,
  SKILL_AGENTS_TEMPLATE,
  SKILL_ARCHIVE_TEMPLATE,
  SKILL_BY_NAME_TEMPLATE,
  SKILL_SKILL_MD_TEMPLATE,
  SkillAgentsResponseSchema,
  SkillDetailSchema,
  SkillListQuerySchema,
  SkillNameSchema,
  SkillUploadQuerySchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import { parseRequest } from "./request-validation.js";
import {
  notifySkillChange,
  registerZipContentTypeParser,
  requireSkillServices,
  requireZipContentType,
  type SkillRouteServices,
  sendSkillArchive,
  zipBody,
} from "./skill-routes-shared.js";

export interface SkillRoutesOptions extends SkillRouteServices {
  authOptions?: UserAuthPreHandlerOptions;
}

const SkillNameParamsSchema = z.object({ name: SkillNameSchema }).strict();
const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

/** Account-facing skill library: upload, inspect, download, delete, and assign skills to the caller's agents. */
export function registerSkillRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  options: SkillRoutesOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, options.authOptions ?? {});
  registerZipContentTypeParser(app);

  app.get(ACCOUNT_SKILLS_PATH, { preHandler }, async (request, reply) => {
    const { skills } = requireSkillServices(options);
    const query = parseRequest(SkillListQuerySchema, request.query);
    return reply.code(200).send(ListSkillsResponseSchema.parse(await skills.list(authenticatedUserId(request), query)));
  });

  app.post(ACCOUNT_SKILLS_PATH, { onRequest: requireZipContentType, preHandler }, async (request, reply) => {
    const { skills } = requireSkillServices(options);
    const userId = authenticatedUserId(request);
    const { onConflict } = parseRequest(SkillUploadQuerySchema, request.query);
    const result = await skills.upsertFromArchive(userId, zipBody(request), {
      onConflict,
      updatedBy: { kind: "user", id: userId },
    });
    await notifySkillChange(request, options.notifier, result.affectedAgentIds);
    return reply.code(result.created ? 201 : 200).send(SkillDetailSchema.parse(result.skill));
  });

  app.get(SKILL_BY_NAME_TEMPLATE, { preHandler }, async (request, reply) => {
    const { skills } = requireSkillServices(options);
    const { name } = parseRequest(SkillNameParamsSchema, request.params);
    return reply.code(200).send(SkillDetailSchema.parse(await skills.get(authenticatedUserId(request), name)));
  });

  app.get(SKILL_SKILL_MD_TEMPLATE, { preHandler }, async (request, reply) => {
    const { skills } = requireSkillServices(options);
    const { name } = parseRequest(SkillNameParamsSchema, request.params);
    const { markdown } = await skills.getSkillMd(authenticatedUserId(request), name);
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", 'inline; filename="SKILL.md"');
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "private, no-cache");
    return reply.code(200).send(markdown);
  });

  app.get(SKILL_ARCHIVE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { skills } = requireSkillServices(options);
    const { name } = parseRequest(SkillNameParamsSchema, request.params);
    return sendSkillArchive(request, reply, await skills.openArchive(authenticatedUserId(request), name));
  });

  app.delete(SKILL_BY_NAME_TEMPLATE, { preHandler }, async (request, reply) => {
    const { skills } = requireSkillServices(options);
    const { name } = parseRequest(SkillNameParamsSchema, request.params);
    const { affectedAgentIds } = await skills.delete(authenticatedUserId(request), name);
    await notifySkillChange(request, options.notifier, affectedAgentIds);
    return reply.code(204).send();
  });

  app.get(SKILL_AGENTS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { assignments } = requireSkillServices(options);
    const { name } = parseRequest(SkillNameParamsSchema, request.params);
    const response = await assignments.agentsForSkill(authenticatedUserId(request), name);
    return reply.code(200).send(SkillAgentsResponseSchema.parse(response));
  });

  app.get(AGENT_SKILLS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { assignments } = requireSkillServices(options);
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = await assignments.listForAgent(authenticatedUserId(request), agentId);
    return reply.code(200).send(AgentSkillsResponseSchema.parse(response));
  });

  app.put(AGENT_SKILLS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { assignments } = requireSkillServices(options);
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const { skillNames } = parseRequest(AgentSkillAssignmentRequestSchema, request.body);
    const response = await assignments.replaceForAgent(authenticatedUserId(request), agentId, skillNames);
    await notifySkillChange(request, options.notifier, [agentId]);
    return reply.code(200).send(AgentSkillsResponseSchema.parse(response));
  });
}
