import { z } from "zod";

export const RUNTIME_ID_MAX_BYTES = 128;
export const RUNTIME_INSTRUCTIONS_MAX_BYTES = 24 * 1024;
export const RUNTIME_DEFAULT_MAX_DURATION_MS = 30 * 60 * 1_000;
export const RUNTIME_MAX_DURATION_MS = 24 * 60 * 60 * 1_000;
/**
 * Minimum Run budget for an internal Session that was created without `--max-duration-ms`.
 * Delegated work (for example coding) usually runs longer than an IM reply, so internal Sessions
 * do not inherit the shorter IM default; a larger Agent configuration still applies.
 */
export const RUNTIME_INTERNAL_SESSION_DEFAULT_MAX_DURATION_MS = 2 * 60 * 60 * 1_000;
// Changing this policy requires a migration that advances every active Agent runtime config revision.
export const OPENTAG_PLATFORM_INSTRUCTIONS = "You run inside OpenTag. IM output is never sent automatically.";
/**
 * Upper bound on an Agent slug in UTF-8 bytes, shared with `AgentNameSchema` so both budgets
 * agree: 64 ASCII characters or 21 Han characters. Counting bytes keeps the reserved platform
 * instruction budget exact whatever script the name uses.
 */
export const AGENT_SLUG_MAX_LENGTH = 64;
/**
 * The characters an Agent name (its slug) may use: ASCII letters in either case, digits, CJK unified
 * ideographs, and hyphens, starting with anything but a hyphen. Case is limited to ASCII so
 * JavaScript `toLowerCase()` and PostgreSQL `lower()` agree on the case-insensitive uniqueness key;
 * ideographs have no case. `Unified_Ideograph` rather than `Script=Han`: the Han script also holds
 * Kangxi and CJK radicals, which render like ordinary characters and which NFC does not fold. The
 * source is unanchored so the client can embed it when reading the slug back from the platform layer.
 */
export const AGENT_SLUG_CHARACTERS = String.raw`[A-Za-z0-9\p{Unified_Ideograph}][A-Za-z0-9\p{Unified_Ideograph}-]*`;
export const AGENT_NAME_PATTERN = new RegExp(`^${AGENT_SLUG_CHARACTERS}$`, "u");

const utf8 = new TextEncoder();

export function runtimeUtf8Length(value: string): number {
  return utf8.encode(value).byteLength;
}

/**
 * The trusted platform instruction layer for one Agent. The prompt is the only channel that
 * reaches an Agent's reasoning, so it is where the Agent learns which `members/<agent-slug>/`
 * directory in the Context Tree is its own. Callers that hash Agent revision identity must hash
 * this exact string.
 */
export function renderPlatformInstructions(input: { agentSlug: string }): string {
  return `${OPENTAG_PLATFORM_INSTRUCTIONS}\n\nOpenTag Agent slug: ${input.agentSlug}`;
}

export function runtimeByteString(maxBytes: number, message: string, minimumBytes = 0) {
  return z.string().superRefine((value, context) => {
    const bytes = runtimeUtf8Length(value);
    if (bytes < minimumBytes) {
      context.addIssue({ code: "custom", message: `Value must contain at least ${minimumBytes} UTF-8 byte(s)` });
    } else if (bytes > maxBytes) {
      context.addIssue({ code: "custom", message });
    }
  });
}

export const RuntimeModelSchema = runtimeByteString(128, "Model exceeds the 128-byte limit", 1);
export const RuntimeReasoningEffortSchema = runtimeByteString(64, "Reasoning effort exceeds the 64-byte limit", 1);
export const RuntimeInstructionSchema = runtimeByteString(
  RUNTIME_INSTRUCTIONS_MAX_BYTES,
  "Runtime instructions are too large",
);
export const RuntimeInstructionsSchema = z
  .object({
    platform: RuntimeInstructionSchema,
    agent: RuntimeInstructionSchema,
    session: RuntimeInstructionSchema.optional(),
  })
  .strict()
  .superRefine((instructions, context) => {
    const totalBytes =
      runtimeUtf8Length(instructions.platform) +
      runtimeUtf8Length(instructions.agent) +
      runtimeUtf8Length(instructions.session ?? "");
    if (totalBytes > RUNTIME_INSTRUCTIONS_MAX_BYTES) {
      context.addIssue({ code: "custom", message: "Combined instructions exceed the 24 KiB limit" });
    }
  });
export const RuntimeMaxDurationMsSchema = z.number().int().safe().positive().max(RUNTIME_MAX_DURATION_MS);
