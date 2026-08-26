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
 * The staging-only Onboarding Lab interface. It is registered only when the deployment configures
 * the Lab Account, and it never accepts a client-selected Account: every request acts on the
 * authenticated Account, and any other Account is indistinguishable from an unregistered route.
 */
export function registerInternalOnboardingLabRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  reset: OnboardingResetService,
  publicOrigin?: string,
): void {
  const preHandler = createUserAuthPreHandler(authService, { publicOrigin });
  const requireLabAccount = (request: FastifyRequest): string => {
    const account = accountId(request);
    if (!reset.allows(account)) throw labNotFound();
    return account;
  };

  app.get(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    requireLabAccount(request);
    return reply.code(204).send();
  });

  app.post(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    await reset.resetOnboarding(requireLabAccount(request));
    return reply.code(204).send();
  });
}

function labNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
