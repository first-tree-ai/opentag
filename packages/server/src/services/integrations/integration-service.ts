import type { IntegrationDiagnostics, IntegrationSummary, SlackBindingActivation } from "@opentag/shared";
import { and, asc, desc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  imMessages,
  imOutboundRequests,
  integrations,
  memberships,
  sessions,
  users,
} from "../../db/schema/index.js";
import type { ApplicationCipher } from "../crypto.js";

const FeishuCredentialSchema = z
  .object({
    appId: z.string().min(1),
    appSecret: z.string().min(1),
    grantedScopes: z.array(z.string().min(1)).max(128),
  })
  .strict();

const SlackCredentialSchema = z
  .object({
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
  integrationId: string;
  generation: number;
  appId: string;
  teamId: string;
  botUserId: string;
  botAccessToken: string;
  signingSecret: string;
}

export interface FeishuConnectionMaterial {
  integrationId: string;
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

export class IntegrationServiceError extends Error {
  readonly category = "deterministic" as const;
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class IntegrationService {
  readonly #cipher: ApplicationCipher;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #runtimeReady: (agentId: string) => Promise<boolean>;

  constructor(
    database: DatabaseClient,
    cipher: ApplicationCipher,
    options: { now?: () => Date; runtimeReady?: (agentId: string) => Promise<boolean> | boolean } = {},
  ) {
    this.#database = database;
    this.#cipher = cipher;
    this.#now = options.now ?? (() => new Date());
    this.#runtimeReady = async (agentId) => (await options.runtimeReady?.(agentId)) ?? true;
  }

  async getAgentComputerId(agentId: string): Promise<string | undefined> {
    const [agent] = await this.#database
      .select({ computerId: agents.computerId })
      .from(agents)
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);
    return agent?.computerId;
  }

  async activateSlack(input: SlackBindingActivation): Promise<string> {
    const credential = SlackCredentialSchema.parse({
      botAccessToken: input.botAccessToken,
      signingSecret: input.signingSecret,
      grantedScopes: [...new Set(input.grantedBotScopes)].sort(),
    });
    return this.#activate({
      agentId: input.agentId,
      provider: "slack",
      identity: {
        appId: input.appId,
        teamId: input.teamId,
        enterpriseId: input.enterpriseId ?? null,
        botId: input.botUserId,
        teamBrand: null,
      },
      credential,
    });
  }

  async activateFeishu(input: VerifiedFeishuBinding, transaction?: DatabaseTransaction): Promise<string> {
    const credential = FeishuCredentialSchema.parse({
      appId: input.appId,
      appSecret: input.appSecret,
      grantedScopes: [...new Set(input.grantedScopes)].sort(),
    });
    return this.#activate(
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
  }

  async findSlackIngressBinding(appId: string, teamId: string): Promise<SlackIngressBinding | undefined> {
    const [row] = await this.#database
      .select()
      .from(integrations)
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .where(
        and(
          eq(integrations.provider, "slack"),
          eq(integrations.externalAppId, appId),
          eq(integrations.externalTeamId, teamId),
          ne(integrations.status, "disabled"),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    const integration = row?.integrations;
    if (!integration?.encryptedCredential || !integration.externalBotId) return undefined;
    const credential = SlackCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(integration.encryptedCredential)));
    return {
      integrationId: integration.id,
      generation: integration.credentialGeneration,
      appId,
      teamId,
      botUserId: integration.externalBotId,
      botAccessToken: credential.botAccessToken,
      signingSecret: credential.signingSecret,
    };
  }

  async getSlackConnectionMaterial(integrationId: string): Promise<SlackConnectionMaterial | undefined> {
    const integration = await this.#activeMaterial(integrationId, "slack");
    if (
      !integration?.encryptedCredential ||
      !integration.externalAppId ||
      !integration.externalTeamId ||
      !integration.externalBotId
    ) {
      return undefined;
    }
    const credential = SlackCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(integration.encryptedCredential)));
    return {
      integrationId,
      generation: integration.credentialGeneration,
      appId: integration.externalAppId,
      teamId: integration.externalTeamId,
      botUserId: integration.externalBotId,
      botAccessToken: credential.botAccessToken,
      signingSecret: credential.signingSecret,
      grantedScopes: credential.grantedScopes,
    };
  }

  async listFeishuConnectionIds(afterId: string | undefined, limit = 100): Promise<string[]> {
    const rows = await this.#database
      .select({ integrationId: integrations.id })
      .from(integrations)
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .where(
        and(
          eq(integrations.provider, "feishu"),
          eq(integrations.status, "active"),
          isNull(agents.deletedAt),
          ...(afterId ? [gt(integrations.id, afterId)] : []),
        ),
      )
      .orderBy(asc(integrations.id))
      .limit(limit);
    return rows.map((row) => row.integrationId);
  }

  async getFeishuConnectionMaterial(
    integrationId: string,
    transaction?: DatabaseTransaction,
  ): Promise<FeishuConnectionMaterial | undefined> {
    const integration = await this.#activeMaterial(integrationId, "feishu", transaction);
    if (!integration?.encryptedCredential || !integration.externalAppId || !integration.externalBotId) return undefined;
    const credential = FeishuCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(integration.encryptedCredential)));
    if (credential.appId !== integration.externalAppId)
      throw new Error("Feishu credential identity does not match binding");
    return {
      integrationId,
      generation: integration.credentialGeneration,
      appId: integration.externalAppId,
      teamId: integration.externalTeamId,
      botOpenId: integration.externalBotId,
      teamBrand:
        integration.externalTeamBrand === "lark"
          ? "lark"
          : integration.externalTeamBrand === "feishu"
            ? "feishu"
            : null,
      appSecret: credential.appSecret,
      grantedScopes: credential.grantedScopes,
    };
  }

  async recordDiagnosticError(integrationId: string, code: string): Promise<void> {
    await this.#database
      .update(integrations)
      .set({ lastErrorCode: code.slice(0, 120), updatedAt: this.#now() })
      .where(eq(integrations.id, integrationId));
  }

  async getForAgent(callerUserId: string, agentId: string): Promise<IntegrationSummary | undefined> {
    await this.assertCanManage(callerUserId, agentId);
    const [row] = await this.#database
      .select({
        integration: {
          id: integrations.id,
          agentId: integrations.agentId,
          provider: integrations.provider,
          status: integrations.status,
          externalAppId: integrations.externalAppId,
          externalTeamId: integrations.externalTeamId,
          externalEnterpriseId: integrations.externalEnterpriseId,
          externalBotId: integrations.externalBotId,
          externalTeamBrand: integrations.externalTeamBrand,
          credentialGeneration: integrations.credentialGeneration,
          grantedCapabilities: integrations.grantedCapabilities,
          disabledAt: integrations.disabledAt,
          createdAt: integrations.createdAt,
          updatedAt: integrations.updatedAt,
        },
        receiveMode: agents.receiveMode,
      })
      .from(integrations)
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .where(and(eq(integrations.agentId, agentId), ne(integrations.status, "disabled")))
      .limit(1);
    if (!row?.integration.externalAppId || !row.integration.externalBotId || row.integration.credentialGeneration < 1) {
      return undefined;
    }
    const activity = await this.#activity(row.integration.id);
    return {
      integration: {
        id: row.integration.id,
        agentId: row.integration.agentId,
        provider: row.integration.provider,
        status: row.integration.status,
        disabledAt: row.integration.disabledAt?.toISOString() ?? null,
        createdAt: row.integration.createdAt.toISOString(),
        updatedAt: row.integration.updatedAt.toISOString(),
      },
      identity:
        row.integration.provider === "feishu"
          ? {
              provider: "feishu",
              appId: row.integration.externalAppId,
              teamId: row.integration.externalTeamId,
              botOpenId: row.integration.externalBotId,
              teamBrand: row.integration.externalTeamBrand,
            }
          : {
              provider: "slack",
              appId: row.integration.externalAppId,
              teamId: row.integration.externalTeamId ?? "",
              enterpriseId: row.integration.externalEnterpriseId,
              botUserId: row.integration.externalBotId,
            },
      receiveMode: row.receiveMode,
      credentialGeneration: row.integration.credentialGeneration,
      grantedCapabilities: row.integration.grantedCapabilities,
      reauthorizationRequired: row.integration.status === "reauthorization_required",
      ...activity,
    };
  }

  async disable(callerUserId: string, integrationId: string): Promise<void> {
    const [integration] = await this.#database
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1);
    if (!integration) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The Integration was not found");
    await this.assertCanManage(callerUserId, integration.agentId);
    await this.#disable(integrationId);
  }

  async diagnostics(callerUserId: string, integrationId: string): Promise<IntegrationDiagnostics> {
    const [integration] = await this.#database
      .select({
        id: integrations.id,
        agentId: integrations.agentId,
        provider: integrations.provider,
        status: integrations.status,
        credentialGeneration: integrations.credentialGeneration,
        connectionLeaseExpiresAt: integrations.connectionLeaseExpiresAt,
        observedConnectedAt: integrations.observedConnectedAt,
        observedAt: integrations.observedAt,
        lastErrorCode: integrations.lastErrorCode,
      })
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1);
    if (!integration) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The Integration was not found");
    await this.assertCanManage(callerUserId, integration.agentId);
    const now = this.#now();
    const runtimeToolAvailable = await this.#runtimeReady(integration.agentId);
    const activity = await this.#activity(integrationId);
    const connection =
      integration.provider === "feishu" && integration.observedAt
        ? {
            state:
              integration.connectionLeaseExpiresAt &&
              integration.connectionLeaseExpiresAt > now &&
              integration.observedConnectedAt
                ? ("connected" as const)
                : ("disconnected" as const),
            observedAt: integration.observedAt.toISOString(),
          }
        : null;
    return {
      integrationId,
      provider: integration.provider,
      ready:
        integration.status === "active" &&
        runtimeToolAvailable &&
        (integration.provider === "slack" || connection?.state === "connected"),
      runtimeToolAvailable,
      credentialGeneration: Math.max(1, integration.credentialGeneration),
      reauthorizationRequired: integration.status === "reauthorization_required",
      connection,
      ...activity,
      lastErrorCode: integration.lastErrorCode,
    };
  }

  async requireReauthorization(integrationId: string, errorCode: string): Promise<void> {
    await this.#database
      .update(integrations)
      .set({ status: "reauthorization_required", lastErrorCode: errorCode.slice(0, 120), updatedAt: this.#now() })
      .where(and(eq(integrations.id, integrationId), ne(integrations.status, "disabled")));
  }

  async disableFromProvider(integrationId: string): Promise<void> {
    await this.#disable(integrationId);
  }

  async assertCanManage(callerUserId: string, agentId: string): Promise<void> {
    const [scope] = await this.#database
      .select({ managerUserId: agents.managerUserId, role: memberships.role })
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
      .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
      .limit(1);
    if (!scope) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The Agent was not found");
    if (scope.managerUserId !== callerUserId && scope.role !== "admin") {
      throw new IntegrationServiceError("INTEGRATION_FORBIDDEN", 403, "The caller cannot manage this Integration");
    }
  }

  async #activate(
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
      credential: z.infer<typeof FeishuCredentialSchema> | z.infer<typeof SlackCredentialSchema>;
    },
    existingTransaction?: DatabaseTransaction,
  ): Promise<string> {
    const encryptedCredential = this.#cipher.encrypt(JSON.stringify(input.credential));
    const activate = async (transaction: DatabaseTransaction): Promise<string> => {
      const [agent] = await transaction
        .select({ id: agents.id, receiveMode: agents.receiveMode })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
        .limit(1)
        .for("update");
      if (!agent) throw new IntegrationServiceError("AGENT_NOT_FOUND", 404, "The Agent was not found");
      const [current] = await transaction
        .select()
        .from(integrations)
        .where(and(eq(integrations.agentId, input.agentId), ne(integrations.status, "disabled")))
        .limit(1)
        .for("update");
      if (current && current.provider !== input.provider) {
        throw new IntegrationServiceError(
          "INTEGRATION_PROVIDER_IMMUTABLE",
          409,
          "The Agent already has a different IM provider",
        );
      }
      const requiredCapabilities =
        input.provider === "feishu"
          ? ["im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly"]
          : ["chat:write", "app_mentions:read", "im:history"];
      if (agent.receiveMode === "all_message") {
        requiredCapabilities.push(
          ...(input.provider === "feishu"
            ? ["im:message.group_msg"]
            : ["channels:history", "groups:history", "mpim:history"]),
        );
      }
      const missing = requiredCapabilities.filter((capability) => !input.credential.grantedScopes.includes(capability));
      if (missing.length > 0) {
        throw new IntegrationServiceError(
          "INTEGRATION_SCOPE_REAUTH_REQUIRED",
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
      const sameIdentity =
        current?.externalAppId === activationInput.identity.appId &&
        current.externalTeamId === activationInput.identity.teamId &&
        current.externalBotId === activationInput.identity.botId;
      if (current && current.status !== "provisioning" && !sameIdentity) {
        await this.#disableInTransaction(transaction, current.id, now);
        const [created] = await transaction
          .insert(integrations)
          .values(this.#activeValues(activationInput, encryptedCredential, 1, now))
          .returning({ id: integrations.id });
        if (!created) throw new Error("Replacement Integration insert did not return an id");
        await transaction
          .update(integrations)
          .set({ replacementIntegrationId: created.id })
          .where(eq(integrations.id, current.id));
        return created.id;
      }
      if (current) {
        await transaction
          .update(integrations)
          .set({
            ...this.#activeValues(activationInput, encryptedCredential, current.credentialGeneration + 1, now),
            setupAttemptId: current.setupAttemptId,
            setupIntent: current.setupIntent,
            setupState: current.setupState,
            setupOwnerInstanceId: current.setupOwnerInstanceId,
            setupOwnerHeartbeatAt: current.setupOwnerHeartbeatAt,
            encryptedSetupContext: current.encryptedSetupContext,
            setupExpiresAt: current.setupExpiresAt,
          })
          .where(eq(integrations.id, current.id));
        return current.id;
      }
      const [created] = await transaction
        .insert(integrations)
        .values(this.#activeValues(activationInput, encryptedCredential, 1, now))
        .returning({ id: integrations.id });
      if (!created) throw new Error("Integration insert did not return an id");
      return created.id;
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
      disabledAt: null,
      lastErrorCode: null,
      updatedAt: now,
    };
  }

  async #activeMaterial(
    integrationId: string,
    provider: "feishu" | "slack",
    transaction?: DatabaseTransaction,
  ): Promise<typeof integrations.$inferSelect | undefined> {
    const source = transaction ?? this.#database;
    const [row] = await source
      .select({ integration: integrations })
      .from(integrations)
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .where(
        and(
          eq(integrations.id, integrationId),
          eq(integrations.provider, provider),
          eq(integrations.status, "active"),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    return row?.integration;
  }

  async #disable(integrationId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      await this.#disableInTransaction(transaction, integrationId, this.#now());
    });
  }

  async #disableInTransaction(transaction: DatabaseTransaction, integrationId: string, now: Date): Promise<void> {
    await transaction
      .update(integrations)
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
      .where(and(eq(integrations.id, integrationId), ne(integrations.status, "disabled")));
    await transaction
      .update(sessions)
      .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
      .where(and(eq(sessions.integrationId, integrationId), isNull(sessions.endedAt)));
  }

  async #activity(integrationId: string): Promise<{ lastInboundAt: string | null; lastOutboundAt: string | null }> {
    const [inbound] = await this.#database
      .select({ at: imMessages.receivedAt })
      .from(imMessages)
      .where(and(eq(imMessages.integrationId, integrationId), eq(imMessages.direction, "inbound")))
      .orderBy(desc(imMessages.receivedAt))
      .limit(1);
    const [outbound] = await this.#database
      .select({ at: imOutboundRequests.completedAt })
      .from(imOutboundRequests)
      .innerJoin(sessions, eq(sessions.id, imOutboundRequests.sessionId))
      .where(and(eq(sessions.integrationId, integrationId), eq(imOutboundRequests.state, "succeeded")))
      .orderBy(desc(imOutboundRequests.completedAt))
      .limit(1);
    return {
      lastInboundAt: inbound?.at.toISOString() ?? null,
      lastOutboundAt: outbound?.at?.toISOString() ?? null,
    };
  }
}
