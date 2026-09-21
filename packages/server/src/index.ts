import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  InternalNavigationVisibility,
  ProviderReadinessStatus,
  RuntimeCredentialServerFrame,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { createApp } from "./app.js";
import { createBetterAuth } from "./auth/better-auth.js";
import { BetterAuthSessionTokens } from "./auth/session-tokens.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { cloudAvailability } from "./cloud-product-config.js";
import {
  cloudAppOptions,
  collectKnownSecrets,
  createCloudDeliveryComposition,
  createCloudIngressAllocationPort,
  createCloudSessionAllocationPort,
  createSandboxRunnerRuntime,
  type SandboxRunnerRuntime,
} from "./cloud-runtime-composition.js";
import { isHostedEnvironment, parseServerConfig, type ServerConfig, serverEnvironmentSummary } from "./config.js";
import { createDatabaseClient, type DatabaseClient } from "./db/client.js";
import { migrateDatabase, verifyDatabaseMigrations } from "./db/migrate.js";
import { agents, computers } from "./db/schema/index.js";
import {
  createBackgroundFailureSupervisor,
  createServerDiagnosticReporter,
  createServiceLoggerPort,
  initTelemetry,
  type ServiceLogger,
  shutdownTelemetry,
} from "./observability/index.js";
import { createPlatformRuntime } from "./platform-runtime.js";
import { AgentRuntimeTestOwner } from "./runtime/agent-runtime-test-owner.js";
import { type AgentSessionStopDependencies, stopAgentSessions } from "./runtime/agent-session-stopper.js";
import { ConnectionRegistry } from "./runtime/connection-registry.js";
import { ContextTreeOperationOwner } from "./runtime/context-tree-operation-owner.js";
import { ImDeliveryWorker } from "./runtime/im-delivery-worker.js";
import type { CloudSessionAllocationPort } from "./runtime/im-delivery-worker.types.js";
import { ProviderCliReconcileOwner } from "./runtime/provider-cli-reconcile-owner.js";
import { PostgresRuntimeCustodyStore } from "./runtime/runtime-custody-store.js";
import { RuntimeDomainOwner } from "./runtime/runtime-domain-owner.js";
import { PostgresRuntimeDurableWorkStore } from "./runtime/runtime-durable-work-store.js";
import { CloudContextTreeOperations } from "./services/agents/cloud-context-tree-operations.js";
import { ContextTreeOperationService } from "./services/agents/context-tree-operation-service.js";
import {
  AgentRuntimeTestService,
  AgentService,
  type AgentSessionStopTarget,
  AgentSetupService,
  CloudAgentRuntimeTester,
} from "./services/agents/index.js";
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
  MCP_RUNTIME_MAX_CONCURRENT_PER_ACCOUNT,
  MCP_RUNTIME_TIMEOUT_MS,
  McpAuthorizationService,
  McpCredentialCipher,
  McpGatewayService,
  McpOAuthClient,
  McpOAuthFlowService,
  McpOutboundFetcher,
  McpProbe,
  McpRefreshWorker,
  McpServerService,
  McpUpstreamCaller,
} from "./services/mcp/index.js";
import { OnboardingResetService } from "./services/onboarding-reset/index.js";
import { EffectiveRuntimeSnapshotAssembler } from "./services/runtime-config/index.js";
import type { CloudDeliveryOwner } from "./services/sandboxes/cloud-delivery-owner.js";
import { RouterCloudModelCatalog } from "./services/sandboxes/cloud-model-catalog.js";
import { CloudRuntimeFence } from "./services/sandboxes/cloud-runtime-fence.js";
import {
  type CloudSessionCollaborationOwner,
  CloudSessionWorkTracker,
  createCloudSourceConnectionVerifier,
  createSessionCliCloudProofAuthority,
} from "./services/sandboxes/cloud-session-collaboration-owner.js";
import { SandboxIdleReclaimer } from "./services/sandboxes/idle-reclaimer.js";
import { SandboxService } from "./services/sandboxes/index.js";
import type { SandboxAllocationReconciliation } from "./services/sandboxes/sandbox-runner-service.js";
import { SessionCliProofService, SessionCollaborationService, SessionService } from "./services/sessions/index.js";
import { AccountSetupService } from "./services/setup/index.js";
import { S3SkillObjectStore, SkillObjectGc, SkillService } from "./services/skills/index.js";
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

