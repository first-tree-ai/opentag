import { z } from "zod";
import { WorkspaceDisplayNameSchema, WorkspaceNameInputSchema, WorkspaceNameSchema } from "./auth.js";
import {
  ComputerConnectionStatusSchema,
  ComputerImCliReadinessCollectionSchema,
  ComputerPlatformSchema,
  ComputerProviderReadinessCollectionSchema,
} from "./computer.js";

export const WorkspaceProfileSchema = z
  .object({
    id: z.string().uuid(),
    name: WorkspaceNameSchema,
    displayName: z.string().min(1),
    setupCompletedAt: z.string().datetime().nullable().default(null),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const CreateWorkspaceRequestSchema = z
  .object({ name: WorkspaceNameInputSchema, displayName: WorkspaceDisplayNameSchema })
  .strict();

export const CreateWorkspaceResponseSchema = WorkspaceProfileSchema.extend({
  createdAt: z.string().datetime(),
  grantedAt: z.string().datetime(),
}).strict();

export const UpdateWorkspaceProfileRequestSchema = z
  .object({ name: WorkspaceNameInputSchema.optional(), displayName: WorkspaceDisplayNameSchema.optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.displayName !== undefined, {
    message: "At least one Workspace profile field is required",
  });

export const WorkspaceAdminSummarySchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().min(1),
    grantedAt: z.string().datetime(),
  })
  .strict();

export const WorkspaceAdminConfigSchema = WorkspaceAdminSummarySchema.extend({
  workspaceId: z.string().uuid(),
  email: z.string().email(),
  grantedByUserId: z.string().uuid(),
}).strict();

export const ListWorkspaceAdminsResponseSchema = z.object({ admins: z.array(WorkspaceAdminSummarySchema) }).strict();
export const ListWorkspaceAdminsConfigResponseSchema = z
  .object({ admins: z.array(WorkspaceAdminConfigSchema) })
  .strict();

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

export const WorkspaceComputerAdminConfigSchema = WorkspaceComputerSummarySchema.extend({
  arch: z.string().min(1),
  clientVersion: z.string().min(1),
  enrolledByUserId: z.string().uuid(),
}).strict();

export const ListWorkspaceComputersResponseSchema = z
  .object({ computers: z.array(WorkspaceComputerSummarySchema) })
  .strict();
export const ListWorkspaceComputersConfigResponseSchema = z
  .object({ computers: z.array(WorkspaceComputerAdminConfigSchema) })
  .strict();

export type WorkspaceProfile = z.infer<typeof WorkspaceProfileSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type CreateWorkspaceResponse = z.infer<typeof CreateWorkspaceResponseSchema>;
export type UpdateWorkspaceProfileRequest = z.infer<typeof UpdateWorkspaceProfileRequestSchema>;
export type WorkspaceAdminSummary = z.infer<typeof WorkspaceAdminSummarySchema>;
export type WorkspaceAdminConfig = z.infer<typeof WorkspaceAdminConfigSchema>;
export type ListWorkspaceAdminsResponse = z.infer<typeof ListWorkspaceAdminsResponseSchema>;
export type ListWorkspaceAdminsConfigResponse = z.infer<typeof ListWorkspaceAdminsConfigResponseSchema>;
export type CompleteWorkspaceSetupRequest = z.infer<typeof CompleteWorkspaceSetupRequestSchema>;
export type WorkspaceSetupCompletion = z.infer<typeof WorkspaceSetupCompletionSchema>;
export type WorkspaceComputerSummary = z.infer<typeof WorkspaceComputerSummarySchema>;
export type WorkspaceComputerAdminConfig = z.infer<typeof WorkspaceComputerAdminConfigSchema>;
export type ListWorkspaceComputersResponse = z.infer<typeof ListWorkspaceComputersResponseSchema>;
export type ListWorkspaceComputersConfigResponse = z.infer<typeof ListWorkspaceComputersConfigResponseSchema>;
