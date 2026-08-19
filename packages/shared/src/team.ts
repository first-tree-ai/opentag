import { z } from "zod";
import { MembershipRoleSchema, MembershipStatusSchema } from "./auth.js";
import { ComputerConnectionStatusSchema, ComputerPlatformSchema } from "./computer.js";

export const TeamMemberSchema = z
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

export const ListTeamMembersResponseSchema = z.object({ members: z.array(TeamMemberSchema) }).strict();
export const UpdateTeamMemberRequestSchema = z.object({ role: MembershipRoleSchema }).strict();
export const RestoreTeamMemberRequestSchema = z.object({ role: MembershipRoleSchema }).strict();

export const TeamComputerSchema = z
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

export const ListTeamComputersResponseSchema = z.object({ computers: z.array(TeamComputerSchema) }).strict();

export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type ListTeamMembersResponse = z.infer<typeof ListTeamMembersResponseSchema>;
export type UpdateTeamMemberRequest = z.infer<typeof UpdateTeamMemberRequestSchema>;
export type RestoreTeamMemberRequest = z.infer<typeof RestoreTeamMemberRequestSchema>;
export type TeamComputer = z.infer<typeof TeamComputerSchema>;
export type ListTeamComputersResponse = z.infer<typeof ListTeamComputersResponseSchema>;
