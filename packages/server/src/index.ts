import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProviderReadinessStatus } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { createBetterAuth } from "./auth/better-auth.js";
import { BetterAuthSessionTokens } from "./auth/session-tokens.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { isHostedEnvironment, parseServerConfig, serverEnvironmentSummary } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { accountComputers, agents } from "./db/schema/index.js";
import { createServerDiagnosticReporter, initTelemetry, shutdownTelemetry } from "./observability/index.js";
import { stopAgentSessions } from "./runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "./runtime/connection-registry.js";
import { ImDeliveryWorker } from "./runtime/im-delivery-worker.js";
import { PostgresRuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "./runtime/runtime-domain-owner.js";
import { AgentService } from "./services/agents/index.js";
import {
  AuthService,
  ConnectCodeService,
  DevBrowserAuthService,
  formatStartupError,
  PostAuthenticationService,
} from "./services/auth/index.js";
import { ComputerService, MachineAuthService } from "./services/computers/index.js";
import { ApplicationCipher } from "./services/crypto.js";
import { ImMessageInbox, ImResourceService } from "./services/im/index.js";
import {
  DefaultFeishuRegistrationGateway,
  FeishuConnectionManager,
  FeishuSetupService,
} from "./services/im-bindings/feishu/index.js";
import { createImProviderAdapterResolver, ImBindingService } from "./services/im-bindings/index.js";
import {
  DefaultSlackApiClient,
  SlackAdapter,
  SlackConfigurationService,
  SlackOAuthService,
  SlackOAuthStateService,
} from "./services/im-bindings/slack/index.js";
import { OnboardingResetService } from "./services/onboarding-reset/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "./services/runtime-config/index.js";
import { SessionCliProofService, SessionCollaborationService, SessionService } from "./services/sessions/index.js";
import { TaskService } from "./services/tasks/index.js";
import { WorkspaceSetupService } from "./services/workspaces/index.js";
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
export { AuthService, AuthServiceError } from "./services/auth/index.js";
export { ComputerService } from "./services/computers/index.js";
export { OnboardingResetError, OnboardingResetService } from "./services/onboarding-reset/index.js";
export {
  SessionCliProofService,
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
      process.env.BETTER_AUTH_SECRET ?? "",
      process.env.OPENTAG_GOOGLE_CLIENT_SECRET ?? "",
      process.env.OPENTAG_ENCRYPTION_KEY ?? "",
      process.env.OPENTAG_OTEL_HEADERS ?? "",
      process.env.OPENTAG_SLACK_CLIENT_SECRET ?? "",
      process.env.OPENTAG_SLACK_SIGNING_SECRET ?? "",
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
    const postAuthentication = new PostAuthenticationService(database);
    const dev = config.devAuth ? new DevBrowserAuthService(database, config.devAuth.email) : undefined;
    const betterAuth = createBetterAuth(database, {
      onSessionCreating: async (userId) => {
        await postAuthentication.ensureAccountReady(userId);
      },
      publicUrl: config.publicUrl,
      secret: config.betterAuthSecret,
      secureCookies: isHostedEnvironment(config.environment),
      sessionTtlSeconds: config.sessionTtlSeconds,
      ...(dev ? { devSignIn: () => dev.resolveUserId() } : {}),
      ...(config.emailPasswordAuth ? { emailPassword: true } : {}),
      ...(config.google ? { google: config.google } : {}),
    });
    const authService = new AuthService(database, new BetterAuthSessionTokens(betterAuth, database));
    const connectCodeService = new ConnectCodeService(database);
    const registry = new ConnectionRegistry();
    const machineAuthService = new MachineAuthService(database, {
      onCredentialRotated: async (workspaceComputerId) => {
        await registry.closeEnrollment(workspaceComputerId);
      },
    });
    const computerService = new ComputerService(database, authService, { providerReadiness: registry });
    const applicationCipher = new ApplicationCipher(config.encryptionKey);
    const agentRuntimeReadinessForAgent = async (agentId: string): Promise<ProviderReadinessStatus> => {
      const [agent] = await database
        .select({ workspaceComputerId: accountComputers.id, runtimeProvider: agents.runtimeProvider })
        .from(agents)
        .innerJoin(accountComputers, eq(accountComputers.id, agents.computerId))
        .where(eq(agents.id, agentId))
        .limit(1);
      const currentInstanceId = agent ? registry.currentInstanceId(agent.workspaceComputerId) : undefined;
      if (!agent || !currentInstanceId) return "unavailable";
      return (
        registry
          .providerReadiness(agent.workspaceComputerId)
          .find(({ observation }) => observation.provider === agent.runtimeProvider)?.observation.status ?? "checking"
      );
    };
    const runtimeReadyForAgent = async (agentId: string): Promise<boolean> =>
      (await agentRuntimeReadinessForAgent(agentId)) === "ready";
    const imBindingService = new ImBindingService(database, applicationCipher, {
      agentRuntimeReadiness: agentRuntimeReadinessForAgent,
      imCliReadiness: async (agentId, provider) => {
        const workspaceComputerId = await imBindingService.getAgentWorkspaceComputerId(agentId);
        if (!workspaceComputerId) return "unavailable";
        const observations = registry.imCliReadiness(workspaceComputerId);
        return (
          observations.find(({ observation }) => observation.provider === provider)?.observation.status ?? "checking"
        );
      },
    });
    const workspaceSetupService = new WorkspaceSetupService(database, imBindingService);
    const imMessageInbox = new ImMessageInbox(database);
    const sessionService = new SessionService(database);
    const taskService = new TaskService(database);
    const runtimeSnapshotAssembler = new EffectiveRuntimeSnapshotAssembler(database);
    const sessionCliProofService = new SessionCliProofService(database, registry, config.encryptionKey);
    const domainOwner = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(database), {
      onImCredentialGrant: (request, context) => imBindingService.issueRuntimeCredentialGrant(request, context),
      prepareReconcile: (workspaceComputerId, connectionInstanceId, request) =>
        sessionCliProofService.prepareReconcile(workspaceComputerId, connectionInstanceId, request),
    });
    const sessionCollaborationService = new SessionCollaborationService({
      assembler: runtimeSnapshotAssembler,
      domain: domainOwner,
      onDiagnostic: reportDiagnostic,
      registry,
      sessions: sessionService,
    });
    const agentService = new AgentService(database, {
      onDiagnostic: (code) => app?.log.error({ code }, "Agent lifecycle diagnostic"),
      stopSessions: (targets) =>
        stopAgentSessions(database, targets, {
          currentInstanceId: (workspaceComputerId) => registry.currentInstanceId(workspaceComputerId),
          requestReconcile: (workspaceComputerId, instanceId, request, onDispatched) =>
            domainOwner.requestReconcile(workspaceComputerId, instanceId, request, onDispatched),
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
    const slackConfigurationService = new SlackConfigurationService({
      api: slackApi,
      database,
      imBindings: imBindingService,
    });
    const slackOAuthService = config.slackOAuth
      ? new SlackOAuthService({
          api: slackApi,
          app: config.slackOAuth,
          database,
          slack: slackConfigurationService,
          state: new SlackOAuthStateService(config.jwtSecret),
        })
      : undefined;
    const resolveImAdapter = createImProviderAdapterResolver({ imBindings: imBindingService, slackApi });
    const imResourceService = new ImResourceService(database, resolveImAdapter);
    const imDeliveryWorker = new ImDeliveryWorker({
      assembler: runtimeSnapshotAssembler,
      database,
      domain: domainOwner,
      registry,
      onDiagnostic: reportDiagnostic,
    });
    const setupResetService = config.stagingSetupReset
      ? new OnboardingResetService({
          agents: agentService,
          database,
          environment: config.environment,
          registry,
        })
      : undefined;
    app = createApp({
      betterAuth: { instance: betterAuth, publicUrl: config.publicUrl },
      webAppRoot: defaultWebAppRoot,
      agentService,
      authService,
      browserAuth: {
        devSignIn: Boolean(dev),
        googleSignIn: Boolean(config.google),
        passwordSignIn: config.emailPasswordAuth,
        publicOrigin: config.publicUrl,
        secureCookies: isHostedEnvironment(config.environment),
        sessionTtlSeconds: config.sessionTtlSeconds,
      },
      connectCode: {
        environment: config.environment,
        issuer: connectCodeService,
        publicUrl: config.publicUrl,
      },
      computerConnectCode: {
        environment: config.environment,
        publicUrl: config.publicUrl,
      },
      computerService,
      machineAuthService,
      imBindingService,
      feishuSetupService,
      taskService,
      ...(slackOAuthService
        ? {
            slackOAuth: {
              authService,
              publicOrigin: config.publicUrl,
              secureCookies: isHostedEnvironment(config.environment),
              slackOAuth: slackOAuthService,
            },
          }
        : {}),
      imResourceService,
      readiness,
      runtime: { registry, domainOwner },
      runtimeSessions: {
        collaboration: sessionCollaborationService,
        proofs: sessionCliProofService,
        sessions: sessionService,
      },
      slackEvents: {
        imBindings: imBindingService,
        inbox: imMessageInbox,
        ...(config.slackOAuth ? { firstPartySigningSecret: config.slackOAuth.signingSecret } : {}),
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
      ...(setupResetService ? { setupResetService } : {}),
      workspaceSetupService,
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
