import { z } from "zod";

const TokenResponseFields = {
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().positive(),
} as const;

export const ConnectCodeExchangeRequestSchema = z
  .object({
    code: z.string().trim().min(16).max(512),
  })
  .strict();

export const ConnectCodeExchangeResponseSchema = z.object(TokenResponseFields).strict();

export const RefreshTokenRequestSchema = z
  .object({
    refreshToken: z.string().min(1).max(4096),
  })
  .strict();

export const RefreshTokenResponseSchema = z.object(TokenResponseFields).strict();

export const MembershipRoleSchema = z.enum(["admin", "member"]);

export const MeMembershipSchema = z
  .object({
    tenantId: z.string().uuid(),
    tenantSlug: z.string().min(1),
    tenantDisplayName: z.string().min(1),
    role: MembershipRoleSchema,
  })
  .strict();

export const MeResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().uuid(),
        email: z.string().email(),
        displayName: z.string().min(1),
      })
      .strict(),
    memberships: z.array(MeMembershipSchema),
  })
  .strict();

export type ConnectCodeExchangeRequest = z.infer<typeof ConnectCodeExchangeRequestSchema>;
export type ConnectCodeExchangeResponse = z.infer<typeof ConnectCodeExchangeResponseSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export type MeMembership = z.infer<typeof MeMembershipSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
