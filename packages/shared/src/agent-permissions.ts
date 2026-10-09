import { z } from "zod";

export const AdditionalAllowedCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[A-Za-z0-9_./:+-]+(?: [A-Za-z0-9_./:+-]+)*$/,
    "Use command names and subcommands without shell operators or wildcards",
  );

export const AgentPermissionsSchema = z
  .object({
    approvalPolicy: z.enum(["on-request", "never"]).default("on-request"),
    allowCommands: z.array(AdditionalAllowedCommandSchema).max(64).default([]),
  })
  .strict();
export type AgentPermissions = z.infer<typeof AgentPermissionsSchema>;
export const DEFAULT_AGENT_PERMISSIONS: AgentPermissions = {
  approvalPolicy: "on-request",
  allowCommands: [],
};
