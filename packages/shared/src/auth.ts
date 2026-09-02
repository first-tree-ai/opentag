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
export const UserDisplayNameSchema = z.string().trim().min(1).max(255);

export const UserProfileSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().email(),
    displayName: UserDisplayNameSchema,
  })
  .strict();

export const UpdateUserProfileRequestSchema = z.object({ displayName: UserDisplayNameSchema }).strict();

/**
 * Authentication proves Account identity only. `setupCompletedAt` is durable Account state from
 * `users.setup_completed_at`; it is never derived from Agents, Workspaces, or grants.
 */
export const MeResponseSchema = z
  .object({
    user: UserProfileSchema,
    /**
     * Whether this Account owns an Agent it can work with. Derived on every read rather than
     * recorded once: an Account that has deleted its last Agent is in the same position as one that
     * never made a first, and a stored marker would answer that question with the past.
     */
    hasActiveAgent: z.boolean(),
  })
  .strict();

/**
 * Password bounds, shared so one number governs both sides of the check.
 *
 * The server configures Better Auth from these same constants. Stating them only in the schema would let the library
 * keep its own defaults underneath, and a password accepted here but refused there — or the reverse — is a rejection
 * with no message that fits it.
 *
 * The floor is twelve rather than the library's eight because this credential is not backed by a second factor and,
 * unlike the redirect providers, is verified entirely by the server that stores it.
 */
export const PASSWORD_MIN_LENGTH = 12;
/** Bounded because the hash cost is paid on the server, so an unbounded password is an unbounded amount of work. */
export const PASSWORD_MAX_LENGTH = 128;

/** Not `.trim()`: leading and trailing spaces are part of a password, and silently removing them changes the secret. */
export const PasswordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH);

export const EmailAddressSchema = z.string().trim().toLowerCase().email().max(320);

export const EmailSignUpRequestSchema = z
  .object({
    email: EmailAddressSchema,
    password: PasswordSchema,
    displayName: UserDisplayNameSchema,
  })
  .strict();

export const EmailSignInRequestSchema = z
  .object({
    email: EmailAddressSchema,
    /*
     * Deliberately not `PasswordSchema`: signing in must not tell a caller that the stored password is shorter than
     * today's floor, and a bounded string is all this needs to refuse an unbounded body.
     */
    password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  })
  .strict();

/**
 * `password` is a form rather than a link, so it is the one provider with no `startUrl`.
 *
 * A caller that renders providers by following `startUrl` must therefore special-case it rather than filtering it out,
 * which is why it is listed here at all instead of being reported through a separate field.
 */
export const AuthProvidersResponseSchema = z
  .object({
    providers: z.array(
      z
        .object({
          id: z.enum(["google", "dev", "password"]),
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
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type UpdateUserProfileRequest = z.infer<typeof UpdateUserProfileRequestSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type AuthProvidersResponse = z.infer<typeof AuthProvidersResponseSchema>;
export type EmailSignUpRequest = z.infer<typeof EmailSignUpRequestSchema>;
export type EmailSignInRequest = z.infer<typeof EmailSignInRequestSchema>;