/** The live Cloud fence exists exactly when the Cloud Runner runtime is enabled. */
function cloudRuntimeFenceFor(runtime: SandboxRunnerRuntime | undefined): CloudRuntimeFence | undefined {
  return runtime ? new CloudRuntimeFence() : undefined;
}

/** Optional platform-runtime fence/revocation wiring; absent keeps the Local-only behavior. */
function cloudPlatformRuntimeOptions(
  fence: CloudRuntimeFence | undefined,
  sender: (computerId: string, instanceId: string, frame: RuntimeCredentialServerFrame) => void,
): { cloudRuntimeFence?: CloudRuntimeFence; cloudRevocationSender?: typeof sender } {
  if (!fence) return {};
  return { cloudRuntimeFence: fence, cloudRevocationSender: sender };
}

/** One model catalog shared by settings, dispatch and diagnostics. */
function createCloudModelRuntime(config: ServerConfig, runner: SandboxRunnerRuntime | undefined) {
  const model = config.cloudModel;
  if (!runner || !model.enabled) return undefined;
  const catalog = new RouterCloudModelCatalog({ upstreamBaseUrl: model.upstreamBaseUrl, masterKey: model.masterKey });
  return { catalog, tester: new CloudAgentRuntimeTester({ catalog, config: model }) };
}

function optionalCloudModelCatalog(runtime: ReturnType<typeof createCloudModelRuntime>) {
  return runtime ? { cloudModelCatalog: runtime.catalog } : {};
}

function optionalCloudModelTester(runtime: ReturnType<typeof createCloudModelRuntime>) {
  return runtime ? { cloud: runtime.tester } : {};
}

function optionalCloudFence(fence: CloudRuntimeFence | undefined): { cloudRuntimeFence?: CloudRuntimeFence } {
  return fence ? { cloudRuntimeFence: fence } : {};
}

/** The optional allocation-status seam for the delivery composition. */
function optionalAllocationStatus(runtime: SandboxRunnerRuntime | undefined): {
  allocationStatus?: (sandboxId: string) => Promise<SandboxAllocationReconciliation | undefined>;
} {
  if (!runtime) return {};
  return { allocationStatus: (sandboxId) => runtime.sandboxRunnerService.reconcileAllocation(sandboxId) };
}

/** The optional E7 business-activity clock for the delivery composition. */
function optionalNoteActivity(runtime: SandboxRunnerRuntime | undefined): {
  noteActivity?: (sandboxId: string) => Promise<void>;
} {
  if (!runtime) return {};
  return { noteActivity: (sandboxId) => runtime.sandboxRunnerService.noteActivity(sandboxId) };
}

/** The optional normal-ingress allocation port for the delivery worker. */
function cloudAllocationPortFor(
  runtime: SandboxRunnerRuntime | undefined,
  sandboxService: SandboxService,
): CloudSessionAllocationPort | undefined {
  if (!runtime) return undefined;
  return createCloudIngressAllocationPort({
    sandboxService,
    sandboxRunnerService: runtime.sandboxRunnerService,
  });
}

/** The optional Cloud inputs for the delivery worker. */
function workerCloudOptions(
  cloudDelivery: CloudDeliveryOwner | undefined,
  cloudAllocation: CloudSessionAllocationPort | undefined,
): { cloudDelivery?: CloudDeliveryOwner; cloudAllocation?: CloudSessionAllocationPort } {
  return {
    ...(cloudDelivery ? { cloudDelivery } : {}),
    ...(cloudAllocation ? { cloudAllocation } : {}),
  };
}

/** Surface non-cancelled stop outcomes without turning a best-effort cancel into a hard failure. */
function reportCloudStopOutcomes(
  outcomes: Awaited<ReturnType<CloudDeliveryOwner["cancelSessionDeliveries"]>>,
  onDiagnostic?: (code: string) => void,
): void {
  for (const outcome of outcomes) {
    // A cancelled owning turn needs no diagnostic; a lost socket or a failed frame send stays
    // explicitly visible instead of being swallowed as "best effort".
    if (outcome.status === "cancelled") continue;
    onDiagnostic?.(
      outcome.status === "no_connection" ? "CLOUD_DELIVERY_STOP_NO_CONNECTION" : "CLOUD_DELIVERY_STOP_SEND_FAILED",
    );
  }
}

