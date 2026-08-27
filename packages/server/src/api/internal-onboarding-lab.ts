import { INTERNAL_ONBOARDING_LAB_PATH, OnboardingLabAccessSchema } from "@opentag/shared";
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
 * the Lab Account, so an unconfigured deployment stays indistinguishable from one that never had
 * the feature. Reading access is open to any authenticated Account, because Scenario Preview is
 * client-side fixtures that read nothing and write nothing; the destructive reset stays closed and
 * never accepts a client-selected Account.
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
    if (!reset.enabled) throw labNotFound();
    const access = OnboardingLabAccessSchema.parse({ reset: reset.allows(accountId(request)) });
    return reply.code(200).send(access);
  });

  app.post(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    await reset.resetOnboarding(requireLabAccount(request));
    return reply.code(204).send();
  });
}

function labNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
