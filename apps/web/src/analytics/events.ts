/**
 * The activation funnel this application measures, written down in one place.
 *
 * The three transitions this exists to answer are "signed in, then created an Agent", "created an
 * Agent, then connected a Computer", and "connected a Computer, then held a first conversation".
 * A transition is not an event, so each end of one is reported as a milestone and the transition is
 * the drop between two adjacent steps.
 *
 * Every milestone carries the same `funnel` and `funnel_step` parameters. A funnel exploration can
 * then be built from the step number alone rather than from a hand-ordered list of differently
 * shaped events, and the steps stay contiguous on purpose: a gap would quietly drop a stage out of
 * the exploration instead of failing.
 */
export const ACTIVATION_FUNNEL = "activation";

export const ACTIVATION_STEP = {
  signed_in: 1,
  agent_created: 2,
  computer_connected: 3,
  first_conversation: 4,
} as const;

export type ActivationStage = keyof typeof ACTIVATION_STEP;

export function activationStep(stage: ActivationStage): { readonly funnel: string; readonly funnel_step: number } {
  return { funnel: ACTIVATION_FUNNEL, funnel_step: ACTIVATION_STEP[stage] };
}

/**
 * Event names. `login`, `sign_up` and `page_view` are Google Analytics recommended names and keep
 * their published spelling so the built-in reports understand them; the rest are this product's own
 * and are namespaced by the noun they describe.
 */
export const ANALYTICS_EVENT = {
  login: "login",
  signUp: "sign_up",
  pageView: "page_view",
  agentCreated: "agent_created",
  agentCreateFailed: "agent_create_failed",
  computerConnectStarted: "computer_connect_started",
  computerConnected: "computer_connected",
  agentSetupStageReached: "agent_setup_stage_reached",
  agentSetupCompleted: "agent_setup_completed",
  firstConversationObserved: "first_conversation_observed",
} as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT)[keyof typeof ANALYTICS_EVENT];
