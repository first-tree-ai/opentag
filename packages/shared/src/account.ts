import { z } from "zod";
import {
  ComputerConnectionStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerPlatformSchema,
  ComputerProviderReadinessCollectionSchema,
} from "./computer.js";

/** Staging-wide visibility for product areas that are not ready for public navigation. */
export const InternalNavigationVisibilitySchema = z.object({ integrations: z.boolean(), skills: z.boolean() }).strict();

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

export type InternalNavigationVisibility = z.infer<typeof InternalNavigationVisibilitySchema>;
export type AccountComputerSummary = z.infer<typeof AccountComputerSummarySchema>;
export type ListAccountComputersResponse = z.infer<typeof ListAccountComputersResponseSchema>;
