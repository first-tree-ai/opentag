import { z } from "zod";
import {
  ComputerImCliReadinessCollectionSchema,
  ComputerKindSchema,
  ComputerPlatformSchema,
  ComputerProviderReadinessCollectionSchema,
} from "./computer.js";

/** Opt-in inventory retains explicitly disconnected Computers; legacy callers see active access only. */
export const COMPUTER_ACCESS_CAPABILITY_HEADER = "x-opentag-computer-access";

export const CompleteAccountSetupRequestSchema = z.object({ agentId: z.string().uuid() }).strict();
export const AccountSetupCompletionSchema = z.object({ setupCompletedAt: z.string().datetime() }).strict();

/** How much of the authenticated Account to reset before onboarding is walked again. */
export const AccountSetupResetModeSchema = z.enum(["all", "reboard"]);
export const AccountSetupResetRequestSchema = z.object({ mode: AccountSetupResetModeSchema }).strict();

/** Staging-wide visibility for product areas that are not ready for public navigation. */
export const InternalNavigationVisibilitySchema = z.object({ integrations: z.boolean() }).strict();

export const AccountComputerSummarySchema = z
  .object({
    computerId: z.string().uuid(),
    /** Present only for explicitly Cloud-capable callers; absent from legacy Local responses. */
    kind: ComputerKindSchema.optional(),
    displayName: z.string().min(1),
    platform: ComputerPlatformSchema,
    connectionStatus: z.enum(["online", "offline", "disconnected"]),
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

/**
 * Dedicated Cloud Computer ensure body. `kind` is required here without changing the Local list DTO.
 * `connectionStatus` is logical online of the Cloud identity, not daemon heartbeat evidence and not
 * Sandbox allocation or Pi execution readiness.
 */
export const AccountCloudComputerEnsureResponseSchema = z
  .object({
    computerId: z.string().uuid(),
    kind: z.literal("cloud"),
    displayName: z.string().min(1),
    platform: ComputerPlatformSchema,
    connectionStatus: z.literal("online"),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CompleteAccountSetupRequest = z.infer<typeof CompleteAccountSetupRequestSchema>;
export type AccountSetupCompletion = z.infer<typeof AccountSetupCompletionSchema>;
export type AccountSetupResetMode = z.infer<typeof AccountSetupResetModeSchema>;
export type AccountSetupResetRequest = z.infer<typeof AccountSetupResetRequestSchema>;
export type InternalNavigationVisibility = z.infer<typeof InternalNavigationVisibilitySchema>;
export type AccountComputerSummary = z.infer<typeof AccountComputerSummarySchema>;
export type ListAccountComputersResponse = z.infer<typeof ListAccountComputersResponseSchema>;
export type AccountCloudComputerEnsureResponse = z.infer<typeof AccountCloudComputerEnsureResponseSchema>;
