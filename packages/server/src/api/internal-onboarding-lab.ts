import { type AccountResetMode, INTERNAL_ONBOARDING_LAB_PATH, isAccountResetMode } from "@opentag/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createUserAuthPreHandler, type UserAuthPreHandlerOptions } from "../plugins/user-auth.js";
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
 * client-side fixtures that read nothing and write nothing. The two reset modes write, but both are
 * reflexive: they act on the authenticated Account and never accept a client-selected one, so each
 * tester reopens their own onboarding and can reach nothing of anyone else's.
 *
 * The mode is required rather than defaulted. `reset-all` destroys the Account's Agents and Computer
 * access while `reboard` keeps them, and a caller that omitted the mode would otherwise be handed
 * the destructive one; a rejected request is the better answer.
 */
export function registerInternalOnboardingLabRoutes(
  app: FastifyInstance,
  authService: UserAuthService,
  reset: OnboardingResetService,
  authOptions?: UserAuthPreHandlerOptions,
): void {
  const preHandler = createUserAuthPreHandler(authService, authOptions ?? {});
  const requireLab = (request: FastifyRequest): string => {
    if (!reset.enabled) throw labNotFound();
    return accountId(request);
  };

  app.get(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    requireLab(request);
    return reply.code(204).send();
  });

  app.post(INTERNAL_ONBOARDING_LAB_PATH, { preHandler }, async (request, reply) => {
    const account = requireLab(request);
    const mode = requestedMode(request.body);
    if (mode === "reboard") await reset.reboard(account);
    else await reset.resetOnboarding(account);
    return reply.code(204).send();
  });
}

function requestedMode(body: unknown): AccountResetMode {
  const mode = (body as { mode?: unknown } | null | undefined)?.mode;
  if (!isAccountResetMode(mode)) throw modeRequired();
  return mode;
}

function modeRequired(): AuthServiceError {
  return new AuthServiceError(
    "VALIDATION_ERROR",
    "validation",
    'The reset mode is required and must be "reset-all" or "reboard"',
    400,
  );
}

function labNotFound(): AuthServiceError {
  return new AuthServiceError("RESOURCE_NOT_FOUND", "deterministic", "The requested resource was not found", 404);
}
