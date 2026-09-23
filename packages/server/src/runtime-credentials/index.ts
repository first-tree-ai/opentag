import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { DatabaseClient } from "../db/client.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { ConnectionRegistry, RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import type { ApplicationCipher } from "../services/crypto.js";
import { ImOutboundCapture } from "../services/im/im-outbound-capture.js";
import { RuntimeCapabilityStore } from "./capability-store.js";
import {
  type RuntimeConnectionFence,
  type RuntimeControlAuthority,
  RuntimeCredentialBroker,
} from "./credential-broker.js";
import { RuntimeProviderProxyTransport } from "./data-transport.js";
import { PostgresRuntimeExecutionAuthority, type RuntimeExecutionAuthority } from "./execution-authority.js";
import { RuntimeExecutionRegistry } from "./execution-registry.js";
import { FEISHU_OPERATIONS } from "./feishu-operations.js";
import { exchangeFeishuTenantToken, FeishuTenantTokenCache } from "./feishu-tenant-token.js";
import { type RuntimeGitHubAdmission, UnavailableRuntimeGitHubAdmission } from "./github-admission.js";
import { ImProviderMaterialResolver } from "./im-material.js";
import { McpGatewayExecutionAuthorizer } from "./mcp-gateway-execution.js";
import { RuntimeMcpGatewayTokenStore } from "./mcp-gateway-token-store.js";
import { LiveMcpServicePolicy, type McpUsableMountReader } from "./mcp-policy.js";
import { ProviderOperationRegistry } from "./operation-registry.js";
import { ImProviderProxyAdapter, type ProviderProxyAdapter } from "./provider-proxy-adapter.js";
import { RuntimeCredentialOwner, type RuntimeCredentialOwnerOptions } from "./runtime-credential-owner.js";
import { RuntimeScopeResolver, type RuntimeScopeResolverPort } from "./scope-resolver.js";
import { SLACK_OPERATIONS } from "./slack-operations.js";
import { DefaultRuntimeTaskPolicy, type RuntimeTaskPolicy } from "./task-policy.js";
import { RuntimeProxyTicketStore } from "./ticket-store.js";
import { RuntimeUrlHandleStore } from "./url-handle-store.js";
import { RuntimeValidationRunRegistry } from "./validation-runs.js";
import { RuntimeWebExecutionAuthorizer } from "./web-execution.js";
import { RuntimeWebGatewayTokenStore } from "./web-gateway-token-store.js";
import type { RuntimeWebRouterKeyResolver, RuntimeWebServicePolicy } from "./web-policy.js";
import type { RouterWebClient } from "./web-router-client.js";
import { RuntimeWebService } from "./web-service.js";

export * from "./capability-store.js";
export * from "./credential-broker.js";
export * from "./data-transport.js";
export * from "./execution-authority.js";
export * from "./execution-bearer-store.js";
export * from "./execution-registry.js";
export * from "./feishu-operations.js";
export * from "./feishu-tenant-token.js";
export * from "./github-admission.js";
export * from "./im-material.js";
export * from "./mcp-gateway-execution.js";
export * from "./mcp-gateway-token-store.js";
export * from "./mcp-policy.js";
export * from "./operation-registry.js";
export * from "./provider-material.js";
export * from "./provider-proxy-adapter.js";
export * from "./provider-proxy-support.js";
export * from "./runtime-credential-owner.js";
export * from "./runtime-validation-execution.js";
export * from "./scope-resolver.js";
export * from "./slack-operations.js";
export * from "./task-policy.js";
export * from "./ticket-store.js";
export * from "./trusted-control.js";
export * from "./types.js";
export * from "./upload-forward.js";
export * from "./url-handle-store.js";
export * from "./validation-runs.js";
export * from "./web-execution.js";
export * from "./web-gateway-token-store.js";
export * from "./web-policy.js";
export * from "./web-router-client.js";
export * from "./web-service.js";
export * from "./write-outcome.js";

