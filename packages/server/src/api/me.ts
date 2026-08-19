import { HTTP_PATHS, MeResponseSchema } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";

export function registerMeRoute(app: FastifyInstance, authService: UserAuthService, publicOrigin?: string): void {
  app.get(
    HTTP_PATHS.me,
    { preHandler: createUserAuthPreHandler(authService, { publicOrigin }) },
    async (request, reply) => reply.code(200).send(MeResponseSchema.parse(request.authContext?.me)),
  );
}
