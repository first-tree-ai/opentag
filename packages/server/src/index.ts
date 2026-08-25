import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProviderReadinessStatus } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { isHostedEnvironment, parseServerConfig, serverEnvironmentSummary } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { agents } from "./db/schema/index.js";
import { createServerDiagnosticReporter, initTelemetry, shutdownTelemetry } from "./observability/index.js";
import { stopAgentSessions } from "./runtime/agent-session-stopper.js";
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
import { ImMessageInbox, ImResourceService } from "./services/im/index.js";
import {
  DefaultFeishuRegistrationGateway,
  FeishuConnectionManager,
  FeishuSetupService,
} from "./services/im-bindings/feishu/index.js";
import { createImProviderAdapterResolver, ImBindingService } from "./services/im-bindings/index.js";
import { DefaultSlackApiClient, SlackAdapter, SlackSetupService } from "./services/im-bindings/slack/index.js";
import { InvitationService } from "./services/invitations/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "./services/runtime-config/index.js";
import { SessionCollaborationService, SessionService } from "./services/sessions/index.js";
import { TeamMembershipService, TeamSetupService } from "./services/teams/index.js";
import { defaultWebAppRoot } from "./web-app.js";

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
export {
  SessionCollaborationService,
  type SessionCollaborationServiceOptions,
  SessionService,
} from "./services/sessions/index.js";