export interface RuntimeCredentialServicesOptions {
  database: DatabaseClient;
  cipher: ApplicationCipher;
  registry: ConnectionRegistry;
  custody: RuntimeCustodyStore;
  logger?: ServiceLogger;
  /**
   * Additional exact connection fence composed with the Local registry fence (E4 Cloud Runner
   * connections). Local registry behavior is unchanged; a frame is current when EITHER fence
   * recognizes its exact (computerId, instanceId, connectionId).
   */
  additionalConnectionFence?: RuntimeConnectionFence;
  /**
   * Composed Local + Cloud control-connection authority for the credential owner (sweep, open
   * fence, revocation routing). Defaults to the Local registry alone; production passes the same
   * composed fence used by `additionalConnectionFence` plus the Cloud revocation sender.
   */
  controlAuthority?: RuntimeControlAuthority;
  /**
   * Parent-constructed execution registry. The parent builds it before the GitHub runtime policy
   * (whose constructor needs `execution.get`) and passes the same instance here so both share one
   * live execution view.
   */
  executions?: RuntimeExecutionRegistry;
  /** Test/deployment scope resolver override; defaults to the Postgres resolver. */
  scopeResolver?: RuntimeScopeResolverPort;
  /**
   * Live Cloud control credential check (the injected trusted verifier's activity check). Cloud
   * requests fail closed when this is missing; Local behavior is unchanged.
   */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
  /** Authoritative Account/owner task delegation. Defaults to the fail-closed policy. */
  taskPolicy?: RuntimeTaskPolicy;
  /** Fresh GitHub UAT admission. Defaults to unavailable, which denies GitHub execution. */
  gitHubAdmission?: RuntimeGitHubAdmission;
  authority?: RuntimeExecutionAuthority;
  fetchImpl?: typeof fetch;
  /** Parent-provided adapters (e.g. GitHub). IM adapters are constructed by default. */
  adapters?: ReadonlyMap<RuntimeCredentialProvider, ProviderProxyAdapter>;
  /**
   * Deployment web service wiring (policy + fixed Router client). Absent keeps the platform web
   * service fully off: no execution carries web scopes and no runtime web route exists.
   */
  web?: {
    readonly policy: RuntimeWebServicePolicy & RuntimeWebRouterKeyResolver;
    readonly router: RouterWebClient;
  };
  /**
   * MCP gateway wiring. Absent keeps the gateway fully off: no execution carries MCP scopes, no
   * token can be issued, and the route has nothing to authorize against.
   *
   * Only the mount reader is injected. Unlike the web service there is no deployment policy to
   * configure — binding an MCP Server in the web UI *is* the opt-in — so the parent passes the
   * service that can answer "does this Agent have a usable mount" and nothing else.
   */
  mcp?: { readonly mounts: McpUsableMountReader };
  sweepIntervalMs?: number;
}

/** The two handles the gateway route needs; neither is useful without the other. */
export interface McpGatewayServices {
  tokens: RuntimeMcpGatewayTokenStore;
  authorizer: McpGatewayExecutionAuthorizer;
}

/**
 * The web service and its execution-bearer store. Grouped because neither is useful without the
 * other: the service fences requests, and the store is the only thing that can name the Cloud
 * execution that made one.
 */
export interface WebGatewayServices {
  service: RuntimeWebService;
  tokens: RuntimeWebGatewayTokenStore;
}

export interface RuntimeCredentialServices {
  owner: RuntimeCredentialOwner;
  transport: RuntimeProviderProxyTransport;
  executions: RuntimeExecutionRegistry;
  capabilities: RuntimeCapabilityStore;
  tickets: RuntimeProxyTicketStore;
  validationRuns: RuntimeValidationRunRegistry;
  urlHandles: RuntimeUrlHandleStore;
  broker: RuntimeCredentialBroker;
  /** Present only when the deployment configured the web service. */
  web?: WebGatewayServices;
  /** Present only when the MCP gateway is wired; the route needs both to serve a request. */
  mcp?: McpGatewayServices;
  close(): void;
}

