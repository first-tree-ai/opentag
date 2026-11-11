import { FEISHU_REQUIRED_TENANT_SCOPES, hasRequiredSlackBotScopes, SLACK_REQUIRED_BOT_SCOPES } from "@opentag/shared";
import { z } from "zod";
import type { slackInstallations } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
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

/*
 * AAD identity contexts for IM credential material. Each binds the encryption purpose to the
 * stable record that owns the ciphertext: the Feishu binding row, the Slack installation row, or
 * the owning binding plus the setup attempt. Record IDs are server-generated and never reassigned,
 * so a value written for one purpose or record can never be opened under another. v1 ciphertexts
 * predate AAD and still open without a context; every write and read is context-aware regardless.
 */
function contextRecordId(value: string): string {
  if (!value) throw new Error("IM credential encryption contexts require a stable record ID");
  return value;
}

export function feishuBindingCredentialContext(bindingId: string): string {
  return `im-binding-credential:feishu:${contextRecordId(bindingId)}`;
}

export function slackInstallationCredentialContext(slackInstallationId: string): string {
  return `slack-installation-credential:${contextRecordId(slackInstallationId)}`;
}

export function feishuSetupAttemptContext(bindingId: string, attemptId: string): string {
  return `feishu-setup-context:${contextRecordId(bindingId)}:${contextRecordId(attemptId)}`;
}

function feishuCredentialAad(options: CredentialDecodeOptions): string | undefined {
  return options.bindingId ? feishuBindingCredentialContext(options.bindingId) : undefined;
}

function slackCredentialAad(options: CredentialDecodeOptions): string | undefined {
  return options.slackInstallationId ? slackInstallationCredentialContext(options.slackInstallationId) : undefined;
}

export interface CredentialInspection {
  status: "valid" | "invalid";
  grantedCapabilities: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
}

export interface CredentialMaterialInput {
  slackInstallationId?: string | null;
  provider: "feishu" | "slack";
  encryptedCredential: string | null;
  externalAppId: string | null;
  externalBotId: string | null;
  externalTeamId: string | null;
  credentialGeneration: number;
  credentialSchemaVersion: number | null;
  grantedCapabilities: string[];
}

export interface CredentialDecodeOptions {
  agentId?: string;
  bindingId?: string;
  slackInstallationId?: string;
  logger?: Pick<ServiceLogger, "warn">;
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
  options: CredentialDecodeOptions = {},
): FeishuCredential | undefined {
  if (!encryptedCredential) return undefined;
  let plaintext: string;
  try {
    plaintext = cipher.decrypt(encryptedCredential, feishuCredentialAad(options));
  } catch {
    options.logger?.warn(
      {
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        bindingId: options.bindingId,
        slackInstallationId: options.slackInstallationId,
        code: "IM_BINDING_CREDENTIAL_DECRYPT_FAILED",
      },
      "Feishu credential decrypt failed",
    );
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    options.logger?.warn(
      {
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        bindingId: options.bindingId,
        slackInstallationId: options.slackInstallationId,
        code: "IM_BINDING_CREDENTIAL_PAYLOAD_INVALID",
      },
      "Feishu credential payload parse failed",
    );
    return undefined;
  }
  try {
    return FeishuCredentialSchema.parse(payload);
  } catch {
    options.logger?.warn(
      {
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        bindingId: options.bindingId,
        slackInstallationId: options.slackInstallationId,
        code: "IM_BINDING_CREDENTIAL_SCHEMA_INVALID",
      },
      "Feishu credential schema validation failed",
    );
    return undefined;
  }
}

export function decodeSlackCredential(
  cipher: ApplicationCipher,
  encryptedCredential: string | null,
  options: CredentialDecodeOptions = {},
): SlackCredential | undefined {
  if (!encryptedCredential) return undefined;
  let plaintext: string;
  try {
    plaintext = cipher.decrypt(encryptedCredential, slackCredentialAad(options));
  } catch {
    options.logger?.warn(
      {
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        bindingId: options.bindingId,
        slackInstallationId: options.slackInstallationId,
        code: "IM_BINDING_CREDENTIAL_DECRYPT_FAILED",
      },
      "Slack credential decrypt failed",
    );
    return undefined;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(plaintext);
  } catch {
    options.logger?.warn(
      {
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        bindingId: options.bindingId,
        slackInstallationId: options.slackInstallationId,
        code: "IM_BINDING_CREDENTIAL_PAYLOAD_INVALID",
      },
      "Slack credential payload parse failed",
    );
    return undefined;
  }
  try {
    return SlackCredentialSchema.parse(payload);
  } catch {
    options.logger?.warn(
      {
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        bindingId: options.bindingId,
        slackInstallationId: options.slackInstallationId,
        code: "IM_BINDING_CREDENTIAL_SCHEMA_INVALID",
      },
      "Slack credential schema validation failed",
    );
    return undefined;
  }
}

