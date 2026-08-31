import type {
  ImBindingAdminDetail,
  ImBindingDiagnostics,
  ImBindingHandoffStatus,
  ImBindingState,
  ImBindingSummary,
  ImCliProvider,
  ImCliReadinessStatus,
  IntegrationCredentialExecutionReason,
  IntegrationCredentialExecutionStatus,
  ProviderCliExpectedIdentity,
  ProviderCliHandoffProgress,
  ProviderCliValidationGrantFrame,
  ProviderReadinessStatus,
  RuntimeImCredentialGrantRequest,
  RuntimeImCredentialGrantResult,
  SlackBindingActivation,
  SlackConfigurationIntent,
  SlackConfigurationResult,
} from "@opentag/shared";
import {
  FEISHU_REQUIRED_TENANT_SCOPES,
  hasRequiredFeishuTenantScopes,
  hasRequiredSlackBotScopes,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  accountComputers,
  agents,
  imBindings,
  imMessages,
  sessionPlacements,
  sessions,
  slackInstallations,
} from "../../db/schema/index.js";
import { schemaRequiredSlackInstallationProjection } from "../../db/schema-required-legacy.js";
import type { ApplicationCipher } from "../crypto.js";

type QueryExecutor = Pick<DatabaseClient, "select">;

const FeishuCredentialSchema = z
  .object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    grantedScopes: z.array(z.string().min(1)).max(128),
  })
  .strict();

const SlackCredentialSchema = z
  .object({
    botId: z.string().min(1),
    botAccessToken: z.string().min(1),
    signingSecret: z.string().min(1),
    grantedScopes: z.array(z.string().min(1)).max(128),
  })
  .strict();

export interface VerifiedFeishuBinding {
  agentId: string;
  appId: string;
  teamId: string | null;
  botOpenId: string;
  teamBrand?: string;
  appSecret: string;
  grantedScopes: string[];
}

export interface SlackInstallationIngress {
  installationId: string;
  generation: number;
  agentId: string;
  appId: string;
  teamId: string;
  botUserId: string;
  botId: string;
  botAccessToken: string;
  signingSecret: string;
}

export interface SlackInboundRoute {
  imBindingId: string;
  agentId: string;
  installationId: string;
  generation: number;
  routeKind: "default";
}

export interface SlackIngressBinding extends SlackInstallationIngress {
  imBindingId: string;
}

export interface FeishuConnectionMaterial {
  imBindingId: string;
  generation: number;
  appId: string;
  teamId: string | null;
  botOpenId: string;
  teamBrand: "feishu" | "lark" | null;
  appSecret: string;
  grantedScopes: string[];
}

export interface SlackConnectionMaterial {
  imBindingId: string;
  installationId: string;
  generation: number;
  appId: string;
  teamId: string;
  botUserId: string;
  botId: string;
  botAccessToken: string;
  grantedScopes: string[];
}

