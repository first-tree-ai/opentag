import type {
  ImBindingAdminDetail,
  ImBindingDiagnostics,
  ImBindingHandoffStatus,
  ImBindingState,
  ImBindingSummary,
  ImCliReadinessStatus,
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
import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessages,
  memberships,
  sessionPlacements,
  sessions,
  users,
} from "../../db/schema/index.js";
import { AuthServiceError } from "../auth/index.js";
import type { ApplicationCipher } from "../crypto.js";
import { TeamMembershipService } from "../teams/index.js";

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

export interface SlackIngressBinding {
  imBindingId: string;
  generation: number;
  appId: string;
  teamId: string;
  botUserId: string;
  botId: string;
  botAccessToken: string;
  signingSecret: string;
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

export interface SlackConnectionMaterial extends SlackIngressBinding {
  grantedScopes: string[];
}

interface ImBindingReadinessInput {
  agentId: string;
  provider: "feishu" | "slack";
  status: ImBindingState;
  connectionLeaseExpiresAt: Date | null;
  observedConnectedAt: Date | null;
  observedAt: Date | null;
  grantedCapabilities: string[];
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
    .returning({ id: imBindings.id });
  if (disabled.length === 0) return false;
  await transaction
    .update(sessions)
    .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
    .where(and(eq(sessions.imBindingId, imBindingId), isNull(sessions.endedAt)));
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
  readonly #membershipService: TeamMembershipService;
  readonly #now: () => Date;
  readonly #agentRuntimeReadiness: (agentId: string) => Promise<ProviderReadinessStatus>;
  readonly #imCliReadiness: (agentId: string, provider: "feishu" | "slack") => Promise<ImCliReadinessStatus>;

  constructor(
    database: DatabaseClient,
    cipher: ApplicationCipher,
    options: {
      afterMutationAuthorityLocked?: () => Promise<void> | void;
      membershipService?: TeamMembershipService;
      now?: () => Date;
      agentRuntimeReadiness?: (agentId: string) => Promise<ProviderReadinessStatus> | ProviderReadinessStatus;
      imCliReadiness?: (
        agentId: string,
        provider: "feishu" | "slack",
      ) => Promise<ImCliReadinessStatus> | ImCliReadinessStatus;
    } = {},
  ) {
    this.#database = database;
    this.#afterMutationAuthorityLocked = options.afterMutationAuthorityLocked;
    this.#membershipService = options.membershipService ?? new TeamMembershipService(database);
    this.#cipher = cipher;
    this.#now = options.now ?? (() => new Date());
    this.#agentRuntimeReadiness = async (agentId) => (await options.agentRuntimeReadiness?.(agentId)) ?? "ready";
    this.#imCliReadiness = async (agentId, provider) => (await options.imCliReadiness?.(agentId, provider)) ?? "ready";
  }

