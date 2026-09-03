import type {
  ImBindingHandoffStatus,
  ImBindingState,
  ImCliProvider,
  ImCliReadinessStatus,
  IntegrationCredentialExecutionReason,
  IntegrationCredentialExecutionStatus,
  ProviderCliExpectedIdentity,
  ProviderCliHandoffProgress,
  ProviderCliValidationGrantFrame,
  ProviderReadinessStatus,
} from "@opentag/shared";
import { hasRequiredFeishuTenantScopes, hasRequiredSlackBotScopes } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings, slackInstallations } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import type { ApplicationCipher } from "../crypto.js";
import { decodeFeishuCredential, decodeSlackCredential } from "./credential-material.js";

export interface ImBindingReadinessInput {
  id: string;
  agentId: string;
  provider: "feishu" | "slack";
  status: ImBindingState;
  connectionLeaseExpiresAt: Date | null;
  observedConnectedAt: Date | null;
  observedAt: Date | null;
  grantedCapabilities: string[];
  credentialGeneration: number;
  credentialStatus: "valid" | "invalid";
}

export interface ImBindingReadiness {
  handoff: ImBindingHandoffStatus;
  agentRuntimeReadiness: ProviderReadinessStatus;
  providerCliReadiness: ImCliReadinessStatus;
  credentialExecutionReadiness: IntegrationCredentialExecutionStatus;
  credentialExecutionReason?: IntegrationCredentialExecutionReason;
  reauthorizationRequired: boolean;
  connection: { state: "connected" | "disconnected"; observedAt: string } | null;
}

export interface ProviderCliRequirement {
  agentId: string;
  credentialGeneration: number;
  expectedIdentity: ProviderCliExpectedIdentity;
  integrationId: string;
  provider: ImCliProvider;
}

export interface ProviderCliValidationGrantInput {
  agentId: string;
  computerId: string;
  installationId: string;
  credentialGeneration: number;
  integrationId: string;
  provider: ImCliProvider;
}

type CredentialReadiness = {
  status: IntegrationCredentialExecutionStatus;
  reason?: IntegrationCredentialExecutionReason;
};

type ReadinessReader = (
  agentId: string,
  provider: ImCliProvider,
  integrationId: string,
  credentialGeneration: number,
) => Promise<CredentialReadiness>;

type ArtifactReadinessReader = (
  agentId: string,
  provider: ImCliProvider,
  integrationId: string,
  credentialGeneration: number,
) => Promise<ImCliReadinessStatus>;

type BindingRow = typeof imBindings.$inferSelect;
type SlackInstallationRow = typeof slackInstallations.$inferSelect;

function expectedIdentity(
  cipher: ApplicationCipher,
  binding: BindingRow,
  installation: SlackInstallationRow | null,
  logger?: Pick<ServiceLogger, "warn">,
): ProviderCliExpectedIdentity | undefined {
  if (binding.provider === "feishu") {
    if (!binding.externalAppId || !binding.externalBotId) return undefined;
    return {
      provider: "feishu",
      appId: binding.externalAppId,
      botOpenId: binding.externalBotId,
      teamBrand: binding.externalTeamBrand === "lark" ? "lark" : "feishu",
    };
  }
  if (!installation?.externalTeamId || !installation.externalBotId) return undefined;
  const credential = decodeSlackCredential(cipher, installation.encryptedCredential, {
    bindingId: binding.id,
    logger,
  });
  if (!credential) return undefined;
  return {
    provider: "slack",
    teamId: installation.externalTeamId,
    botUserId: installation.externalBotId,
    botId: credential.botId,
  };
}

function requirementFromRow(
  cipher: ApplicationCipher,
  row: { binding: BindingRow; slackInstallation: SlackInstallationRow | null },
  logger?: Pick<ServiceLogger, "warn">,
): ProviderCliRequirement | undefined {
  const identity = expectedIdentity(cipher, row.binding, row.slackInstallation, logger);
  if (!identity) return undefined;
  return {
    agentId: row.binding.agentId,
    credentialGeneration:
      row.binding.provider === "slack" && row.slackInstallation
        ? row.slackInstallation.credentialGeneration
        : row.binding.credentialGeneration,
    expectedIdentity: identity,
    integrationId: row.binding.id,
    provider: row.binding.provider,
  };
}