interface ImBindingReadinessInput {
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

interface CredentialInspection {
  status: "valid" | "invalid";
  grantedCapabilities: string[];
  requiredCapabilities: string[];
  missingCapabilities: string[];
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function requiredCapabilitiesFor(provider: "feishu" | "slack"): string[] {
  return provider === "feishu" ? [...FEISHU_REQUIRED_TENANT_SCOPES] : [...SLACK_REQUIRED_BOT_SCOPES];
}

interface ImBindingReadiness {
  handoff: ImBindingHandoffStatus;
  agentRuntimeReadiness: ProviderReadinessStatus;
  providerCliReadiness: ImCliReadinessStatus;
  credentialExecutionReadiness: IntegrationCredentialExecutionStatus;
  credentialExecutionReason?: IntegrationCredentialExecutionReason;
  reauthorizationRequired: boolean;
  connection: { state: "connected" | "disconnected"; observedAt: string } | null;
}

interface ActivatedBinding {
  id: string;
  agentId: string;
  provider: "feishu" | "slack";
  appId: string;
  teamId: string | null;
  botId: string;
  credentialGeneration: number;
}

export async function disableImBindingInTransaction(
  transaction: DatabaseTransaction,
  imBindingId: string,
  now: Date,
  expectedGeneration?: number,
  releaseUnusedSlackInstallation = true,
): Promise<boolean> {
  const disabled = await transaction
    .update(imBindings)
    .set({
      status: "disabled",
      encryptedCredential: null,
      encryptedSetupContext: null,
      setupOwnerInstanceId: null,
      setupOwnerHeartbeatAt: null,
      setupExpiresAt: null,
      connectionOwnerInstanceId: null,
      connectionLeaseExpiresAt: null,
      disabledAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(imBindings.id, imBindingId),
        ne(imBindings.status, "disabled"),
        ...(expectedGeneration === undefined ? [] : [eq(imBindings.credentialGeneration, expectedGeneration)]),
      ),
    )
    .returning({ id: imBindings.id, slackInstallationId: imBindings.slackInstallationId });
  if (disabled.length === 0) return false;
  await transaction
    .update(sessions)
    .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
    .where(and(eq(sessions.imBindingId, imBindingId), isNull(sessions.endedAt)));
  const installationId = disabled[0]?.slackInstallationId;
  if (installationId && releaseUnusedSlackInstallation) {
    const [installation] = await transaction
      .select({ id: slackInstallations.id, status: slackInstallations.status })
      .from(slackInstallations)
      .where(eq(slackInstallations.id, installationId))
      .limit(1)
      .for("update");
    if (installation && installation.status !== "disabled") {
      const [remainingRoute] = await transaction
        .select({ id: imBindings.id })
        .from(imBindings)
        .where(
          and(
            eq(imBindings.slackInstallationId, installationId),
            eq(imBindings.provider, "slack"),
            ne(imBindings.status, "disabled"),
          ),
        )
        .limit(1);
      if (!remainingRoute) {
        await transaction
          .update(slackInstallations)
          .set({ status: "disabled", encryptedCredential: null, disabledAt: now, updatedAt: now })
          .where(and(eq(slackInstallations.id, installationId), ne(slackInstallations.status, "disabled")));
      }
    }
  }
  return true;
}

export class ImBindingServiceError extends Error {
  readonly category = "deterministic" as const;
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Whether a thrown error (or any error in its cause chain) is a PostgreSQL unique violation on one constraint. */
export function isImBindingUniqueViolation(error: unknown, constraintName: string): boolean {
  let current = error;
  const visited = new Set<unknown>();
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      "code" in current &&
      current.code === "23505" &&
      "constraint_name" in current &&
      current.constraint_name === constraintName
    ) {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

function projectedErrorCode(input: {
  credentialStatus: "valid" | "invalid";
  lastErrorCode: string | null;
  missingCapabilities: readonly string[];
  provider: "feishu" | "slack";
  reauthorizationRequired: boolean;
  status: ImBindingState;
}): string | null {
  if (input.lastErrorCode) return input.lastErrorCode;
  if (input.status === "active" && input.missingCapabilities.length > 0) {
    return input.provider === "slack" ? "SLACK_SCOPE_REAUTH_REQUIRED" : "FEISHU_SCOPE_REAUTH_REQUIRED";
  }
  if (input.status === "active" && input.credentialStatus === "invalid") {
    return "IM_BINDING_CREDENTIAL_INVALID";
  }
  return null;
}

function slackInstallationInspectionInput(installation: typeof slackInstallations.$inferSelect): {
  provider: "slack";
  encryptedCredential: string | null;
  externalAppId: string | null;
  externalBotId: string | null;
  externalTeamId: string | null;
  credentialGeneration: number;
  credentialSchemaVersion: number | null;
  grantedCapabilities: string[];
} {
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

function providerCliProgress(
  artifactStatus: ImCliReadinessStatus,
  credential: { status: IntegrationCredentialExecutionStatus; reason?: IntegrationCredentialExecutionReason },
): ProviderCliHandoffProgress | undefined {
  if (credential.reason === "upgrade_required" || credential.status === "needs_attention") {
    return {
      phase: "needs_attention",
      ...(credential.reason ? { reason: credential.reason } : {}),
    };
  }
  if (artifactStatus !== "ready") {
    return artifactStatus === "unavailable" ? { phase: "needs_attention" } : { phase: "preparing_cli" };
  }
  if (credential.status === "ready") return undefined;
  return { phase: "checking_credentials" };
}

function needsScopeUpdate(
  status: "provisioning" | "active" | "reauthorization_required" | "error" | "disabled",
  provider: "feishu" | "slack",
  scopes: readonly string[],
): boolean {
  if (status !== "active") return false;
  return provider === "feishu" ? !hasRequiredFeishuTenantScopes(scopes) : !hasRequiredSlackBotScopes(scopes);
}

export class ImBindingService {
  readonly #afterMutationAuthorityLocked: (() => Promise<void> | void) | undefined;
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #agentRuntimeReadiness: (agentId: string) => Promise<ProviderReadinessStatus>;
  readonly #imCliReadiness: (
    agentId: string,
    provider: "feishu" | "slack",
    integrationId: string,
    credentialGeneration: number,
  ) => Promise<ImCliReadinessStatus>;
  readonly #credentialExecutionReadiness: (
    agentId: string,
    provider: "feishu" | "slack",
    integrationId: string,
    credentialGeneration: number,
  ) => Promise<{ status: IntegrationCredentialExecutionStatus; reason?: IntegrationCredentialExecutionReason }>;
  readonly #onActiveBindingChanged:
    | ((input: { agentId: string; workspaceComputerId: string }) => Promise<void> | void)
    | undefined;

  constructor(
    database: DatabaseClient,
    cipher: ApplicationCipher,
    options: {
      afterMutationAuthorityLocked?: () => Promise<void> | void;
      now?: () => Date;
      agentRuntimeReadiness?: (agentId: string) => Promise<ProviderReadinessStatus> | ProviderReadinessStatus;
      imCliReadiness?: (
        agentId: string,
        provider: "feishu" | "slack",
        integrationId: string,
        credentialGeneration: number,
      ) => Promise<ImCliReadinessStatus> | ImCliReadinessStatus;
      credentialExecutionReadiness?: (
        agentId: string,
        provider: "feishu" | "slack",
        integrationId: string,
        credentialGeneration: number,
      ) =>
        | Promise<{ status: IntegrationCredentialExecutionStatus; reason?: IntegrationCredentialExecutionReason }>
        | { status: IntegrationCredentialExecutionStatus; reason?: IntegrationCredentialExecutionReason };
      onActiveBindingChanged?: (input: { agentId: string; workspaceComputerId: string }) => Promise<void> | void;
    } = {},
  ) {
    this.#database = database;
    this.#afterMutationAuthorityLocked = options.afterMutationAuthorityLocked;
    this.#cipher = cipher;
    this.#now = options.now ?? (() => new Date());
    this.#agentRuntimeReadiness = async (agentId) => (await options.agentRuntimeReadiness?.(agentId)) ?? "ready";
    this.#imCliReadiness = async (agentId, provider, integrationId, credentialGeneration) =>
      (await options.imCliReadiness?.(agentId, provider, integrationId, credentialGeneration)) ?? "checking";
    this.#credentialExecutionReadiness = async (agentId, provider, integrationId, credentialGeneration) =>
      (await options.credentialExecutionReadiness?.(agentId, provider, integrationId, credentialGeneration)) ?? {
        status: "unconfirmed",
      };
    this.#onActiveBindingChanged = options.onActiveBindingChanged;
  }

  async getAgentWorkspaceComputerId(agentId: string): Promise<string | undefined> {
    const [agent] = await this.#database
      .select({ workspaceComputerId: agents.computerId })
      .from(agents)
      .innerJoin(accountComputers, eq(accountComputers.id, agents.computerId))
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    return agent?.workspaceComputerId ?? undefined;
  }

  async listActiveProviderCliRequirements(workspaceComputerId: string): Promise<
    readonly {
      agentId: string;
      credentialGeneration: number;
      expectedIdentity: ProviderCliExpectedIdentity;
      integrationId: string;
      provider: ImCliProvider;
    }[]
  > {
    const rows = await this.#database
      .select({
        binding: imBindings,
        slackInstallation: slackInstallations,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(
        and(eq(agents.computerId, workspaceComputerId), eq(agents.status, "active"), eq(imBindings.status, "active")),
      );
    const requirements: {
      agentId: string;
      credentialGeneration: number;
      expectedIdentity: ProviderCliExpectedIdentity;
      integrationId: string;
      provider: ImCliProvider;
    }[] = [];
    for (const row of rows) {
      const identity = this.#expectedIdentity(row.binding, row.slackInstallation);
      if (!identity) continue;
      requirements.push({
        agentId: row.binding.agentId,
        credentialGeneration:
          row.binding.provider === "slack" && row.slackInstallation
            ? row.slackInstallation.credentialGeneration
            : row.binding.credentialGeneration,
        expectedIdentity: identity,
        integrationId: row.binding.id,
        provider: row.binding.provider,
      });
    }
    return requirements;
  }

  async issueIntegrationCliValidationGrant(input: {
    agentId: string;
    computerId: string;
    credentialGeneration: number;
    integrationId: string;
    provider: ImCliProvider;
    workspaceComputerId: string;
  }): Promise<
    { expectedIdentity: ProviderCliExpectedIdentity; grant: ProviderCliValidationGrantFrame["grant"] } | undefined
  > {
    const [row] = await this.#database
      .select({
        binding: imBindings,
        slackInstallation: slackInstallations,
        workspaceComputerId: agents.computerId,
        computerId: accountComputers.currentInstallationId,
        agentStatus: agents.status,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(accountComputers, eq(accountComputers.id, agents.computerId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(and(eq(imBindings.id, input.integrationId), eq(imBindings.agentId, input.agentId)))
      .limit(1);
    if (
      !row ||
      row.agentStatus !== "active" ||
      row.workspaceComputerId !== input.workspaceComputerId ||
      row.computerId !== input.computerId
    ) {
      return undefined;
    }
    if (row.binding.status !== "active" || row.binding.provider !== input.provider) return undefined;
    const identity = this.#expectedIdentity(row.binding, row.slackInstallation);
    if (!identity) return undefined;
    if (row.binding.provider === "feishu") {
      if (row.binding.credentialGeneration !== input.credentialGeneration) return undefined;
      const credential = this.#decodeFeishuCredential(row.binding.encryptedCredential);
      if (!credential || credential.appId !== row.binding.externalAppId) return undefined;
      return {
        expectedIdentity: identity,
        grant: {
          provider: "feishu",
          appId: credential.appId,
          appSecret: credential.appSecret,
          teamBrand: row.binding.externalTeamBrand === "lark" ? "lark" : "feishu",
        },
      };
    }
    const installation = row.slackInstallation;
    if (
      !installation ||
      installation.status !== "active" ||
      installation.credentialGeneration !== input.credentialGeneration
    ) {
      return undefined;
    }
    const credential = this.#decodeSlackCredential(installation.encryptedCredential);
    if (!credential || !hasRequiredSlackBotScopes(credential.grantedScopes)) return undefined;
    return {
      expectedIdentity: identity,
      grant: { provider: "slack", botAccessToken: credential.botAccessToken },
    };
  }

  async issueRuntimeCredentialGrant(
    request: RuntimeImCredentialGrantRequest,
    computerAuth: {
      computerId: string;
      workspaceComputerId: string;
      workspaceId: string;
      imCredentialGrantVersion?: 1 | 2;
    },
  ): Promise<RuntimeImCredentialGrantResult> {
    const [row] = await this.#database
      .select({
        sessionId: sessions.id,
        sessionKind: sessions.kind,
        sessionEndedAt: sessions.endedAt,
        channelId: sessions.channelId,
        threadKey: sessions.threadKey,
        binding: imBindings,
        slackInstallation: slackInstallations,
        boundAgentId: imBindings.agentId,
        agentCreatedByUserId: agents.createdByUserId,
        agentStatus: agents.status,
        computerOwnerAccountId: accountComputers.ownerAccountId,
        placementComputerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        workspaceComputerId: agents.computerId,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .leftJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .leftJoin(accountComputers, eq(accountComputers.id, sessionPlacements.computerId))
      .where(eq(sessions.id, request.sessionId))
      .limit(1);
    const rejected = (
      code: "binding_inactive" | "credential_stale" | "placement_stale" | "agent_mismatch",
    ): RuntimeImCredentialGrantResult => ({
      type: "im:credential:result",
      requestId: request.requestId,
      status: "rejected",
      code,
    });
    if (
      !row ||
      row.sessionKind === "internal" ||
      row.boundAgentId !== request.agentId ||
      row.computerOwnerAccountId !== row.agentCreatedByUserId ||
      row.workspaceComputerId !== computerAuth.workspaceComputerId ||
      row.agentStatus !== "active"
    ) {
      return rejected("agent_mismatch");
    }
    if (
      row.sessionEndedAt !== null ||
      row.placementComputerId !== computerAuth.workspaceComputerId ||
      row.placementGeneration !== request.placementGeneration
    ) {
      return rejected("placement_stale");
    }
    const binding = row.binding;
    if (binding.status !== "active") return rejected("binding_inactive");
    if (binding.provider !== "slack" && this.#inspectCredentialMaterial(binding).status !== "valid") {
      return rejected("credential_stale");
    }
    if (binding.provider === "feishu") {
      const credential = this.#decodeFeishuCredential(binding.encryptedCredential);
      if (!credential || credential.appId !== binding.externalAppId) return rejected("credential_stale");
      return {
        type: "im:credential:result",
        requestId: request.requestId,
        status: "succeeded",
        credentialGeneration: binding.credentialGeneration,
        grant: {
          provider: "feishu",
          appId: credential.appId,
          appSecret: credential.appSecret,
          teamBrand: binding.externalTeamBrand === "lark" ? "lark" : "feishu",
        },
        ...(computerAuth.imCredentialGrantVersion === 2
          ? {
              outboxContext: {
                provider: "feishu" as const,
                sessionKind: row.sessionKind,
                chatId: row.channelId,
                ...(row.threadKey ? { threadId: row.threadKey } : {}),
              },
            }
          : {}),
      };
    }
    const installation = row.slackInstallation;
    if (!installation) return rejected("binding_inactive");
    if (
      installation.status !== "active" ||
      installation.agentId !== row.boundAgentId ||
      !installation.observedConnectedAt
    ) {
      return rejected("binding_inactive");
    }
    if (this.#inspectCredentialMaterial(slackInstallationInspectionInput(installation)).status !== "valid") {
      return rejected("credential_stale");
    }
    const credential = this.#decodeSlackCredential(installation.encryptedCredential);
    if (!credential || !hasRequiredSlackBotScopes(credential.grantedScopes)) return rejected("credential_stale");
    return {
      type: "im:credential:result",
      requestId: request.requestId,
      status: "succeeded",
      credentialGeneration: installation.credentialGeneration,
      grant: { provider: "slack", botAccessToken: credential.botAccessToken },
      ...(computerAuth.imCredentialGrantVersion === 2
        ? {
            outboxContext: {
              provider: "slack" as const,
              sessionKind: row.sessionKind,
              channelId: row.channelId,
              ...(row.threadKey ? { threadTs: row.threadKey } : {}),
            },
          }
        : {}),
    };
  }

  async activateSlack(
    input: SlackBindingActivation,
    verifiedBotId: string,
    transaction?: DatabaseTransaction,
  ): Promise<SlackConfigurationResult> {
    const credential = SlackCredentialSchema.parse({
      botId: verifiedBotId,
      botAccessToken: input.botAccessToken,
      signingSecret: input.signingSecret,
      grantedScopes: [...new Set(input.grantedBotScopes)].sort(),
    });
    try {
      const activated = await this.#activateSlackInstallation(input, credential, transaction);
      if (!transaction) await this.#notifyActiveBindingChanged(activated.agentId).catch(() => undefined);
      return {
        imBindingId: activated.id,
        agentId: activated.agentId,
        appId: activated.appId,
        teamId: activated.teamId,
        botUserId: activated.botId,
        credentialGeneration: activated.credentialGeneration,
        bindingState: "active",
        identityClosure: { status: "pending", verifiedAt: null },
      };
    } catch (error) {
      if (isImBindingUniqueViolation(error, "slack_installations_app_team_current_unique")) {
        throw new ImBindingServiceError(
          "SLACK_APP_TEAM_ALREADY_BOUND",
          409,
          "This Slack App installation is already bound to another OpenTag Agent",
        );
      }
      throw error;
    }
  }

  async activateFeishu(input: VerifiedFeishuBinding, transaction?: DatabaseTransaction): Promise<string> {
    const credential = FeishuCredentialSchema.parse({
      appId: input.appId,
      appSecret: input.appSecret,
      grantedScopes: [...new Set(input.grantedScopes)].sort(),
    });
    try {
      const activated = await this.#activate(
        {
          agentId: input.agentId,
          provider: "feishu",
          identity: {
            appId: input.appId,
            teamId: input.teamId,
            enterpriseId: null,
            botId: input.botOpenId,
            teamBrand: input.teamBrand ?? null,
          },
          credential,
        },
        transaction,
      );
      if (!transaction) await this.#notifyActiveBindingChanged(activated.agentId).catch(() => undefined);
      return activated.id;
    } catch (error) {
      if (isImBindingUniqueViolation(error, "im_bindings_feishu_app_current_unique")) {
        throw new ImBindingServiceError(
          "FEISHU_APP_ALREADY_BOUND",
          409,
          "The selected Feishu App is already bound to another Agent",
        );
      }
      throw error;
    }
  }

  async findSlackInstallationIngress(appId: string, teamId: string): Promise<SlackInstallationIngress | undefined> {
    const [row] = await this.#database
      .select()
      .from(slackInstallations)
      .where(
        and(
          eq(slackInstallations.externalAppId, appId),
          eq(slackInstallations.externalTeamId, teamId),
          eq(slackInstallations.status, "active"),
        ),
      )
      .limit(1);
    return this.#slackInstallationIngressFromRow(row);
  }

  async findSlackInstallationIngressForAgent(agentId: string): Promise<SlackInstallationIngress | undefined> {
    const [row] = await this.#database
      .select({ installation: slackInstallations })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(
        and(
          eq(imBindings.agentId, agentId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(slackInstallations.status, "active"),
          eq(slackInstallations.agentId, agentId),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    return this.#slackInstallationIngressFromRow(row?.installation);
  }

  async resolveSlackDefaultRoute(installationId: string): Promise<SlackInboundRoute | undefined> {
    return this.#resolveSlackRoute(installationId);
  }

  async resolveSlackAgentRoute(installationId: string, agentId: string): Promise<SlackInboundRoute | undefined> {
    return this.#resolveSlackRoute(installationId, agentId);
  }

  async findSlackIngressBinding(appId: string, teamId: string): Promise<SlackIngressBinding | undefined> {
    const installation = await this.findSlackInstallationIngress(appId, teamId);
    if (!installation) return undefined;
    const route = await this.resolveSlackDefaultRoute(installation.installationId);
    if (!route) return undefined;
    return { ...installation, imBindingId: route.imBindingId };
  }

  async findSlackIngressBindingForAgent(agentId: string): Promise<SlackIngressBinding | undefined> {
    const installation = await this.findSlackInstallationIngressForAgent(agentId);
    if (!installation) return undefined;
    const route = await this.resolveSlackAgentRoute(installation.installationId, agentId);
    if (!route) return undefined;
    return { ...installation, imBindingId: route.imBindingId };
  }

  async getSlackConnectionMaterial(imBindingId: string): Promise<SlackConnectionMaterial | undefined> {
    const [row] = await this.#database
      .select({ imBinding: imBindings, installation: slackInstallations })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(slackInstallations.status, "active"),
          eq(slackInstallations.agentId, imBindings.agentId),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    if (!row?.installation.observedConnectedAt) {
      return undefined;
    }
    const ingress = this.#slackInstallationIngressFromRow(row.installation);
    if (!ingress) return undefined;
    const credential = this.#decodeSlackCredential(row.installation.encryptedCredential);
    if (!credential) return undefined;
    return {
      imBindingId,
      installationId: ingress.installationId,
      generation: ingress.generation,
      appId: ingress.appId,
      teamId: ingress.teamId,
      botUserId: ingress.botUserId,
      botId: ingress.botId,
      botAccessToken: ingress.botAccessToken,
      grantedScopes: credential.grantedScopes,
    };
  }

  async listFeishuConnectionIds(afterId: string | undefined, limit = 100): Promise<string[]> {
    const rows = await this.#database
      .select({ imBindingId: imBindings.id })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(imBindings.provider, "feishu"),
          eq(imBindings.status, "active"),
          ne(agents.status, "deleted"),
          ...(afterId ? [gt(imBindings.id, afterId)] : []),
        ),
      )
      .orderBy(asc(imBindings.id))
      .limit(limit);
    return rows.map((row) => row.imBindingId);
  }

  async getFeishuConnectionMaterial(
    imBindingId: string,
    transaction?: DatabaseTransaction,
  ): Promise<FeishuConnectionMaterial | undefined> {
    const imBinding = await this.#activeMaterial(imBindingId, "feishu", transaction);
    if (!imBinding?.externalAppId || !imBinding.externalBotId) return undefined;
    if (this.#inspectCredentialMaterial(imBinding).status !== "valid") return undefined;
    const credential = this.#decodeFeishuCredential(imBinding.encryptedCredential);
    if (!credential) return undefined;
    return {
      imBindingId,
      generation: imBinding.credentialGeneration,
      appId: imBinding.externalAppId,
      teamId: imBinding.externalTeamId,
      botOpenId: imBinding.externalBotId,
      teamBrand:
        imBinding.externalTeamBrand === "lark" ? "lark" : imBinding.externalTeamBrand === "feishu" ? "feishu" : null,
      appSecret: credential.appSecret,
      grantedScopes: credential.grantedScopes,
    };
  }

  async recordDiagnosticError(imBindingId: string, code: string): Promise<void> {
    await this.#database
      .update(imBindings)
      .set({ lastErrorCode: code.slice(0, 120), updatedAt: this.#now() })
      .where(eq(imBindings.id, imBindingId));
  }

  async getForAgent(callerUserId: string, agentId: string): Promise<ImBindingSummary | undefined> {
    await this.#assertCanRead(callerUserId, agentId);
    const [row] = await this.#database
      .select({
        id: imBindings.id,
        agentId: imBindings.agentId,
        provider: imBindings.provider,
        bindingState: imBindings.status,
        botDisplayName: imBindings.botDisplayName,
        botAvatarUrl: imBindings.botAvatarUrl,
        observedAt: imBindings.observedAt,
        activatedAt: imBindings.activatedAt,
        receiveMode: agents.receiveMode,
        grantedCapabilities: imBindings.grantedCapabilities,
        encryptedCredential: imBindings.encryptedCredential,
        externalAppId: imBindings.externalAppId,
        externalBotId: imBindings.externalBotId,
        externalTeamId: imBindings.externalTeamId,
        credentialSchemaVersion: imBindings.credentialSchemaVersion,
        credentialGeneration: imBindings.credentialGeneration,
        slackInstallation: slackInstallations,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (!row) return undefined;
    const activity = await this.#activity(row.id);
    const credential = this.#inspectBindingCredentials(row, row.slackInstallation);
    const reauthorizationRequired =
      row.bindingState === "reauthorization_required" ||
      needsScopeUpdate(row.bindingState, row.provider, row.grantedCapabilities) ||
      (row.bindingState === "active" && credential.status === "invalid");
    return {
      id: row.id,
      agentId: row.agentId,
      provider: row.provider,
      bindingState: reauthorizationRequired ? "reauthorization_required" : row.bindingState,
      bot: { displayName: row.botDisplayName, avatarUrl: row.botAvatarUrl },
      receiveMode: row.receiveMode,
      ...activity,
      lastValidatedAt: row.activatedAt?.toISOString() ?? null,
      lastRuntimeObservationAt:
        (row.provider === "slack" ? (row.slackInstallation?.observedAt ?? null) : row.observedAt)?.toISOString() ??
        null,
    };
  }

  async getHandoffForAgent(callerUserId: string, agentId: string): Promise<ImBindingHandoffStatus | undefined> {
    await this.#assertCanRead(callerUserId, agentId);
    const [row] = await this.#database
      .select({
        id: imBindings.id,
        agentId: imBindings.agentId,
        provider: imBindings.provider,
        status: imBindings.status,
        connectionLeaseExpiresAt: imBindings.connectionLeaseExpiresAt,
        observedConnectedAt: imBindings.observedConnectedAt,
        observedAt: imBindings.observedAt,
        grantedCapabilities: imBindings.grantedCapabilities,
        encryptedCredential: imBindings.encryptedCredential,
        externalAppId: imBindings.externalAppId,
        externalBotId: imBindings.externalBotId,
        externalTeamId: imBindings.externalTeamId,
        credentialSchemaVersion: imBindings.credentialSchemaVersion,
        credentialGeneration: imBindings.credentialGeneration,
        slackInstallation: slackInstallations,
      })
      .from(imBindings)
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (!row) return undefined;
    const credential = this.#inspectBindingCredentials(row, row.slackInstallation);
    const observedConnectedAt =
      row.provider === "slack" ? (row.slackInstallation?.observedConnectedAt ?? null) : row.observedConnectedAt;
    const observedAt = row.provider === "slack" ? (row.slackInstallation?.observedAt ?? null) : row.observedAt;
    const grantedCapabilities =
      row.provider === "slack" && row.slackInstallation
        ? row.slackInstallation.grantedCapabilities
        : row.grantedCapabilities;
    const credentialGeneration =
      row.provider === "slack" && row.slackInstallation
        ? row.slackInstallation.credentialGeneration
        : row.credentialGeneration;
    const status =
      row.provider === "slack" && row.slackInstallation?.status === "reauthorization_required"
        ? "reauthorization_required"
        : row.status;
    return (
      await this.#readiness(
        this.#withCredentialStatus(
          { ...row, status, observedConnectedAt, observedAt, grantedCapabilities, credentialGeneration },
          credential.status,
        ),
      )
    ).handoff;
  }

  async getConfigForAgent(callerUserId: string, agentId: string): Promise<ImBindingAdminDetail | undefined> {
    await this.assertCanManage(callerUserId, agentId);
    const [row] = await this.#database
      .select({ imBinding: imBindings, receiveMode: agents.receiveMode, slackInstallation: slackInstallations })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (!row) return undefined;
    const binding = row.imBinding;
    if (!binding.externalAppId || !binding.externalBotId || binding.credentialGeneration < 1) return undefined;
    const activity = await this.#activity(binding.id);
    const credential = this.#inspectBindingCredentials(binding, row.slackInstallation);
    const reauthorizationRequired =
      binding.status === "reauthorization_required" ||
      needsScopeUpdate(binding.status, binding.provider, binding.grantedCapabilities) ||
      (binding.status === "active" && credential.status === "invalid");
    const summary: ImBindingSummary = {
      id: binding.id,
      agentId: binding.agentId,
      provider: binding.provider,
      bindingState: reauthorizationRequired ? "reauthorization_required" : binding.status,
      bot: { displayName: binding.botDisplayName, avatarUrl: binding.botAvatarUrl },
      receiveMode: row.receiveMode,
      ...activity,
      lastValidatedAt: binding.activatedAt?.toISOString() ?? null,
      lastRuntimeObservationAt: binding.observedAt?.toISOString() ?? null,
    };
    return {
      ...summary,
      identity:
        binding.provider === "feishu"
          ? {
              provider: "feishu",
              appId: binding.externalAppId,
              teamId: binding.externalTeamId,
              botOpenId: binding.externalBotId,
              teamBrand: binding.externalTeamBrand,
            }
          : {
              provider: "slack",
              appId: binding.externalAppId,
              teamId: binding.externalTeamId ?? "",
              enterpriseId: binding.externalEnterpriseId,
              botUserId: binding.externalBotId,
              appIdEvidence: "configured",
            },
      credentialGeneration: binding.credentialGeneration,
      grantedCapabilities: binding.grantedCapabilities,
      reauthorizationRequired,
      lastErrorCode: projectedErrorCode({
        credentialStatus: credential.status,
        lastErrorCode: binding.lastErrorCode,
        missingCapabilities: credential.missingCapabilities,
        provider: binding.provider,
        reauthorizationRequired,
        status: binding.status,
      }),
    };
  }

  async disable(callerUserId: string, imBindingId: string): Promise<void> {
    const agentId = await this.#database.transaction(async (transaction) => {
      const [candidate] = await transaction
        .select({ agentId: imBindings.agentId })
        .from(imBindings)
        .where(eq(imBindings.id, imBindingId))
        .limit(1);
      if (!candidate) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM binding was not found");
      await this.assertCanManageForMutation(callerUserId, candidate.agentId, transaction);
      const [imBinding] = await transaction
        .select({ agentId: imBindings.agentId })
        .from(imBindings)
        .where(eq(imBindings.id, imBindingId))
        .limit(1)
        .for("update");
      if (!imBinding || imBinding.agentId !== candidate.agentId) {
        throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM binding was not found");
      }
      await disableImBindingInTransaction(transaction, imBindingId, this.#now());
      return imBinding.agentId;
    });
    await this.#notifyActiveBindingChanged(agentId).catch(() => undefined);
  }

  async diagnostics(callerUserId: string, imBindingId: string): Promise<ImBindingDiagnostics> {
    const [row] = await this.#database
      .select({
        id: imBindings.id,
        agentId: imBindings.agentId,
        provider: imBindings.provider,
        status: imBindings.status,
        credentialGeneration: imBindings.credentialGeneration,
        connectionLeaseExpiresAt: imBindings.connectionLeaseExpiresAt,
        observedConnectedAt: imBindings.observedConnectedAt,
        observedAt: imBindings.observedAt,
        lastErrorCode: imBindings.lastErrorCode,
        grantedCapabilities: imBindings.grantedCapabilities,
        externalAppId: imBindings.externalAppId,
        externalBotId: imBindings.externalBotId,
        externalTeamId: imBindings.externalTeamId,
        encryptedCredential: imBindings.encryptedCredential,
        credentialSchemaVersion: imBindings.credentialSchemaVersion,
        activatedAt: imBindings.activatedAt,
        slackInstallation: slackInstallations,
      })
      .from(imBindings)
      .leftJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(eq(imBindings.id, imBindingId))
      .limit(1);
    if (!row) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM binding was not found");
    await this.assertCanManage(callerUserId, row.agentId);
    const credential = this.#inspectBindingCredentials(row, row.slackInstallation);
    const observedConnectedAt =
      row.provider === "slack" ? (row.slackInstallation?.observedConnectedAt ?? null) : row.observedConnectedAt;
    const observedAt = row.provider === "slack" ? (row.slackInstallation?.observedAt ?? null) : row.observedAt;
    const grantedCapabilities =
      row.provider === "slack" && row.slackInstallation
        ? row.slackInstallation.grantedCapabilities
        : row.grantedCapabilities;
    const credentialGeneration =
      row.provider === "slack" && row.slackInstallation
        ? row.slackInstallation.credentialGeneration
        : row.credentialGeneration;
    const status =
      row.provider === "slack" && row.slackInstallation?.status === "reauthorization_required"
        ? "reauthorization_required"
        : row.status;
    const lastErrorCode =
      row.provider === "slack" && row.slackInstallation ? row.slackInstallation.lastErrorCode : row.lastErrorCode;
    const imBinding = {
      ...row,
      status,
      observedConnectedAt,
      observedAt,
      grantedCapabilities,
      credentialGeneration,
      lastErrorCode,
    };
    const readiness = await this.#readiness(this.#withCredentialStatus(imBinding, credential.status));
    const activity = await this.#activity(imBindingId);
    return {
      imBindingId,
      provider: imBinding.provider,
      ready: readiness.handoff.handoffReady,
      agentRuntimeReadiness: readiness.agentRuntimeReadiness,
      providerCliReadiness: readiness.providerCliReadiness,
      credentialExecutionReadiness: readiness.credentialExecutionReadiness,
      ...(readiness.credentialExecutionReason
        ? { credentialExecutionReason: readiness.credentialExecutionReason }
        : {}),
      credentialGeneration: imBinding.credentialGeneration,
      credentialStatus: credential.status,
      requiredCapabilities: credential.requiredCapabilities,
      grantedCapabilities: credential.grantedCapabilities,
      missingCapabilities: credential.missingCapabilities,
      reauthorizationRequired: readiness.reauthorizationRequired,
      slackAppId:
        imBinding.provider === "slack" && imBinding.externalAppId
          ? { value: imBinding.externalAppId, evidence: "configured", ingressMatchRequired: true }
          : null,
      slackIdentityClosure:
        imBinding.provider === "slack"
          ? {
              status: imBinding.observedConnectedAt ? "verified" : "pending",
              verifiedAt: imBinding.observedConnectedAt?.toISOString() ?? null,
            }
          : null,
      connection: readiness.connection,
      ...activity,
      lastValidatedAt: imBinding.activatedAt?.toISOString() ?? null,
      lastRuntimeObservationAt: imBinding.observedAt?.toISOString() ?? null,
      lastErrorCode: projectedErrorCode({
        credentialStatus: credential.status,
        lastErrorCode: imBinding.lastErrorCode,
        missingCapabilities: credential.missingCapabilities,
        provider: imBinding.provider,
        reauthorizationRequired: readiness.reauthorizationRequired,
        status: imBinding.status,
      }),
    };
  }

  async requireReauthorization(imBindingId: string, generation: number, errorCode: string): Promise<boolean> {
    const installationId = await this.#slackInstallationIdForRoute(imBindingId);
    return installationId ? this.requireSlackInstallationReauthorization(installationId, generation, errorCode) : false;
  }

  async recordSlackObservation(imBindingId: string, generation: number): Promise<boolean> {
    const installationId = await this.#slackInstallationIdForRoute(imBindingId);
    return installationId ? this.recordSlackInstallationObservation(installationId, generation) : false;
  }

  async recordSlackIdentityClosure(imBindingId: string, generation: number): Promise<boolean> {
    const installationId = await this.#slackInstallationIdForRoute(imBindingId);
    return installationId ? this.recordSlackInstallationIdentityClosure(installationId, generation) : false;
  }

  async disableFromProvider(imBindingId: string, generation: number): Promise<boolean> {
    const installationId = await this.#slackInstallationIdForRoute(imBindingId);
    return installationId ? this.disableSlackInstallationFromProvider(installationId, generation) : false;
  }

  async recordSlackInstallationObservation(installationId: string, generation: number): Promise<boolean> {
    const observedAt = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(slackInstallations)
        .set({ observedAt })
        .where(
          and(
            eq(slackInstallations.id, installationId),
            eq(slackInstallations.status, "active"),
            eq(slackInstallations.credentialGeneration, generation),
          ),
        )
        .returning({ id: slackInstallations.id });
      if (!updated) return false;
      await transaction
        .update(imBindings)
        .set({ observedAt })
        .where(
          and(
            eq(imBindings.slackInstallationId, installationId),
            eq(imBindings.provider, "slack"),
            ne(imBindings.status, "disabled"),
          ),
        );
      return true;
    });
  }

  async recordSlackInstallationIdentityClosure(installationId: string, generation: number): Promise<boolean> {
    const observedAt = this.#now();
    return this.#database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(slackInstallations)
        .set({
          observedAt,
          observedConnectedAt: sql<Date>`coalesce(
            ${slackInstallations.observedConnectedAt},
            ${sql.param(observedAt, slackInstallations.observedConnectedAt)}
          )`,
        })
        .where(
          and(
            eq(slackInstallations.id, installationId),
            eq(slackInstallations.status, "active"),
            eq(slackInstallations.credentialGeneration, generation),
          ),
        )
        .returning({
          id: slackInstallations.id,
          observedConnectedAt: slackInstallations.observedConnectedAt,
        });
      if (!updated) return false;
      await transaction
        .update(imBindings)
        .set({
          observedAt,
          observedConnectedAt: updated.observedConnectedAt,
        })
        .where(
          and(
            eq(imBindings.slackInstallationId, installationId),
            eq(imBindings.provider, "slack"),
            ne(imBindings.status, "disabled"),
          ),
        );
      return true;
    });
  }

  async requireSlackInstallationReauthorization(
    installationId: string,
    generation: number,
    errorCode: string,
  ): Promise<boolean> {
    const now = this.#now();
    const lastErrorCode = errorCode.slice(0, 120);
    return this.#database.transaction(async (transaction) => {
      const [updated] = await transaction
        .update(slackInstallations)
        .set({ status: "reauthorization_required", lastErrorCode, updatedAt: now })
        .where(
          and(
            eq(slackInstallations.id, installationId),
            eq(slackInstallations.status, "active"),
            eq(slackInstallations.credentialGeneration, generation),
          ),
        )
        .returning({ id: slackInstallations.id });
      if (!updated) return false;
      await transaction
        .update(imBindings)
        .set({ status: "reauthorization_required", lastErrorCode, updatedAt: now })
        .where(
          and(
            eq(imBindings.slackInstallationId, installationId),
            eq(imBindings.provider, "slack"),
            eq(imBindings.status, "active"),
          ),
        );
      return true;
    });
  }

  async disableSlackInstallationFromProvider(installationId: string, generation: number): Promise<boolean> {
    const result = await this.#database.transaction(async (transaction) => {
      const [installation] = await transaction
        .select({ agentId: slackInstallations.agentId })
        .from(slackInstallations)
        .where(eq(slackInstallations.id, installationId))
        .limit(1);
      const disabled = await this.#disableSlackInstallation(transaction, installationId, this.#now(), generation);
      return { agentId: installation?.agentId, disabled };
    });
    if (result.disabled && result.agentId) {
      await this.#notifyActiveBindingChanged(result.agentId).catch(() => undefined);
    }
    return result.disabled;
  }

  async assertCanManage(
    callerUserId: string,
    agentId: string,
    executor: QueryExecutor = this.#database,
  ): Promise<void> {
    const [agent] = await executor
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")))
      .limit(1);
    if (!agent) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
  }

  async assertCanManageForMutation(
    callerUserId: string,
    agentId: string,
    transaction: DatabaseTransaction,
  ): Promise<void> {
    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.createdByUserId, callerUserId), ne(agents.status, "deleted")))
      .limit(1)
      .for("update");
    if (!agent) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    await this.#afterMutationAuthorityLocked?.();
  }

