import { z } from "zod";

/**
 * What the authenticated Account may do in the staging Onboarding Lab. The interface exists only
 * where a deployment configures the Lab Account, so reaching it at all already means the Lab is
 * configured; `reset` then reports whether this particular Account owns the destructive half.
 */
export const OnboardingLabAccessSchema = z
  .object({
    reset: z.boolean(),
  })
  .strict();

export type OnboardingLabAccess = z.infer<typeof OnboardingLabAccessSchema>;
