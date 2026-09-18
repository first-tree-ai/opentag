import { rm } from "node:fs/promises";
import type { RuntimeImOutboxContext } from "@opentag/shared";
import {
  WEB_TOOLS_PROTOCOL_VERSION,
  type WebFetchExecutionRequest,
  type WebSearchExecutionRequest,
} from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";
import {
  ImCredentialEnvironmentError,
  ImCredentialEnvironmentManager,
  type ImCredentialEnvironmentManagerOptions,
  type ImCredentialGrantSubject,
  type PreparedImCredentialEnvironment,
} from "./im-credential-environment-manager.js";
import type { RuntimeConnection } from "./runtime-connection.js";
import {
  RUNTIME_CREDENTIAL_CAPABILITY,
  RUNTIME_PROVIDER_PROXY_CAPABILITY,
  RUNTIME_WEB_TOOLS_CAPABILITY,
  type RuntimeExecutionSandbox,
  type RuntimeExecutionSource,
  type RuntimeProxyProvider,
  runtimeProxyErrorReason,
} from "./runtime-credential-frames.js";
import {
  RuntimeCredentialRelay,
  RuntimeCredentialRelayError,
  type RuntimeProxyDataConnectionFactory,
  type RuntimeRelayScheduler,
} from "./runtime-credential-relay.js";
import { RuntimeProxyLoopbackAdapter, type RuntimeProxyLoopbackCaMaterial } from "./runtime-proxy-loopback-adapter.js";
import {
  buildRuntimeProxyEnvironment,
  providerRoutingEnvironment,
  type RuntimeProxyEnvironment,
  RuntimeProxyMaterialStore,
  runtimeProxyOutboxContext,
} from "./runtime-proxy-material.js";
import { WebToolsClientError, WebToolsServerClient } from "./web-tools-client.js";
import { allocateWebGatewaySocket, WebGatewayDispatchError, WebToolsGatewayServer } from "./web-tools-gateway.js";

export type RuntimeCredentialMode = "legacy" | "proxy";

export interface RuntimeCredentialRunSubject {
  readonly runId: string;
  readonly source: RuntimeExecutionSource;
}

export interface RuntimeCredentialPrepareSubject extends ImCredentialGrantSubject {
  /** Real Run identity and accepted-delivery/Session-message/validation source. */
  readonly run?: RuntimeCredentialRunSubject;
}

/**
 * One Server-authorized proxy validation execution (`source.kind === "validation"`). The
 * caller must obtain the Server-issued `validationRunId` through the readiness control
 * flow; the Client never invents one. Read-only identity scope only.
 */
export interface RuntimeCredentialValidationSubject {
  readonly agentId: string;
  readonly placementGeneration: number;
  readonly validationRunId: string;
}

export interface PreparedProxyValidationSession {
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly executionId: string;
  readonly signal: AbortSignal;
  readonly slackApiHost?: string;
  cleanup(): Promise<void>;
}

/** Trusted web tools launch facts for one execution; the socket path is a nonsecret descriptor. */
export interface PreparedWebToolsLaunch {
  readonly extensionPath: string;
  readonly socketPath: string;
}

export interface PreparedRuntimeCredentialEnvironment {
  /** Present in proxy mode; exact-execution cleanup token. */
  readonly executionId?: string;
  /** Proxy mode: execution environment manifest merged by the Turn launcher. */
  readonly environmentManifest?: string;
  readonly outboxContext?: RuntimeImOutboxContext;
  readonly path: string;
  /** IM provider for Turn plan/outbox flows; absent for GitHub-only executions. */
  readonly provider?: "feishu" | "slack";
  /** Every provider opened for this execution, in Server-granted order, when known. */
  readonly providers?: readonly RuntimeProxyProvider[];
  /** Proxy mode: fires on revocation, close, or control/owner replacement. */
  readonly signal?: AbortSignal;
  /** Proxy mode: loopback HTTPS endpoint for the Slack `--apihost` launcher flag. */
  readonly slackApiHost?: string;
  readonly slackConfigDir?: string;
  /** Present only while this execution carries an authorized web service with a live gateway. */
  readonly web?: PreparedWebToolsLaunch;
}