  async getAgentComputerId(agentId: string): Promise<string | undefined> {
    const [agent] = await this.#database
      .select({ computerId: agents.computerId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    return agent?.computerId;
  }

  async issueRuntimeCredentialGrant(
    request: RuntimeImCredentialGrantRequest,
    authenticatedComputerId: string,
  ): Promise<RuntimeImCredentialGrantResult> {
    const [row] = await this.#database
      .select({
        sessionId: sessions.id,
        sessionKind: sessions.kind,
        sessionEndedAt: sessions.endedAt,
        binding: imBindings,
        boundAgentId: imBindings.agentId,
        agentComputerId: agents.computerId,
        agentStatus: agents.status,
        placementComputerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .leftJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
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
      row.agentComputerId !== authenticatedComputerId ||
      row.agentStatus !== "active"
    ) {
      return rejected("agent_mismatch");
    }
    if (
      row.sessionEndedAt !== null ||
      row.placementComputerId !== authenticatedComputerId ||
      row.placementGeneration !== request.placementGeneration
    ) {
      return rejected("placement_stale");
    }
    const binding = row.binding;
    if (binding.status !== "active") return rejected("binding_inactive");
    if (this.#inspectCredentialMaterial(binding).status !== "valid") {
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
      };
    }
    if (!binding.observedConnectedAt) return rejected("binding_inactive");
    const credential = this.#decodeSlackCredential(binding.encryptedCredential);
    if (!credential || !hasRequiredSlackBotScopes(credential.grantedScopes)) return rejected("credential_stale");
    return {
      type: "im:credential:result",
      requestId: request.requestId,
      status: "succeeded",
      credentialGeneration: binding.credentialGeneration,
      grant: { provider: "slack", botAccessToken: credential.botAccessToken },
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
      const activated = await this.#activate(
        {
          agentId: input.agentId,
          provider: "slack",
          intent: input.intent,
          identity: {
            appId: input.appId,
            teamId: input.teamId,
            enterpriseId: input.enterpriseId ?? null,
            botId: input.botUserId,
            teamBrand: null,
          },
          credential,
        },
        transaction,
      );
      if (!activated.teamId) throw new Error("Activated Slack binding did not contain a Team ID");
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
      // The partial unique index decides concurrent activations of one App/Team; report the loser
      // with the same typed conflict the in-transaction precheck uses.
      if (isImBindingUniqueViolation(error, "im_bindings_slack_app_team_current_unique")) {
        throw new ImBindingServiceError(
          "SLACK_APP_TEAM_ALREADY_BOUND",
          409,
          "This Slack App installation is already bound to another Agent",
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
      return (
        await this.#activate(
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
        )
      ).id;
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

  async findSlackIngressBinding(appId: string, teamId: string): Promise<SlackIngressBinding | undefined> {
    const [row] = await this.#database
      .select({ imBinding: imBindings })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(imBindings.provider, "slack"),
          eq(imBindings.externalAppId, appId),
          eq(imBindings.externalTeamId, teamId),
          eq(imBindings.status, "active"),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    return this.#slackIngressFromRow(row?.imBinding, appId, teamId);
  }

  async findSlackIngressBindingForAgent(agentId: string): Promise<SlackIngressBinding | undefined> {
    const [row] = await this.#database
      .select({ imBinding: imBindings })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(imBindings.agentId, agentId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          ne(agents.status, "deleted"),
        ),
      )
      .limit(1);
    const imBinding = row?.imBinding;
    if (!imBinding?.externalAppId || !imBinding.externalTeamId) return undefined;
    return this.#slackIngressFromRow(imBinding, imBinding.externalAppId, imBinding.externalTeamId);
  }

  async getSlackConnectionMaterial(imBindingId: string): Promise<SlackConnectionMaterial | undefined> {
    const imBinding = await this.#activeMaterial(imBindingId, "slack");
    if (!imBinding?.externalAppId || !imBinding.externalTeamId || !imBinding.observedConnectedAt) return undefined;
    const ingress = this.#slackIngressFromRow(imBinding, imBinding.externalAppId, imBinding.externalTeamId);
    if (!ingress) return undefined;
    const credential = this.#decodeSlackCredential(imBinding.encryptedCredential);
    if (!credential) return undefined;
    return { ...ingress, grantedScopes: credential.grantedScopes };
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
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (!row) return undefined;
    const activity = await this.#activity(row.id);
    const credential = this.#inspectCredentialMaterial(row);
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
      lastRuntimeObservationAt: row.observedAt?.toISOString() ?? null,
    };
  }

  async getHandoffForAgent(callerUserId: string, agentId: string): Promise<ImBindingHandoffStatus | undefined> {
    await this.#assertCanRead(callerUserId, agentId);
    const [imBinding] = await this.#database
      .select({
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
      })
      .from(imBindings)
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (!imBinding) return undefined;
    return (await this.#readiness(this.#withCredentialStatus(imBinding))).handoff;
  }

  async getConfigForAgent(callerUserId: string, agentId: string): Promise<ImBindingAdminDetail | undefined> {
    await this.assertCanManage(callerUserId, agentId);
    const [row] = await this.#database
      .select({ imBinding: imBindings, receiveMode: agents.receiveMode })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(and(eq(imBindings.agentId, agentId), ne(imBindings.status, "disabled")))
      .limit(1);
    if (!row) return undefined;
    const binding = row.imBinding;
    if (!binding.externalAppId || !binding.externalBotId || binding.credentialGeneration < 1) return undefined;
    const activity = await this.#activity(binding.id);
    const credential = this.#inspectCredentialMaterial(binding);
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
    await this.#database.transaction(async (transaction) => {
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
    });
  }

  async diagnostics(callerUserId: string, imBindingId: string): Promise<ImBindingDiagnostics> {
    const [imBinding] = await this.#database
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
      })
      .from(imBindings)
      .where(eq(imBindings.id, imBindingId))
      .limit(1);
    if (!imBinding) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The IM binding was not found");
    await this.assertCanManage(callerUserId, imBinding.agentId);
    const credential = this.#inspectCredentialMaterial(imBinding);
    const readiness = await this.#readiness(this.#withCredentialStatus(imBinding, credential.status));
    const activity = await this.#activity(imBindingId);
    return {
      imBindingId,
      provider: imBinding.provider,
      ready: readiness.handoff.handoffReady,
      agentRuntimeReadiness: readiness.agentRuntimeReadiness,
      providerCliReadiness: readiness.providerCliReadiness,
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
    const updated = await this.#database
      .update(imBindings)
      .set({ status: "reauthorization_required", lastErrorCode: errorCode.slice(0, 120), updatedAt: this.#now() })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(imBindings.credentialGeneration, generation),
        ),
      )
      .returning({ id: imBindings.id });
    return updated.length === 1;
  }

