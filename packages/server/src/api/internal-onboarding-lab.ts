import { INTERNAL_ONBOARDING_LAB_PATH } from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createUserAuthPreHandler } from "../plugins/user-auth.js";
import { AuthServiceError, type UserAuthService } from "../services/auth/index.js";
import type { OnboardingResetService } from "../services/onboarding-lab/index.js";

function accountId(request: FastifyRequest): string {
  const value = request.authContext?.me.user.id;
  if (!value) throw new Error("Authenticated Account context is missing");
  return value;
}

/**
 * The staging-only Onboarding Lab interface. Any staging deployment registers it, and every
 * deployment outside staging stays indistinguishable from one that never had the feature.
 *
 * Both halves are open to every authenticated Account, for different reasons. Scenario Preview is
 * client-side fixtures that read nothing and write nothing. The reset is destructive but reflexive:
 * it acts on the authenticated Account and never accepts a client-selected one, so each tester
 * returns their own onboarding to a first-run state and can reach nothing of anyone else's.
 */
export function registerInternalOnboardingLabRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  reset: OnboardingResetService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });
  const requireLab = (request: FastifyRequest): string => {
    if (!reset.enabled) throw labNotFound();
    return accountId(request);
  };

  app.get(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    requireLab(request);
    return reply.code(204).send();
  });

  app.post(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    await reset.resetOnboarding(requireLab(request));
    return reply.code(204).send();
  });
}

function labNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
