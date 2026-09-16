import { GitHubDecimalIdSchema } from "@opentag/shared";
import { z } from "zod";
import type { ApplicationCipher } from "./crypto.js";

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const ConnectionBindingSchema = z
  .object({
    connectionId: UuidSchema,
    accountId: UuidSchema,
    githubHost: z.literal("github.com"),
    appId: GitHubDecimalIdSchema,
  })
  .strict();
const UserCredentialBindingSchema = ConnectionBindingSchema.extend({ githubUserId: GitHubDecimalIdSchema });
const OAuthBindingSchema = ConnectionBindingSchema.extend({ flowId: UuidSchema });
const UserCredentialSchema = z
  .object({
    accessToken: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(4096),
  })
  .strict();
const OAuthSecretSchema = z
  .object({
    pkceVerifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
  })
  .strict();
const EncryptedMaterialSchema = z
  .object({
    ciphertext: z
      .string()
      .min(1)
      .max(16 * 1024),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  })
  .strict();

export type GitHubUserCredentialBinding = z.infer<typeof UserCredentialBindingSchema>;
export type GitHubOAuthSecretBinding = z.infer<typeof OAuthBindingSchema>;
export type GitHubUserCredential = z.infer<typeof UserCredentialSchema>;
export type GitHubEncryptedMaterial = z.infer<typeof EncryptedMaterialSchema>;

function userCredentialContext(binding: GitHubUserCredentialBinding): string {
  const value = UserCredentialBindingSchema.parse(binding);
  return JSON.stringify([
    "github-user-credential",
    value.connectionId,
    value.accountId,
    value.githubHost,
    value.appId,
    value.githubUserId,
  ]);
}

function oauthContext(binding: GitHubOAuthSecretBinding): string {
  const value = OAuthBindingSchema.parse(binding);
  return JSON.stringify([
    "github-oauth-pkce",
    value.connectionId,
    value.accountId,
    value.githubHost,
    value.appId,
    value.flowId,
  ]);
}

/** Server-only credential serialization. The access/refresh pair is sealed in one bound envelope. */
export class GitHubCredentialCipher {
  constructor(private readonly cipher: ApplicationCipher) {}

  encryptUserCredential(
    binding: GitHubUserCredentialBinding,
    credential: GitHubUserCredential,
  ): GitHubEncryptedMaterial {
    return this.seal(UserCredentialSchema, credential, () => userCredentialContext(binding));
  }

  decryptUserCredential(binding: GitHubUserCredentialBinding, material: GitHubEncryptedMaterial): GitHubUserCredential {
    return this.open(UserCredentialSchema, material, () => userCredentialContext(binding));
  }

  encryptOAuthSecret(binding: GitHubOAuthSecretBinding, pkceVerifier: string): GitHubEncryptedMaterial {
    return this.seal(OAuthSecretSchema, { pkceVerifier }, () => oauthContext(binding));
  }

  decryptOAuthSecret(binding: GitHubOAuthSecretBinding, material: GitHubEncryptedMaterial): string {
    return this.open(OAuthSecretSchema, material, () => oauthContext(binding)).pkceVerifier;
  }

  private seal<T>(schema: z.ZodType<T>, value: T, context: () => string): GitHubEncryptedMaterial {
    try {
      const plaintext = JSON.stringify(schema.parse(value));
      return this.cipher.encryptBound(plaintext, context());
    } catch {
      throw new Error("GitHub credential material could not be encrypted");
    }
  }

  private open<T>(schema: z.ZodType<T>, material: GitHubEncryptedMaterial, context: () => string): T {
    try {
      const value = EncryptedMaterialSchema.parse(material);
      if (!value.ciphertext.startsWith(`v2.${value.keyId}.`)) throw new Error("Invalid envelope");
      return schema.parse(JSON.parse(this.cipher.decrypt(value.ciphertext, context())));
    } catch {
      throw new Error("GitHub credential material could not be authenticated");
    }
  }
}
