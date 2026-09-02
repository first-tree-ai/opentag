import { createFileRoute } from "@tanstack/react-router";
import { AgentSetupLabPage } from "../onboarding-v2/agent-setup-lab-page.js";

/*
 * Agent Setup against its in-memory Adapter. It sits outside every gate on purpose: it reaches
 * no Server, so requiring an Account to look at it would only slow down the page and interaction
 * work it exists for. The same presentation against the real Server is `/agents/setup`.
 */
export const Route = createFileRoute("/internal/agent-setup")({
  component: AgentSetupLabPage,
});