export function slackInstallationInspectionInput(
  installation: typeof slackInstallations.$inferSelect,
): CredentialMaterialInput & { provider: "slack" } {
  return {
    slackInstallationId: installation.id,
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

function logCredentialInspectionWarning(
  options: CredentialDecodeOptions,
  slackInstallationId: string | undefined,
  provider: "feishu" | "slack",
  code: "IM_BINDING_CREDENTIAL_ENVELOPE_INVALID" | "IM_BINDING_CREDENTIAL_MISMATCH",
  message: string,
): void {
  options.logger?.warn(
    {
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      bindingId: options.bindingId,
      slackInstallationId,
      provider,
      code,
    },
    message,
  );
}

function inspectFeishuCredentialMaterial(
  cipher: ApplicationCipher,
  input: CredentialMaterialInput,
  storedCapabilities: string[],
  requiredCapabilities: string[],
  decodeOptions: CredentialDecodeOptions,
): CredentialInspection {
  const credential = decodeFeishuCredential(cipher, input.encryptedCredential, decodeOptions);
  if (!credential) return invalidInspection(storedCapabilities, requiredCapabilities);
  const credentialCapabilities = uniqueSorted(credential.grantedScopes);
  if (credential.appId !== input.externalAppId || !capabilitiesMatch(credentialCapabilities, storedCapabilities)) {
    logCredentialInspectionWarning(
      decodeOptions,
      decodeOptions.slackInstallationId,
      input.provider,
      "IM_BINDING_CREDENTIAL_MISMATCH",
      "Feishu credential metadata mismatch",
    );
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

function inspectSlackCredentialMaterial(
  cipher: ApplicationCipher,
  input: CredentialMaterialInput,
  storedCapabilities: string[],
  requiredCapabilities: string[],
  decodeOptions: CredentialDecodeOptions,
): CredentialInspection {
  const credential = decodeSlackCredential(cipher, input.encryptedCredential, decodeOptions);
  if (!credential) return invalidInspection(storedCapabilities, requiredCapabilities);
  const credentialCapabilities = uniqueSorted(credential.grantedScopes);
  const missingCapabilities = requiredCapabilities.filter(
    (capability) => !storedCapabilities.includes(capability) || !credentialCapabilities.includes(capability),
  );
  const valid =
    capabilitiesMatch(credentialCapabilities, storedCapabilities) &&
    missingCapabilities.length === 0 &&
    hasRequiredSlackBotScopes(credential.grantedScopes);
  if (!valid && missingCapabilities.length === 0) {
    logCredentialInspectionWarning(
      decodeOptions,
      decodeOptions.slackInstallationId,
      input.provider,
      "IM_BINDING_CREDENTIAL_MISMATCH",
      "Slack credential metadata mismatch",
    );
  }
  return {
    status: valid ? "valid" : "invalid",
    grantedCapabilities: storedCapabilities,
    requiredCapabilities,
    missingCapabilities,
  };
}

export function inspectCredentialMaterial(
  cipher: ApplicationCipher,
  input: CredentialMaterialInput,
  options: CredentialDecodeOptions = {},
): CredentialInspection {
  const requiredCapabilities = requiredCapabilitiesFor(input.provider);
  const storedCapabilities = uniqueSorted(input.grantedCapabilities);
  const slackInstallationId = options.slackInstallationId ?? input.slackInstallationId ?? undefined;
  const decodeOptions: CredentialDecodeOptions = {
    ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
    bindingId: options.bindingId,
    slackInstallationId,
    logger: options.logger,
  };
  if (!materialEnvelopeValid(input)) {
    logCredentialInspectionWarning(
      decodeOptions,
      slackInstallationId,
      input.provider,
      "IM_BINDING_CREDENTIAL_ENVELOPE_INVALID",
      "IM binding credential envelope invalid",
    );
    return invalidInspection(storedCapabilities, requiredCapabilities);
  }
  return input.provider === "feishu"
    ? inspectFeishuCredentialMaterial(cipher, input, storedCapabilities, requiredCapabilities, decodeOptions)
    : inspectSlackCredentialMaterial(cipher, input, storedCapabilities, requiredCapabilities, decodeOptions);
}

export function inspectBindingCredentials(
  cipher: ApplicationCipher,
  binding: CredentialMaterialInput,
  installation: typeof slackInstallations.$inferSelect | null | undefined,
  options: CredentialDecodeOptions = {},
): CredentialInspection {
  const bindingId = options.bindingId;
  if (binding.provider !== "slack") {
    return inspectCredentialMaterial(cipher, binding, {
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      bindingId,
      slackInstallationId: options.slackInstallationId,
      logger: options.logger,
    });
  }
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
    {
      ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
      bindingId,
      slackInstallationId: options.slackInstallationId,
      logger: options.logger,
    },
  );
}
