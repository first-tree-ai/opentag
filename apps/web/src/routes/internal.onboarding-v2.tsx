import { createFileRoute } from "@tanstack/react-router";
import { OnboardingV2Page } from "../onboarding-v2/page.js";

/*
 * The redesigned onboarding flow, built against an in-page mock. It sits outside every gate on
 * purpose: it reaches no Server, so requiring an Account to look at it would only slow down the
 * page and interaction work it exists for.
 */
export const Route = createFileRoute("/internal/onboarding-v2")({
  component: OnboardingV2Page,
});