/** Builds the optional web service exactly once per stack; absent config keeps it fully off. */
function createRuntimeWebService(
  options: RuntimeCredentialServicesOptions,
  deps: {
    executions: RuntimeExecutionRegistry;
    scopeResolver: RuntimeScopeResolverPort;
    authority: RuntimeExecutionAuthority;
    connectionFence: RuntimeConnectionFence;
  },
): WebGatewayServices | undefined {
  const web = options.web;
  if (!web) return undefined;
  return {
    tokens: new RuntimeWebGatewayTokenStore(),
    service: new RuntimeWebService({
      authorizer: new RuntimeWebExecutionAuthorizer({
        executions: deps.executions,
        scopeResolver: deps.scopeResolver,
        authority: deps.authority,
        connectionFence: deps.connectionFence,
        ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
      }),
      policy: web.policy,
      router: web.router,
      executions: deps.executions,
      ...(options.logger ? { logger: options.logger } : {}),
    }),
  };
}

/**
 * Builds the optional MCP gateway pieces exactly once per stack; absent config keeps it fully off.
 *
 * The token store and the fence are returned together because neither is useful alone: a token that
 * nothing re-checks would be a bearer credential with no fence, and a fence with no store would have
 * nothing to authenticate.
 */
function createMcpGatewayServices(
  options: RuntimeCredentialServicesOptions,
  deps: {
    executions: RuntimeExecutionRegistry;
    scopeResolver: RuntimeScopeResolverPort;
    authority: RuntimeExecutionAuthority;
    connectionFence: RuntimeConnectionFence;
  },
): McpGatewayServices | undefined {
  if (!options.mcp) return undefined;
  return {
    tokens: new RuntimeMcpGatewayTokenStore(),
    authorizer: new McpGatewayExecutionAuthorizer({
      executions: deps.executions,
      scopeResolver: deps.scopeResolver,
      authority: deps.authority,
      connectionFence: deps.connectionFence,
      ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
    }),
  };
}

/** The composed MCP handles, as the optional field of the services result. */
function mcpServicesResult(mcp: McpGatewayServices | undefined): { mcp?: McpGatewayServices } {
  return mcp ? { mcp } : {};
}

/**
 * The MCP fields the credential owner needs, as one object.
 *
 * Grouped rather than spread inline so the composition function stays under the complexity ratchet,
 * and because the policy and the token store are two halves of one decision: the gateway is either
 * wired or it is not.
 */
function mcpOwnerOptions(
  options: RuntimeCredentialServicesOptions,
  mcp: McpGatewayServices | undefined,
): Partial<RuntimeCredentialOwnerOptions> {
  if (!options.mcp || !mcp) return {};
  return { mcpPolicy: new LiveMcpServicePolicy(options.mcp.mounts), mcpGatewayTokens: mcp.tokens };
}

/**
 * The owner's platform-service options as one object: the web policy and bearer store, plus the MCP
 * policy and bearer store. Grouped for the same reason the MCP pair is — a service is either wired
 * with both halves or not wired at all — and to keep the composition function readable.
 */
function gatewayOwnerOptions(
  options: RuntimeCredentialServicesOptions,
  mcp: McpGatewayServices | undefined,
  web: WebGatewayServices | undefined,
): Partial<RuntimeCredentialOwnerOptions> {
  return {
    ...(options.web ? { webPolicy: options.web.policy } : {}),
    ...(web ? { webGatewayTokens: web.tokens } : {}),
    ...mcpOwnerOptions(options, mcp),
  };
}

/**
 * Composes the whole Server runtime credential stack with production defaults: IM adapters over
 * the registered operation tables, Feishu tenant token caching, and a fail-closed GitHub
 * admission port until the parent injects the authoritative implementation. The parent composes
 * this once from `app.ts` and wires `owner` into `registerRuntimeRoutes` and `transport` into
 * `registerRuntimeProviderProxyRoutes`.
 */