export interface RuntimeCredentialEnvironmentManagerOptions {
  readonly connection: Pick<
    RuntimeConnection,
    "capabilityVersion" | "send" | "subscribeBusinessFrames" | "subscribeState"
  >;
  readonly dataConnectionFactory?: RuntimeProxyDataConnectionFactory;
  readonly generateCa?: (materialDir: string) => Promise<RuntimeProxyLoopbackCaMaterial>;
  readonly home: string;
  /** Optional legacy seam (tests); production composition uses the default. */
  readonly legacy?: (options: ImCredentialEnvironmentManagerOptions) => ImCredentialEnvironmentManager;
  readonly logger?: Pick<ClientLogger, "debug" | "warn">;
  /**
   * Explicit mode selection. `"proxy"` never falls back to raw materials; `"legacy"`
   * keeps the existing Local behavior unchanged. Default `"legacy"`.
   */
  readonly mode?: RuntimeCredentialMode;
  readonly now?: () => number;
  readonly openBudgetMs?: number;
  readonly platform?: NodeJS.Platform;
  /** Trusted Cloud Sandbox binding facts for the Session, when composed for Cloud. */
  readonly sandboxForSession?: (sessionId: string) => RuntimeExecutionSandbox | undefined;
  readonly scheduler?: RuntimeRelayScheduler;
  /** Base Server URL for the data endpoint; required in proxy mode. */
  readonly serverUrl?: string;
  /**
   * Explicit web tools opt-in (deployment + negotiated capability required too). The extension
   * path is the fixed trusted built artifact; the machine token never leaves this process.
   */
  readonly webTools?: {
    readonly extensionPath: string;
    readonly machineToken: string;
    readonly fetchImpl?: typeof fetch;
  };
}

interface ActiveProxyExecution {
  readonly adapter: RuntimeProxyLoopbackAdapter;
  readonly environment: RuntimeProxyEnvironment;
  readonly executionId: string;
  readonly outboxContext?: RuntimeImOutboxContext;
  readonly provider?: "feishu" | "slack";
  readonly providers: readonly RuntimeProxyProvider[];
  readonly relay: RuntimeCredentialRelay;
  readonly slackApiHost?: string;
  readonly slackConfigDir?: string;
  readonly web?: PreparedWebToolsLaunch;
  readonly webGateway?: WebToolsGatewayServer;
  /** Short private per-execution socket directory owned by this execution only. */
  readonly webSocketDirectory?: string;
}

/**
 * Runtime credential environment lifecycle with explicit proxy mode. Proxy mode opens
 * a trusted execution through the control connection, holds short-lived capabilities
 * only inside the trusted Relay, and materializes execution-local handles, CA, CLI
 * config, and shims for the Sandbox. Legacy mode delegates to the existing IM
 * credential environment manager unchanged.
 */
export class RuntimeCredentialEnvironmentManager {
  readonly #legacy?: ImCredentialEnvironmentManager;
  readonly #logger: Pick<ClientLogger, "debug" | "warn">;
  readonly #mode: RuntimeCredentialMode;
  readonly #options: RuntimeCredentialEnvironmentManagerOptions;
  readonly #platform: NodeJS.Platform;
  readonly #proxyExecutions = new Map<string, ActiveProxyExecution>();
  readonly #store?: RuntimeProxyMaterialStore;
  readonly #startupCleanup?: Promise<ImCredentialEnvironmentError | undefined>;
  #closed = false;

