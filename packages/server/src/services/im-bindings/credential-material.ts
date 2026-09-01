import { FEISHU_REQUIRED_TENANT_SCOPES, hasRequiredSlackBotScopes, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { z } from "zod";
import type { slackInstallations } from "../../db/schema/index.js";
import type { ApplicationCipher } from "../crypto.js";

export const FeishuCredentialSchema = z
  .object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    grantedScopes: z.array(z.string().min(1)).max(128),
  })
  .strict();

export const SlackCredentialSchema = z
  .object({
    botId: z.string().min(1),
    botAccessToken: z.string().min(1),
    signingSecret: z.string().min(1),
    grantedScopes: z.array(z.string().min(1)).max(128),
  })
  .strict();

export type FeishuCredential = z.infer<typeof FeishuCredentialSchema>;
export type SlackCredential = z.infer<typeof SlackCredentialSchema>;

export interface CredentialInspection {
  status: "valid" | "invalid";
  grantedCapabilities: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
}

export interface CredentialMaterialInput {
  provider: "feishu" | "slack";
  encryptedCredential: string | null;
  externalAppId: string | null;
  externalBotId: string | null;
  externalTeamId: string | null;
  credentialGeneration: number;
  credentialSchemaVersion: number | null;
  grantedCapabilities: string[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function requiredCapabilitiesFor(provider: "feishu" | "slack"): string[] {
  return provider === "feishu" ? [...FEISHU_REQUIRED_TENANT_SCOPES] : [...SLACK_REQUIRED_BOT_SCOPES];
}

export function decodeFeishuCredential(
  cipher: ApplicationCipher,
  encryptedCredential: string | null,
): FeishuCredential | undefined {
  if (!encryptedCredential) return undefined;
  try {
    return FeishuCredentialSchema.parse(JSON.parse(cipher.decrypt(encryptedCredential)));
  } catch {
    return undefined;
  }
}

export function decodeSlackCredential(
  cipher: ApplicationCipher,
  encryptedCredential: string | null,
): SlackCredential | undefined {
  if (!encryptedCredential) return undefined;
  try {
    return SlackCredentialSchema.parse(JSON.parse(cipher.decrypt(encryptedCredential)));
  } catch {
    return undefined;
  }
}

export function slackInstallationInspectionInput(
  installation: typeof slackInstallations.$inferSelect,
): CredentialMaterialInput & { provider: "slack" } {
  return {
    provider: "slack",
    encryptedCredential: installation.encryptedCredential,
    externalAppId: installation.externalAppId,
    externalBotId: installation.externalBotId,
    externalTeamId: installation.externalTeamId,
    credentialGeneration: installation.credentialGeneration,
    credentialSchemaVersion: installation.credentialSchemaVersion,
    grantedCapabilities: installation.grantedCapabilities,
  };
}

function invalidInspection(
  storedCapabilities: string[],
  requiredCapabilities: string[],
  credentialCapabilities: readonly string[] = storedCapabilities,
): CredentialInspection {
  return {
    status: "invalid",
    grantedCapabilities: storedCapabilities,
    requiredCapabilities,
    missingCapabilities: requiredCapabilities.filter(
      (capability) => !storedCapabilities.includes(capability) || !credentialCapabilities.includes(capability),
    ),
  };
}

function materialEnvelopeValid(input: CredentialMaterialInput): boolean {
  return (
    input.credentialGeneration >= 1 &&
    input.credentialSchemaVersion === 1 &&
    Boolean(input.encryptedCredential && input.externalAppId && input.externalBotId) &&
    (input.provider !== "slack" || Boolean(input.externalTeamId))
  );
}

function capabilitiesMatch(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((capability, index) => capability === right[index]);
}

export function inspectCredentialMaterial(
  cipher: ApplicationCipher,
  input: CredentialMaterialInput,
): CredentialInspection {
  const requiredCapabilities = requiredCapabilitiesFor(input.provider);
  const storedCapabilities = uniqueSorted(input.grantedCapabilities);
  if (!materialEnvelopeValid(input)) return invalidInspection(storedCapabilities, requiredCapabilities);
  if (input.provider === "feishu") {
    const credential = decodeFeishuCredential(cipher, input.encryptedCredential);
    if (!credential) return invalidInspection(storedCapabilities, requiredCapabilities);
    const credentialCapabilities = uniqueSorted(credential.grantedScopes);
    if (credential.appId !== input.externalAppId || !capabilitiesMatch(credentialCapabilities, storedCapabilities)) {
      return invalidInspection(storedCapabilities, requiredCapabilities, credentialCapabilities);
    }
    return {
      // A scope-incomplete Feishu grant remains usable by the existing Channel while the
      // replacement authorization is validated. Readiness still reports the missing scopes.
      status: "valid",
      grantedCapabilities: storedCapabilities,
      requiredCapabilities,
      missingCapabilities: requiredCapabilities.filter((capability) => !storedCapabilities.includes(capability)),
    };
  }
  const credential = decodeSlackCredential(cipher, input.encryptedCredential);
  if (!credential) return invalidInspection(storedCapabilities, requiredCapabilities);
  const credentialCapabilities = uniqueSorted(credential.grantedScopes);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !storedCapabilities.includes(capability) || !credentialCapabilities.includes(capability),
  );
  return {
    status:
      capabilitiesMatch(credentialCapabilities, storedCapabilities) &&
      missingCapabilities.length === 0 &&
      hasRequiredSlackBotScopes(credential.grantedScopes)
        ? "valid"
        : "invalid",
    grantedCapabilities: storedCapabilities,
    requiredCapabilities,
    missingCapabilities,
  };
}

export function inspectBindingCredentials(
  cipher: ApplicationCipher,
  binding: CredentialMaterialInput,
  installation: typeof slackInstallations.$inferSelect | null | undefined,
): CredentialInspection {
  if (binding.provider !== "slack") return inspectCredentialMaterial(cipher, binding);
  return inspectCredentialMaterial(
    cipher,
    installation
      ? slackInstallationInspectionInput(installation)
      : {
          provider: "slack",
          encryptedCredential: null,
          externalAppId: binding.externalAppId,
          externalBotId: binding.externalBotId,
          externalTeamId: binding.externalTeamId,
          credentialGeneration: binding.credentialGeneration,
          credentialSchemaVersion: binding.credentialSchemaVersion,
          grantedCapabilities: binding.grantedCapabilities,
        },
  );
}
