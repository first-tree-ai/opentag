import { RUNTIME_IM_RESOURCE_TEMPLATE } from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ImResourceService } from "../services/im/index.js";
import { parseRequest } from "./request-validation.js";

const ParamsSchema = z.object({ resourceId: z.string().uuid() }).strict();
const QuerySchema = z
  .object({
    sessionId: z.string().uuid(),
    computerId: z.string().uuid(),
    instanceId: z.string().uuid(),
    placementGeneration: z.coerce.number().int().min(1),
  })
  .strict();

function userId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated user context is missing");
  return value;
}

function safeMediaType(value: string | undefined): string {
  return value && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value) ? value : "application/octet-stream";
}

export function registerImResourceRoute(
  app: FastifyInstance,
  authService: UserAuthService,
  resources: ImResourceService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });
  app.get(RUNTIME_IM_RESOURCE_TEMPLATE, { preHandler }, async (request, reply) => {
    const { resourceId } = parseRequest(ParamsSchema, request.params);
    const scope = parseRequest(QuerySchema, request.query);
    const resource = await resources.open(userId(request), scope, resourceId);
    reply.header("content-type", safeMediaType(resource.mediaType));
    if (resource.sizeBytes !== undefined) reply.header("content-length", String(resource.sizeBytes));
    if (resource.filename) {
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(resource.filename)}`);
    }
    return reply.send(resource.stream);
  });
}
