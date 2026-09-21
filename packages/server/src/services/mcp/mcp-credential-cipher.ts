import { z } from "zod";
import type { ApplicationCipher } from "../crypto.js";

const UuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

/**
 * The authorization row's credential: the access token and, when the AS rotated one, the refresh
 * token, sealed together in one bound envelope. Every field is optional-but-present in practice, so
 * a token response that omits a refresh token keeps the previous one by the caller, not here.
 */
const AuthorizationCredentialSchema = z
  .object({
    accessToken: z
      .string()
      .min(1)
      .max(16 * 1024),
    refreshToken: z
      .string()
      .min(1)
      .max(16 * 1024)
      .optional(),
    tokenType: z.string().min(1).max(64).optional(),
  })
  .strict();
const PKCESecretSchema = z
  .object({
    codeVerifier: z
      .string()
      .min(43)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/),
  })
  .strict();
const ClientSecretSchema = z
  .object({
    clientSecret: z
      .string()
      .min(1)
      .max(16 * 1024),
  })
  .strict();
const EncryptedMaterialSchema = z
  .object({
    ciphertext: z
      .string()
      .min(1)
      .max(64 * 1024),
    keyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
  })
  .strict();

export type McpAuthorizationCredential = z.infer<typeof AuthorizationCredentialSchema>;
export type McpEncryptedMaterial = z.infer<typeof EncryptedMaterialSchema>;

export interface McpAuthorizationBinding {
  mcpServerId: string;
  agentId: string;
  /** The selected authorization server issuer, or `null` while none is chosen. */
  authorizationServer: string | null;
}

export interface McpRegistrationBinding {
  accountId: string;
  authorizationServer: string;
}

/*
 * The AAD format is pinned as `domain|field|field`, with each field value passed through
 * `encodeURIComponent` and `null` rendered as the empty string.
 *
 * Two properties matter and both are deliberate:
 *
 * - **No `kind`.** Changing an authorization's kind (`none` to `bearer`, say) is an UPSERT into the
 *   same row, so a `kind` in the AAD would make the new credential unopenable by the very write
 *   that replaced it. The old ciphertext never survives that write, so there is no path where a
 *   stale credential is read after a kind change.
 * - **No `authHeader` / `extraHeaders`.** Renaming the authorization header is a configuration edit,
 *   not a credential change, and must not invalidate a stored key.
 *
 * The alternative — `JSON.stringify([...])` — has no format contract beyond the array order, so a
 * later field reordering would silently make every stored ciphertext unopenable. `encodeURIComponent`
 * keeps the separator unambiguous when a value itself contains `|`.
 */
function aadContext(domain: string, fields: readonly (string | null)[]): string {
  const rendered = fields.map((field) => encodeURIComponent(field ?? ""));
  return [domain, ...rendered].join("|");
}

export function authorizationAadContext(binding: McpAuthorizationBinding): string {
  return aadContext("mcp-authorization", [
    UuidSchema.parse(binding.mcpServerId),
    UuidSchema.parse(binding.agentId),
    binding.authorizationServer,
  ]);
}

export function registrationAadContext(binding: McpRegistrationBinding): string {
  return aadContext("mcp-client-registration", [UuidSchema.parse(binding.accountId), binding.authorizationServer]);
}

/**
 * Server-only credential serialization for the MCP feature. Two envelopes, each with its own AAD
 * context, so a ciphertext lifted from one row cannot be replayed into another row of the other kind.
 */
export class McpCredentialCipher {
  constructor(private readonly cipher: ApplicationCipher) {}

  encryptAuthorizationCredential(
    binding: McpAuthorizationBinding,
    credential: McpAuthorizationCredential,
  ): McpEncryptedMaterial {
    return this.seal(AuthorizationCredentialSchema, credential, authorizationAadContext(binding));
  }

  decryptAuthorizationCredential(
    binding: McpAuthorizationBinding,
    material: McpEncryptedMaterial,
  ): McpAuthorizationCredential {
    return this.open(AuthorizationCredentialSchema, material, authorizationAadContext(binding));
  }

  encryptPkceVerifier(binding: McpAuthorizationBinding, codeVerifier: string): McpEncryptedMaterial {
    return this.seal(PKCESecretSchema, { codeVerifier }, authorizationAadContext(binding));
  }

  decryptPkceVerifier(binding: McpAuthorizationBinding, material: McpEncryptedMaterial): string {
    return this.open(PKCESecretSchema, material, authorizationAadContext(binding)).codeVerifier;
  }

  encryptClientSecret(binding: McpRegistrationBinding, clientSecret: string): McpEncryptedMaterial {
    return this.seal(ClientSecretSchema, { clientSecret }, registrationAadContext(binding));
  }

  decryptClientSecret(binding: McpRegistrationBinding, material: McpEncryptedMaterial): string {
    return this.open(ClientSecretSchema, material, registrationAadContext(binding)).clientSecret;
  }

  private seal<T>(schema: z.ZodType<T>, value: T, context: string): McpEncryptedMaterial {
    try {
      return this.cipher.encryptBound(JSON.stringify(schema.parse(value)), context);
    } catch {
      throw new Error("MCP credential material could not be encrypted");
    }
  }

  private open<T>(schema: z.ZodType<T>, material: McpEncryptedMaterial, context: string): T {
    try {
      const value = EncryptedMaterialSchema.parse(material);
      if (!value.ciphertext.startsWith(`v2.${value.keyId}.`)) throw new Error("Invalid envelope");
      return schema.parse(JSON.parse(this.cipher.decrypt(value.ciphertext, context)));
    } catch {
      throw new Error("MCP credential material could not be authenticated");
    }
  }
}