export function createRuntimeCredentialServices(options: RuntimeCredentialServicesOptions): RuntimeCredentialServices {
  const executions = options.executions ?? new RuntimeExecutionRegistry();
  const capabilities = new RuntimeCapabilityStore();
  const tickets = new RuntimeProxyTicketStore();
  const validationRuns = new RuntimeValidationRunRegistry();
  const urlHandles = new RuntimeUrlHandleStore();
  const scopeResolver = options.scopeResolver ?? new RuntimeScopeResolver(options.database);
  const policy = options.taskPolicy ?? new DefaultRuntimeTaskPolicy();
  const gitHubAdmission = options.gitHubAdmission ?? new UnavailableRuntimeGitHubAdmission();
  const authority =
    options.authority ??
    new PostgresRuntimeExecutionAuthority({
      database: options.database,
      custody: options.custody,
      validationRuns,
    });
  const tenantTokens = new FeishuTenantTokenCache(
    options.fetchImpl
      ? {
          exchange: (input) => exchangeFeishuTenantToken({ ...input, fetchImpl: options.fetchImpl as typeof fetch }),
        }
      : {},
  );
  const materialResolver = new ImProviderMaterialResolver({
    database: options.database,
    cipher: options.cipher,
    tenantTokens,
  });
  const connectionFence = options.additionalConnectionFence
    ? composeConnectionFences(registryConnectionFence(options.registry), options.additionalConnectionFence)
    : registryConnectionFence(options.registry);
  const broker = new RuntimeCredentialBroker({
    capabilities,
    executions,
    scopeResolver,
    policy,
    gitHubAdmission,
    authority,
    connectionFence,
    ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
    materialResolvers: {
      slack: materialResolver,
      feishu: materialResolver,
    },
  });
  const adapters = createImAdapters(options, urlHandles);
  const mcp = createMcpGatewayServices(options, { executions, scopeResolver, authority, connectionFence });
  const web = createRuntimeWebService(options, { executions, scopeResolver, authority, connectionFence });
  const owner = new RuntimeCredentialOwner({
    registry: options.registry,
    ...(options.controlAuthority ? { controlAuthority: options.controlAuthority } : {}),
    executions,
    capabilities,
    tickets,
    validationRuns,
    authority,
    scopeResolver,
    broker,
    policy,
    gitHubAdmission,
    ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
    ...gatewayOwnerOptions(options, mcp, web),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.sweepIntervalMs !== undefined ? { sweepIntervalMs: options.sweepIntervalMs } : {}),
  });
  const transport = new RuntimeProviderProxyTransport({
    broker,
    adapters,
    tickets,
    executions,
    connectionFence,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const unsubscribeHandles = executions.onClose((event) => {
    urlHandles.revokeExecution(event.executionId);
  });
  return {
    owner,
    transport,
    executions,
    capabilities,
    tickets,
    validationRuns,
    urlHandles,
    broker,
    ...(web ? { web } : {}),
    ...mcpServicesResult(mcp),
    close: () => {
      unsubscribeHandles();
      owner.close();
      tenantTokens.clear();
    },
  };
}

/** A frame/execution is current when ANY composed fence recognizes its exact connection. */
function composeConnectionFences(...fences: readonly RuntimeConnectionFence[]): RuntimeConnectionFence {
  return {
    isCurrent: (computerId, instanceId, connectionId) =>
      fences.some((fence) => fence.isCurrent(computerId, instanceId, connectionId)),
    currentControlIdentity: (computerId) => {
      for (const fence of fences) {
        const identity = fence.currentControlIdentity?.(computerId);
        if (identity) return identity;
      }
      return undefined;
    },
  };
}

function registryConnectionFence(registry: ConnectionRegistry): RuntimeConnectionFence {
  return {
    isCurrent: (computerId, instanceId, connectionId) =>
      registry.isCurrentConnection(computerId, instanceId, connectionId),
    currentControlIdentity: (computerId) => registry.currentControlIdentity(computerId),
  };
}

/** Parent-provided adapters win; the Slack/Feishu IM adapters are constructed over their tables. */
function createImAdapters(
  options: RuntimeCredentialServicesOptions,
  urlHandles: RuntimeUrlHandleStore,
): Map<RuntimeCredentialProvider, ProviderProxyAdapter> {
  const adapters = new Map<RuntimeCredentialProvider, ProviderProxyAdapter>(options.adapters ?? []);
  const outboundCapture = new ImOutboundCapture(options.database, {
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const defaults = [
    ["slack", SLACK_OPERATIONS],
    ["feishu", FEISHU_OPERATIONS],
  ] as const;
  for (const [provider, operations] of defaults) {
    if (adapters.has(provider)) continue;
    adapters.set(
      provider,
      new ImProviderProxyAdapter({
        provider,
        registry: new ProviderOperationRegistry(operations),
        urlHandles,
        outboundCapture,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
      }),
    );
  }
  return adapters;
}
