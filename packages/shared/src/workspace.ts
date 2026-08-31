import { z } from "zod";
import {
  ComputerConnectionStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerPlatformSchema,
  ComputerProviderReadinessCollectionSchema,
} from "./computer.js";

export const CompleteWorkspaceSetupRequestSchema = z.object({ agentId: z.string().uuid() }).strict();

/**
 * How much of an Account to undo so onboarding can be walked again.
 *
 * `all` returns the Account to a genuine first run: the Agents it created, its Computer
 * enrollments and its messaging connections are all taken down before setup is cleared, so the
 * next run has nothing to resume from.
 *
 * `reboard` clears only the setup marker. Everything the Account owns stays, which is the point —
 * it makes onboarding repeatable without making the tester rebuild an Agent and re-enroll a
 * machine first. Because those resources survive, the next run resumes into them rather than
 * exercising first-run creation.
 */
export const AccountSetupResetModeSchema = z.enum(["all", "reboard"]);

export const AccountSetupResetRequestSchema = z.object({ mode: AccountSetupResetModeSchema }).strict();
export const WorkspaceSetupCompletionSchema = z.object({ setupCompletedAt: z.string().datetime() }).strict();

export const WorkspaceComputerSummarySchema = z
  .object({
    computerId: z.string().uuid(),
    displayName: z.string().min(1),
    platform: ComputerPlatformSchema,
    connectionStatus: ComputerConnectionStatusSchema,
    providerReadiness: ComputerProviderReadinessCollectionSchema.optional(),
    imCliReadiness: ComputerImCliReadinessCollectionSchema.optional(),
    connectedAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime().nullable(),
    observedAt: z.string().datetime(),
    enrolledAt: z.string().datetime(),
    agentIds: z.array(z.string().uuid()),
  })
  .strict();

export const ListWorkspaceComputersResponseSchema = z
  .object({ computers: z.array(WorkspaceComputerSummarySchema) })
  .strict();

export type CompleteWorkspaceSetupRequest = z.infer<typeof CompleteWorkspaceSetupRequestSchema>;
export type AccountSetupResetMode = z.infer<typeof AccountSetupResetModeSchema>;
export type AccountSetupResetRequest = z.infer<typeof AccountSetupResetRequestSchema>;
export type WorkspaceSetupCompletion = z.infer<typeof WorkspaceSetupCompletionSchema>;
export type WorkspaceComputerSummary = z.infer<typeof WorkspaceComputerSummarySchema>;
export type ListWorkspaceComputersResponse = z.infer<typeof ListWorkspaceComputersResponseSchema>;
