import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { defaultAdminWebRoot } from "./admin-web.js";
import { createApp } from "./app.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { isHostedEnvironment, parseServerConfig, serverEnvironmentSummary } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { agents } from "./db/schema/index.js";
import { ConnectionRegistry } from "./runtime/connection-registry.js";
import { ImDeliveryWorker } from "./runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "./runtime/runtime-domain-owner.js";
import { AgentService } from "./services/agents/index.js";
import {
  AuthIdentityService,
  AuthService,
  AuthTokenService,
  ConnectCodeService,
  DefaultGoogleIdentityClient,
  DevBrowserAuthService,
  formatStartupError,
  GoogleBrowserAuthService,
  OAuthFlowService,
  PostAuthenticationService,
} from "./services/auth/index.js";
import { ComputerService } from "./services/computers/index.js";
import { ApplicationCipher } from "./services/crypto.js";
import { ImMessageInbox, ImResourceService, OutboundMessageService } from "./services/im/index.js";
import {
  DefaultFeishuRegistrationGateway,
  FeishuConnectionManager,
  FeishuSetupService,
} from "./services/integrations/feishu/index.js";
import { createImProviderAdapterResolver, IntegrationService } from "./services/integrations/index.js";
import { DefaultSlackApiClient, SlackAdapter } from "./services/integrations/slack/index.js";
import { InvitationService } from "./services/invitations/index.js";
import { TeamMembershipService } from "./services/teams/index.js";

