import { z } from "zod";
import { MembershipRoleSchema, MembershipStatusSchema, TeamNameSchema } from "./auth.js";
import { ComputerConnectionStatusSchema, ComputerPlatformSchema } from "./computer.js";

export const TeamProfileSchema = z
  .object({
    id: z.string().uuid(),
    name: TeamNameSchema,
    displayName: z.string().min(1),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const CreateTeamRequestSchema = z
  .object({
    name: z.string().trim().toLowerCase().max(64).pipe(TeamNameSchema),
    displayName: z.string().trim().min(1).max(120),
  })
  .strict();

export const CreateTeamResponseSchema = z
  .object({
    id: z.string().uuid(),
    name: TeamNameSchema,
    displayName: z.string().min(1),
    role: MembershipRoleSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const UpdateTeamProfileRequestSchema = z
  .object({
    name: z.string().trim().toLowerCase().pipe(TeamNameSchema).optional(),
    displayName: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine((value) => value.name !== undefined || value.displayName !== undefined, {
    message: "At least one Team profile field is required",
  });

export const TeamMemberSummarySchema = z
  .object({
    userId: z.string().uuid(),
    displayName: z.string().min(1),
    role: MembershipRoleSchema,
  })
  .strict();

export const TeamMemberAdminConfigSchema = z
  .object({
    teamId: z.string().uuid(),
    userId: z.string().uuid(),
    email: z.string().email(),
    displayName: z.string().min(1),
    role: MembershipRoleSchema,
    status: MembershipStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ListTeamMembersResponseSchema = z.object({ members: z.array(TeamMemberSummarySchema) }).strict();
export const ListTeamMembersConfigResponseSchema = z.object({ members: z.array(TeamMemberAdminConfigSchema) }).strict();
export const UpdateTeamMemberRequestSchema = z.object({ role: MembershipRoleSchema }).strict();
export const RestoreTeamMemberRequestSchema = z.object({ role: MembershipRoleSchema }).strict();

export const TeamComputerSummarySchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    ownerDisplayName: z.string().min(1),
    displayName: z.string().min(1),
    platform: ComputerPlatformSchema,
    connectionStatus: ComputerConnectionStatusSchema,
    connectedAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    agentIds: z.array(z.string().uuid()),
  })
  .strict();

export const TeamComputerAdminConfigSchema = z
  .object({
    id: z.string().uuid(),
    ownerUserId: z.string().uuid(),
    ownerDisplayName: z.string().min(1),
    displayName: z.string().min(1),
    platform: ComputerPlatformSchema,
    arch: z.string().min(1),
    clientVersion: z.string().min(1),
    connectionStatus: ComputerConnectionStatusSchema,
    connectedAt: z.string().datetime().nullable(),
    lastSeenAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    agentIds: z.array(z.string().uuid()),
  })
  .strict();

export const ListTeamComputersResponseSchema = z.object({ computers: z.array(TeamComputerSummarySchema) }).strict();
export const ListTeamComputersConfigResponseSchema = z
  .object({ computers: z.array(TeamComputerAdminConfigSchema) })
  .strict();

export type TeamMemberSummary = z.infer<typeof TeamMemberSummarySchema>;
export type TeamProfile = z.infer<typeof TeamProfileSchema>;
export type CreateTeamRequest = z.infer<typeof CreateTeamRequestSchema>;
export type CreateTeamResponse = z.infer<typeof CreateTeamResponseSchema>;
export type UpdateTeamProfileRequest = z.infer<typeof UpdateTeamProfileRequestSchema>;
export type TeamMemberAdminConfig = z.infer<typeof TeamMemberAdminConfigSchema>;
export type ListTeamMembersResponse = z.infer<typeof ListTeamMembersResponseSchema>;
export type ListTeamMembersConfigResponse = z.infer<typeof ListTeamMembersConfigResponseSchema>;
export type UpdateTeamMemberRequest = z.infer<typeof UpdateTeamMemberRequestSchema>;
export type RestoreTeamMemberRequest = z.infer<typeof RestoreTeamMemberRequestSchema>;
export type TeamComputerSummary = z.infer<typeof TeamComputerSummarySchema>;
export type TeamComputerAdminConfig = z.infer<typeof TeamComputerAdminConfigSchema>;
export type ListTeamComputersResponse = z.infer<typeof ListTeamComputersResponseSchema>;
export type ListTeamComputersConfigResponse = z.infer<typeof ListTeamComputersConfigResponseSchema>;
