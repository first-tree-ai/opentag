import {
  AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE,
  AGENT_SKILLS_INSTALL_TEMPLATE,
  InstallRemoteSkillsRequestSchema,
  ResolveRemoteSkillsRequestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { RemoteSkillService } from "../services/skills/source/remote-skill-service.js";
import { parseRequest } from "./request-validation.js";

/**
 * The Account-facing remote-install surface: preview a source, install a selection.
 *
 * Both routes are separate resources rather than extra verbs on the Skills collection, because
 * neither of them is an archive upload: one reads an external address and writes nothing, and the
 * other names Skills the source publishes. They sit outside the octet-stream scope
 * `skill-upload.ts` installs, so a JSON body keeps the usual Fastify parser.
 *
 * Every failure these handlers can raise is a `SkillServiceError`, which the root Account-facing
 * error handler already renders as the shared envelope — including the source codes, because
 * `SKILL_ERROR_CODES` is what that envelope validates against.
 */

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerRemoteSkillRoutes(
  app: FastifyInstance,
  remote: RemoteSkillService,
  authService: UserAuthService,
  authOptions: UserAuthPreHandlerOptions = {},
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions);

  app.post(AGENT_SKILLS_INSTALL_RESOLVE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const { source } = parseRequest(ResolveRemoteSkillsRequestSchema, request.body);
    const response = await remote.resolve({ callerUserId: authenticatedUserId(request), agentId, source });
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.post(AGENT_SKILLS_INSTALL_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const { source, selections } = parseRequest(InstallRemoteSkillsRequestSchema, request.body);
    const response = await remote.install({
      callerUserId: authenticatedUserId(request),
      agentId,
      source,
      selections,
    });
    return reply.header("cache-control", "no-store").code(200).send(response);
  });
}