  async recordSlackObservation(imBindingId: string, generation: number): Promise<boolean> {
    const updated = await this.#database
      .update(imBindings)
      .set({ observedAt: this.#now() })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(imBindings.credentialGeneration, generation),
        ),
      )
      .returning({ id: imBindings.id });
    return updated.length === 1;
  }

  async recordSlackIdentityClosure(imBindingId: string, generation: number): Promise<boolean> {
    const observedAt = this.#now();
    const updated = await this.#database
      .update(imBindings)
      .set({ observedAt, observedConnectedAt: observedAt, updatedAt: observedAt })
      .where(
        and(
          eq(imBindings.id, imBindingId),
          eq(imBindings.provider, "slack"),
          eq(imBindings.status, "active"),
          eq(imBindings.credentialGeneration, generation),
        ),
      )
      .returning({ id: imBindings.id });
    return updated.length === 1;
  }

  async disableFromProvider(imBindingId: string, generation: number): Promise<boolean> {
    return this.#disable(imBindingId, generation);
  }

  async assertCanManage(
    callerUserId: string,
    agentId: string,
    executor: QueryExecutor = this.#database,
  ): Promise<void> {
    const [scope] = await executor
      .select({ role: memberships.role })
      .from(agents)
      .innerJoin(
        memberships,
        and(
          eq(memberships.teamId, agents.teamId),
          eq(memberships.userId, callerUserId),
          eq(memberships.status, "active"),
        ),
      )
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!scope) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    if (scope.role !== "admin") {
      throw new ImBindingServiceError("IM_BINDING_FORBIDDEN", 403, "The caller cannot manage this IM binding");
    }
  }

