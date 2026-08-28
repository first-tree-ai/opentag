import { z } from "zod";

/**
 * What the authenticated Account may do in the staging Onboarding Lab. The interface exists on every
 * staging deployment, so reaching it at all means only that this is staging; `reset` reports whether
 * this particular Account owns the destructive half, and is false for everyone until a deployment
 * configures an Account to own it.
 */
export const OnboardingLabAccessSchema = z
  .object({
    reset: z.boolean(),
  })
  .strict();

export type OnboardingLabAccess = z.infer<typeof OnboardingLabAccessSchema>;
