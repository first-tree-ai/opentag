import { z } from "zod";
import {
  ComputerConnectionStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerPlatformSchema,
  ComputerProviderReadinessCollectionSchema,
} from "./computer.js";

export const CompleteAccountSetupRequestSchema = z.object({ agentId: z.string().uuid() }).strict();
export const AccountSetupCompletionSchema = z.object({ setupCompletedAt: z.string().datetime() }).strict();

/** How much of the authenticated Account to reset before onboarding is walked again. */
export const AccountSetupResetModeSchema = z.enum(["all", "reboard"]);
export const AccountSetupResetRequestSchema = z.object({ mode: AccountSetupResetModeSchema }).strict();

export const AccountComputerSummarySchema = z
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
    createdAt: z.string().datetime(),
    agentIds: z.array(z.string().uuid()),
  })
  .strict();

export const ListAccountComputersResponseSchema = z
  .object({ computers: z.array(AccountComputerSummarySchema) })
  .strict();

export type CompleteAccountSetupRequest = z.infer<typeof CompleteAccountSetupRequestSchema>;
export type AccountSetupCompletion = z.infer<typeof AccountSetupCompletionSchema>;
export type AccountSetupResetMode = z.infer<typeof AccountSetupResetModeSchema>;
export type AccountSetupResetRequest = z.infer<typeof AccountSetupResetRequestSchema>;
export type AccountComputerSummary = z.infer<typeof AccountComputerSummarySchema>;
export type ListAccountComputersResponse = z.infer<typeof ListAccountComputersResponseSchema>;
