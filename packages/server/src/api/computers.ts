import { HTTP_PATHS, ListComputersResponseSchema } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerService } from "../services/computers/index.js";

export function registerComputerRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  computerService: ComputerService,
): void {
  app.get(HTTP_PATHS.meComputers, { preHandler: createUserAuthPreHandler(authService) }, async (request, reply) => {
    const userId = request.authContext?.me.user.id;
    if (!userId) {
      throw new Error("Authenticated user context is missing");
    }
    return reply.code(200).send(ListComputersResponseSchema.parse(await computerService.listForUser(userId)));
  });
}
