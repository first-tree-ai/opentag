import {
  COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE,
  COMPUTER_AGENT_SKILLS_TEMPLATE,
  RuntimeSkillManifestSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import type { SkillService } from "../services/skills/index.js";
import { parseRequest } from "./request-validation.js";
import { sendSkillBundle } from "./skill-bundle.js";

/**
 * The Computer Skill surface, authenticated by a machine token.
 *
 * A Computer may be bound to several Agents, so it names the Agent it is syncing. The service
 * refuses an Agent that is not bound to this Computer, and the manifest lists enabled Skills only —
 * the Computer then fetches each bundle it does not already have and verifies its sha256.
 */

const AgentParamsSchema = z.object({ agentId: z.string().uuid() }).strict();
const AgentSkillParamsSchema = z.object({ agentId: z.string().uuid(), skillId: z.string().uuid() }).strict();

function computerId(request: FastifyRequest): string {
  const context = request.computerAuthContext;
  if (!context) throw new Error("Authenticated Computer context is missing");
  return context.computerId;
}

export function registerComputerSkillRoutes(
  app: FastifyInstance,
  machineAuth: ComputerAuthVerifier,
  skillService: SkillService,
): void {
  const preHandler = createComputerAuthPreHandler(machineAuth);

  app.get(COMPUTER_AGENT_SKILLS_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId } = parseRequest(AgentParamsSchema, request.params);
    const response = RuntimeSkillManifestSchema.parse(
      await skillService.manifestForComputer(computerId(request), agentId),
    );
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.get(COMPUTER_AGENT_SKILL_BUNDLE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { agentId, skillId } = parseRequest(AgentSkillParamsSchema, request.params);
    const bundle = await skillService.openBundleForComputer(computerId(request), agentId, skillId);
    return sendSkillBundle(reply, bundle);
  });
}
