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

export const ConnectCodeIssueRequestSchema = z.object({ teamId: z.string().uuid() }).strict();

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
export const UserDisplayNameSchema = z.string().trim().min(1).max(255);

/**
 * The canonical Team field contracts, used by every writer: creation, profile update and the bootstrap CLI.
 * Length lives here rather than on the projections below, because a bound on a writer prevents bad data
 * while a bound on a read path only turns a value older writers validly stored into an unrecoverable error
 * on pages the user cannot get past. Rows predating these bounds stay readable and come into range the
 * first time they are renamed.
 */
export const TeamNameInputSchema = z.string().trim().toLowerCase().max(64).pipe(TeamNameSchema);
export const TeamDisplayNameSchema = z.string().trim().min(1).max(120);

export const MeMembershipSchema = z
  .object({
    teamId: z.string().uuid(),
    teamName: TeamNameSchema,
    teamDisplayName: z.string().min(1),
    role: MembershipRoleSchema,
  })
  .strict();

export const UserProfileSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: UserDisplayNameSchema,
  })
  .strict();

export const UpdateUserProfileRequestSchema = z
  .object({
    displayName: UserDisplayNameSchema,
  })
  .strict();

export const MeResponseSchema = z
  .object({
    user: UserProfileSchema,
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
export type ConnectCodeIssueRequest = z.infer<typeof ConnectCodeIssueRequestSchema>;
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;
export type MembershipRole = z.infer<typeof MembershipRoleSchema>;
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;
export type AuthIdentityProvider = z.infer<typeof AuthIdentityProviderSchema>;
export type TeamName = z.infer<typeof TeamNameSchema>;
export type MeMembership = z.infer<typeof MeMembershipSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type UpdateUserProfileRequest = z.infer<typeof UpdateUserProfileRequestSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;