  constructor(options: RuntimeCredentialEnvironmentManagerOptions) {
    this.#options = options;
    this.#mode = options.mode ?? "legacy";
    this.#platform = options.platform ?? process.platform;
    this.#logger = options.logger ?? createLogger("runtime-credential-environment");
    if (this.#mode === "legacy") {
      this.#legacy = (options.legacy ?? ((legacyOptions) => new ImCredentialEnvironmentManager(legacyOptions)))({
        connection: options.connection,
        home: options.home,
        logger: options.logger,
        ...(options.platform ? { platform: options.platform } : {}),
      });
    }
    if (this.#mode === "proxy") {
      if (!options.serverUrl) throw new ImCredentialEnvironmentError("proxy_configuration_missing");
      if (this.#platform === "win32") throw new ImCredentialEnvironmentError("proxy_platform_unsupported");
      this.#store = new RuntimeProxyMaterialStore({ home: options.home });
      this.#startupCleanup = this.#store.cleanupStale().then(
        () => undefined,
        () => new ImCredentialEnvironmentError("stale_cleanup_failed"),
      );
    }
  }

  get mode(): RuntimeCredentialMode {
    return this.#mode;
  }

  pathForSession(sessionId: string): string {
    if (this.#mode === "proxy") return this.#requireStore().environmentFilePath(sessionId);
    return this.#requireLegacy().pathForSession(sessionId);
  }

  activeSlackConfigDirForSession(sessionId: string): string | undefined {
    if (this.#mode === "proxy") return this.#proxyExecutions.get(sessionId)?.slackConfigDir;
    return this.#requireLegacy().activeSlackConfigDirForSession(sessionId);
  }

  /** Proxy shim directory prepended to the Session PATH in proxy mode. */
  shimDirForSession(sessionId: string): string | undefined {
    if (this.#mode !== "proxy") return undefined;
    return this.#requireStore().shimDir(sessionId);
  }

  /**
   * Current execution CLI env map (defined values) for the Agent runtime: execution-scoped
   * handles and routing inputs only, never the standard proxy/CA variables. Provider CLI
   * children derive those from the same execution through `providerRoutingEnvironment`.
   */
  environmentForSession(sessionId: string): Readonly<Record<string, string>> | undefined {
    const active = this.#proxyExecutions.get(sessionId);
    if (!active) return undefined;
    return Object.fromEntries(
      Object.entries(active.environment).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
    );
  }

  /**
   * Raw execution environment for trusted host-side CLI children (for example Context Tree Git).
   * The standard proxy/CA variables are derived here because these consumers are allowed to use
   * the credential proxy; the Agent runtime environment intentionally never receives them. Unlike
   * `environmentForSession`, `undefined` entries are preserved so a caller can unset inherited
   * ambient credentials (for example a daemon-level `GITHUB_TOKEN`). Legacy mode returns
   * `undefined`; the returned map is valid only for the current execution.
   */
  executionEnvironmentForSession(sessionId: string): Readonly<Record<string, string | undefined>> | undefined {
    const environment = this.#proxyExecutions.get(sessionId)?.environment;
    if (!environment) return undefined;
    return { ...environment, ...providerRoutingEnvironment(environment) };
  }

  /** Current execution id for a Session, when a proxy execution is active. */
  executionIdForSession(sessionId: string): string | undefined {
    return this.#proxyExecutions.get(sessionId)?.executionId;
  }

  /** Trusted web tools launch facts for the Session's live execution, when authorized and started. */
  webToolsForSession(sessionId: string): PreparedWebToolsLaunch | undefined {
    return this.#proxyExecutions.get(sessionId)?.web;
  }

  async prepare(
    request: RuntimeCredentialPrepareSubject,
    signal?: AbortSignal,
  ): Promise<PreparedRuntimeCredentialEnvironment> {
    if (this.#mode === "legacy") {
      const prepared = await this.#requireLegacy().prepare(request, signal);
      return { ...prepared, providers: [prepared.provider] };
    }
    return this.#prepareProxy(request, signal);
  }

  /**
   * Open a Server-authorized validation execution through the same Relay/data path as a
   * business Run. Raw grant material is never accepted; the local adapter only receives
   * execution-local handles and the loopback CA. Release with `cleanup()` before reporting.
   */
  async prepareValidationSession(
    request: RuntimeCredentialValidationSubject,
    signal?: AbortSignal,
  ): Promise<PreparedProxyValidationSession> {
    if (this.#mode !== "proxy") throw new ImCredentialEnvironmentError("proxy_negotiation_unavailable");
    // Validation-scoped material key; the Server authorizes by validationRunId, never by a
    // business Session, and this key never grants access to an existing Session directory.
    const sessionId = `validation:${request.validationRunId}`;
    const prepared = await this.#prepareProxy(
      {
        agentId: request.agentId,
        placementGeneration: request.placementGeneration,
        sessionId,
        run: {
          runId: request.validationRunId,
          source: { kind: "validation", validationRunId: request.validationRunId },
        },
      },
      signal,
    );
    const executionId = prepared.executionId;
    if (!executionId) throw new ImCredentialEnvironmentError("proxy_unavailable");
    const active = this.#proxyExecutions.get(sessionId);
    const environment = {
      ...(this.environmentForSession(sessionId) ?? {}),
      ...providerRoutingEnvironment(active?.environment ?? {}),
    };
    const argumentsForProvider =
      active?.slackApiHost !== undefined ? (["--apihost", active.slackApiHost] as const) : ([] as const);
    return {
      arguments: argumentsForProvider,
      environment,
      executionId,
      signal: prepared.signal ?? new AbortController().signal,
      ...(active?.slackApiHost ? { slackApiHost: active.slackApiHost } : {}),
      cleanup: async () => {
        await this.cleanup(sessionId, executionId).catch(() => undefined);
      },
    };
  }

  async cleanup(sessionId: string, executionId?: string): Promise<void> {
    if (this.#mode === "legacy") return this.#requireLegacy().cleanup(sessionId);
    const active = this.#proxyExecutions.get(sessionId);
    if (executionId !== undefined && active && active.executionId !== executionId) {
      // Stale cleanup for a replaced execution: successor material stays untouched.
      return;
    }
    const targetExecutionId = executionId ?? active?.executionId;
    if (active) {
      this.#proxyExecutions.delete(sessionId);
      await this.#closeActive(active);
    }
    const store = this.#requireStore();
    if (targetExecutionId !== undefined) {
      await store.cleanupExecution(sessionId, targetExecutionId);
      return;
    }
    await store.cleanupSession(sessionId);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#mode === "legacy") return this.#requireLegacy().close();
    const startupFailure = await this.#startupCleanup;
    const sessions = [...this.#proxyExecutions.keys()];
    await Promise.all(sessions.map((sessionId) => this.cleanup(sessionId)));
    if (startupFailure) throw startupFailure;
  }

  async #prepareProxy(
    request: RuntimeCredentialPrepareSubject,
    signal?: AbortSignal,
  ): Promise<PreparedRuntimeCredentialEnvironment> {
    if (this.#closed) throw new ImCredentialEnvironmentError("client_shutdown");
    const startupFailure = await this.#startupCleanup;
    if (startupFailure) throw startupFailure;
    this.#assertProxyNegotiation();
    if (!request.run) throw new ImCredentialEnvironmentError("execution_source_required");
    this.#requireStore();
    const relay = await this.#openProxyRelay(request, request.run, signal);
    try {
      return await this.#materializeProxyExecution(request.sessionId, relay, signal);
    } catch (error) {
      await relay.close("materialization_failed").catch(() => undefined);
      throw toEnvironmentError(error);
    }
  }

  /** Explicit negotiation gate: unsupported Cloud/proxy can never fall back to raw material. */
  #assertProxyNegotiation(): void {
    const connection = this.#options.connection;
    if (
      connection.capabilityVersion(RUNTIME_CREDENTIAL_CAPABILITY) !== 1 ||
      connection.capabilityVersion(RUNTIME_PROVIDER_PROXY_CAPABILITY) !== 1
    ) {
      throw new ImCredentialEnvironmentError("proxy_negotiation_unavailable");
    }
  }

  /**
   * Web service opt-in: requested only when the deployment enabled web tools AND the Server
   * negotiated the webTools capability; the Server still grants per its own Account policy.
   */
  #requestedProxyServices(): readonly "web"[] | undefined {
    return this.#options.webTools && this.#options.connection.capabilityVersion(RUNTIME_WEB_TOOLS_CAPABILITY) === 1
      ? (["web"] as const)
      : undefined;
  }

  async #openProxyRelay(
    request: RuntimeCredentialPrepareSubject,
    run: RuntimeCredentialRunSubject,
    signal?: AbortSignal,
  ): Promise<RuntimeCredentialRelay> {
    const sandbox = this.#options.sandboxForSession?.(request.sessionId);
    const requestedServices = this.#requestedProxyServices();
    try {
      return await RuntimeCredentialRelay.open(
        {
          connection: this.#options.connection,
          ...(this.#options.dataConnectionFactory
            ? { dataConnectionFactory: this.#options.dataConnectionFactory }
            : {}),
          logger: this.#logger,
          ...(this.#options.now ? { now: this.#options.now } : {}),
          ...(this.#options.openBudgetMs ? { openBudgetMs: this.#options.openBudgetMs } : {}),
          ...(this.#options.scheduler ? { scheduler: this.#options.scheduler } : {}),
          serverUrl: this.#options.serverUrl ?? "",
        },
        {
          agentId: request.agentId,
          placementGeneration: request.placementGeneration,
          runId: run.runId,
          sessionId: request.sessionId,
          source: run.source,
          ...(sandbox ? { sandbox } : {}),
          ...(requestedServices ? { services: [...requestedServices] } : {}),
        },
        signal,
      );
    } catch (error) {
      throw toEnvironmentError(error);
    }
  }

  async #materializeProxyExecution(
    sessionId: string,
    relay: RuntimeCredentialRelay,
    signal?: AbortSignal,
  ): Promise<PreparedRuntimeCredentialEnvironment> {
    const store = this.#requireStore();
    await this.#closeReplacedProxyExecution(sessionId, store);
    signal?.throwIfAborted();
    const layout = store.executionLayout(sessionId, relay.executionId);
    const handles = collectProxyHandles(relay);
    const adapter = await this.#startProxyAdapter(relay, layout);
    try {
      const active = await this.#activateProxyExecution(sessionId, relay, store, layout, handles, adapter);
      return this.#preparedProxyResult(sessionId, relay, store, active);
    } catch (error) {
      await adapter.close().catch(() => undefined);
      await store.cleanupExecution(sessionId, relay.executionId).catch(() => undefined);
      throw error;
    }
  }

  /** One active execution per Session: close the replaced execution and its material first. */
  async #closeReplacedProxyExecution(sessionId: string, store: RuntimeProxyMaterialStore): Promise<void> {
    const previous = this.#proxyExecutions.get(sessionId);
    if (!previous) return;
    this.#proxyExecutions.delete(sessionId);
    await this.#closeActive(previous);
    await store.cleanupExecution(sessionId, previous.executionId);
  }

  async #startProxyAdapter(
    relay: RuntimeCredentialRelay,
    layout: ReturnType<RuntimeProxyMaterialStore["executionLayout"]>,
  ): Promise<RuntimeProxyLoopbackAdapter> {
    return RuntimeProxyLoopbackAdapter.start({
      executionId: relay.executionId,
      ...(this.#options.generateCa ? { generateCa: this.#options.generateCa } : {}),
      localHandleFor: (provider) => {
        try {
          return relay.localHandleFor(provider);
        } catch {
          return undefined;
        }
      },
      logger: this.#logger,
      materialDir: layout.executionDir,
      openStream: (request) => relay.openProviderStream(request),
      verifyHandle: (provider, handle) => relay.verifyLocalHandle(provider, handle),
    });
  }

  async #activateProxyExecution(
    sessionId: string,
    relay: RuntimeCredentialRelay,
    store: RuntimeProxyMaterialStore,
    layout: ReturnType<RuntimeProxyMaterialStore["executionLayout"]>,
    handles: Map<RuntimeProxyProvider, string>,
    adapter: RuntimeProxyLoopbackAdapter,
  ): Promise<ActiveProxyExecution> {
    const environment = buildRuntimeProxyEnvironment({
      adapterCaCertPath: adapter.caCertPath,
      cliMetadata: (provider) => relay.cliMetadataFor(provider),
      connectProxyUrl: adapter.connectProxyUrl,
      handles,
      layout,
      slackApiHost: adapter.slackApiHost,
    });
    await store.publish({
      adapterCaCertPath: adapter.caCertPath,
      environment,
      executionId: relay.executionId,
      handles,
      platform: this.#platform,
      sessionId,
    });
    const providers = relay.providers.map((provider) => provider.provider);
    const imProvider = providers.includes("feishu") ? "feishu" : providers.includes("slack") ? "slack" : undefined;
    const outboxContext = imProvider ? runtimeProxyOutboxContext(relay.cliMetadataFor(imProvider)) : undefined;
    const webGateway = await this.#startWebGateway(relay);
    const web = webGateway
      ? {
          extensionPath: this.#options.webTools?.extensionPath ?? "",
          socketPath: webGateway.gateway.socketPath,
        }
      : undefined;
    const active: ActiveProxyExecution = {
      adapter,
      environment,
      executionId: relay.executionId,
      ...(outboxContext ? { outboxContext } : {}),
      ...(imProvider ? { provider: imProvider } : {}),
      providers,
      relay,
      slackApiHost: adapter.slackApiHost,
      ...(imProvider === "slack" ? { slackConfigDir: layout.slackConfigDir } : {}),
      ...(web ? { web } : {}),
      ...(webGateway ? { webGateway: webGateway.gateway, webSocketDirectory: webGateway.socketDirectory } : {}),
    };
    this.#proxyExecutions.set(sessionId, active);
    relay.signal.addEventListener(
      "abort",
      () => {
        // Revocation/connection replacement: tear down the execution entry and material.
        if (this.#proxyExecutions.get(sessionId) === active) this.#proxyExecutions.delete(sessionId);
        void adapter.close().catch(() => undefined);
        void this.#closeWebGateway(active).catch(() => undefined);
        void store.cleanupExecution(sessionId, active.executionId).catch(() => undefined);
      },
      { once: true },
    );
    return active;
  }

  #preparedProxyResult(
    sessionId: string,
    relay: RuntimeCredentialRelay,
    store: RuntimeProxyMaterialStore,
    active: ActiveProxyExecution,
  ): PreparedRuntimeCredentialEnvironment {
    return {
      executionId: relay.executionId,
      environmentManifest: store.manifestPath(sessionId),
      ...(active.outboxContext ? { outboxContext: active.outboxContext } : {}),
      path: store.environmentFilePath(sessionId),
      ...(active.provider ? { provider: active.provider } : {}),
      providers: active.providers,
      signal: relay.signal,
      slackApiHost: active.slackApiHost,
      ...(active.slackConfigDir ? { slackConfigDir: active.slackConfigDir } : {}),
      ...(active.web ? { web: active.web } : {}),
    };
  }

  /**
   * Start the per-execution web gateway when the Server granted web scopes to this execution.
   * Every execution owns a fresh, short, private socket directory (mkdtemp under the OS temp
   * root, never a long Session storage path), so a stale descriptor from an earlier execution
   * can never reach a successor and a late close can never unlink a successor socket. A start
   * failure keeps the execution usable without web tools (the tools simply never register).
   */
  async #startWebGateway(
    relay: RuntimeCredentialRelay,
  ): Promise<{ gateway: WebToolsGatewayServer; socketDirectory: string } | undefined> {
    const options = this.#options.webTools;
    if (!options) return undefined;
    const webGrant = relay.services.find((service) => service.service === "web");
    if (!webGrant || webGrant.scopes.length === 0) return undefined;
    const client = new WebToolsServerClient({
      serverUrl: this.#options.serverUrl ?? "",
      machineToken: options.machineToken,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    const executionId = relay.executionId;
    let socketDirectory: string | undefined;
    try {
      const allocated = await allocateWebGatewaySocket();
      socketDirectory = allocated.directory;
      const gateway = await WebToolsGatewayServer.start({
        socketPath: allocated.socketPath,
        dispatch: async (input, signal) => {
          // The gateway injects the execution identity itself; the Sandbox only ever supplies
          // the runtime-generated toolCallId and validated business parameters.
          const request = {
            protocolVersion: WEB_TOOLS_PROTOCOL_VERSION,
            executionId,
            toolCallId: input.toolCallId,
            ...input.params,
          };
          try {
            return input.operation === "search"
              ? await client.search({
                  request: request as WebSearchExecutionRequest,
                  remainingMs: input.remainingMs,
                  signal,
                })
              : await client.fetch({
                  request: request as WebFetchExecutionRequest,
                  remainingMs: input.remainingMs,
                  signal,
                });
          } catch (error) {
            if (error instanceof WebToolsClientError) {
              throw new WebGatewayDispatchError(error.code, error.message, {
                ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
              });
            }
            throw error;
          }
        },
      });
      return { gateway, socketDirectory };
    } catch (error) {
      if (socketDirectory) {
        await rm(socketDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      this.#logger.warn(
        { code: "web_gateway_start_failed", error: runtimeProxyErrorReason(error) },
        "The web tools gateway could not start",
      );
      return undefined;
    }
  }

  /** Close one execution's gateway and remove only that execution's private socket directory. */
  async #closeWebGateway(active: ActiveProxyExecution): Promise<void> {
    await active.webGateway?.close().catch(() => undefined);
    if (active.webSocketDirectory) {
      await rm(active.webSocketDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async #closeActive(active: ActiveProxyExecution): Promise<void> {
    await this.#closeWebGateway(active);
    await active.adapter.close().catch(() => undefined);
    await active.relay.close("cleanup").catch((error: unknown) => {
      this.#logger.debug(
        { code: "proxy_execution_close_failed", error: runtimeProxyErrorReason(error) },
        "Proxy execution close failed",
      );
    });
  }

  #requireLegacy(): ImCredentialEnvironmentManager {
    if (!this.#legacy) throw new ImCredentialEnvironmentError("proxy_configuration_missing");
    return this.#legacy;
  }

  #requireStore(): RuntimeProxyMaterialStore {
    if (!this.#store) throw new ImCredentialEnvironmentError("proxy_configuration_missing");
    return this.#store;
  }
}

function collectProxyHandles(relay: RuntimeCredentialRelay): Map<RuntimeProxyProvider, string> {
  const handles = new Map<RuntimeProxyProvider, string>();
  for (const provider of relay.providers) handles.set(provider.provider, relay.localHandleFor(provider.provider));
  return handles;
}

function toEnvironmentError(error: unknown): ImCredentialEnvironmentError {
  if (error instanceof ImCredentialEnvironmentError) return error;
  if (error instanceof RuntimeCredentialRelayError) {
    const code =
      error.code === "execution_rejected" || error.code === "acquire_failed" || error.code === "ticket_failed"
        ? "execution_rejected"
        : error.code === "execution_not_ready" || error.code === "execution_timeout"
          ? "execution_not_ready"
          : error.code === "aborted"
            ? "aborted"
            : "proxy_unavailable";
    return new ImCredentialEnvironmentError(code);
  }
  return new ImCredentialEnvironmentError("proxy_unavailable");
}

export type { PreparedImCredentialEnvironment, RuntimeProxyEnvironment };
