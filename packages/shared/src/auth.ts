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

export const ConnectCodeIssueRequestSchema = z.object({}).strict();

export const RefreshTokenRequestSchema = z.object({ refreshToken: z.string().min(1).max(4096) }).strict();
export const RefreshTokenResponseSchema = z.object(TokenResponseFields).strict();

export const AuthIdentityProviderSchema = z.enum(["google", "github", "oidc"]);
export const WorkspaceNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
export const UserDisplayNameSchema = z.string().trim().min(1).max(255);
export const WorkspaceNameInputSchema = z.string().trim().toLowerCase().max(64).pipe(WorkspaceNameSchema);
export const WorkspaceDisplayNameSchema = z.string().trim().min(1).max(120);

export const MeWorkspaceSchema = z
  .object({
    id: z.string().uuid(),
    name: WorkspaceNameSchema,
    displayName: z.string().min(1),
    setupCompletedAt: z.string().datetime().nullable().default(null),
    grantedAt: z.string().datetime(),
  })
  .strict();

export const UserProfileSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: UserDisplayNameSchema,
  })
  .strict();

export const UpdateUserProfileRequestSchema = z.object({ displayName: UserDisplayNameSchema }).strict();

/** Workspaces are ordered by setup-complete, earliest grant, then UUID. */
export const MeResponseSchema = z
  .object({
    user: UserProfileSchema,
    workspaces: z.array(MeWorkspaceSchema),
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
export type AuthIdentityProvider = z.infer<typeof AuthIdentityProviderSchema>;
export type WorkspaceName = z.infer<typeof WorkspaceNameSchema>;
export type MeWorkspace = z.infer<typeof MeWorkspaceSchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type UpdateUserProfileRequest = z.infer<typeof UpdateUserProfileRequestSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;
