import {
  AGENT_SKILL_PRESET_INSTALL_TEMPLATE,
  AGENT_SKILL_PRESETS_TEMPLATE,
  InstallSkillPresetResponseSchema,
  ListSkillPresetsResponseSchema,
  SkillNameSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { SkillPresetService } from "../services/skills/index.js";
import { parseRequest } from "./request-validation.js";

/**
 * The Account-facing preset catalog surface: browse the catalog, install or update one preset.
 *
 * The paths are sibling resources of the Agent's Skills rather than verbs on the collection — the
 * catalog is global while its install state is per Agent, and neither call uploads an archive, so
 * they stay outside the octet-stream scope `skill-upload.ts` installs. Every failure is a
 * `SkillServiceError`, which the Account error handler renders as the shared envelope.
 */

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const AgentPresetParamsSchema = z.object({ agentId: z.string().uuid(), presetName: SkillNameSchema }).strict();

function authenticatedUserId(request: FastifyRequest): string {
  const userId = request.authContext?.me.user.id;
  if (!userId) throw new Error("Authenticated user context is missing");
  return userId;
}

export function registerSkillPresetRoutes(
  app: FastifyInstance,
  presetService: SkillPresetService,
  authService: UserAuthService,
  authOptions: UserAuthPreHandlerOptions = {},
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions);

  app.get(AGENT_SKILL_PRESETS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = ListSkillPresetsResponseSchema.parse(
      await presetService.list(authenticatedUserId(request), agentId),
    );
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.post(AGENT_SKILL_PRESET_INSTALL_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, presetName } = parseRequest(AgentPresetParamsSchema, request.params);
    const response = InstallSkillPresetResponseSchema.parse(
      await presetService.install(authenticatedUserId(request), agentId, presetName),
    );
    return reply.header("cache-control", "no-store").code(200).send(response);
  });
}