export { bootstrapInitialAdmin } from "./admin/bootstrap.js";
export { createApp } from "./app.js";
export { BootstrapReadiness } from "./bootstrap-readiness.js";
export {
  type DatabaseConfig,
  isHostedEnvironment,
  parseDatabaseConfig,
  parseServerConfig,
  type ServerConfig,
  serverEnvironmentSummary,
} from "./config.js";
export { createDatabaseClient, type DatabaseClient } from "./db/client.js";
export {
  MigrationVerificationError,
  migrateDatabase,
  verifyDatabaseMigrations,
  withMigrationLock,
} from "./db/migrate.js";
export {
  ConnectionRegistry,
  type RuntimeConnectionEntry,
  RuntimeRegistrySendError,
} from "./runtime/connection-registry.js";
export { PostgresRuntimeCustodyStore, type RuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
export {
  type AcceptedDeliveryRecord,
  type RecordedTurnRecord,
  RuntimeDomainConflictError,
  RuntimeDomainOwner,
  type RuntimeDomainOwnerOptions,
  RuntimeDomainRequestError,
} from "./runtime/runtime-domain-owner.js";
export { AgentService, AgentServiceError } from "./services/agents/index.js";
export { AuthService, AuthServiceError, AuthTokenService } from "./services/auth/index.js";
export { ComputerService } from "./services/computers/index.js";

export async function startServer(): Promise<void> {
  const readiness = new BootstrapReadiness();
  let app: ReturnType<typeof createApp> | undefined;
  const knownSecrets: string[] = [];

  try {
    knownSecrets.push(
      process.env.OPENTAG_DATABASE_URL ?? "",
      process.env.OPENTAG_JWT_SECRET ?? "",
      process.env.OPENTAG_GOOGLE_CLIENT_SECRET ?? "",
      process.env.OPENTAG_ENCRYPTION_KEY ?? "",
    );
    const config = parseServerConfig(process.env);
    readiness.complete("configuration");
    if (config.autoMigrate) {
      await migrateDatabase(config.databaseUrl, config.migrationsDirectory);
    } else {
      await verifyDatabaseMigrations(config.databaseUrl, config.migrationsDirectory);
    }
    readiness.complete("migration");

    const { database, sql } = createDatabaseClient(config.databaseUrl);
    const authService = new AuthService(
      database,
      new AuthTokenService(config.jwtSecret, config.accessTokenTtlSeconds, config.refreshTokenTtlSeconds),
    );
    const connectCodeService = new ConnectCodeService(database);
    const computerService = new ComputerService(database, authService);
    const teamService = new TeamMembershipService(database);
    const agentService = new AgentService(database, { membershipService: teamService });
    const applicationCipher = new ApplicationCipher(config.encryptionKey);
    const invitationService = new InvitationService(database, teamService, applicationCipher, config.publicUrl);
    const registry = new ConnectionRegistry();
    const integrationService = new IntegrationService(database, applicationCipher, {
      runtimeReady: async (agentId) => {
        const [agent] = await database
          .select({ computerId: agents.computerId })
          .from(agents)
          .where(eq(agents.id, agentId))
          .limit(1);
        const currentInstanceId = agent ? registry.currentInstanceId(agent.computerId) : undefined;
        return Boolean(
          agent && currentInstanceId && registry.supports(agent.computerId, currentInstanceId, "imMessageTool"),
        );
      },
    });
    const imMessageInbox = new ImMessageInbox(database);
    const instanceId = randomUUID();
    let outboundMessageService: OutboundMessageService;
    const domainOwner = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(database), {
      onImToolRequest: async (request, context) => {
        const result = await outboundMessageService.execute({
          requestId: request.requestId,
          sessionId: request.sessionId,
          agentId: request.agentId,
          computerId: context.computerId,
          computerInstanceId: context.instanceId,
          placementGeneration: request.placementGeneration,
          expectedLatestImMessageId: request.expectedLatestImMessageId,
          operation: request.operation,
          ...(request.text
            ? {
                content: {
                  version: 1,
                  fallbackText: request.text,
                  blocks: [{ type: "text", text: request.text }],
                  truncated: false,
                },
              }
            : {}),
          ...(request.replyToImMessageId ? { replyToImMessageId: request.replyToImMessageId } : {}),
          ...(request.targetImMessageId ? { targetImMessageId: request.targetImMessageId } : {}),
          ...(request.emoji ? { emoji: request.emoji } : {}),
        });
        return { type: "im:tool:result", requestId: request.requestId, ...result };
      },
    });
    const feishuConnections = new FeishuConnectionManager({
      database,
      inbox: imMessageInbox,
      instanceId,
      integrations: integrationService,
      runtimeReady: async (agentId) => {
        const computerId = await integrationService.getAgentComputerId(agentId);
        const currentInstanceId = computerId ? registry.currentInstanceId(computerId) : undefined;
        return Boolean(
          computerId && currentInstanceId && registry.supports(computerId, currentInstanceId, "imMessageTool"),
        );
      },
    });
    const feishuSetupService = new FeishuSetupService({
      database,
      cipher: applicationCipher,
      instanceId,
      integrations: integrationService,
      registrations: new DefaultFeishuRegistrationGateway(),
      activation: feishuConnections,
    });
    const slackApi = new DefaultSlackApiClient();
    const resolveImAdapter = createImProviderAdapterResolver({ integrations: integrationService, slackApi });
    outboundMessageService = new OutboundMessageService(database, resolveImAdapter);
    const imResourceService = new ImResourceService(database, resolveImAdapter);
    const imDeliveryWorker = new ImDeliveryWorker({
      database,
      domain: domainOwner,
      registry,
      onDiagnostic: (code) => app?.log.error({ code }, "IM delivery worker diagnostic"),
    });
    const identityService = new AuthIdentityService(database);
    const postAuthentication = new PostAuthenticationService(database, invitationService, {
      membershipService: teamService,
    });
    const google = config.google
      ? new GoogleBrowserAuthService({
          database,
          flow: new OAuthFlowService(config.jwtSecret),
          google: new DefaultGoogleIdentityClient(config.google.clientId, config.google.clientSecret),
          identities: identityService,
          postAuthentication,
          publicUrl: config.publicUrl,
          tokenIssuer: authService,
        })
      : undefined;
    const dev = config.devAuth ? new DevBrowserAuthService(database, authService, config.devAuth.email) : undefined;
    app = createApp({
      adminWebRoot: defaultAdminWebRoot,
      agentService,
      authService,
      browserAuth: {
        dev,
        google,
        publicOrigin: config.publicUrl,
        refreshTokenTtlSeconds: config.refreshTokenTtlSeconds,
        secureCookies: isHostedEnvironment(config.environment),
      },
      connectCode: {
        environment: config.environment,
        issuer: connectCodeService,
        publicUrl: config.publicUrl,
      },
      computerService,
      invitationService,
      integrationService,
      feishuSetupService,
      imResourceService,
      readiness,
      runtime: { registry, domainOwner },
      slackEvents: {
        integrations: integrationService,
        inbox: imMessageInbox,
        createAdapter: (binding) =>
          new SlackAdapter({
            api: slackApi,
            token: binding.botAccessToken,
            appId: binding.appId,
            teamId: binding.teamId,
            botUserId: binding.botUserId,
          }),
      },
      teamService,
    });
    feishuSetupService.start();
    feishuConnections.start();
    imDeliveryWorker.start();
    app.addHook("onClose", async () => {
      imDeliveryWorker.stop();
      await feishuSetupService.stop();
      await feishuConnections.stop();
      await sql.end();
    });
    app.log.info(serverEnvironmentSummary(config), "Resolved OpenTag environment");
    readiness.complete("application");
    await app.listen({ host: config.host, port: config.port });
    readiness.complete("listen");
  } catch (error) {
    if (app) {
      app.log.error({ detail: formatStartupError(error, knownSecrets) }, "Failed to start OpenTag server");
      await app.close();
    } else {
      process.stderr.write(`Failed to start OpenTag server: ${formatStartupError(error, knownSecrets)}\n`);
    }
    process.exitCode = 1;
  }
}

const isProcessEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isProcessEntry) {
  await startServer();
}
