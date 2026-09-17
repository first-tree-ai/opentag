import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { InternalNavigationVisibility, ProviderReadinessStatus } from "@opentag/shared";
import { sandboxRunnerWebSocketUrl } from "@opentag/shared";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { createBetterAuth } from "./auth/better-auth.js";
import { BetterAuthSessionTokens } from "./auth/session-tokens.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { isHostedEnvironment, parseServerConfig, type ServerConfig, serverEnvironmentSummary } from "./config.js";
import { createDatabaseClient, type DatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { agents, computers } from "./db/schema/index.js";
import {
  createBackgroundFailureSupervisor,
  createServerDiagnosticReporter,
  createServiceLoggerPort,
  initTelemetry,
  shutdownTelemetry,
} from "./observability/index.js";
import { createPlatformRuntime } from "./platform-runtime.js";
import { AgentRuntimeTestOwner } from "./runtime/agent-runtime-test-owner.js";
import { stopAgentSessions } from "./runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "./runtime/connection-registry.js";
import { ContextTreeOperationOwner } from "./runtime/context-tree-operation-owner.js";
import { ImDeliveryWorker } from "./runtime/im-delivery-worker.js";
import { ProviderCliReconcileOwner } from "./runtime/provider-cli-reconcile-owner.js";
import { PostgresRuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "./runtime/runtime-domain-owner.js";
import { PostgresRuntimeDurableWorkStore } from "./runtime/runtime-durable-work-store.js";
import { ContextTreeOperationService } from "./services/agents/context-tree-operation-service.js";
import { AgentRuntimeTestService, AgentService, AgentSetupService } from "./services/agents/index.js";
import {
  AuthService,
  ConnectCodeService,
  DevBrowserAuthService,
  formatStartupError,
  PostAuthenticationService,
} from "./services/auth/index.js";
import { createChannelTargetPoller } from "./services/channel-target/index.js";
import {
  CloudRunAdmin,
  createMetadataServerTokenProvider,
  createStaticTokenProvider,
} from "./services/cloud-run/index.js";
import { ComputerService, MachineAuthService } from "./services/computers/index.js";
import { ApplicationCipher } from "./services/crypto.js";
import { createGitHubIntegration } from "./services/github/index.js";
import { GitHubCredentialCipher } from "./services/github-credential-material.js";
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
import {
  McpAuthorizationService,
  McpCredentialCipher,
  McpOAuthClient,
  McpOAuthFlowService,
  McpOutboundFetcher,
  McpProbe,
  McpRefreshWorker,
  McpServerService,
} from "./services/mcp/index.js";
import { OnboardingResetService } from "./services/onboarding-reset/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "./services/runtime-config/index.js";
import { SandboxService } from "./services/sandboxes/index.js";
import { RunnerBootstrapTokenService } from "./services/sandboxes/runner-bootstrap-token.js";
import { RunnerHub } from "./services/sandboxes/runner-hub.js";
import { SandboxRunnerService } from "./services/sandboxes/sandbox-runner-service.js";
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
  type ConnectionRegistryOptions,
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
  DEFAULT_RUNTIME_DURABLE_WORK_PAGE_SIZE,
  DEFAULT_RUNTIME_DURABLE_WORK_PAYLOAD_BYTES_LIMIT,
  DEFAULT_RUNTIME_DURABLE_WORK_RECORD_LIMIT,
  DEFAULT_RUNTIME_DURABLE_WORK_RETENTION_MS,
  DEFAULT_RUNTIME_DURABLE_WORK_SINGLE_PAYLOAD_BYTES_LIMIT,
  DEFAULT_RUNTIME_DURABLE_WORK_TERMINAL_LIMIT,
  PostgresRuntimeDurableWorkStore,
  RUNTIME_DURABLE_WORK_ALLOWED_TRANSITIONS,
  RUNTIME_DURABLE_WORK_MAX_PAGE_SIZE,
  RuntimeDurableWorkConflictError,
  RuntimeDurableWorkCursorError,
  type RuntimeDurableWorkListOptions,
  type RuntimeDurableWorkListPage,
  RuntimeDurableWorkPayloadTooLargeError,
  RuntimeDurableWorkQuotaExceededError,
  RuntimeDurableWorkStaleWriteError,
  type RuntimeDurableWorkStoreOptions,
  RuntimeDurableWorkTransitionError,
} from "./runtime/runtime-durable-work-store.js";
export { AgentService, AgentServiceError, AgentSetupService } from "./services/agents/index.js";
export { AuthService, AuthServiceError } from "./services/auth/index.js";
export { ComputerService } from "./services/computers/index.js";
export { OnboardingResetError, OnboardingResetService } from "./services/onboarding-reset/index.js";
export { SandboxService, SandboxServiceError } from "./services/sandboxes/index.js";
export {
  SessionCliProofService,
  SessionCollaborationService,
  type SessionCollaborationServiceOptions,
  SessionService,
} from "./services/sessions/index.js";
export { createPlatformRuntime };

class InternalNavigationVisibilityService {
  #value: InternalNavigationVisibility = { integrations: false, skills: false };

  read(): InternalNavigationVisibility {
    return this.#value;
  }

  update(value: InternalNavigationVisibility): InternalNavigationVisibility {
    this.#value = { ...value };
    return this.#value;
  }
}

/**
 * E3 Cloud Runner wiring: present only when explicitly enabled. Token acquisition is the GCE
 * metadata server in production; the acceptance harness may inject a short-lived static token
 * through the environment. The signing key for bootstrap tokens is the Server's own JWT secret
 * under a dedicated audience; no machine/daemon credential is reused for runners.
 */
function createSandboxRunnerRuntime(
  database: DatabaseClient,
  config: Pick<ServerConfig, "environment" | "jwtSecret" | "cloudRunner" | "cloudIdentities">,
): SandboxRunnerRuntime | undefined {
  const cloudRunner = config.cloudRunner;
  if (!cloudRunner.enabled) return undefined;
  const cloudIdentities = config.cloudIdentities;
  if (!cloudIdentities.enabled) {
    throw new Error("Cloud Runner requires cloud identities (Runner build version) to be enabled");
  }
  const tokenProvider = cloudRunner.staticAccessToken
    ? createStaticTokenProvider(cloudRunner.staticAccessToken)
    : createMetadataServerTokenProvider();
  const cloudAdmin = new CloudRunAdmin(
    {
      project: cloudRunner.project,
      region: cloudRunner.region,
      serviceAccount: cloudRunner.serviceAccount,
      image: cloudRunner.image,
      vpc: cloudRunner.vpc,
      apiTimeoutMs: cloudRunner.apiTimeoutMs,
    },
    { tokenProvider },
  );
  const tokens = new RunnerBootstrapTokenService(config.jwtSecret, {
    ttlSeconds: cloudRunner.bootstrapTokenTtlSeconds,
  });
  const hub = new RunnerHub();
  const sandboxRunnerService = new SandboxRunnerService(database, {
    cloudAdmin,
    tokens,
    hub,
    environment: config.environment,
    backendUrl: sandboxRunnerWebSocketUrl(cloudRunner.backendOrigin),
    expectedRunnerVersion: cloudIdentities.runnerVersion,
    acceptanceTimeoutMs: cloudRunner.acceptanceTimeoutMs,
    createConvergeTimeoutMs: cloudRunner.createConvergeTimeoutMs,
  });
  return { sandboxRunnerService, runnerChannel: { tokens, hub } };
}

interface SandboxRunnerRuntime {
  sandboxRunnerService: SandboxRunnerService;
  runnerChannel: { tokens: RunnerBootstrapTokenService; hub: RunnerHub };
}

/** Only pass the Runner route options when allocation is actually enabled. */
function sandboxRunnerRouteOptions(runtime: SandboxRunnerRuntime | undefined):
  | {
      sandboxRunnerService: SandboxRunnerService;
      runnerChannel: { tokens: RunnerBootstrapTokenService; hub: RunnerHub };
    }
  | Record<string, never> {
  return runtime ? { sandboxRunnerService: runtime.sandboxRunnerService, runnerChannel: runtime.runnerChannel } : {};
}

/*
 * The legacy key always stays configured for v1 reads; the optional ring turns on authenticated
 * v2 envelopes and, when the deployment opted in, v2 IM credential writes.
 */
function createApplicationCipher(config: ServerConfig): ApplicationCipher {
  if (!config.encryptionKeyRing) return new ApplicationCipher(config.encryptionKey);
  return new ApplicationCipher({
    legacyKey: config.encryptionKey,
    keys: config.encryptionKeyRing.keys,
    activeKeyId: config.encryptionKeyRing.activeKeyId,
    writeVersion: config.imCredentialEncryptionWriteVersion,
  });
}

/** Every configured value startup errors must never echo, including the raw key ring JSON. */
function collectKnownSecrets(environment: NodeJS.ProcessEnv): string[] {
  return [
    environment.OPENTAG_DATABASE_URL ?? "",
    environment.OPENTAG_JWT_SECRET ?? "",
    environment.BETTER_AUTH_SECRET ?? "",
    environment.OPENTAG_GOOGLE_CLIENT_SECRET ?? "",
    environment.OPENTAG_ENCRYPTION_KEY ?? "",
    environment.OPENTAG_ENCRYPTION_KEY_RING ?? "",
    environment.OPENTAG_OTEL_HEADERS ?? "",
    environment.OPENTAG_SLACK_CLIENT_SECRET ?? "",
    environment.OPENTAG_SLACK_SIGNING_SECRET ?? "",
    environment.OPENTAG_GITHUB_APP_CLIENT_SECRET ?? "",
    environment.OPENTAG_GITHUB_APP_PRIVATE_KEY ?? "",
    environment.OPENTAG_GITHUB_APP_WEBHOOK_SECRET ?? "",
    // The dev-only static Cloud Runner token is a live Google access token while it is set.
    environment.OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN ?? "",
  ];
}

function cipherKeySecrets(config: ServerConfig): string[] {
  return Array.from(config.encryptionKeyRing?.keys.values() ?? [], (key) => Buffer.from(key).toString("base64"));
}

export async function startServer(): Promise<void> {
  const readiness = new BootstrapReadiness();
  let app: ReturnType<typeof createApp> | undefined;
  const knownSecrets: string[] = collectKnownSecrets(process.env);
  const reportDiagnostic = createServerDiagnosticReporter(() => app?.log);
  const serviceLogger = (module: string) => createServiceLoggerPort(() => app?.log, module);
  const backgroundFailureSupervisor = createBackgroundFailureSupervisor({
    logger: (payload, message) => app?.log.error(payload, message),
    onEvent: (event) => app?.log.error({ event }, "Background diagnostic event"),
    onCounter: (name, labels) => app?.log.info({ name, ...labels }, "Background failure counter"),
  });

  try {
    const config = parseServerConfig(process.env);
    knownSecrets.push(...cipherKeySecrets(config));
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
    const registry = new ConnectionRegistry({ logger: serviceLogger("runtime-registry") });
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
    const cloudIdentities = config.cloudIdentities;

    const applicationCipher = createApplicationCipher(config);
    /*
     * The GitHub management plane exists only when the deployment App is coherently configured;
     * the routes are registered either way so the UI reads explicit availability instead of a 404.
     */
    const github = config.githubApp
      ? createGitHubIntegration({
          database,
          config: config.githubApp,
          cipher: new GitHubCredentialCipher(applicationCipher),
          worker: {
            logger: {
              warn: (bindings, message) => app?.log.warn(bindings, message),
              error: (bindings, message) => app?.log.error(bindings, message),
            },
          },
        })
      : undefined;
    const custody = new PostgresRuntimeCustodyStore(database);
    const platformRuntime = await createPlatformRuntime({
      config,
      database,
      cipher: applicationCipher,
      registry,
      custody,
      machineAuth: machineAuthService,
      ...(github ? { github } : {}),
      logger: serviceLogger("platform-runtime"),
    });
    const computerService = new ComputerService(database, authService, {
      providerReadiness: registry,
      cloudIdentities,
      assertCloudControlCredential: platformRuntime.assertCloudControlCredential,
    });
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
        const observation = observations.find(
          ({ observation }) =>
            observation.agentId === agentId &&
            observation.provider === provider &&
            observation.integrationId === integrationId &&
            observation.credentialGeneration === credentialGeneration,
        )?.observation;
        if (!observation) return "checking";
        return {
          status: observation.status,
          ...(observation.reason ? { reason: observation.reason } : {}),
        };
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
      runtimeCredentialValidation: {
        issueValidationRun: (input) => platformRuntime.credentials.owner.issueValidationRun(input),
      },
      logger: serviceLogger("im-binding"),
    });
    const accountSetupService = new AccountSetupService(database);
    const imMessageInbox = new ImMessageInbox(database, { logger: serviceLogger("im-inbox") });
    const feishuInboundReceipts = new FeishuInboundReceiptStore(database, {
      onMetric: (metric) => app?.log.info({ metric }, "Feishu inbound receipt metric"),
    });
    const sessionService = new SessionService(database, { logger: serviceLogger("session") });
    const sandboxService = new SandboxService(database, sessionService, { cloudIdentities });
    const cloudRunnerRuntime = createSandboxRunnerRuntime(database, config);
    const taskService = new TaskService(database);
    const runtimeSnapshotAssembler = new EffectiveRuntimeSnapshotAssembler(database);
    const sessionCliProofService = new SessionCliProofService(database, registry, config.encryptionKey);
    const domainOwner = new RuntimeDomainOwner(registry, custody, {
      logger: serviceLogger("runtime-domain"),
      onImCredentialGrant: (request, context) => imBindingService.issueRuntimeCredentialGrant(request, context),
      prepareReconcile: (computerId, connectionInstanceId, request) =>
        sessionCliProofService.prepareReconcile(computerId, connectionInstanceId, request),
    });
    const durableWorkStore = new PostgresRuntimeDurableWorkStore(database);
    providerCliReconcileOwner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: (computerId) => imBindingService.listActiveProviderCliRequirements(computerId),
      issueIntegrationCliValidationGrant: (input) => imBindingService.issueIntegrationCliValidationGrant(input),
      issueRuntimeValidationRun: (input) => imBindingService.issueRuntimeValidationRun(input),
      computerKind: (computerId) => imBindingService.computerKind(computerId),
      shouldPrewarmOfficialProviderClis: (computerId) =>
        computerService.hasActiveAgentWithoutMessagingSetup(computerId),
    });
    const contextTreeOperationOwner = new ContextTreeOperationOwner(registry);
    const agentRuntimeTestOwner = new AgentRuntimeTestOwner(registry);
    const sessionCollaborationService = new SessionCollaborationService({
      assembler: runtimeSnapshotAssembler,
      domain: domainOwner,
      onDiagnostic: reportDiagnostic,
      registry,
      sessions: sessionService,
      logger: serviceLogger("session-collaboration"),
    });
    const agentService = new AgentService(database, {
      cloudIdentitiesEnabled: cloudIdentities.enabled,
      onDiagnostic: (code) => app?.log.error({ code }, "Agent lifecycle diagnostic"),
      onProviderCliPlacementChanged: (input) => providerCliReconcileOwner?.onAgentPlacementChanged(input),
      stopSessions: (targets) =>
        stopAgentSessions(database, targets, {
          currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
          requestReconcile: (computerId, instanceId, request, onDispatched) =>
            domainOwner.requestReconcile(computerId, instanceId, request, onDispatched),
        }),
    });
    const contextTreeOperationService = new ContextTreeOperationService(agentService, contextTreeOperationOwner);
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
    const agentSetupService = new AgentSetupService(database, agentService, imBindingService, feishuSetupService, {
      prepareComputer: async (input) => {
        const owner = providerCliReconcileOwner;
        if (!owner) throw new Error("Provider CLI preparation owner is unavailable");
        await owner.prepareComputer(input);
      },
      providerReadiness: registry,
      slackOAuthAvailable: config.slackOAuth !== undefined,
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
    const imDeliveryLogger = serviceLogger("im-delivery");
    /*
     * The MCP management plane. Every outbound request goes through one fetcher that enforces the
     * URL policy, so the discovery chain cannot be used to reach an internal address; loopback plain
     * HTTP is permitted only on a development deployment that explicitly opted in.
     */
    const mcpFetcher = new McpOutboundFetcher({ allowLoopback: config.mcpAllowLoopback });
    const mcpServers = new McpServerService({ database });
    const mcpCipher = new McpCredentialCipher(applicationCipher);
    const mcpOAuth = new McpOAuthClient({ fetcher: mcpFetcher, publicUrl: config.publicUrl });
    const mcpProbe = new McpProbe({ fetcher: mcpFetcher });
    const mcpAuthorization = new McpAuthorizationService({
      database,
      cipher: mcpCipher,
      probe: mcpProbe,
      servers: mcpServers,
    });
    const mcpFlows = new McpOAuthFlowService({ database, cipher: mcpCipher, oauth: mcpOAuth, servers: mcpServers });
    const mcpRefreshWorker = new McpRefreshWorker({
      authorization: mcpAuthorization,
      database,
      flows: mcpFlows,
      servers: mcpServers,
      onError: (error) => app?.log.error({ error }, "MCP refresh pass failed"),
    });
    const imDeliveryWorker = new ImDeliveryWorker({
      assembler: runtimeSnapshotAssembler,
      database,
      domain: domainOwner,
      logger: imDeliveryLogger,
      onMetric: (metric) => imDeliveryLogger.info({ metric }, "IM delivery worker metric"),
      registry,
      onDiagnostic: reportDiagnostic,
      supervisor: backgroundFailureSupervisor,
    });
    const setupResetService = config.internalTools
      ? new OnboardingResetService({
          allowLocalPreview: config.environment === "dev",
          agents: agentService,
          database,
          environment: config.environment,
          registry,
        })
      : undefined;
    const internalNavigationService = new InternalNavigationVisibilityService();
    app = createApp({
      loggerLevel: config.logLevel,
      betterAuth: { instance: betterAuth, publicUrl: config.publicUrl },
      webAppRoot: defaultWebAppRoot,
      agentService,
      agentSetupService,
      agentRuntimeTestService,
      contextTreeOperationService,
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
        downloadBaseUrl: config.channelTarget.downloadBaseUrl,
        environment: config.environment,
        publicUrl: config.publicUrl,
      },
      computerService,
      sandboxService,
      ...sandboxRunnerRouteOptions(cloudRunnerRuntime),
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
      mcp: {
        authorization: mcpAuthorization,
        flows: mcpFlows,
        servers: mcpServers,
        publicOrigin: config.publicUrl,
        secureCookies: isHostedEnvironment(config.environment),
      },
      readiness,
      runtimeAuthService: platformRuntime.auth,
      runtimeProviderProxy: { transport: platformRuntime.credentials.transport },
      runtime: {
        runtimeCredentialOwner: platformRuntime.credentials.owner,
        registry,
        domainOwner,
        agentRuntimeTestOwner,
        contextTreeOperationOwner,
        providerCliReconcileOwner,
        channelTarget: () => channelTargetPoller.get(),
      },
      runtimeDurableWork: { machineAuth: platformRuntime.auth, store: durableWorkStore },
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
      githubIntegrations: {
        availability: config.githubApp
          ? ({ available: true, githubHost: "github.com", appId: config.githubApp.appId } as const)
          : ({ available: false, githubHost: "github.com", appId: null } as const),
        publicOrigin: config.publicUrl,
        secureCookies: isHostedEnvironment(config.environment),
        ...(github ? { management: github.management, webhook: github.webhook } : {}),
      },
      ...(setupResetService ? { internalNavigationService, setupResetService } : {}),
      accountSetupService,
    });
    feishuSetupService.start();
    feishuConnections.start();
    imDeliveryWorker.start();
    github?.worker.start();
    mcpRefreshWorker.start();
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
      mcpRefreshWorker.stop();
      if (github) await github.worker.stop();
      await platformRuntime.close();
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
