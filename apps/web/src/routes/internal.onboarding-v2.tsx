import { createFileRoute } from "@tanstack/react-router";
import { OnboardingV2MockPage } from "../onboarding-v2/page.js";

/*
 * The onboarding flow against its in-page mock. It sits outside every gate on purpose: it reaches
 * no Server, so requiring an Account to look at it would only slow down the page and interaction
 * work it exists for. The same flow against the real Server is `/onboarding`.
 */
export const Route = createFileRoute("/internal/onboarding-v2")({
  component: OnboardingV2MockPage,
});
