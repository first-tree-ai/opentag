import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { DatabaseClient } from "../db/client.js";
import type { ServiceLogger } from "../observability/service-logger.js";
import type { ConnectionRegistry, RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import type { ApplicationCipher } from "../services/crypto.js";
import { RuntimeCapabilityStore } from "./capability-store.js";
import { type RuntimeConnectionFence, RuntimeCredentialBroker } from "./credential-broker.js";
import { RuntimeProviderProxyTransport } from "./data-transport.js";
import { PostgresRuntimeExecutionAuthority, type RuntimeExecutionAuthority } from "./execution-authority.js";
import { RuntimeExecutionRegistry } from "./execution-registry.js";
import { FEISHU_OPERATIONS } from "./feishu-operations.js";
import { exchangeFeishuTenantToken, FeishuTenantTokenCache } from "./feishu-tenant-token.js";
import { type RuntimeGitHubAdmission, UnavailableRuntimeGitHubAdmission } from "./github-admission.js";
import { ImProviderMaterialResolver } from "./im-material.js";
import { ProviderOperationRegistry } from "./operation-registry.js";
import { ImProviderProxyAdapter, type ProviderProxyAdapter } from "./provider-proxy-adapter.js";
import { RuntimeCredentialOwner } from "./runtime-credential-owner.js";
import { RuntimeScopeResolver, type RuntimeScopeResolverPort } from "./scope-resolver.js";
import { SLACK_OPERATIONS } from "./slack-operations.js";
import { type RuntimeSourceRecorder, UnavailableRuntimeSourceRecorder } from "./source-recorder.js";
import { DefaultRuntimeTaskPolicy, type RuntimeTaskPolicy } from "./task-policy.js";
import { RuntimeProxyTicketStore } from "./ticket-store.js";
import { RuntimeUrlHandleStore } from "./url-handle-store.js";
import { RuntimeValidationRunRegistry } from "./validation-runs.js";
import { type RuntimeWriteJournal, UnavailableRuntimeWriteJournal } from "./write-journal.js";

export * from "./capability-store.js";
export * from "./credential-broker.js";
export * from "./data-transport.js";
export * from "./execution-authority.js";
export * from "./execution-registry.js";
export * from "./feishu-operations.js";
export * from "./feishu-tenant-token.js";
export * from "./github-admission.js";
export * from "./im-material.js";
export * from "./operation-registry.js";
export * from "./provider-material.js";
export * from "./provider-proxy-adapter.js";
export * from "./provider-proxy-support.js";
export * from "./runtime-credential-owner.js";
export * from "./runtime-validation-execution.js";
export * from "./scope-resolver.js";
export * from "./slack-operations.js";
export * from "./source-recorder.js";
export * from "./task-policy.js";
export * from "./ticket-store.js";
export * from "./trusted-control.js";
export * from "./types.js";
export * from "./url-handle-store.js";
export * from "./validation-runs.js";
export * from "./write-journal.js";

export interface RuntimeCredentialServicesOptions {
  database: DatabaseClient;
  cipher: ApplicationCipher;
  registry: ConnectionRegistry;
  custody: RuntimeCustodyStore;
  logger?: ServiceLogger;
  /**
   * Parent-constructed execution registry. The parent builds it before the GitHub runtime policy
   * (whose constructor needs `execution.get`) and passes the same instance here so both share one
   * live execution view.
   */
  executions?: RuntimeExecutionRegistry;
  /** Test/deployment scope resolver override; defaults to the Postgres resolver. */
  scopeResolver?: RuntimeScopeResolverPort;
  /**
   * Live Cloud control credential check (`FileCloudControlAuthority.isActive`). Cloud requests
   * fail closed when this is missing; Local behavior is unchanged.
   */
  cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
  /** Authoritative Account/owner task delegation. Defaults to the fail-closed policy. */
  taskPolicy?: RuntimeTaskPolicy;
  /** Fresh GitHub UAT admission. Defaults to unavailable, which denies GitHub execution. */
  gitHubAdmission?: RuntimeGitHubAdmission;
  /** Parent-owned durable write intent/outcome store (SessionControlStore). */
  writeJournal?: RuntimeWriteJournal;
  /** Parent-owned durable source recorder for protected read outputs. */
  sourceRecorder?: RuntimeSourceRecorder;
  authority?: RuntimeExecutionAuthority;
  fetchImpl?: typeof fetch;
  /** Parent-provided adapters (e.g. GitHub). IM adapters are constructed by default. */
  adapters?: ReadonlyMap<RuntimeCredentialProvider, ProviderProxyAdapter>;
  sweepIntervalMs?: number;
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
  close(): void;
}

/**
 * Composes the whole Server runtime credential stack with production defaults: IM adapters over
 * the registered operation tables, Feishu tenant token caching, and fail-closed GitHub/journal/
 * source ports until the parent injects the authoritative implementations. The parent composes
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
  const connectionFence = registryConnectionFence(options.registry);
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
  const journal = options.writeJournal ?? new UnavailableRuntimeWriteJournal();
  const sourceRecorder = options.sourceRecorder ?? new UnavailableRuntimeSourceRecorder();
  const adapters = createImAdapters(options, urlHandles, journal, sourceRecorder);
  const owner = new RuntimeCredentialOwner({
    registry: options.registry,
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
    close: () => {
      unsubscribeHandles();
      owner.close();
      tenantTokens.clear();
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
  journal: RuntimeWriteJournal,
  sourceRecorder: RuntimeSourceRecorder,
): Map<RuntimeCredentialProvider, ProviderProxyAdapter> {
  const adapters = new Map<RuntimeCredentialProvider, ProviderProxyAdapter>(options.adapters ?? []);
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
        journal,
        sourceRecorder,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      }),
    );
  }
  return adapters;
}
