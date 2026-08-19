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
    expectedUserId: z.string().uuid().optional(),
  })
  .strict();

export const ConnectCodeExchangeResponseSchema = z.object(TokenResponseFields).strict();

export const ConnectCodeIssueResponseSchema = z
  .object({
    bootstrapCommand: z.string().min(1),
    expiresIn: z.number().int().positive(),
    issuedAt: z.string().datetime(),
  })
  .strict();

export const RefreshTokenRequestSchema = z
  .object({
    refreshToken: z.string().min(1).max(4096),
  })
  .strict();

export const RefreshTokenResponseSchema = z.object(TokenResponseFields).strict();

export const MembershipRoleSchema = z.enum(["admin", "member"]);
export const MembershipStatusSchema = z.enum(["active", "left", "removed"]);
export const AuthIdentityProviderSchema = z.enum(["google", "github", "oidc"]);
export const TeamNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

export const MeMembershipSchema = z
  .object({
    teamId: z.string().uuid(),
    teamName: TeamNameSchema,
    teamDisplayName: z.string().min(1),
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

export const AuthProvidersResponseSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.enum(["google", "dev"]),
          enabled: z.boolean(),
          startUrl: z.string().min(1).nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type ConnectCodeExchangeRequest = z.infer<typeof ConnectCodeExchangeRequestSchema>;
export type ConnectCodeExchangeResponse = z.infer<typeof ConnectCodeExchangeResponseSchema>;
export type ConnectCodeIssueResponse = z.infer<typeof ConnectCodeIssueResponseSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;
export type AuthIdentityProvider = z.infer<typeof AuthIdentityProviderSchema>;
export type TeamName = z.infer<typeof TeamNameSchema>;
export type MeMembership = z.infer<typeof MeMembershipSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;
