import { z } from "zod";

export const AgentPermissionsSchema = z
  .object({
    approverExternalId: z.string().trim().min(1).max(128).nullable(),
    // Native provider rules expressed as JSON; an empty string uses OpenTag's defaults.
    rules: z.string().max(16_384),
  })
  .strict();
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;
export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = { approverExternalId: null, rules: "" };

const action = z.enum(["allow", "ask", "deny"]);
const patterns = z.array(z.string().min(1).max(512)).max(128);
export const CodexPermissionRulesSchema = z
  .array(
    z
      .object({
        pattern: z.array(z.string().min(1).max(512)).min(1).max(32),
        decision: z.enum(["allow", "prompt", "forbidden"]),
      })
      .strict(),
  )
  .max(128);
export const ClaudePermissionRulesSchema = z
  .object({ allow: patterns.optional(), ask: patterns.optional(), deny: patterns.optional() })
  .strict();
export const PiPermissionRulesSchema = z.record(
  z.string().min(1).max(128),
  z.union([action, z.record(z.string().min(1).max(512), action)]),
);

export function parseAgentPermissionRules(provider: "codex" | "claude-code" | "pi", rules: string) {
  const value: unknown = rules.trim() ? JSON.parse(rules) : provider === "codex" ? [] : {};
  if (provider === "codex") return CodexPermissionRulesSchema.parse(value);
  if (provider === "claude-code") return ClaudePermissionRulesSchema.parse(value);
  return PiPermissionRulesSchema.parse(value);
}
