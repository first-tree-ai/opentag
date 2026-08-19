import { z } from "zod";
import { MeMembershipSchema, MembershipRoleSchema } from "./auth.js";

export const InvitationTokenSchema = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/);

export const TeamInvitationSchema = z
  .object({
    token: InvitationTokenSchema,
    inviteUrl: z.string().url(),
    role: MembershipRoleSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const InvitationPreviewSchema = z
  .object({
    teamDisplayName: z.string().min(1),
    role: MembershipRoleSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

export const InvitationRedemptionResponseSchema = z.object({ membership: MeMembershipSchema }).strict();

export type InvitationToken = z.infer<typeof InvitationTokenSchema>;
export type TeamInvitation = z.infer<typeof TeamInvitationSchema>;
export type InvitationPreview = z.infer<typeof InvitationPreviewSchema>;
export type InvitationRedemptionResponse = z.infer<typeof InvitationRedemptionResponseSchema>;