/**
 * Explicit Session stop for Cloud Sessions cancels the in-flight Cloud turn on its owning Runner
 * (best-effort; the cancellation report still flows through the durable report path) before the
 * Local reconcile-based stop runs. Cloud cancel failures never block the Local stop path.
 */
async function stopCloudThenLocalAgentSessions(
  database: DatabaseClient,
  targets: AgentSessionStopTarget[],
  cloudDelivery: CloudDeliveryOwner | undefined,
  dependencies: AgentSessionStopDependencies,
  onDiagnostic?: (code: string) => void,
  cloudSession?: CloudSessionCollaborationOwner,
): Promise<void> {
  if (cloudDelivery) {
    for (const target of targets) {
      try {
        reportCloudStopOutcomes(await cloudDelivery.cancelSessionDeliveries(target.sessionId), onDiagnostic);
      } catch {
        // The cancel path itself failed; Local stop and Runner scope invalidation still proceed.
        onDiagnostic?.("CLOUD_DELIVERY_STOP_FAILED");
      }
    }
  }
  for (const target of targets) {
    try {
      const outcomes = await cloudSession?.cancelSessionMessages(target.sessionId);
      for (const outcome of outcomes ?? []) {
        if (outcome.status !== "requested") onDiagnostic?.("CLOUD_SESSION_STOP_UNCONFIRMED");
      }
    } catch {
      onDiagnostic?.("CLOUD_SESSION_STOP_FAILED");
    }
  }
  await stopAgentSessions(database, targets, dependencies);
}

function cloudSessionAuthorityOptions(
  fence: CloudRuntimeFence | undefined,
  credentials: Parameters<typeof createCloudDeliveryComposition>[0]["credentialOwner"],
) {
  if (!fence) return { session: {}, proof: {} };
  return {
    session: { cloudSourceConnection: createCloudSourceConnectionVerifier(fence) },
    proof: { cloud: createSessionCliCloudProofAuthority({ fence, registry: credentials.executionRegistry }) },
  };
}

