import { z } from "zod";
import { AgentInstructionsSchema } from "./agent.js";
import { RuntimeModelSchema, RuntimeReasoningEffortSchema } from "./runtime-config.js";

/*
 * The Agent self-configuration surface: what an Agent running inside a managed Session may change
 * about itself through the session-proof-authenticated runtime API.
 *
 * The surface is deliberately narrower than the Account surface. An Agent may tune how it thinks
 * (instructions, model, reasoning effort) and which Account MCP Servers it mounts or enables. It
 * may not rename itself, change how it receives messages, raise its own Turn duration limit, or
 * touch MCP endpoints, headers, or credentials: those either widen its own authority or could send
 * an existing credential to another origin, and stay a human decision.
 */

export const UpdateSelfAgentRuntimeConfigSchema = z
  .object({
    model: RuntimeModelSchema.nullable().optional(),
    reasoningEffort: RuntimeReasoningEffortSchema.nullable().optional(),
    instructions: AgentInstructionsSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one runtime config field must be updated",
  });

export const UpdateSelfAgentRequestSchema = z
  .object({
    expectedRevision: z.number().int().min(1),
    runtimeConfig: UpdateSelfAgentRuntimeConfigSchema,
  })
  .strict();

/** The only binding change an Agent may make to its own mount: enable or disable it. */
export const UpdateSelfMCPBindingRequestSchema = z.object({ enabled: z.boolean() }).strict();

export type UpdateSelfAgentRuntimeConfig = z.infer<typeof UpdateSelfAgentRuntimeConfigSchema>;
export type UpdateSelfAgentRequest = z.infer<typeof UpdateSelfAgentRequestSchema>;
export type UpdateSelfMCPBindingRequest = z.infer<typeof UpdateSelfMCPBindingRequestSchema>;
