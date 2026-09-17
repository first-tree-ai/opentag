import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { imBindings, slackInstallations } from "../db/schema/index.js";
import type { ApplicationCipher } from "../services/crypto.js";
import { decodeFeishuCredential, decodeSlackCredential } from "../services/im-bindings/credential-material.js";
import type { FeishuTenantTokenCache } from "./feishu-tenant-token.js";
import {
  feishuOriginForBrand,
  imCredentialGenerationPin,
  type RuntimeProviderMaterial,
  type RuntimeProviderMaterialInput,
  SLACK_FIXED_ORIGIN,
} from "./provider-material.js";

/**
 * Resolves real IM platform material entirely on the Server: existing encrypted bot/app
 * credentials are decrypted in memory, the Feishu tenant token is exchanged and cached Server-side
 * at the fixed brand origin, and the Slack bot token never leaves the Server. A generation
 * mismatch against the capability-pinned value resolves to undefined and fails the request.
 */
export class ImProviderMaterialResolver {
  readonly #database: DatabaseClient;
  readonly #cipher: ApplicationCipher;
  readonly #tenantTokens: FeishuTenantTokenCache;

  constructor(options: {
    database: DatabaseClient;
    cipher: ApplicationCipher;
    tenantTokens: FeishuTenantTokenCache;
  }) {
    this.#database = options.database;
    this.#cipher = options.cipher;
    this.#tenantTokens = options.tenantTokens;
  }

  async resolve(input: RuntimeProviderMaterialInput): Promise<RuntimeProviderMaterial | undefined> {
    if (input.provider === "feishu") return this.#resolveFeishu(input);
    if (input.provider === "slack") return this.#resolveSlack(input);
    return undefined;
  }

  async #resolveFeishu(input: RuntimeProviderMaterialInput): Promise<RuntimeProviderMaterial | undefined> {
    const [binding] = await this.#database
      .select()
      .from(imBindings)
      .where(
        and(eq(imBindings.id, input.bindingId), eq(imBindings.provider, "feishu"), eq(imBindings.status, "active")),
      )
      .limit(1);
    if (!binding || String(binding.credentialGeneration) !== input.credentialGeneration) return undefined;
    const credential = decodeFeishuCredential(this.#cipher, binding.encryptedCredential, { bindingId: binding.id });
    if (!credential || credential.appId !== binding.externalAppId) return undefined;
    const brand = binding.externalTeamBrand === "lark" ? "lark" : "feishu";
    const token = await this.#tenantTokens.get({
      bindingId: binding.id,
      credentialGeneration: binding.credentialGeneration,
      brand,
      origin: feishuOriginForBrand(brand),
      appId: credential.appId,
      appSecret: credential.appSecret,
      signal: input.signal,
    });
    return { kind: "bearer", token: token.token, origin: feishuOriginForBrand(brand), expiresAt: token.expiresAt };
  }

  async #resolveSlack(input: RuntimeProviderMaterialInput): Promise<RuntimeProviderMaterial | undefined> {
    const [binding] = await this.#database
      .select()
      .from(imBindings)
      .where(and(eq(imBindings.id, input.bindingId), eq(imBindings.provider, "slack"), eq(imBindings.status, "active")))
      .limit(1);
    if (!binding?.slackInstallationId) return undefined;
    const [installation] = await this.#database
      .select()
      .from(slackInstallations)
      .where(and(eq(slackInstallations.id, binding.slackInstallationId), eq(slackInstallations.status, "active")))
      .limit(1);
    if (!installation || installation.agentId !== binding.agentId) return undefined;
    const pin = imCredentialGenerationPin("slack", binding.credentialGeneration, installation.credentialGeneration);
    if (pin !== input.credentialGeneration) return undefined;
    const credential = decodeSlackCredential(this.#cipher, installation.encryptedCredential, {
      bindingId: binding.id,
      slackInstallationId: installation.id,
    });
    if (!credential) return undefined;
    return { kind: "bearer", token: credential.botAccessToken, origin: SLACK_FIXED_ORIGIN };
  }
}
