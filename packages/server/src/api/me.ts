import { MeResponseSchema } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";

export function registerMeRoute(app: FastifyInstance, authService: UserAuthService): void {
  app.get("/v1/me", { preHandler: createUserAuthPreHandler(authService) }, async (request, reply) =>
    reply.code(200).send(MeResponseSchema.parse(request.authContext?.me)),
  );
}