  async assertCanManageForMutation(
    callerUserId: string,
    agentId: string,
    transaction: DatabaseTransaction,
  ): Promise<void> {
    const [candidate] = await transaction
      .select({ teamId: agents.teamId })
      .from(agents)
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!candidate) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    try {
      await this.#membershipService.requireActiveMembershipForMutation(
        transaction,
        callerUserId,
        candidate.teamId,
        "admin",
      );
    } catch (error) {
      if (error instanceof AuthServiceError && error.statusCode === 403) {
        throw new ImBindingServiceError("IM_BINDING_FORBIDDEN", 403, "The caller cannot manage this IM binding");
      }
      if (error instanceof AuthServiceError && error.statusCode === 404) {
        throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
      }
      throw error;
    }
    const [agent] = await transaction
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.teamId, candidate.teamId), ne(agents.status, "deleted")))
      .limit(1)
      .for("update");
    if (!agent) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
    await this.#afterMutationAuthorityLocked?.();
  }

  async #assertCanRead(callerUserId: string, agentId: string): Promise<void> {
    const [scope] = await this.#database
      .select({ agentId: agents.id })
      .from(agents)
      .innerJoin(
        memberships,
        and(
          eq(memberships.teamId, agents.teamId),
          eq(memberships.userId, callerUserId),
          eq(memberships.status, "active"),
        ),
      )
      .innerJoin(users, and(eq(users.id, memberships.userId), isNull(users.suspendedAt)))
      .where(and(eq(agents.id, agentId), ne(agents.status, "deleted")))
      .limit(1);
    if (!scope) throw new ImBindingServiceError("IM_BINDING_NOT_FOUND", 404, "The Agent was not found");
  }

  async #readiness(imBinding: ImBindingReadinessInput): Promise<ImBindingReadiness> {
    const [agentRuntimeReadiness, providerCliReadiness] = await Promise.all([
      this.#agentRuntimeReadiness(imBinding.agentId),
      this.#imCliReadiness(imBinding.agentId, imBinding.provider),
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
    const handoff: ImBindingHandoffStatus =
      bindingState !== "active"
        ? { bindingState, handoffReady: false }
        : agentRuntimeReadiness === "ready" && providerCliReadiness === "ready" && connectionReady
          ? { bindingState, handoffReady: true }
          : { bindingState, handoffReady: false };
    return {
      handoff,
      agentRuntimeReadiness,
      providerCliReadiness,
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

  #slackIngressFromRow(
    imBinding: typeof imBindings.$inferSelect | undefined,
    appId: string,
    teamId: string,
  ): SlackIngressBinding | undefined {
    if (!imBinding?.externalBotId || this.#inspectCredentialMaterial(imBinding).status !== "valid") return undefined;
    const credential = this.#decodeSlackCredential(imBinding.encryptedCredential);
    if (!credential || !hasRequiredSlackBotScopes(credential.grantedScopes)) return undefined;
    return {
      imBindingId: imBinding.id,
      generation: imBinding.credentialGeneration,
      appId,
      teamId,
      botUserId: imBinding.externalBotId,
      botId: credential.botId,
      botAccessToken: credential.botAccessToken,
      signingSecret: credential.signingSecret,
    };
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
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), ne(agents.status, "deleted")))
        .limit(1)
        .for("update");
      if (!agent) throw new ImBindingServiceError("AGENT_NOT_FOUND", 404, "The Agent was not found");
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
      if (input.provider === "slack" && input.identity.teamId) {
        const [conflicting] = await transaction
          .select({ id: imBindings.id })
          .from(imBindings)
          .where(
            and(
              eq(imBindings.provider, "slack"),
              eq(imBindings.externalAppId, input.identity.appId),
              eq(imBindings.externalTeamId, input.identity.teamId),
              ne(imBindings.agentId, input.agentId),
              ne(imBindings.status, "disabled"),
            ),
          )
          .limit(1);
        if (conflicting) {
          throw new ImBindingServiceError(
            "SLACK_APP_TEAM_ALREADY_BOUND",
            409,
            "This Slack App installation is already bound to another Agent",
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
      const sameIdentity =
        input.provider === "feishu"
          ? sameProviderApp
          : sameProviderApp &&
            current?.externalTeamId === activationInput.identity.teamId &&
            current.externalBotId === activationInput.identity.botId;
      if (input.provider === "slack") {
        const proposedSlackCredential = SlackCredentialSchema.parse(input.credential);
        const configuredCurrent = current?.status === "provisioning" ? undefined : current;
        const currentSlackCredential = configuredCurrent
          ? this.#decodeSlackCredential(configuredCurrent.encryptedCredential)
          : undefined;
        if (!input.intent) throw new Error("Slack activation intent is missing");
        if (input.intent === "create" && configuredCurrent) {
          throw new ImBindingServiceError(
            "SLACK_CONFIGURATION_CONFLICT",
            409,
            "Create cannot replace an existing Slack binding",
          );
        }
        if (input.intent !== "create" && !configuredCurrent) {
          throw new ImBindingServiceError(
            "SLACK_CONFIGURATION_CONFLICT",
            409,
            `Slack ${input.intent} requires a current configured binding`,
          );
        }
        if (
          input.intent === "reauthorize" &&
          (!sameIdentity ||
            (currentSlackCredential?.botId !== undefined &&
              currentSlackCredential.botId !== proposedSlackCredential.botId))
        ) {
          throw new ImBindingServiceError(
            "SLACK_BINDING_IDENTITY_MISMATCH",
            409,
            "Reauthorization must preserve the current Slack App, Team, and Bot identity",
          );
        }
        if (input.intent === "replace" && sameProviderApp) {
          throw new ImBindingServiceError(
            "SLACK_CONFIGURATION_CONFLICT",
            409,
            "Change App requires a different Slack App ID",
          );
        }
      }
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

  async #disable(imBindingId: string, expectedGeneration?: number): Promise<boolean> {
    return this.#database.transaction(async (transaction) => {
      return disableImBindingInTransaction(transaction, imBindingId, this.#now(), expectedGeneration);
    });
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
