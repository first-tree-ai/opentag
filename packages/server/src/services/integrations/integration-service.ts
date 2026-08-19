import type { IntegrationDiagnostics, IntegrationSummary, SlackBindingActivation } from "@opentag/shared";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  feishuConnectionLeases,
  feishuIntegrationIdentities,
  imConversations,
  integrationCredentials,
  integrations,
  memberships,
  sessions,
  slackIntegrationIdentities,
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
  tenantKey: string | null;
  botOpenId: string;
  tenantBrand?: string;
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
  tenantKey: string | null;
  botOpenId: string;
  tenantBrand: "feishu" | "lark" | null;
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
    return this.#activate(
      input.agentId,
      "slack",
      credential,
      async (transaction, integrationId, replacing) => {
        if (replacing) {
          await transaction
            .delete(slackIntegrationIdentities)
            .where(eq(slackIntegrationIdentities.integrationId, integrationId));
        }
        await transaction.insert(slackIntegrationIdentities).values({
          integrationId,
          appId: input.appId,
          teamId: input.teamId,
          enterpriseId: input.enterpriseId ?? null,
          botUserId: input.botUserId,
        });
      },
      async (transaction, integrationId) => {
        const [identity] = await transaction
          .select()
          .from(slackIntegrationIdentities)
          .where(eq(slackIntegrationIdentities.integrationId, integrationId))
          .limit(1);
        return (
          !identity ||
          identity.appId !== input.appId ||
          identity.teamId !== input.teamId ||
          identity.botUserId !== input.botUserId
        );
      },
    );
  }

  async activateFeishu(input: VerifiedFeishuBinding, transaction?: DatabaseTransaction): Promise<string> {
    const credential = FeishuCredentialSchema.parse({
      appId: input.appId,
      appSecret: input.appSecret,
      grantedScopes: [...new Set(input.grantedScopes)].sort(),
    });
    return this.#activate(
      input.agentId,
      "feishu",
      credential,
      async (transaction, integrationId, replacing) => {
        if (replacing) {
          await transaction
            .delete(feishuIntegrationIdentities)
            .where(eq(feishuIntegrationIdentities.integrationId, integrationId));
        }
        await transaction.insert(feishuIntegrationIdentities).values({
          integrationId,
          appId: input.appId,
          tenantKey: input.tenantKey,
          botOpenId: input.botOpenId,
          tenantBrand: input.tenantBrand ?? null,
        });
      },
      async (transaction, integrationId) => {
        const [identity] = await transaction
          .select()
          .from(feishuIntegrationIdentities)
          .where(eq(feishuIntegrationIdentities.integrationId, integrationId))
          .limit(1);
        return (
          !identity ||
          identity.appId !== input.appId ||
          identity.botOpenId !== input.botOpenId ||
          (identity.tenantKey !== null && input.tenantKey !== null && identity.tenantKey !== input.tenantKey)
        );
      },
      transaction,
    );
  }

  async findSlackIngressBinding(appId: string, teamId: string): Promise<SlackIngressBinding | undefined> {
    const [row] = await this.#database
      .select({ identity: slackIntegrationIdentities, credential: integrationCredentials })
      .from(slackIntegrationIdentities)
      .innerJoin(integrations, eq(integrations.id, slackIntegrationIdentities.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
      .where(
        and(
          eq(slackIntegrationIdentities.appId, appId),
          eq(slackIntegrationIdentities.teamId, teamId),
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    const credential = SlackCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(row.credential.encryptedPayload)));
    return {
      integrationId: row.identity.integrationId,
      generation: row.credential.generation,
      appId: row.identity.appId,
      teamId: row.identity.teamId,
      botUserId: row.identity.botUserId,
      botAccessToken: credential.botAccessToken,
      signingSecret: credential.signingSecret,
    };
  }

  async getSlackConnectionMaterial(integrationId: string): Promise<SlackConnectionMaterial | undefined> {
    const [row] = await this.#database
      .select({ identity: slackIntegrationIdentities, credential: integrationCredentials })
      .from(slackIntegrationIdentities)
      .innerJoin(integrations, eq(integrations.id, slackIntegrationIdentities.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
      .where(
        and(
          eq(slackIntegrationIdentities.integrationId, integrationId),
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
          eq(integrations.reauthorizationRequired, false),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    const credential = SlackCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(row.credential.encryptedPayload)));
    return {
      integrationId,
      generation: row.credential.generation,
      appId: row.identity.appId,
      teamId: row.identity.teamId,
      botUserId: row.identity.botUserId,
      botAccessToken: credential.botAccessToken,
      signingSecret: credential.signingSecret,
      grantedScopes: credential.grantedScopes,
    };
  }

  async listFeishuConnectionIds(limit = 20): Promise<string[]> {
    const rows = await this.#database
      .select({ integrationId: feishuIntegrationIdentities.integrationId })
      .from(feishuIntegrationIdentities)
      .innerJoin(integrations, eq(integrations.id, feishuIntegrationIdentities.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .where(
        and(
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
          eq(integrations.reauthorizationRequired, false),
          sql`${integrations.readyAt} is not null`,
        ),
      )
      .limit(limit);
    return rows.map((row) => row.integrationId);
  }

  async getFeishuConnectionMaterial(
    integrationId: string,
    transaction?: DatabaseTransaction,
  ): Promise<FeishuConnectionMaterial | undefined> {
    const source = transaction ?? this.#database;
    const [row] = await source
      .select({ identity: feishuIntegrationIdentities, credential: integrationCredentials })
      .from(feishuIntegrationIdentities)
      .innerJoin(integrations, eq(integrations.id, feishuIntegrationIdentities.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
      .where(
        and(
          eq(feishuIntegrationIdentities.integrationId, integrationId),
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
          eq(integrations.reauthorizationRequired, false),
        ),
      )
      .limit(1);
    if (!row) return undefined;
    const credential = FeishuCredentialSchema.parse(JSON.parse(this.#cipher.decrypt(row.credential.encryptedPayload)));
    if (credential.appId !== row.identity.appId) throw new Error("Feishu credential identity does not match binding");
    return {
      integrationId,
      generation: row.credential.generation,
      appId: row.identity.appId,
      tenantKey: row.identity.tenantKey,
      botOpenId: row.identity.botOpenId,
      tenantBrand:
        row.identity.tenantBrand === "lark" ? "lark" : row.identity.tenantBrand === "feishu" ? "feishu" : null,
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
      .select({ integration: integrations, credential: integrationCredentials, agent: agents })
      .from(integrations)
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
      .where(eq(integrations.agentId, agentId))
      .limit(1);
    if (!row) return undefined;
    const identity =
      row.integration.provider === "feishu"
        ? await this.#database
            .select()
            .from(feishuIntegrationIdentities)
            .where(eq(feishuIntegrationIdentities.integrationId, row.integration.id))
            .limit(1)
        : await this.#database
            .select()
            .from(slackIntegrationIdentities)
            .where(eq(slackIntegrationIdentities.integrationId, row.integration.id))
            .limit(1);
    const providerIdentity = identity[0];
    if (!providerIdentity) throw new Error("Integration identity is missing");
    return {
      integration: {
        id: row.integration.id,
        agentId: row.integration.agentId,
        provider: row.integration.provider,
        disabledAt: row.integration.disabledAt?.toISOString() ?? null,
        createdAt: row.integration.createdAt.toISOString(),
        updatedAt: row.integration.updatedAt.toISOString(),
      },
      identity:
        row.integration.provider === "feishu"
          ? {
              provider: "feishu",
              appId: (providerIdentity as typeof feishuIntegrationIdentities.$inferSelect).appId,
              tenantKey: (providerIdentity as typeof feishuIntegrationIdentities.$inferSelect).tenantKey,
              botOpenId: (providerIdentity as typeof feishuIntegrationIdentities.$inferSelect).botOpenId,
              tenantBrand: (providerIdentity as typeof feishuIntegrationIdentities.$inferSelect).tenantBrand,
            }
          : {
              provider: "slack",
              appId: (providerIdentity as typeof slackIntegrationIdentities.$inferSelect).appId,
              teamId: (providerIdentity as typeof slackIntegrationIdentities.$inferSelect).teamId,
              enterpriseId: (providerIdentity as typeof slackIntegrationIdentities.$inferSelect).enterpriseId,
              botUserId: (providerIdentity as typeof slackIntegrationIdentities.$inferSelect).botUserId,
            },
      receiveMode: row.agent.receiveMode,
      credentialGeneration: row.credential.generation,
      grantedCapabilities: row.credential.grantedCapabilities,
      reauthorizationRequired: row.integration.reauthorizationRequired,
      lastInboundAt: row.integration.lastInboundAt?.toISOString() ?? null,
      lastOutboundAt: row.integration.lastOutboundAt?.toISOString() ?? null,
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
    await this.#database.transaction(async (transaction) => {
      const now = this.#now();
      await transaction
        .update(integrations)
        .set({ disabledAt: now, updatedAt: now })
        .where(and(eq(integrations.id, integrationId), isNull(integrations.disabledAt)));
      await this.#detachConversations(transaction, integrationId, now);
    });
  }

  async diagnostics(callerUserId: string, integrationId: string): Promise<IntegrationDiagnostics> {
    const [integration] = await this.#database
      .select()
      .from(integrations)
      .where(eq(integrations.id, integrationId))
      .limit(1);
    if (!integration) throw new IntegrationServiceError("INTEGRATION_NOT_FOUND", 404, "The Integration was not found");
    await this.assertCanManage(callerUserId, integration.agentId);
    const [credential] = await this.#database
      .select({ generation: integrationCredentials.generation })
      .from(integrationCredentials)
      .where(eq(integrationCredentials.integrationId, integrationId))
      .limit(1);
    if (!credential) throw new Error("Integration credential is missing");
    const [lease] =
      integration.provider === "feishu"
        ? await this.#database
            .select()
            .from(feishuConnectionLeases)
            .where(eq(feishuConnectionLeases.integrationId, integrationId))
            .limit(1)
        : [];
    const now = this.#now();
    const runtimeToolAvailable = await this.#runtimeReady(integration.agentId);
    return {
      integrationId,
      provider: integration.provider,
      ready:
        integration.readyAt !== null &&
        integration.disabledAt === null &&
        !integration.reauthorizationRequired &&
        runtimeToolAvailable,
      runtimeToolAvailable,
      credentialGeneration: credential.generation,
      reauthorizationRequired: integration.reauthorizationRequired,
      connection:
        integration.provider === "feishu" && lease
          ? {
              state: lease.expiresAt > now && lease.observedConnectedAt ? "connected" : "disconnected",
              observedAt: lease.observedAt.toISOString(),
            }
          : null,
      lastInboundAt: integration.lastInboundAt?.toISOString() ?? null,
      lastOutboundAt: integration.lastOutboundAt?.toISOString() ?? null,
      lastErrorCode: integration.lastErrorCode,
    };
  }

  async requireReauthorization(integrationId: string, errorCode: string): Promise<void> {
    await this.#database
      .update(integrations)
      .set({ reauthorizationRequired: true, lastErrorCode: errorCode, updatedAt: this.#now() })
      .where(eq(integrations.id, integrationId));
  }

  async disableFromProvider(integrationId: string): Promise<void> {
    await this.#database.transaction(async (transaction) => {
      const now = this.#now();
      await transaction
        .update(integrations)
        .set({ disabledAt: now, updatedAt: now })
        .where(and(eq(integrations.id, integrationId), isNull(integrations.disabledAt)));
      await this.#detachConversations(transaction, integrationId, now);
    });
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
    agentId: string,
    provider: "feishu" | "slack",
    credential: z.infer<typeof FeishuCredentialSchema> | z.infer<typeof SlackCredentialSchema>,
    writeIdentity: (transaction: DatabaseTransaction, integrationId: string, replacing: boolean) => Promise<void>,
    identityChanged: (transaction: DatabaseTransaction, integrationId: string) => Promise<boolean>,
    existingTransaction?: DatabaseTransaction,
  ): Promise<string> {
    const encryptedPayload = this.#cipher.encrypt(JSON.stringify(credential));
    const activate = async (transaction: DatabaseTransaction): Promise<string> => {
      const [agent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
        .limit(1)
        .for("update");
      if (!agent) throw new IntegrationServiceError("AGENT_NOT_FOUND", 404, "The Agent was not found");
      const [existing] = await transaction
        .select()
        .from(integrations)
        .where(eq(integrations.agentId, agentId))
        .limit(1)
        .for("update");
      if (existing && existing.provider !== provider) {
        throw new IntegrationServiceError(
          "INTEGRATION_PROVIDER_IMMUTABLE",
          409,
          "The Agent already has a different IM provider",
        );
      }
      const now = this.#now();
      const requiredCapabilities =
        provider === "feishu"
          ? ["im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly"]
          : ["chat:write", "app_mentions:read", "im:history"];
      if (provider === "feishu" && (await this.#agentReceiveMode(transaction, agentId)) === "all_message") {
        requiredCapabilities.push("im:message.group_msg");
      }
      if (provider === "slack" && (await this.#agentReceiveMode(transaction, agentId)) === "all_message") {
        requiredCapabilities.push("channels:history", "groups:history", "mpim:history");
      }
      const missing = requiredCapabilities.filter((capability) => !credential.grantedScopes.includes(capability));
      if (missing.length > 0) {
        throw new IntegrationServiceError(
          "INTEGRATION_SCOPE_REAUTH_REQUIRED",
          409,
          `The provider grant is missing required capabilities: ${missing.join(", ")}`,
        );
      }
      const integrationId =
        existing?.id ??
        (
          await transaction
            .insert(integrations)
            .values({ agentId, provider, readyAt: now, createdAt: now, updatedAt: now })
            .returning({ id: integrations.id })
        )[0]?.id;
      if (!integrationId) throw new Error("Integration insert did not return an id");
      const replacing = existing ? await identityChanged(transaction, integrationId) : false;
      if (existing && replacing) await writeIdentity(transaction, integrationId, true);
      if (replacing) await this.#detachConversations(transaction, integrationId, now);
      if (existing) {
        await transaction
          .update(integrations)
          .set({ readyAt: now, disabledAt: null, reauthorizationRequired: false, lastErrorCode: null, updatedAt: now })
          .where(eq(integrations.id, integrationId));
        await transaction
          .update(integrationCredentials)
          .set({
            schemaVersion: 1,
            generation: sql`${integrationCredentials.generation} + 1`,
            encryptedPayload,
            grantedCapabilities: credential.grantedScopes,
            updatedAt: now,
          })
          .where(eq(integrationCredentials.integrationId, integrationId));
      } else {
        await writeIdentity(transaction, integrationId, false);
        await transaction.insert(integrationCredentials).values({
          integrationId,
          schemaVersion: 1,
          generation: 1,
          encryptedPayload,
          grantedCapabilities: credential.grantedScopes,
          updatedAt: now,
        });
      }
      return integrationId;
    };
    return existingTransaction ? activate(existingTransaction) : this.#database.transaction(activate);
  }

  async #detachConversations(transaction: DatabaseTransaction, integrationId: string, now: Date): Promise<void> {
    const conversationRows = await transaction
      .update(imConversations)
      .set({ detachedAt: now })
      .where(and(eq(imConversations.integrationId, integrationId), isNull(imConversations.detachedAt)))
      .returning({ id: imConversations.id });
    const conversationIds = conversationRows.map((row) => row.id);
    if (conversationIds.length === 0) return;
    await transaction
      .update(sessions)
      .set({ endedAt: now, revision: sql`${sessions.revision} + 1` })
      .where(and(or(...conversationIds.map((id) => eq(sessions.conversationId, id))), isNull(sessions.endedAt)));
  }

  async #agentReceiveMode(transaction: DatabaseTransaction, agentId: string): Promise<"all_message" | "mention_only"> {
    const [agent] = await transaction
      .select({ receiveMode: agents.receiveMode })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent) throw new IntegrationServiceError("AGENT_NOT_FOUND", 404, "The Agent was not found");
    return agent.receiveMode;
  }
}
