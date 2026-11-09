import { z } from "zod";
import { AgentInstructionsSchema } from "./agent.js";
import {
  type MCPAgentServer,
  MCPAuthKindSchema,
  MCPAuthorizationStatusSchema,
  MCPProbeStateSchema,
  MCPServerNameSchema,
  MCPServerUrlSchema,
} from "./mcp.js";
import { RuntimeModelSchema, RuntimeReasoningEffortSchema } from "./runtime-config.js";

/*
 * The Agent self-configuration surface: what an Agent running inside a managed Session may change
 * about itself through the session-proof-authenticated runtime API.
 *
 * The surface is deliberate about two different kinds of power. An Agent may tune how it thinks
 * (instructions, model, reasoning effort), mount or enable Account MCP Servers, and — so a user can
 * ask "connect HubSpot" and get a working connector — register a Server definition for itself and
 * write its own credential for it. It may not rename itself, change how it receives messages, raise
 * its own Turn duration limit, or override the endpoint and headers of an Account Server it did not
 * create: those either widen its own authority or could send an existing credential to another
 * origin, and stay a human decision.
 *
 * Two limits keep the credential power bounded. A definition the Agent registers is always its own:
 * names are unique per Account, so a self-registration can never shadow or redirect an existing
 * Server. And the Agent still may not mount an anonymous Server (`defaultAuthKind: "none"`), because
 * mounting one grants access immediately, with no credential step for a human to review.
 */

/** Matches `SetMCPAuthorizationRequestSchema`'s bound: one credential, one write path. */
const SELF_MCP_API_KEY_MAX_LENGTH = 16_384;

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

/**
 * Register a Server definition and mount it on the calling Agent in one step.
 *
 * `apiKey` is the only credential this surface accepts, and only for a `bearer` Server: an OAuth
 * credential cannot be written directly, it arrives through a flow the human completes in a browser.
 * Anonymous registration is refused because an anonymous mount is immediately usable, which would
 * hand an Agent a channel to send data to without any human step.
 */
export const CreateSelfMCPServerRequestSchema = z
  .object({
    name: MCPServerNameSchema,
    url: MCPServerUrlSchema,
    defaultAuthKind: MCPAuthKindSchema.default("oauth"),
    apiKey: z.string().min(1).max(SELF_MCP_API_KEY_MAX_LENGTH).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.defaultAuthKind === "none") {
      context.addIssue({
        code: "custom",
        path: ["defaultAuthKind"],
        message: "An Agent may not register an MCP Server that requires no credentials",
      });
    }
    if (value.apiKey !== undefined && value.defaultAuthKind !== "bearer") {
      context.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "An API key can only be written for a Server whose defaultAuthKind is bearer",
      });
    }
  });

export type CreateSelfMCPServerRequest = z.infer<typeof CreateSelfMCPServerRequestSchema>;

/**
 * Write this Agent's own Bearer key for a Server it already mounts.
 *
 * The body is the key alone: kind, endpoint, and header all come from the existing mount, so this
 * route cannot be used to retarget a credential at another origin.
 */
export const SetSelfMCPCredentialRequestSchema = z
  .object({ apiKey: z.string().min(1).max(SELF_MCP_API_KEY_MAX_LENGTH) })
  .strict();
export type SetSelfMCPCredentialRequest = z.infer<typeof SetSelfMCPCredentialRequestSchema>;

/** One tool name a Server's last successful probe recorded, without its input schema. */
export const SelfMCPToolSchema = z.object({ name: z.string().min(1), description: z.string().nullable() }).strict();
export type SelfMCPTool = z.infer<typeof SelfMCPToolSchema>;

/**
 * The cheap answer to "is it usable yet, and what can it do?".
 *
 * A projection of `MCPAgentServer`, not a replacement: the tool input schemas and the raw protocol
 * snapshot are omitted, so a poll loop costs a few hundred bytes instead of hundreds of kilobytes.
 * `authStatus` and `probeState` are independent — a mounted Server may be authorized but not
 * yet probed, and only `probeState: "succeeded"` with a non-empty `tools` means the tools are live.
 */
export const SelfMCPOAuthStatusSchema = z
  .object({
    mcpServerId: z.string().uuid(),
    name: MCPServerNameSchema,
    enabled: z.boolean(),
    authKind: MCPAuthKindSchema.nullable(),
    authStatus: MCPAuthorizationStatusSchema.nullable(),
    probeState: MCPProbeStateSchema.nullable(),
    probeError: z.string().nullable(),
    failureCode: z.string().nullable(),
    toolsCount: z.number().int().min(0).nullable(),
    toolsTruncated: z.boolean(),
    tools: z.array(SelfMCPToolSchema).nullable(),
  })
  .strict();
export type SelfMCPOAuthStatus = z.infer<typeof SelfMCPOAuthStatusSchema>;

/** Project one Agent-scoped Server view onto the polling shape. */
export function selfMcpOAuthStatus(server: MCPAgentServer): SelfMCPOAuthStatus {
  const authorization = server.authorization;
  const tools = server.snapshot?.tools ?? null;
  return {
    mcpServerId: server.mcpServerId,
    name: server.name,
    enabled: server.enabled,
    authKind: authorization?.kind ?? null,
    authStatus: authorization?.status ?? null,
    probeState: authorization?.probeState ?? null,
    probeError: authorization?.probeError ?? null,
    failureCode: authorization?.failureCode ?? null,
    toolsCount: authorization?.toolsCount ?? null,
    toolsTruncated: authorization?.toolsTruncated ?? false,
    tools:
      tools === null
        ? null
        : tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
          })),
  };
}

export type UpdateSelfAgentRuntimeConfig = z.infer<typeof UpdateSelfAgentRuntimeConfigSchema>;
export type UpdateSelfAgentRequest = z.infer<typeof UpdateSelfAgentRequestSchema>;
export type UpdateSelfMCPBindingRequest = z.infer<typeof UpdateSelfMCPBindingRequestSchema>;
