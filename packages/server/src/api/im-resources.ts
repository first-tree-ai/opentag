import { RUNTIME_IM_RESOURCE_TEMPLATE } from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import type { ImResourceService } from "../services/im/index.js";
import { parseRequest } from "./request-validation.js";

const ParamsSchema = z
  .object({ imMessageId: z.string().uuid(), ordinal: z.coerce.number().int().min(0).max(15) })
  .strict();
const QuerySchema = z
  .object({
    sessionId: z.string().uuid(),
    instanceId: z.string().uuid(),
    placementGeneration: z.coerce.number().int().min(1),
  })
  .strict();

function computerAuthContext(request: FastifyRequest) {
  const value = request.computerAuthContext;
  if (!value) throw new Error("Authenticated Computer context is missing");
  return value;
}

function safeMediaType(value: string | undefined): string {
  return value && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value) ? value : "application/octet-stream";
}

export function registerImResourceRoute(
  app: FastifyInstance,
  machineAuth: ComputerAuthVerifier,
  resources: ImResourceService,
): void {
  const preHandler = createComputerAuthPreHandler(machineAuth);
  app.get(RUNTIME_IM_RESOURCE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { imMessageId, ordinal } = parseRequest(ParamsSchema, request.params);
    const scope = parseRequest(QuerySchema, request.query);
    const resource = await resources.open(computerAuthContext(request), scope, imMessageId, ordinal);
    reply.header("content-type", safeMediaType(resource.mediaType));
    if (resource.sizeBytes !== undefined) reply.header("content-length", String(resource.sizeBytes));
    if (resource.filename) {
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(resource.filename)}`);
    }
    return reply.send(resource.stream);
  });
}