function createContextTreeServices(
  management: NonNullable<ReturnType<typeof createGitHubIntegration>>["management"] | undefined,
  imBindings: ImBindingService,
  agents: AgentService,
  owner: ContextTreeOperationOwner,
) {
  const computerKind = (computerId: string) => imBindings.computerKind(computerId);
  const cloudContextTreeOperations = management
    ? new CloudContextTreeOperations({ management, computerKind })
    : undefined;
  return {
    cloudContextTreeOperations,
    contextTreeOperationService: new ContextTreeOperationService(agents, owner, {
      computerKind,
      run: (input) =>
        cloudContextTreeOperations?.run(input) ?? Promise.resolve({ status: "failed", code: "capability_missing" }),
    }),
  };
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

/**
 * Builds the Agent Skill runtime. The service always exists — without object storage it still lists
 * Skills and manages their rows, and only bundle reads/writes fail with SKILL_STORAGE_UNAVAILABLE.
 * The S3 store, and with it the orphan-object collector, is constructed only when the storage group
 * is coherently configured and collection is not disabled.
 */
function createSkillRuntime(
  config: ServerConfig,
  database: DatabaseClient,
  logger: ServiceLogger,
): { service: SkillService; gc?: SkillObjectGc } {
  const storage = config.skillStorage;
  if (!storage.enabled) {
    return { service: new SkillService({ database, keyPrefix: "skills", logger }) };
  }
  const store = new S3SkillObjectStore({
    config: {
      endpoint: storage.endpoint,
      region: storage.region,
      bucket: storage.bucket,
      accessKeyId: storage.accessKeyId,
      secretAccessKey: storage.secretAccessKey,
      forcePathStyle: storage.forcePathStyle,
    },
    logger,
  });
  const service = new SkillService({ database, store, keyPrefix: storage.prefix, logger });
  if (storage.gcIntervalSeconds <= 0) return { service };
  const gc = new SkillObjectGc({
    database,
    store,
    prefix: storage.prefix,
    intervalMs: storage.gcIntervalSeconds * 1000,
    graceMs: storage.gcGraceSeconds * 1000,
    logger,
    onError: (error) => logger.error({ error }, "Skill object GC pass failed"),
  });
  return { service, gc };
}

/** Every configured value startup errors must never echo, including the raw key ring JSON. */
function cipherKeySecrets(config: ServerConfig): string[] {
  return Array.from(config.encryptionKeyRing?.keys.values() ?? [], (key) => Buffer.from(key).toString("base64"));
}

function deploymentProof(config: ServerConfig) {
  return {
    revision: config.buildRevision,
    runner:
      config.cloudRunner.enabled && config.cloudIdentities.enabled
        ? { image: config.cloudRunner.image, version: config.cloudIdentities.runnerVersion }
        : undefined,
  };
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
    let cloudSessionOwner: CloudSessionCollaborationOwner | undefined;
    const cloudSessionWork = new CloudSessionWorkTracker();
    const cloudRunnerRuntime = createSandboxRunnerRuntime(database, config, {
      sessionWorkBusy: (allocation) => cloudSessionWork.isBusy(allocation),
      sessionWorkBarrier: (input) => cloudSessionOwner?.hasUnsettledSessionWork(input) ?? Promise.resolve(false),
    });
    /*
     * E7 idle reclamation runs on the existing Server lifecycle: one fixed 15s cadence, one idle
     * budget from lastActivityAt, bounded batches, and a database CAS that converges across
     * restarts. It is created only when the Cloud Runner allocation is enabled.
     */
    const sandboxIdleReclaimer = cloudRunnerRuntime
      ? new SandboxIdleReclaimer({
          service: cloudRunnerRuntime.sandboxRunnerService,
          supervisor: backgroundFailureSupervisor,
          onDiagnostic: reportDiagnostic,
        })
      : undefined;
    /*
     * E4: the Cloud Runner fence exists before the platform runtime so credential executions
     * opened over the per-Sandbox Runner channel compose into the broker/data-transport fences.
     * It is a standalone live-connection map; the Local registry above is never shared with it.
     */
    const cloudRuntimeFence = cloudRuntimeFenceFor(cloudRunnerRuntime);
    /*
     * The one Server-owned Router model catalog and the bounded hosted-model connectivity tester.
     * Both exist exactly when the Cloud model path is enabled, and every consumer — Agent and
     * Session model validation, dispatch and model-grant admission, the account model list route,
     * and the runtime test — shares the same catalog instance (one lazy cache, one in-flight
     * Router read per process). The catalog performs no I/O at construction.
     */
    const cloudModelRuntime = createCloudModelRuntime(config, cloudRunnerRuntime);
    const modelCatalogOptions = optionalCloudModelCatalog(cloudModelRuntime);
    // Exact Cloud revocation sender: the credential owner's sweep/close notifications reach the
    // owning Runner connection through the controller created below. Declared here because the
    // platform runtime is composed before the delivery owner.
    let cloudDeliveryOwnerRef: CloudDeliveryOwner | undefined;
    /*
     * Built here rather than with the rest of the MCP services below, because the platform runtime
     * is composed first and needs this to decide whether an execution may open the MCP service. The
     * service is stateless over the database, so constructing it early costs nothing and keeps one
     * instance shared by the management routes and the runtime gateway.
     */
    const mcpServers = new McpServerService({ database });
    const platformRuntime = await createPlatformRuntime({
      config,
      database,
      cipher: applicationCipher,
      registry,
      custody,
      machineAuth: machineAuthService,
      mcpMounts: mcpServers,
      ...(github ? { github } : {}),
      ...cloudPlatformRuntimeOptions(cloudRuntimeFence, (computerId, instanceId, frame) => {
        cloudDeliveryOwnerRef?.sendRevocationToInstance(computerId, instanceId, frame);
      }),
      logger: serviceLogger("platform-runtime"),
    });
    const computerService = new ComputerService(database, authService, {
      providerReadiness: registry,
      cloudIdentities,
      assertCloudControlCredential: platformRuntime.assertCloudControlCredential,
    });
    const agentRuntimeReadinessForAgent = async (agentId: string): Promise<ProviderReadinessStatus> => {
      const [agent] = await database
        .select({ computerId: computers.id, computerKind: computers.kind, runtimeProvider: agents.runtimeProvider })
        .from(agents)
        .innerJoin(computers, eq(computers.id, agents.computerId))
        .where(eq(agents.id, agentId))
        .limit(1);
      // A Cloud Agent's runtime is the managed service: readiness is the deployment's Cloud
      // configuration, never a Local registry observation — a Cloud Computer has no daemon to ask.
      if (agent?.computerKind === "cloud") {
        return cloudAvailability(config).available ? "ready" : "unavailable";
      }
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
    const sessionAuthority = cloudSessionAuthorityOptions(cloudRuntimeFence, platformRuntime.credentials.owner);
    const sessionService = new SessionService(database, {
      logger: serviceLogger("session"),
      ...sessionAuthority.session,
      ...modelCatalogOptions,
    });
    const sandboxService = new SandboxService(database, sessionService, { cloudIdentities });
    const taskService = new TaskService(database);
    const runtimeSnapshotAssembler = new EffectiveRuntimeSnapshotAssembler(database);
    const sessionCliProofService = new SessionCliProofService(
      database,
      registry,
      config.encryptionKey,
      sessionAuthority.proof,
    );
    const skillRuntime = createSkillRuntime(config, database, serviceLogger("skills"));
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
    const agentService = new AgentService(database, {
      cloudIdentitiesEnabled: cloudIdentities.enabled,
      ...modelCatalogOptions,
      onDiagnostic: (code) => app?.log.error({ code }, "Agent lifecycle diagnostic"),
      onProviderCliPlacementChanged: (input) => providerCliReconcileOwner?.onAgentPlacementChanged(input),
      stopSessions: (targets) =>
        stopCloudThenLocalAgentSessions(
          database,
          targets,
          cloudDeliveryOwner,
          {
            currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
            requestReconcile: (computerId, instanceId, request, onDispatched) =>
              domainOwner.requestReconcile(computerId, instanceId, request, onDispatched),
          },
          reportDiagnostic,
          cloudSessionOwner,
        ),
    });
    const { cloudContextTreeOperations, contextTreeOperationService } = createContextTreeServices(
      github?.management,
      imBindingService,
      agentService,
      contextTreeOperationOwner,
    );
    const agentRuntimeTestService = new AgentRuntimeTestService(agentService, agentRuntimeTestOwner, {
      // The branch key is the server-derived bound Computer kind; ownership was already enforced.
      computerKind: async (computerId) => {
        const [row] = await database
          .select({ kind: computers.kind })
          .from(computers)
          .where(eq(computers.id, computerId))
          .limit(1);
        return row?.kind;
      },
      ...optionalCloudModelTester(cloudModelRuntime),
    });
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
      cloudAvailability: (now) => cloudAvailability(config, now),
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
    /*
     * E4 Cloud delivery owner: present exactly when Cloud Runner allocation is enabled. The model
     * grant service additionally requires the deployment model path (default disabled); without
     * it Cloud deliveries stay pending on transient IM_DELIVERY_CLOUD_MODEL_UNAVAILABLE retries —
     * nothing executes against a model the deployment did not explicitly configure. The SAME
     * factory and grant instance feed the owner and the createApp model route below.
     */
    const cloudDelivery = createCloudDeliveryComposition({
      cloudModel: config.cloudModel,
      jwtSecret: config.jwtSecret,
      publicUrl: config.publicUrl,
      database,
      custody,
      hub: cloudRunnerRuntime?.runnerChannel.hub,
      ...modelCatalogOptions,
      ...optionalCloudFence(cloudRuntimeFence),
      credentialOwner: platformRuntime.credentials.owner,
      sessionProofs: sessionCliProofService,
      ...(cloudRunnerRuntime
        ? {
            sessionCollaboration: {
              work: cloudSessionWork,
              assembler: runtimeSnapshotAssembler,
              proofs: sessionCliProofService,
              sessions: sessionService,
              durableWork: durableWorkStore,
              allocation: createCloudSessionAllocationPort({
                database,
                sandboxService,
                sandboxRunnerService: cloudRunnerRuntime.sandboxRunnerService,
              }),
            },
          }
        : {}),
      ...optionalAllocationStatus(cloudRunnerRuntime),
      ...optionalNoteActivity(cloudRunnerRuntime),
      logger: serviceLogger("cloud-delivery"),
    });
    const cloudDeliveryOwner = cloudDelivery.cloudDeliveryOwner;
    cloudDeliveryOwnerRef = cloudDeliveryOwner;
    cloudSessionOwner = cloudDelivery.cloudSessionOwner;
    const sessionCollaborationService = new SessionCollaborationService({
      assembler: runtimeSnapshotAssembler,
      domain: domainOwner,
      onDiagnostic: reportDiagnostic,
      registry,
      sessions: sessionService,
      cloud: cloudSessionOwner,
      logger: serviceLogger("session-collaboration"),
    });
    const imDeliveryLogger = serviceLogger("im-delivery");
    /*
     * The MCP management plane. Every outbound request goes through one fetcher that enforces the
     * URL policy, so the discovery chain cannot be used to reach an internal address; loopback plain
     * HTTP is permitted only on a development deployment that explicitly opted in.
     */
    const mcpFetcher = new McpOutboundFetcher({ allowLoopback: config.mcpAllowLoopback });
    /*
     * A second fetcher for runtime tool calls. It enforces the same URL policy — the gate, the
     * redirect refusal, the response bound are all properties of the class — but carries its own
     * deadline and its own per-Account concurrency counter, because a tool call is not a probe: it
     * runs as long as the tool does, and a background probe must never be able to starve a live turn.
     */
    const mcpRuntimeFetcher = new McpOutboundFetcher({
      allowLoopback: config.mcpAllowLoopback,
      timeoutMs: MCP_RUNTIME_TIMEOUT_MS,
      maxConcurrentPerAccount: MCP_RUNTIME_MAX_CONCURRENT_PER_ACCOUNT,
    });
    const mcpCipher = new McpCredentialCipher(applicationCipher);
    const mcpOAuth = new McpOAuthClient({ fetcher: mcpFetcher, publicUrl: config.publicUrl });
    const mcpProbe = new McpProbe({ fetcher: mcpFetcher });
    const mcpAuthorization = new McpAuthorizationService({
      database,
      cipher: mcpCipher,
      probe: mcpProbe,
      servers: mcpServers,
    });
    /*
     * The runtime gateway. It shares the one outbound fetcher with the management plane, so a
     * runtime tool call is bound by the same URL policy, per-Account concurrency limit, redirect
     * refusal, and response cap that a probe is.
     */
    const mcpGatewayService = new McpGatewayService({
      servers: mcpServers,
      authorizations: mcpAuthorization,
      upstream: new McpUpstreamCaller({ fetcher: mcpRuntimeFetcher }),
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
      ...workerCloudOptions(cloudDeliveryOwner, cloudAllocationPortFor(cloudRunnerRuntime, sandboxService)),
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
      deployment: deploymentProof(config),
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
      cloudAvailability: () => cloudAvailability(config),
      ...cloudAppOptions({
        runnerRuntime: cloudRunnerRuntime,
        composition: cloudDelivery,
        cloudModel: config.cloudModel,
      }),
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
      ...(platformRuntime.credentials.web
        ? { runtimeWeb: { machineAuth: platformRuntime.auth, service: platformRuntime.credentials.web } }
        : {}),
      ...(platformRuntime.credentials.mcp
        ? {
            mcpGateway: {
              tokens: platformRuntime.credentials.mcp.tokens,
              authorizer: platformRuntime.credentials.mcp.authorizer,
              service: mcpGatewayService,
              logger: serviceLogger("mcp-gateway"),
            },
          }
        : {}),
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
      skills: { service: skillRuntime.service, proofs: sessionCliProofService },
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
    sandboxIdleReclaimer?.start();
    github?.worker.start();
    mcpRefreshWorker.start();
    skillRuntime.gc?.start();
    channelTargetPoller.start();
    const closeForSignal = () => {
      void app?.close();
    };
    process.once("SIGINT", closeForSignal);
    process.once("SIGTERM", closeForSignal);
    app.addHook("preClose", async () => {
      cloudModelRuntime?.tester.close();
    });
    app.addHook("onClose", async () => {
      process.off("SIGINT", closeForSignal);
      process.off("SIGTERM", closeForSignal);
      channelTargetPoller.stop();
      await sandboxIdleReclaimer?.stop();
      imDeliveryWorker.stop();
      mcpRefreshWorker.stop();
      skillRuntime.gc?.stop();
      if (github) await github.worker.stop();
      await cloudContextTreeOperations?.close();
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