export async function startServer(): Promise<void> {
  const readiness = new BootstrapReadiness();
  let app: ReturnType<typeof createApp> | undefined;
  const knownSecrets: string[] = [];
  const reportDiagnostic = createServerDiagnosticReporter(() => app?.log);

  try {
    knownSecrets.push(
      process.env.OPENTAG_DATABASE_URL ?? "",
      process.env.OPENTAG_JWT_SECRET ?? "",
      process.env.OPENTAG_GOOGLE_CLIENT_SECRET ?? "",
      process.env.OPENTAG_ENCRYPTION_KEY ?? "",
      process.env.OPENTAG_OTEL_HEADERS ?? "",
    );
    const config = parseServerConfig(process.env);
    const instanceId = randomUUID();
    await initTelemetry(config.observability.tracing, instanceId);
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
    const registry = new ConnectionRegistry();
    const computerService = new ComputerService(database, authService, { providerReadiness: registry });
    const teamService = new TeamMembershipService(database, { providerReadiness: registry });
    const applicationCipher = new ApplicationCipher(config.encryptionKey);
    const invitationService = new InvitationService(database, teamService, applicationCipher, config.publicUrl);
    const agentRuntimeReadinessForAgent = async (agentId: string): Promise<ProviderReadinessStatus> => {
      const [agent] = await database
        .select({ computerId: agents.computerId, runtimeProvider: agents.runtimeProvider })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);
      const currentInstanceId = agent ? registry.currentInstanceId(agent.computerId) : undefined;
      if (!agent || !currentInstanceId) return "unavailable";
      return (
        registry
          .providerReadiness(agent.computerId)
          .find(({ observation }) => observation.provider === agent.runtimeProvider)?.observation.status ?? "checking"
      );
    };
    const runtimeReadyForAgent = async (agentId: string): Promise<boolean> =>
      (await agentRuntimeReadinessForAgent(agentId)) === "ready";
    const imBindingService = new ImBindingService(database, applicationCipher, {
      agentRuntimeReadiness: agentRuntimeReadinessForAgent,
      imCliReadiness: async (agentId, provider) => {
        const computerId = await imBindingService.getAgentComputerId(agentId);
        if (!computerId) return "unavailable";
        const observations = registry.imCliReadiness(computerId);
        return (
          observations.find(({ observation }) => observation.provider === provider)?.observation.status ?? "checking"
        );
      },
    });
    const teamSetupService = new TeamSetupService(database, teamService, imBindingService);
    const imMessageInbox = new ImMessageInbox(database);
    const sessionService = new SessionService(database);
    const runtimeSnapshotAssembler = new EffectiveRuntimeSnapshotAssembler(database);
    let sessionCollaborationService: SessionCollaborationService;
    const domainOwner = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(database), {
      onImCredentialGrant: (request, context) =>
        imBindingService.issueRuntimeCredentialGrant(request, context.computerId),
      onLocalSessionMessageDeliveryResult: (result, context) =>
        sessionCollaborationService.handleLocalDeliveryResult(result, context),
      onSessionCollaborationCommand: (request, context) => sessionCollaborationService.handle(request, context),
    });
    sessionCollaborationService = new SessionCollaborationService({
      assembler: runtimeSnapshotAssembler,
      domain: domainOwner,
      onDiagnostic: reportDiagnostic,
      registry,
      sessions: sessionService,
    });
    const agentService = new AgentService(database, {
      membershipService: teamService,
      onDiagnostic: (code) => app?.log.error({ code }, "Agent lifecycle diagnostic"),
      stopSessions: (targets) =>
        stopAgentSessions(database, targets, {
          currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
          requestReconcile: (computerId, instanceId, request, onDispatched) =>
            domainOwner.requestReconcile(computerId, instanceId, request, onDispatched),
        }),
    });
    const feishuConnections = new FeishuConnectionManager({
      database,
      inbox: imMessageInbox,
      instanceId,
      imBindings: imBindingService,
      runtimeReady: runtimeReadyForAgent,
      onDiagnostic: reportDiagnostic,
    });
    const feishuSetupService = new FeishuSetupService({
      database,
      cipher: applicationCipher,
      instanceId,
      imBindings: imBindingService,
      registrations: new DefaultFeishuRegistrationGateway(),
      activation: feishuConnections,
      onDiagnostic: reportDiagnostic,
    });
    const slackApi = new DefaultSlackApiClient();
    const slackSetupService = new SlackSetupService({
      api: slackApi,
      cipher: applicationCipher,
      database,
      imBindings: imBindingService,
      instanceId,
      publicOrigin: config.publicUrl,
    });
    const resolveImAdapter = createImProviderAdapterResolver({ imBindings: imBindingService, slackApi });
    const imResourceService = new ImResourceService(database, resolveImAdapter);
    const imDeliveryWorker = new ImDeliveryWorker({
      assembler: runtimeSnapshotAssembler,
      database,
      domain: domainOwner,
      registry,
      onDiagnostic: reportDiagnostic,
    });
    const identityService = new AuthIdentityService(database);
    const postAuthentication = new PostAuthenticationService(database, invitationService, teamService);
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
      webAppRoot: defaultWebAppRoot,
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
      imBindingService,
      feishuSetupService,
      slackSetupService,
      imResourceService,
      readiness,
      runtime: { registry, domainOwner },
      slackEvents: {
        imBindings: imBindingService,
        inbox: imMessageInbox,
        setup: slackSetupService,
        createAdapter: (binding) =>
          new SlackAdapter({
            api: slackApi,
            token: binding.botAccessToken,
            appId: binding.appId,
            teamId: binding.teamId,
            botUserId: binding.botUserId,
            botId: binding.botId,
          }),
      },
      teamService,
      teamSetupService,
    });
    feishuSetupService.start();
    feishuConnections.start();
    imDeliveryWorker.start();
    const closeForSignal = () => {
      void app?.close();
    };
    process.once("SIGINT", closeForSignal);
    process.once("SIGTERM", closeForSignal);
    app.addHook("onClose", async () => {
      process.off("SIGINT", closeForSignal);
      process.off("SIGTERM", closeForSignal);
      imDeliveryWorker.stop();
      await feishuSetupService.stop();
      await feishuConnections.stop();
      await sql.end();
      await shutdownTelemetry();
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
    await shutdownTelemetry();
    process.exitCode = 1;
  }
}

const isProcessEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isProcessEntry) {
  await startServer();
}