  async #assertCanRead(callerUserId: string, agentId: string): Promise<void> {
    await this.assertCanManage(callerUserId, agentId);
  }

  async #readiness(imBinding: ImBindingReadinessInput): Promise<ImBindingReadiness> {
    const [agentRuntimeReadiness, providerCliReadiness, credentialExecution] = await Promise.all([
      this.#agentRuntimeReadiness(imBinding.agentId),
      this.#imCliReadiness(imBinding.agentId, imBinding.provider, imBinding.id, imBinding.credentialGeneration),
      this.#credentialExecutionReadiness(
        imBinding.agentId,
        imBinding.provider,
        imBinding.id,
        imBinding.credentialGeneration,
      ),
    ]);
    const reauthorizationRequired =
      imBinding.status === "reauthorization_required" ||
      needsScopeUpdate(imBinding.status, imBinding.provider, imBinding.grantedCapabilities) ||
      (imBinding.status === "active" && imBinding.credentialStatus === "invalid");
    const bindingState = reauthorizationRequired ? "reauthorization_required" : imBinding.status;
    const connection =
      imBinding.provider === "feishu" && imBinding.observedAt
        ? {
            state:
              imBinding.connectionLeaseExpiresAt &&
              imBinding.connectionLeaseExpiresAt > this.#now() &&
              imBinding.observedConnectedAt
                ? ("connected" as const)
                : ("disconnected" as const),
            observedAt: imBinding.observedAt.toISOString(),
          }
        : null;
    const connectionReady =
      imBinding.provider === "slack" ? imBinding.observedConnectedAt !== null : connection?.state === "connected";
    const layersReady =
      agentRuntimeReadiness === "ready" &&
      providerCliReadiness === "ready" &&
      credentialExecution.status === "ready" &&
      connectionReady;
    const providerCli = providerCliProgress(providerCliReadiness, credentialExecution);
    const handoff: ImBindingHandoffStatus =
      bindingState !== "active"
        ? { bindingState, handoffReady: false }
        : layersReady
          ? { bindingState, handoffReady: true }
          : {
              bindingState,
              handoffReady: false,
              ...(providerCli ? { providerCli } : {}),
            };
    return {
      handoff,
      agentRuntimeReadiness,
      providerCliReadiness,
      credentialExecutionReadiness: credentialExecution.status,
      ...(credentialExecution.reason ? { credentialExecutionReason: credentialExecution.reason } : {}),
      reauthorizationRequired,
      connection,
    };
  }

  #withCredentialStatus<
    T extends {
      provider: "feishu" | "slack";
      encryptedCredential: string | null;
      externalAppId: string | null;
      externalBotId: string | null;
      externalTeamId: string | null;
      credentialGeneration: number;
      credentialSchemaVersion: number | null;
      grantedCapabilities: string[];
    },
  >(
    imBinding: T,
    credentialStatus = this.#inspectCredentialMaterial(imBinding).status,
  ): T & { credentialStatus: "valid" | "invalid" } {
    return { ...imBinding, credentialStatus };
  }

  #inspectCredentialMaterial(input: {
    provider: "feishu" | "slack";
    encryptedCredential: string | null;
    externalAppId: string | null;
    externalBotId: string | null;
    externalTeamId: string | null;
    credentialGeneration: number;
    credentialSchemaVersion: number | null;
    grantedCapabilities: string[];
  }): CredentialInspection {
    const requiredCapabilities = requiredCapabilitiesFor(input.provider);
    const storedCapabilities = uniqueSorted(input.grantedCapabilities);
    const invalid = (credentialCapabilities: readonly string[] = storedCapabilities): CredentialInspection => ({
      status: "invalid",
      grantedCapabilities: storedCapabilities,
      requiredCapabilities,
      missingCapabilities: requiredCapabilities.filter(
        (capability) => !storedCapabilities.includes(capability) || !credentialCapabilities.includes(capability),
      ),
    });
    if (
      input.credentialGeneration < 1 ||
      input.credentialSchemaVersion !== 1 ||
      !input.encryptedCredential ||
      !input.externalAppId ||
      !input.externalBotId ||
      (input.provider === "slack" && !input.externalTeamId)
    ) {
      return invalid();
    }
    if (input.provider === "feishu") {
      const credential = this.#decodeFeishuCredential(input.encryptedCredential);
      if (!credential) return invalid();
      const credentialCapabilities = uniqueSorted(credential.grantedScopes);
      const snapshotsMatch =
        credentialCapabilities.length === storedCapabilities.length &&
        credentialCapabilities.every((capability, index) => capability === storedCapabilities[index]);
      if (credential.appId !== input.externalAppId || !snapshotsMatch) return invalid(credentialCapabilities);
      const missingCapabilities = requiredCapabilities.filter((capability) => !storedCapabilities.includes(capability));
      return {
        // A scope-incomplete Feishu grant remains usable by the existing Channel
        // while the replacement authorization is validated. Readiness still
        // projects the missing capabilities as reauthorization required.
        status: "valid",
        grantedCapabilities: storedCapabilities,
        requiredCapabilities,
        missingCapabilities,
      };
    }
    const credential = this.#decodeSlackCredential(input.encryptedCredential);
    if (!credential) return invalid();
    const credentialCapabilities = uniqueSorted(credential.grantedScopes);
    const snapshotsMatch =
      credentialCapabilities.length === storedCapabilities.length &&
      credentialCapabilities.every((capability, index) => capability === storedCapabilities[index]);
    const missingCapabilities = requiredCapabilities.filter(
      (capability) => !storedCapabilities.includes(capability) || !credentialCapabilities.includes(capability),
    );
    return {
      status: snapshotsMatch && missingCapabilities.length === 0 ? "valid" : "invalid",
      grantedCapabilities: storedCapabilities,
      requiredCapabilities,
      missingCapabilities,
    };
  }

  #expectedIdentity(
    binding: typeof imBindings.$inferSelect,
    installation: typeof slackInstallations.$inferSelect | null,
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
    if (!installation) return undefined;
    const credential = this.#decodeSlackCredential(installation.encryptedCredential);
    if (!credential || !installation.externalTeamId || !installation.externalBotId) return undefined;
    return {
      provider: "slack",
      teamId: installation.externalTeamId,
      botUserId: installation.externalBotId,
      botId: credential.botId,
    };
  }

  async notifyProviderCliRequirementChanged(agentId: string): Promise<void> {
    await this.#notifyActiveBindingChanged(agentId);
  }

  async #notifyActiveBindingChanged(agentId: string): Promise<void> {
    if (!this.#onActiveBindingChanged) return;
    const workspaceComputerId = await this.getAgentWorkspaceComputerId(agentId);
    if (!workspaceComputerId) return;
    await this.#onActiveBindingChanged({ agentId, workspaceComputerId });
  }

  #decodeFeishuCredential(encryptedCredential: string | null): z.infer<typeof FeishuCredentialSchema> | undefined {
    if (!encryptedCredential) return undefined;
    try {
      return FeishuCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(encryptedCredential)));
    } catch {
      return undefined;
    }
  }

  #decodeSlackCredential(encryptedCredential: string | null): z.infer<typeof SlackCredentialSchema> | undefined {
    if (!encryptedCredential) return undefined;
    try {
      return SlackCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(encryptedCredential)));
    } catch {
      return undefined;
    }
  }

  #inspectBindingCredentials(
    binding: {
      provider: "feishu" | "slack";
      encryptedCredential: string | null;
      externalAppId: string | null;
      externalBotId: string | null;
      externalTeamId: string | null;
      credentialGeneration: number;
      credentialSchemaVersion: number | null;
      grantedCapabilities: string[];
    },
    installation: typeof slackInstallations.$inferSelect | null | undefined,
  ): CredentialInspection {
    if (binding.provider !== "slack") return this.#inspectCredentialMaterial(binding);
    if (!installation) {
      return this.#inspectCredentialMaterial({
        provider: "slack",
        encryptedCredential: null,
        externalAppId: binding.externalAppId,
        externalBotId: binding.externalBotId,
        externalTeamId: binding.externalTeamId,
        credentialGeneration: binding.credentialGeneration,
        credentialSchemaVersion: binding.credentialSchemaVersion,
        grantedCapabilities: binding.grantedCapabilities,
      });
    }
    return this.#inspectCredentialMaterial(slackInstallationInspectionInput(installation));
  }

  #slackInstallationIngressFromRow(
    installation: typeof slackInstallations.$inferSelect | undefined,
  ): SlackInstallationIngress | undefined {
    if (
      !installation ||
      this.#inspectCredentialMaterial(slackInstallationInspectionInput(installation)).status !== "valid"
    ) {
      return undefined;
    }
    const credential = this.#decodeSlackCredential(installation.encryptedCredential);
    if (!credential || !hasRequiredSlackBotScopes(credential.grantedScopes)) return undefined;
    return {
      installationId: installation.id,
      generation: installation.credentialGeneration,
      agentId: installation.agentId,
      appId: installation.externalAppId,
      teamId: installation.externalTeamId,
      botUserId: installation.externalBotId,
      botId: credential.botId,
      botAccessToken: credential.botAccessToken,
      signingSecret: credential.signingSecret,
    };
  }

  async #resolveSlackRoute(installationId: string, agentId?: string): Promise<SlackInboundRoute | undefined> {
    const rows = await this.#database
      .select({
        imBinding: imBindings,
        agentStatus: agents.status,
        installation: slackInstallations,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .innerJoin(slackInstallations, eq(slackInstallations.id, imBindings.slackInstallationId))
      .where(
        and(
          eq(imBindings.slackInstallationId, installationId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(imBindings.slackRouteKind, "default"),
          eq(slackInstallations.id, installationId),
          eq(slackInstallations.status, "active"),
          eq(slackInstallations.agentId, imBindings.agentId),
          ...(agentId ? [eq(imBindings.agentId, agentId)] : []),
        ),
      )
      .limit(2);
    if (rows.length !== 1) return undefined;
    const row = rows[0];
    if (!row || row.agentStatus === "deleted") {
      return undefined;
    }
    if (row.imBinding.slackRouteKind !== "default") return undefined;
    return {
      imBindingId: row.imBinding.id,
      agentId: row.imBinding.agentId,
      installationId: row.installation.id,
      generation: row.installation.credentialGeneration,
      routeKind: row.imBinding.slackRouteKind,
    };
  }

  async #slackInstallationIdForRoute(imBindingId: string): Promise<string | undefined> {
    const [row] = await this.#database
      .select({ slackInstallationId: imBindings.slackInstallationId })
      .from(imBindings)
      .where(and(eq(imBindings.id, imBindingId), eq(imBindings.provider, "slack")))
      .limit(1);
    return row?.slackInstallationId ?? undefined;
  }

  async #activateSlackInstallation(
    input: SlackBindingActivation,
    credential: z.infer<typeof SlackCredentialSchema>,
    existingTransaction?: DatabaseTransaction,
  ): Promise<{
    id: string;
    installationId: string;
    agentId: string;
    appId: string;
    teamId: string;
    botId: string;
    credentialGeneration: number;
  }> {
    const missing = SLACK_REQUIRED_BOT_SCOPES.filter((scope) => !credential.grantedScopes.includes(scope));
    if (missing.length > 0) {
      throw new ImBindingServiceError(
        "IM_BINDING_SCOPE_REAUTH_REQUIRED",
        409,
        `The provider grant is missing required capabilities: ${missing.join(", ")}`,
      );
    }
    const encryptedCredential = this.#cipher.encrypt(JSON.stringify(credential));
    const activate = async (transaction: DatabaseTransaction) => {
      const [agent] = await transaction
        .select({ computerId: agents.computerId, id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), ne(agents.status, "deleted")))
        .limit(1)
        .for("update");
      if (!agent) throw new ImBindingServiceError("AGENT_NOT_FOUND", 404, "The Agent was not found");
      // Messaging routes work to the Agent's Computer, so a binding that has none would be created
      // ready to deliver to nowhere. The Account binds a Computer first.
      if (agent.computerId === null) {
        throw new ImBindingServiceError(
          "AGENT_COMPUTER_NOT_BOUND",
          409,
          "The Agent must be bound to a Computer before messaging can be connected",
        );
      }
      const schemaInstallation = await schemaRequiredSlackInstallationProjection(transaction, agent.computerId);
      const [currentRoute] = await transaction
        .select()
        .from(imBindings)
        .where(and(eq(imBindings.agentId, input.agentId), ne(imBindings.status, "disabled")))
        .limit(1)
        .for("update");
      if (currentRoute && currentRoute.provider !== "slack") {
        throw new ImBindingServiceError(
          "IM_BINDING_PROVIDER_IMMUTABLE",
          409,
          "The Agent already has a different IM provider",
        );
      }
      const [appTeamInstallation] = await transaction
        .select()
        .from(slackInstallations)
        .where(
          and(
            eq(slackInstallations.externalAppId, input.appId),
            eq(slackInstallations.externalTeamId, input.teamId),
            ne(slackInstallations.status, "disabled"),
          ),
        )
        .limit(1)
        .for("update");
      if (appTeamInstallation && appTeamInstallation.agentId !== input.agentId) {
        throw new ImBindingServiceError(
          "SLACK_APP_TEAM_ALREADY_BOUND",
          409,
          "This Slack App installation is already bound to another OpenTag Agent",
        );
      }
      const [sameAgentInstallation] = await transaction
        .select()
        .from(slackInstallations)
        .where(and(eq(slackInstallations.agentId, input.agentId), ne(slackInstallations.status, "disabled")))
        .limit(1)
        .for("update");
      const configuredRoute = currentRoute?.status === "provisioning" ? undefined : currentRoute;
      if (input.intent === "create" && configuredRoute) {
        throw new ImBindingServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "Create cannot replace an existing Slack binding",
        );
      }
      if (input.intent !== "create" && !configuredRoute) {
        throw new ImBindingServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          `Slack ${input.intent} requires a current configured binding`,
        );
      }
      const now = this.#now();
      let currentAppTeamInstallation = appTeamInstallation;
      let currentSameAgentInstallation = sameAgentInstallation;
      let releasedInstallationId: string | undefined;
      if (currentSameAgentInstallation) {
        const [installationRoute] = await transaction
          .select({ id: imBindings.id })
          .from(imBindings)
          .where(
            and(
              eq(imBindings.slackInstallationId, currentSameAgentInstallation.id),
              eq(imBindings.provider, "slack"),
              ne(imBindings.status, "disabled"),
            ),
          )
          .limit(1);
        if (!installationRoute) {
          await this.#disableSlackInstallation(transaction, currentSameAgentInstallation.id, now);
          releasedInstallationId = currentSameAgentInstallation.id;
          if (currentAppTeamInstallation?.id === currentSameAgentInstallation.id) {
            currentAppTeamInstallation = undefined;
          }
          currentSameAgentInstallation = undefined;
        }
      }
      if (
        currentSameAgentInstallation &&
        currentAppTeamInstallation &&
        currentSameAgentInstallation.id !== currentAppTeamInstallation.id
      ) {
        throw new ImBindingServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "This Agent already has a different Slack installation",
        );
      }
      if (input.intent === "create" && currentSameAgentInstallation && !currentAppTeamInstallation) {
        throw new ImBindingServiceError(
          "SLACK_CONFIGURATION_CONFLICT",
          409,
          "This Agent already has a Slack installation",
        );
      }
      const existingInstallation = currentAppTeamInstallation ?? currentSameAgentInstallation;
      if (existingInstallation) {
        const currentCredential = this.#decodeSlackCredential(existingInstallation.encryptedCredential);
        const sameIdentity =
          existingInstallation.externalAppId === input.appId &&
          existingInstallation.externalTeamId === input.teamId &&
          existingInstallation.externalBotId === input.botUserId &&
          currentCredential?.botId === credential.botId;
        if (input.intent === "reauthorize" && !sameIdentity) {
          if (configuredRoute?.slackInstallationId !== existingInstallation.id) {
            throw new ImBindingServiceError(
              "SLACK_CONFIGURATION_CONFLICT",
              409,
              "The configured Slack route does not belong to the current Agent installation",
            );
          }
          await this.#disableSlackInstallation(transaction, existingInstallation.id, now);
          const replacement = await this.#insertSlackInstallationAndDefaultRoute(
            transaction,
            {
              agentId: input.agentId,
              ...schemaInstallation,
              appId: input.appId,
              teamId: input.teamId,
              enterpriseId: input.enterpriseId ?? null,
              botUserId: input.botUserId,
              encryptedCredential,
              grantedCapabilities: credential.grantedScopes,
            },
            now,
          );
          await transaction
            .update(slackInstallations)
            .set({ replacementSlackInstallationId: replacement.installationId, updatedAt: now })
            .where(eq(slackInstallations.id, existingInstallation.id));
          await transaction
            .update(imBindings)
            .set({ replacementImBindingId: replacement.id, updatedAt: now })
            .where(eq(imBindings.id, configuredRoute.id));
          return replacement;
        }
        const nextGeneration = existingInstallation.credentialGeneration + 1;
        const [updatedInstallation] = await transaction
          .update(slackInstallations)
          .set({
            status: "active",
            externalAppId: input.appId,
            externalTeamId: input.teamId,
            externalEnterpriseId: input.enterpriseId ?? null,
            externalBotId: input.botUserId,
            credentialSchemaVersion: 1,
            credentialGeneration: nextGeneration,
            encryptedCredential,
            grantedCapabilities: credential.grantedScopes,
            observedAt: null,
            observedConnectedAt: null,
            activatedAt: now,
            disabledAt: null,
            lastErrorCode: null,
            updatedAt: now,
          })
          .where(and(eq(slackInstallations.id, existingInstallation.id), eq(slackInstallations.agentId, input.agentId)))
          .returning();
        if (!updatedInstallation) throw new Error("Slack installation update did not return a row");
        await this.#syncSlackRoutesFromInstallation(transaction, updatedInstallation, now);
        const routeId =
          input.intent === "create"
            ? await this.#insertDefaultSlackRoute(transaction, updatedInstallation, input.agentId, now)
            : configuredRoute?.id;
        if (!routeId) throw new Error("Slack route was not created");
        if (input.intent === "reauthorize" && configuredRoute && configuredRoute.id !== routeId) {
          throw new Error("Slack reauthorization lost the current route");
        }
        return {
          id: routeId,
          installationId: updatedInstallation.id,
          agentId: input.agentId,
          appId: updatedInstallation.externalAppId,
          teamId: updatedInstallation.externalTeamId,
          botId: updatedInstallation.externalBotId,
          credentialGeneration: nextGeneration,
        };
      }
      const created = await this.#insertSlackInstallationAndDefaultRoute(
        transaction,
        {
          agentId: input.agentId,
          ...schemaInstallation,
          appId: input.appId,
          teamId: input.teamId,
          enterpriseId: input.enterpriseId ?? null,
          botUserId: input.botUserId,
          encryptedCredential,
          grantedCapabilities: credential.grantedScopes,
        },
        now,
      );
      if (releasedInstallationId) {
        await transaction
          .update(slackInstallations)
          .set({ replacementSlackInstallationId: created.installationId, updatedAt: now })
          .where(eq(slackInstallations.id, releasedInstallationId));
      }
      return created;
    };
    return existingTransaction ? activate(existingTransaction) : this.#database.transaction(activate);
  }

  async #insertSlackInstallationAndDefaultRoute(
    transaction: DatabaseTransaction,
    input: {
      agentId: string;
      workspaceId: string;
      appId: string;
      teamId: string;
      enterpriseId: string | null;
      botUserId: string;
      encryptedCredential: string;
      grantedCapabilities: string[];
    },
    now: Date,
  ): Promise<{
    id: string;
    installationId: string;
    agentId: string;
    appId: string;
    teamId: string;
    botId: string;
    credentialGeneration: number;
  }> {
    const [createdInstallation] = await transaction
      .insert(slackInstallations)
      .values({
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        status: "active",
        externalAppId: input.appId,
        externalTeamId: input.teamId,
        externalEnterpriseId: input.enterpriseId,
        externalBotId: input.botUserId,
        credentialSchemaVersion: 1,
        credentialGeneration: 1,
        encryptedCredential: input.encryptedCredential,
        grantedCapabilities: input.grantedCapabilities,
        observedAt: null,
        observedConnectedAt: null,
        activatedAt: now,
        disabledAt: null,
        lastErrorCode: null,
        updatedAt: now,
        createdAt: now,
      })
      .returning();
    if (!createdInstallation) throw new Error("Slack installation insert did not return a row");
    const routeId = await this.#insertDefaultSlackRoute(transaction, createdInstallation, input.agentId, now);
    return {
      id: routeId,
      installationId: createdInstallation.id,
      agentId: input.agentId,
      appId: createdInstallation.externalAppId,
      teamId: createdInstallation.externalTeamId,
      botId: createdInstallation.externalBotId,
      credentialGeneration: 1,
    };
  }

  async #insertDefaultSlackRoute(
    transaction: DatabaseTransaction,
    installation: typeof slackInstallations.$inferSelect,
    agentId: string,
    now: Date,
  ): Promise<string> {
    const currentRoutes = await transaction
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(
        and(
          eq(imBindings.slackInstallationId, installation.id),
          eq(imBindings.provider, "slack"),
          ne(imBindings.status, "disabled"),
        ),
      )
      .for("update");
    for (const route of currentRoutes) {
      await disableImBindingInTransaction(transaction, route.id, now, undefined, false);
    }
    const [created] = await transaction
      .insert(imBindings)
      .values(this.#slackRouteValues(installation, agentId, now))
      .returning({ id: imBindings.id });
    if (!created) throw new Error("Slack route insert did not return an id");
    if (currentRoutes.length > 0) {
      await transaction
        .update(imBindings)
        .set({ replacementImBindingId: created.id, updatedAt: now })
        .where(
          inArray(
            imBindings.id,
            currentRoutes.map((route) => route.id),
          ),
        );
    }
    return created.id;
  }

  async #syncSlackRoutesFromInstallation(
    transaction: DatabaseTransaction,
    installation: typeof slackInstallations.$inferSelect,
    now: Date,
  ): Promise<void> {
    await transaction
      .update(imBindings)
      .set({
        status: installation.status === "reauthorization_required" ? "reauthorization_required" : "active",
        externalAppId: installation.externalAppId,
        externalTeamId: installation.externalTeamId,
        externalEnterpriseId: installation.externalEnterpriseId,
        externalBotId: installation.externalBotId,
        externalTeamName: installation.externalTeamName,
        botDisplayName: installation.botDisplayName,
        botAvatarUrl: installation.botAvatarUrl,
        credentialSchemaVersion: installation.credentialSchemaVersion,
        credentialGeneration: installation.credentialGeneration,
        grantedCapabilities: installation.grantedCapabilities,
        observedAt: installation.observedAt,
        observedConnectedAt: installation.observedConnectedAt,
        lastErrorCode: installation.lastErrorCode,
        activatedAt: installation.activatedAt,
        encryptedCredential: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(imBindings.slackInstallationId, installation.id),
          eq(imBindings.provider, "slack"),
          ne(imBindings.status, "disabled"),
        ),
      );
  }

  #slackRouteValues(installation: typeof slackInstallations.$inferSelect, agentId: string, now: Date) {
    return {
      agentId,
      provider: "slack" as const,
      status: "active" as const,
      slackInstallationId: installation.id,
      slackRouteKind: "default" as const,
      externalAppId: installation.externalAppId,
      externalTeamId: installation.externalTeamId,
      externalEnterpriseId: installation.externalEnterpriseId,
      externalBotId: installation.externalBotId,
      externalTeamBrand: null,
      externalTeamName: installation.externalTeamName,
      botDisplayName: installation.botDisplayName,
      botAvatarUrl: installation.botAvatarUrl,
      credentialSchemaVersion: 1,
      credentialGeneration: installation.credentialGeneration,
      encryptedCredential: null,
      grantedCapabilities: installation.grantedCapabilities,
      setupAttemptId: null,
      setupIntent: null,
      setupState: null,
      setupOwnerInstanceId: null,
      setupOwnerHeartbeatAt: null,
      encryptedSetupContext: null,
      setupExpiresAt: null,
      observedAt: installation.observedAt,
      observedConnectedAt: installation.observedConnectedAt,
      activatedAt: now,
      disabledAt: null,
      lastErrorCode: null,
      updatedAt: now,
    };
  }

  async #disableSlackInstallation(
    transaction: DatabaseTransaction,
    installationId: string,
    now: Date,
    expectedGeneration?: number,
  ): Promise<boolean> {
    const [disabled] = await transaction
      .update(slackInstallations)
      .set({
        status: "disabled",
        encryptedCredential: null,
        disabledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(slackInstallations.id, installationId),
          ne(slackInstallations.status, "disabled"),
          ...(expectedGeneration === undefined
            ? []
            : [eq(slackInstallations.credentialGeneration, expectedGeneration)]),
        ),
      )
      .returning({ id: slackInstallations.id });
    if (!disabled) return false;
    const routes = await transaction
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(
        and(
          eq(imBindings.slackInstallationId, installationId),
          eq(imBindings.provider, "slack"),
          ne(imBindings.status, "disabled"),
        ),
      );
    for (const route of routes) {
      await disableImBindingInTransaction(transaction, route.id, now);
    }
    return true;
  }

  async #activate(
    input: {
      agentId: string;
      provider: "feishu" | "slack";
      intent?: SlackConfigurationIntent;
      identity: {
        appId: string;
        teamId: string | null;
        enterpriseId: string | null;
        botId: string;
        teamBrand: string | null;
      };
      credential: z.infer<typeof FeishuCredentialSchema> | z.infer<typeof SlackCredentialSchema>;
    },
    existingTransaction?: DatabaseTransaction,
  ): Promise<ActivatedBinding> {
    const encryptedCredential = this.#cipher.encrypt(JSON.stringify(input.credential));
    const activate = async (transaction: DatabaseTransaction): Promise<ActivatedBinding> => {
      const [agent] = await transaction
        .select({ computerId: agents.computerId, id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), ne(agents.status, "deleted")))
        .limit(1)
        .for("update");
      if (!agent) throw new ImBindingServiceError("AGENT_NOT_FOUND", 404, "The Agent was not found");
      // Messaging routes work to the Agent's Computer, so a binding that has none would be created
      // ready to deliver to nowhere. The Account binds a Computer first.
      if (agent.computerId === null) {
        throw new ImBindingServiceError(
          "AGENT_COMPUTER_NOT_BOUND",
          409,
          "The Agent must be bound to a Computer before messaging can be connected",
        );
      }
      const [current] = await transaction
        .select()
        .from(imBindings)
        .where(and(eq(imBindings.agentId, input.agentId), ne(imBindings.status, "disabled")))
        .limit(1)
        .for("update");
      if (current && current.provider !== input.provider) {
        throw new ImBindingServiceError(
          "IM_BINDING_PROVIDER_IMMUTABLE",
          409,
          "The Agent already has a different IM provider",
        );
      }
      if (input.provider === "slack") {
        throw new Error("Slack activation must use the workspace installation write path");
      }
      if (input.provider === "feishu") {
        const [conflicting] = await transaction
          .select({ id: imBindings.id })
          .from(imBindings)
          .where(
            and(
              eq(imBindings.provider, "feishu"),
              eq(imBindings.externalAppId, input.identity.appId),
              ne(imBindings.agentId, input.agentId),
              ne(imBindings.status, "disabled"),
            ),
          )
          .limit(1);
        if (conflicting) {
          throw new ImBindingServiceError(
            "FEISHU_APP_ALREADY_BOUND",
            409,
            "The selected Feishu App is already bound to another Agent",
          );
        }
      }
      const requiredCapabilities =
        input.provider === "feishu" ? [...FEISHU_REQUIRED_TENANT_SCOPES] : [...SLACK_REQUIRED_BOT_SCOPES];
      const missing = requiredCapabilities.filter((capability) => !input.credential.grantedScopes.includes(capability));
      if (missing.length > 0) {
        throw new ImBindingServiceError(
          "IM_BINDING_SCOPE_REAUTH_REQUIRED",
          409,
          `The provider grant is missing required capabilities: ${missing.join(", ")}`,
        );
      }
      const now = this.#now();
      const activationInput =
        input.provider === "feishu" &&
        input.identity.teamId === null &&
        current?.externalAppId === input.identity.appId &&
        current.externalTeamId
          ? { ...input, identity: { ...input.identity, teamId: current.externalTeamId } }
          : input;
      const sameProviderApp = current?.externalAppId === activationInput.identity.appId;
      if (
        current &&
        current.status !== "provisioning" &&
        input.provider === "feishu" &&
        sameProviderApp &&
        (current.externalTeamId !== activationInput.identity.teamId ||
          current.externalBotId !== activationInput.identity.botId)
      ) {
        throw new ImBindingServiceError(
          "FEISHU_BINDING_IDENTITY_MISMATCH",
          409,
          "The authorized Feishu Bot identity does not match the current App binding",
        );
      }
      const sameIdentity = sameProviderApp;
      const activated = (id: string, credentialGeneration: number): ActivatedBinding => ({
        id,
        agentId: activationInput.agentId,
        provider: activationInput.provider,
        appId: activationInput.identity.appId,
        teamId: activationInput.identity.teamId,
        botId: activationInput.identity.botId,
        credentialGeneration,
      });
      if (current && current.status !== "provisioning" && !sameIdentity) {
        await disableImBindingInTransaction(transaction, current.id, now);
        const [created] = await transaction
          .insert(imBindings)
          .values(this.#activeValues(activationInput, encryptedCredential, 1, now))
          .returning({ id: imBindings.id });
        if (!created) throw new Error("Replacement IM binding insert did not return an id");
        await transaction
          .update(imBindings)
          .set({ replacementImBindingId: created.id })
          .where(eq(imBindings.id, current.id));
        return activated(created.id, 1);
      }
      if (current) {
        const nextGeneration = current.credentialGeneration + 1;
        const [updated] = await transaction
          .update(imBindings)
          .set({
            ...this.#activeValues(activationInput, encryptedCredential, nextGeneration, now),
            ...(input.provider === "feishu"
              ? {
                  setupAttemptId: current.setupAttemptId,
                  setupIntent: current.setupIntent,
                  setupState: current.setupState,
                  setupOwnerInstanceId: current.setupOwnerInstanceId,
                  setupOwnerHeartbeatAt: current.setupOwnerHeartbeatAt,
                  encryptedSetupContext: current.encryptedSetupContext,
                  setupExpiresAt: current.setupExpiresAt,
                }
              : {
                  setupAttemptId: null,
                  setupIntent: null,
                  setupState: null,
                  setupOwnerInstanceId: null,
                  setupOwnerHeartbeatAt: null,
                  encryptedSetupContext: null,
                  setupExpiresAt: null,
                }),
          })
          .where(eq(imBindings.id, current.id))
          .returning({ id: imBindings.id });
        if (!updated) throw new Error("IM binding activation update did not return an id");
        return activated(updated.id, nextGeneration);
      }
      const [created] = await transaction
        .insert(imBindings)
        .values(this.#activeValues(activationInput, encryptedCredential, 1, now))
        .returning({ id: imBindings.id });
      if (!created) throw new Error("IM binding insert did not return an id");
      return activated(created.id, 1);
    };
    return existingTransaction ? activate(existingTransaction) : this.#database.transaction(activate);
  }

  #activeValues(
    input: {
      agentId: string;
      provider: "feishu" | "slack";
      identity: {
        appId: string;
        teamId: string | null;
        enterpriseId: string | null;
        botId: string;
        teamBrand: string | null;
      };
      credential: { grantedScopes: string[] };
    },
    encryptedCredential: string,
    generation: number,
    now: Date,
  ) {
    return {
      agentId: input.agentId,
      provider: input.provider,
      status: "active" as const,
      externalAppId: input.identity.appId,
      externalTeamId: input.identity.teamId,
      externalEnterpriseId: input.identity.enterpriseId,
      externalBotId: input.identity.botId,
      externalTeamBrand: input.identity.teamBrand,
      credentialSchemaVersion: 1,
      credentialGeneration: generation,
      encryptedCredential,
      grantedCapabilities: input.credential.grantedScopes,
      activatedAt: now,
      ...(input.provider === "slack" ? { observedAt: null, observedConnectedAt: null } : {}),
      disabledAt: null,
      lastErrorCode: null,
      updatedAt: now,
    };
  }

  async #activeMaterial(
    imBindingId: string,
    provider: "feishu" | "slack",
    transaction?: DatabaseTransaction,
  ): Promise<typeof imBindings.$inferSelect | undefined> {
    const source = transaction ?? this.#database;
    const [row] = await source
      .select({ imBinding: imBindings })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.provider, provider),
          eq(imBindings.status, "active"),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    return row?.imBinding;
  }

  async #activity(imBindingId: string): Promise<{ lastInboundAt: string | null }> {
    const [inbound] = await this.#database
      .select({ at: imMessages.receivedAt })
      .from(imMessages)
      .where(and(eq(imMessages.imBindingId, imBindingId), eq(imMessages.direction, "inbound")))
      .orderBy(desc(imMessages.receivedAt))
      .limit(1);
    return {
      lastInboundAt: inbound?.at.toISOString() ?? null,
    };
  }
}
