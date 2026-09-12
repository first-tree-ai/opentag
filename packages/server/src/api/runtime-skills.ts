import {
  RUNTIME_SESSION_SKILLS_TEMPLATE,
  RUNTIME_SKILL_ARCHIVE_TEMPLATE,
  RUNTIME_SKILLS_PATH,
  RuntimeSkillsManifestSchema,
  RuntimeSkillsQuerySchema,
  SESSION_CLI_PROOF_HEADER,
  SkillDetailSchema,
  SkillNameSchema,
  SkillUploadQuerySchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import type { SessionCliProofService } from "../services/sessions/index.js";
import { skillResourceNotFound } from "../services/skills/index.js";
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

export interface RuntimeSkillRoutesOptions extends SkillRouteServices {
  /** Enables the in-session push route; absent when the server does not issue Session CLI proofs. */
  proofs?: Pick<SessionCliProofService, "authenticate">;
}

const SkillNameParamsSchema = z.object({ name: SkillNameSchema }).strict();
const SessionParamsSchema = z.object({ sessionId: z.string().uuid() }).strict();

function computerId(request: FastifyRequest): string {
  const context = request.computerAuthContext;
  if (!context) throw new Error("Authenticated Computer context is missing");
  return context.computerId;
}

function proofHeader(request: FastifyRequest): string {
  const header = request.headers[SESSION_CLI_PROOF_HEADER];
  return typeof header === "string" ? header : "";
}

/**
 * Computer-facing skill sync: the manifest of every agent on the machine, archive downloads scoped to what those
 * agents are assigned, and the in-session push that lets an agent publish a skill it created locally.
 */
export function registerRuntimeSkillRoutes(
  app: FastifyInstance,
  machineAuth: ComputerAuthVerifier,
  options: RuntimeSkillRoutesOptions,
): void {
  const preHandler = createComputerAuthPreHandler(machineAuth);
  registerZipContentTypeParser(app);

  app.get(RUNTIME_SKILLS_PATH, { preHandler }, async (request, reply) => {
    const { assignments } = requireSkillServices(options);
    const { agentId } = parseRequest(RuntimeSkillsQuerySchema, request.query);
    const manifest = await assignments.manifestForComputer(computerId(request), agentId);
    if (!manifest) throw skillResourceNotFound();
    return reply.header("cache-control", "no-store").code(200).send(RuntimeSkillsManifestSchema.parse(manifest));
  });

  app.get(RUNTIME_SKILL_ARCHIVE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { skills, assignments } = requireSkillServices(options);
    const { name } = parseRequest(SkillNameParamsSchema, request.params);
    const { skillId } = await assignments.assertSkillAssignedOnComputer(computerId(request), name);
    return sendSkillArchive(request, reply, await skills.openArchiveById(skillId));
  });

  const proofs = options.proofs;
  if (!proofs) return;
  app.post(RUNTIME_SESSION_SKILLS_TEMPLATE, { onRequest: requireZipContentType }, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const { skills, assignments } = requireSkillServices(options);
    const source = await proofs.authenticate(proofHeader(request));
    const { sessionId } = parseRequest(SessionParamsSchema, request.params);
    if (sessionId !== source.sessionId) throw skillResourceNotFound();
    const owner = await assignments.resolveAgentOwner(source.agentId);
    if (!owner) throw skillResourceNotFound();
    const { onConflict } = parseRequest(SkillUploadQuerySchema, request.query);
    const result = await skills.upsertFromArchive(owner.ownerAccountId, zipBody(request), {
      onConflict,
      updatedBy: { kind: "session", id: source.sessionId },
      autoAssignAgentId: source.agentId,
    });
    await notifySkillChange(request, options.notifier, result.affectedAgentIds);
    return reply.code(result.created ? 201 : 200).send(SkillDetailSchema.parse(result.skill));
  });
}
