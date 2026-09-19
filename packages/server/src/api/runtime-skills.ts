import {
  HTTP_PATHS,
  ListAgentSkillsResponseSchema,
  RUNTIME_SKILL_BUNDLE_TEMPLATE,
  SESSION_CLI_PROOF_HEADER,
  SkillDetailSchema,
  SkillNameSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { SessionCliProofService } from "../services/sessions/session-cli-proof-service.js";
import type { SkillService } from "../services/skills/index.js";
import { parseRequest } from "./request-validation.js";
import { sendSkillBundle } from "./skill-bundle.js";
import { registerSkillUploadRoute } from "./skill-upload.js";

/**
 * The Agent CLI Skill surface, authenticated by the Session CLI proof file.
 *
 * This surface deliberately takes no Agent id in the path or body: the Agent is always the one the
 * session proof resolves to, so a request can never address a different Agent. Listing and uploads
 * are scoped to that Agent, and an uploaded Skill lands under the `agent_upload` source.
 */

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the session-proof authentication step before the body parser. */
    skillAgentId?: string;
  }
}

const BundleParamsSchema = z.object({ name: SkillNameSchema }).strict();

async function authenticate(request: FastifyRequest, proofs: Pick<SessionCliProofService, "authenticate">) {
  const header = request.headers[SESSION_CLI_PROOF_HEADER];
  const source = await proofs.authenticate(typeof header === "string" ? header : "");
  request.skillAgentId = source.agentId;
}

function authenticatedAgentId(request: FastifyRequest): string {
  const agentId = request.skillAgentId;
  if (!agentId) throw new Error("Authenticated Agent context is missing");
  return agentId;
}

export function registerRuntimeSkillRoutes(
  app: FastifyInstance,
  skillService: SkillService,
  proofs: Pick<SessionCliProofService, "authenticate">,
): void {
  app.get(HTTP_PATHS.runtimeSkills, async (request, reply) => {
    const source = await proofs.authenticate(readProof(request));
    const response = ListAgentSkillsResponseSchema.parse(await skillService.listForAgent(source.agentId));
    return reply.header("cache-control", "no-store").code(200).send(response);
  });

  app.get(RUNTIME_SKILL_BUNDLE_TEMPLATE, async (request, reply) => {
    const source = await proofs.authenticate(readProof(request));
    const { name } = parseRequest(BundleParamsSchema, request.params);
    const bundle = await skillService.openBundleForAgent(source.agentId, name);
    return sendSkillBundle(reply, bundle);
  });

  registerSkillUploadRoute(app, {
    path: HTTP_PATHS.runtimeSkills,
    authenticate: async (request) => {
      await authenticate(request, proofs);
    },
    upload: async (request, frame) => {
      return SkillDetailSchema.parse(await skillService.uploadForAgent(authenticatedAgentId(request), frame));
    },
  });
}

function readProof(request: FastifyRequest): string {
  const header = request.headers[SESSION_CLI_PROOF_HEADER];
  return typeof header === "string" ? header : "";
}
