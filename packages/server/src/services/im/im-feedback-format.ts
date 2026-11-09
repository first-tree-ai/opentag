export function feedbackMessageFormat(environment: NodeJS.ProcessEnv = process.env): "interactive_v1" | "text_v1" {
  const enabled = environment.OPENTAG_IM_FEEDBACK_TEXT_ENABLED;
  if (enabled === "false") return "interactive_v1";
  if (enabled === undefined || enabled === "true") return "text_v1";
  throw new Error("OPENTAG_IM_FEEDBACK_TEXT_ENABLED must be true or false");
}
