import type { FastifyInstance } from "fastify";
import type { UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
import type { UserAuthService } from "../services/auth/index.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import type { SessionCliProofService } from "../services/sessions/index.js";
import { registerRuntimeSkillRoutes } from "./runtime-skills.js";
import type { SkillRouteServices } from "./skill-routes-shared.js";
import { registerSkillRoutes } from "./skills.js";

export interface SkillRouteGroupOptions {
  authService: UserAuthService;
  authOptions: UserAuthPreHandlerOptions;
  services?: SkillRouteServices;
  machineAuth?: ComputerAuthVerifier;
  proofs?: Pick<SessionCliProofService, "authenticate">;
}

/**
 * Registers both skill route groups. The account routes always exist; the computer routes need machine
 * authentication and the in-session push additionally needs Session CLI proofs.
 */
export function registerSkillRouteGroups(app: FastifyInstance, options: SkillRouteGroupOptions): void {
  const services = options.services ?? {};
  registerSkillRoutes(app, options.authService, { ...services, authOptions: options.authOptions });
  if (!options.machineAuth) return;
  registerRuntimeSkillRoutes(app, options.machineAuth, {
    ...services,
    ...(options.proofs ? { proofs: options.proofs } : {}),
  });
}