function providerCliProgress(
  artifactStatus: ImCliReadinessStatus,
  credential: CredentialReadiness,
): ProviderCliHandoffProgress | undefined {
  if (credential.reason === "upgrade_required" || credential.status === "needs_attention") {
    return { phase: "needs_attention", ...(credential.reason ? { reason: credential.reason } : {}) };
  }
  if (artifactStatus !== "ready") {
    return artifactStatus === "unavailable" ? { phase: "needs_attention" } : { phase: "preparing_cli" };
  }
  return credential.status === "ready" ? undefined : { phase: "checking_credentials" };
}

function connectionObservation(
  input: ImBindingReadinessInput,
  now: Date,
): { state: "connected" | "disconnected"; observedAt: string } | null {
  if (input.provider !== "feishu" || !input.observedAt) return null;
  return {
    state:
      input.connectionLeaseExpiresAt && input.connectionLeaseExpiresAt > now && input.observedConnectedAt
        ? "connected"
        : "disconnected",
    observedAt: input.observedAt.toISOString(),
  };
}

function reauthorizationRequired(input: ImBindingReadinessInput): boolean {
  if (input.status === "reauthorization_required") return true;
  if (input.status !== "active") return false;
  const scopesReady =
    input.provider === "feishu"
      ? hasRequiredFeishuTenantScopes(input.grantedCapabilities)
      : hasRequiredSlackBotScopes(input.grantedCapabilities);
  return !scopesReady || input.credentialStatus === "invalid";
}

function projectHandoff(input: {
  bindingState: ImBindingState;
  connectionReady: boolean;
  agentRuntimeReadiness: ProviderReadinessStatus;
  providerCliReadiness: ImCliReadinessStatus;
  credentialExecution: CredentialReadiness;
}): ImBindingHandoffStatus {
  if (input.bindingState !== "active") return { bindingState: input.bindingState, handoffReady: false };
  const ready =
    input.connectionReady &&
    input.agentRuntimeReadiness === "ready" &&
    input.providerCliReadiness === "ready" &&
    input.credentialExecution.status === "ready";
  if (ready) return { bindingState: input.bindingState, handoffReady: true };
  const providerCli = providerCliProgress(input.providerCliReadiness, input.credentialExecution);
  return {
    bindingState: input.bindingState,
    handoffReady: false,
    ...(providerCli ? { providerCli } : {}),
  };
}

function feishuValidationGrant(
  cipher: ApplicationCipher,
  binding: BindingRow,
  identity: ProviderCliExpectedIdentity,
  generation: number,
  logger?: Pick<ServiceLogger, "warn">,
): { expectedIdentity: ProviderCliExpectedIdentity; grant: ProviderCliValidationGrantFrame["grant"] } | undefined {
  if (binding.credentialGeneration !== generation) return undefined;
  const credential = decodeFeishuCredential(cipher, binding.encryptedCredential, { bindingId: binding.id, logger });
  if (!credential || credential.appId !== binding.externalAppId) return undefined;
  return {
    expectedIdentity: identity,
    grant: {
      provider: "feishu",
      appId: credential.appId,
      appSecret: credential.appSecret,
      teamBrand: binding.externalTeamBrand === "lark" ? "lark" : "feishu",
    },
  };
}

function slackValidationGrant(
  cipher: ApplicationCipher,
  bindingId: string,
  installation: SlackInstallationRow | null,
  identity: ProviderCliExpectedIdentity,
  generation: number,
  logger?: Pick<ServiceLogger, "warn">,
): { expectedIdentity: ProviderCliExpectedIdentity; grant: ProviderCliValidationGrantFrame["grant"] } | undefined {
  if (!installation || installation.status !== "active" || installation.credentialGeneration !== generation) {
    return undefined;
  }
  const credential = decodeSlackCredential(cipher, installation.encryptedCredential, { bindingId, logger });
  if (!credential || !hasRequiredSlackBotScopes(credential.grantedScopes)) return undefined;
  return { expectedIdentity: identity, grant: { provider: "slack", botAccessToken: credential.botAccessToken } };
}

