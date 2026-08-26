import { z } from "zod";
import {
  ComputerConnectionStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerPlatformSchema,
  ComputerProviderReadinessCollectionSchema,
} from "./computer.js";

export const CompleteWorkspaceSetupRequestSchema = z.object({ agentId: z.string().uuid() }).strict();
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
export type WorkspaceSetupCompletion = z.infer<typeof WorkspaceSetupCompletionSchema>;
export type WorkspaceComputerSummary = z.infer<typeof WorkspaceComputerSummarySchema>;
export type ListWorkspaceComputersResponse = z.infer<typeof ListWorkspaceComputersResponseSchema>;
