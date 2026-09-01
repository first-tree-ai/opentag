import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { InternalNavigationVisibility, ProviderReadinessStatus } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { createBetterAuth } from "./auth/better-auth.js";
import { BetterAuthSessionTokens } from "./auth/session-tokens.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { isHostedEnvironment, parseServerConfig, serverEnvironmentSummary } from "./config.js";
import { createDatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { agents, computers } from "./db/schema/index.js";
import {
  createBackgroundFailureSupervisor,
  createServerDiagnosticReporter,
  initTelemetry,
  shutdownTelemetry,
} from "./observability/index.js";
import { AgentRuntimeTestOwner } from "./runtime/agent-runtime-test-owner.js";
import { stopAgentSessions } from "./runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "./runtime/connection-registry.js";
import { ImDeliveryWorker } from "./runtime/im-delivery-worker.js";
import { ProviderCliReconcileOwner } from "./runtime/provider-cli-reconcile-owner.js";
import { PostgresRuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "./runtime/runtime-domain-owner.js";
import { PostgresRuntimeDurableWorkStore } from "./runtime/runtime-durable-work-store.js";
import { AgentRuntimeTestService, AgentService } from "./services/agents/index.js";
import {
  AuthService,
  ConnectCodeService,
  DevBrowserAuthService,
  formatStartupError,
  PostAuthenticationService,
} from "./services/auth/index.js";
import { createChannelTargetPoller } from "./services/channel-target/index.js";
import { ComputerService, MachineAuthService } from "./services/computers/index.js";
import { ApplicationCipher } from "./services/crypto.js";
import { ExternalCallPolicy } from "./services/im/external-call-policy.js";
import { ImMessageInbox, ImResourceService } from "./services/im/index.js";
import { FeishuInboundReceiptStore } from "./services/im-bindings/feishu/inbound-receipt-store.js";
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
import { SlackWebhookReceiptStore } from "./services/im-bindings/slack/webhook-receipt-store.js";
import { OnboardingResetService } from "./services/onboarding-reset/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "./services/runtime-config/index.js";
import { SessionCliProofService, SessionCollaborationService, SessionService } from "./services/sessions/index.js";
import { AccountSetupService } from "./services/setup/index.js";
import { TaskService } from "./services/tasks/index.js";
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
export {
  DEFAULT_RUNTIME_DURABLE_WORK_RETENTION_MS,
  DEFAULT_RUNTIME_DURABLE_WORK_TERMINAL_LIMIT,
  PostgresRuntimeDurableWorkStore,
  RuntimeDurableWorkConflictError,
  type RuntimeDurableWorkStoreOptions,
} from "./runtime/runtime-durable-work-store.js";
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

class StagingInternalNavigationVisibilityService {
  #value: InternalNavigationVisibility = { integrations: false, skills: false };

  read(): InternalNavigationVisibility {
    return this.#value;
  }

  update(value: InternalNavigationVisibility): InternalNavigationVisibility {
    this.#value = { ...value };
    return this.#value;
  }
}

export async function startServer(): Promise<void> {
  const readiness = new BootstrapReadiness();
  let app: ReturnType<typeof createApp> | undefined;
  const knownSecrets: string[] = [];
  const reportDiagnostic = createServerDiagnosticReporter(() => app?.log);
  const backgroundFailureSupervisor = createBackgroundFailureSupervisor({
    logger: (payload, message) => app?.log.error(payload, message),
    onEvent: (event) => app?.log.error({ event }, "Background diagnostic event"),
    onCounter: (name, labels) => app?.log.info({ name, ...labels }, "Background failure counter"),
  });

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
    const imCallPolicy = new ExternalCallPolicy({
      allowedHosts: ["slack.com", "files.slack.com", "open.feishu.cn", "open.larksuite.com"],
      maxConcurrency: 16,
      onMetric: (metric) => app?.log.info({ metric }, "IM provider call metric"),
    });
    /*
     * Registration gets its own pool, because it is the one call here that waits on a person.
     *
     * The policy holds a concurrency slot for the whole call, and a registration is open from the
     * moment the QR appears until someone has scanned, signed in and approved — or until the code
     * expires an hour later, since closing a tab cancels nothing. Sharing the pool that carries
     * message delivery would let people standing at a connect screen exhaust it, and ordinary
     * delivery would then queue behind them and time out waiting for capacity.
     *
     * Its concurrency bounds how many people may be mid-connect at once, which is a different
     * quantity from how many requests may be in flight, and deserves its own number.
     */
    const feishuRegistrationPolicy = new ExternalCallPolicy({
      allowedHosts: ["open.feishu.cn", "open.larksuite.com"],
      maxConcurrency: 64,
      onMetric: (metric) => app?.log.info({ metric }, "Feishu registration call metric"),
    });
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
    const channelTargetPoller = createChannelTargetPoller({
      channel: config.environment,
      downloadBaseUrl: config.channelTarget.downloadBaseUrl,
      intervalMs: config.channelTarget.pollIntervalMs,
      logger: {
        info: (bindings: Record<string, unknown>, message: string) => app?.log.info(bindings, message),
        warn: (bindings: Record<string, unknown>, message: string) => app?.log.warn(bindings, message),
      },
    });
    const machineAuthService = new MachineAuthService(database, {
      onCredentialRotated: async (computerId) => {
        await registry.closeComputer(computerId);
      },
    });
    const computerService = new ComputerService(database, authService, { providerReadiness: registry });
    const applicationCipher = new ApplicationCipher(config.encryptionKey);
    const agentRuntimeReadinessForAgent = async (agentId: string): Promise<ProviderReadinessStatus> => {
      const [agent] = await database
        .select({ computerId: computers.id, runtimeProvider: agents.runtimeProvider })
        .from(agents)
        .innerJoin(computers, eq(computers.id, agents.computerId))
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
    let providerCliReconcileOwner: ProviderCliReconcileOwner | undefined;
    const refreshProviderCliReadiness = (agentId: string, computerId: string): void => {
      void providerCliReconcileOwner?.ensureActiveReadiness({ agentId, computerId }).catch(() => {
        reportDiagnostic("PROVIDER_CLI_READINESS_REFRESH_FAILED");
      });
    };
    const imBindingService = new ImBindingService(database, applicationCipher, {
      agentRuntimeReadiness: agentRuntimeReadinessForAgent,
      imCliReadiness: async (agentId, provider, integrationId, credentialGeneration) => {
        const computerId = await imBindingService.getAgentComputerId(agentId);
        if (!computerId) return "unavailable";
        refreshProviderCliReadiness(agentId, computerId);
        const observations = registry.providerCliArtifactReadiness(computerId);
        return (
          observations.find(
            ({ observation }) =>
              observation.agentId === agentId &&
              observation.provider === provider &&
              observation.integrationId === integrationId &&
              observation.credentialGeneration === credentialGeneration,
          )?.observation.status ?? "checking"
        );
      },
      credentialExecutionReadiness: async (agentId, provider, integrationId, credentialGeneration) => {
        const computerId = await imBindingService.getAgentComputerId(agentId);
        if (!computerId) return { status: "unconfirmed" };
        refreshProviderCliReadiness(agentId, computerId);
        const observations = registry.providerCliCredentialReadiness(computerId);
        const observation = observations.find(
          ({ observation }) =>
            observation.agentId === agentId &&
            observation.provider === provider &&
            observation.integrationId === integrationId &&
            observation.credentialGeneration === credentialGeneration,
        )?.observation;
        return observation
          ? { status: observation.status, ...(observation.reason ? { reason: observation.reason } : {}) }
          : { status: "unconfirmed" };
      },
      onActiveBindingChanged: (input) => providerCliReconcileOwner?.onActiveBindingChanged(input),
    });
    const accountSetupService = new AccountSetupService(database, imBindingService);
    const imMessageInbox = new ImMessageInbox(database);
    const feishuInboundReceipts = new FeishuInboundReceiptStore(database, {
      onMetric: (metric) => app?.log.info({ metric }, "Feishu inbound receipt metric"),
    });
    const sessionService = new SessionService(database);
    const taskService = new TaskService(database);
    const runtimeSnapshotAssembler = new EffectiveRuntimeSnapshotAssembler(database);
    const sessionCliProofService = new SessionCliProofService(database, registry, config.encryptionKey);
    const domainOwner = new RuntimeDomainOwner(registry, new PostgresRuntimeCustodyStore(database), {
      onImCredentialGrant: (request, context) => imBindingService.issueRuntimeCredentialGrant(request, context),
      prepareReconcile: (computerId, connectionInstanceId, request) =>
        sessionCliProofService.prepareReconcile(computerId, connectionInstanceId, request),
    });
    const durableWorkStore = new PostgresRuntimeDurableWorkStore(database);
    providerCliReconcileOwner = new ProviderCliReconcileOwner(registry, imBindingService);
    const agentRuntimeTestOwner = new AgentRuntimeTestOwner(registry);
    const sessionCollaborationService = new SessionCollaborationService({
      assembler: runtimeSnapshotAssembler,
      domain: domainOwner,
      onDiagnostic: reportDiagnostic,
      registry,
      sessions: sessionService,
    });
    const agentService = new AgentService(database, {
      onDiagnostic: (code) => app?.log.error({ code }, "Agent lifecycle diagnostic"),
      onProviderCliPlacementChanged: (input) => providerCliReconcileOwner?.onAgentPlacementChanged(input),
      stopSessions: (targets) =>
        stopAgentSessions(database, targets, {
          currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
          requestReconcile: (computerId, instanceId, request, onDispatched) =>
            domainOwner.requestReconcile(computerId, instanceId, request, onDispatched),
        }),
    });
    const agentRuntimeTestService = new AgentRuntimeTestService(agentService, agentRuntimeTestOwner);
    const feishuConnections = new FeishuConnectionManager({
      database,
      inbox: imMessageInbox,
      instanceId,
      imBindings: imBindingService,
      runtimeReady: runtimeReadyForAgent,
      onDiagnostic: reportDiagnostic,
      policy: imCallPolicy,
      supervisor: backgroundFailureSupervisor,
      receipts: feishuInboundReceipts,
    });
    const feishuSetupService = new FeishuSetupService({
      database,
      cipher: applicationCipher,
      instanceId,
      imBindings: imBindingService,
      registrations: new DefaultFeishuRegistrationGateway(undefined, feishuRegistrationPolicy),
      activation: feishuConnections,
      onDiagnostic: reportDiagnostic,
      supervisor: backgroundFailureSupervisor,
    });
    const slackApi = new DefaultSlackApiClient(undefined, undefined, imCallPolicy);
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
    const imResourceService = new ImResourceService(database, resolveImAdapter, imCallPolicy);
    const slackWebhookReceipts = new SlackWebhookReceiptStore(database, {
      onMetric: (metric) => app?.log.info({ metric }, "Slack webhook receipt metric"),
    });
    const imDeliveryWorker = new ImDeliveryWorker({
      assembler: runtimeSnapshotAssembler,
      database,
      domain: domainOwner,
      registry,
      onDiagnostic: reportDiagnostic,
      supervisor: backgroundFailureSupervisor,
    });
    const setupResetService = config.stagingSetupReset
      ? new OnboardingResetService({
          agents: agentService,
          database,
          environment: config.environment,
          registry,
        })
      : undefined;
    const internalNavigationService = new StagingInternalNavigationVisibilityService();
    app = createApp({
      betterAuth: { instance: betterAuth, publicUrl: config.publicUrl },
      webAppRoot: defaultWebAppRoot,
      agentService,
      agentRuntimeTestService,
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
      runtime: {
        registry,
        domainOwner,
        agentRuntimeTestOwner,
        providerCliReconcileOwner,
        channelTarget: () => channelTargetPoller.get(),
      },
      runtimeDurableWork: { machineAuth: machineAuthService, store: durableWorkStore },
      runtimeSessions: {
        collaboration: sessionCollaborationService,
        proofs: sessionCliProofService,
        sessions: sessionService,
      },
      slackEvents: {
        imBindings: imBindingService,
        inbox: imMessageInbox,
        receipts: slackWebhookReceipts,
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
      ...(setupResetService ? { internalNavigationService, setupResetService } : {}),
      accountSetupService,
    });
    feishuSetupService.start();
    feishuConnections.start();
    imDeliveryWorker.start();
    channelTargetPoller.start();
    const closeForSignal = () => {
      void app?.close();
    };
    process.once("SIGINT", closeForSignal);
    process.once("SIGTERM", closeForSignal);
    app.addHook("onClose", async () => {
      process.off("SIGINT", closeForSignal);
      process.off("SIGTERM", closeForSignal);
      channelTargetPoller.stop();
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