export class ImBindingProviderCli {
  readonly #database: DatabaseClient;
  readonly #cipher: ApplicationCipher;
  readonly #artifactReadiness: ArtifactReadinessReader;
  readonly #credentialReadiness: ReadinessReader;
  readonly #logger?: Pick<ServiceLogger, "warn">;

  constructor(
    database: DatabaseClient,
    cipher: ApplicationCipher,
    options: {
      artifactReadiness: ArtifactReadinessReader;
      credentialReadiness: ReadinessReader;
      logger?: Pick<ServiceLogger, "warn">;
    },
  ) {
    this.#database = database;
    this.#cipher = cipher;
    this.#artifactReadiness = options.artifactReadiness;
    this.#credentialReadiness = options.credentialReadiness;
    this.#logger = options.logger;
  }

  async listActiveRequirements(computerId: string): Promise<readonly ProviderCliRequirement[]> {
    const rows = await this.#database
      .select({ binding: imBindings, slackInstallation: slackInstallations })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(and(eq(agents.computerId, computerId), eq(agents.status, "active"), eq(imBindings.status, "active")));
    return rows.flatMap((row) => {
      const requirement = requirementFromRow(this.#cipher, row, this.#logger);
      return requirement ? [requirement] : [];
    });
  }

  async issueValidationGrant(
    input: ProviderCliValidationGrantInput,
  ): Promise<
    { expectedIdentity: ProviderCliExpectedIdentity; grant: ProviderCliValidationGrantFrame["grant"] } | undefined
  > {
    const [row] = await this.#database
      .select({
        binding: imBindings,
        slackInstallation: slackInstallations,
        computerId: agents.computerId,
        installationId: computers.currentInstallationId,
        agentStatus: agents.status,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(computers, eq(computers.id, agents.computerId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(and(eq(imBindings.id, input.integrationId), eq(imBindings.agentId, input.agentId)))
      .limit(1);
    if (
      !row ||
      row.agentStatus !== "active" ||
      row.computerId !== input.computerId ||
      row.installationId !== input.installationId ||
      row.binding.status !== "active" ||
      row.binding.provider !== input.provider
    ) {
      return undefined;
    }
    const identity = expectedIdentity(this.#cipher, row.binding, row.slackInstallation, this.#logger);
    if (!identity) return undefined;
    return row.binding.provider === "feishu"
      ? feishuValidationGrant(this.#cipher, row.binding, identity, input.credentialGeneration, this.#logger)
      : slackValidationGrant(
          this.#cipher,
          row.binding.id,
          row.slackInstallation,
          identity,
          input.credentialGeneration,
          this.#logger,
        );
  }

  async readiness(
    input: ImBindingReadinessInput,
    agentRuntimeReadiness: Promise<ProviderReadinessStatus>,
    now: Date,
  ): Promise<ImBindingReadiness> {
    const [runtime, artifact, credential] = await Promise.all([
      agentRuntimeReadiness,
      this.#artifactReadiness(input.agentId, input.provider, input.id, input.credentialGeneration),
      this.#credentialReadiness(input.agentId, input.provider, input.id, input.credentialGeneration),
    ]);
    const needsReauthorization = reauthorizationRequired(input);
    const bindingState = needsReauthorization ? "reauthorization_required" : input.status;
    const connection = connectionObservation(input, now);
    const connectionReady =
      input.provider === "slack" ? input.observedConnectedAt !== null : connection?.state === "connected";
    return {
      handoff: projectHandoff({
        bindingState,
        connectionReady,
        agentRuntimeReadiness: runtime,
        providerCliReadiness: artifact,
        credentialExecution: credential,
      }),
      agentRuntimeReadiness: runtime,
      providerCliReadiness: artifact,
      credentialExecutionReadiness: credential.status,
      ...(credential.reason ? { credentialExecutionReason: credential.reason } : {}),
      reauthorizationRequired: needsReauthorization,
      connection,
    };
  }
}
