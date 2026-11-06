import type { FastifyBaseLogger } from "fastify";
import {
  createPerformanceLogger,
  exitPerformanceContext,
  type PerformanceCategory,
  type PerformanceLogger,
  type PerformanceLoggingConfig,
  runWithPerformanceContext,
} from "./performance-logger.js";

const DEFAULT_EXCLUDED_METHODS = new Set([
  "constructor",
  "then",
  "catch",
  "finally",
  "toJSON",
  "toString",
  "valueOf",
  "start",
  "stop",
  "close",
  "snapshot",
  "currentInstanceId",
  "supportsCapability",
  "supportsProvider",
  "providerReadiness",
  "providerCliArtifactReadiness",
  "providerCliCredentialReadiness",
  "imCliReadiness",
  "isExecutionLive",
  "isControlActive",
  "isBusy",
  "admitUrl",
  "businessOptions",
  "notify",
  "onActiveBindingChanged",
  "onAgentPlacementChanged",
  "executionComputerId",
  "executionContext",
  "hasActiveCapacityLease",
  "inputInstance",
  "canBatch",
  "canSteer",
  "isModelPathConfigured",
  "isSandboxBusy",
  "attachConnection",
  "detachConnection",
  "sendRevocationToInstance",
]);

const SAFE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID_PATTERN.test(value) ? value : undefined;
}

function safeGeneration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickSafeId(sources: ReadonlyArray<Record<string, unknown> | undefined>, key: string): string | undefined {
  for (const source of sources) {
    const id = safeId(source?.[key]);
    if (id) return id;
  }
  return undefined;
}

function extractResourceIds(firstArg: unknown): {
  accountId?: string;
  agentId?: string;
  computerId?: string;
  sandboxId?: string;
  environmentGeneration?: number;
  sessionId?: string;
  deliveryId?: string;
  turnId?: string;
} {
  const record = asRecord(firstArg);
  if (!record) return {};
  const scope = asRecord(record.scope) ?? asRecord(record.allocation);
  const sources = [record, scope, asRecord(record.claims), asRecord(record.request)];
  const accountId = pickSafeId(sources, "accountId");
  const agentId = pickSafeId(sources, "agentId");
  const computerId = pickSafeId(sources, "computerId");
  const sandboxId = pickSafeId(sources, "sandboxId");
  const environmentGeneration =
    safeGeneration(record.environmentGeneration) ?? safeGeneration(scope?.environmentGeneration);
  const sessionId = pickSafeId(sources, "sessionId");
  const deliveryId = pickSafeId(sources, "deliveryId");
  const turnId = pickSafeId(sources, "turnId");
  return {
    ...(accountId ? { accountId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(computerId ? { computerId } : {}),
    ...(sandboxId ? { sandboxId } : {}),
    ...(environmentGeneration !== undefined ? { environmentGeneration } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
    ...(turnId ? { turnId } : {}),
  };
}

export interface InstrumentServiceOptions {
  serviceName: string;
  perfLogger: PerformanceLogger | undefined;
  category?: Extract<PerformanceCategory, "service" | "worker">;
  module?: string;
  excludeMethods?: ReadonlySet<string>;
}

const instrumentedServices = new WeakMap<object, unknown>();

export function instrumentService<T extends object>(instance: T, options: InstrumentServiceOptions): T;
export function instrumentService<T extends object>(
  instance: T | undefined,
  options: InstrumentServiceOptions,
): T | undefined;
export function instrumentService<T extends object>(
  instance: T | undefined,
  options: InstrumentServiceOptions,
): T | undefined {
  const perfLogger = options.perfLogger;
  if (!instance || !perfLogger?.config.enabled) return instance;
  const existing = instrumentedServices.get(instance);
  if (existing) return existing as T;

  const wrappedMethods = new Map<string, (...args: unknown[]) => unknown>();
  const category = options.category ?? "service";
  const moduleName = options.module ?? options.serviceName;

  const proxy = new Proxy(instance, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      if (
        typeof prop !== "string" ||
        prop.startsWith("_") ||
        DEFAULT_EXCLUDED_METHODS.has(prop) ||
        options.excludeMethods?.has(prop)
      ) {
        return value.bind(target);
      }
      let wrapped = wrappedMethods.get(prop);
      if (!wrapped) {
        const operation = `${options.serviceName}.${prop}`;
        wrapped = (...args: unknown[]) => {
          const ids = extractResourceIds(args[0]);
          return perfLogger.traceOperation(
            {
              module: moduleName,
              category,
              operation,
              ...ids,
            },
            () => Reflect.apply(value, target, args),
            {
              fallbackErrorCode: category === "worker" ? "WORKER_OPERATION_FAILED" : "SERVICE_OPERATION_FAILED",
            },
          );
        };
        wrappedMethods.set(prop, wrapped);
      }
      return wrapped;
    },
  });

  instrumentedServices.set(instance, proxy);
  return proxy;
}

function isWebSocketUpgradeRequest(request: { headers?: Record<string, unknown> }): boolean {
  const upgrade = request.headers?.upgrade;
  return typeof upgrade === "string" && upgrade.toLowerCase() === "websocket";
}

export function registerHttpPerformanceHooks(
  app: {
    addHook(
      name: "onRequest",
      hook: (
        request: {
          id: string;
          method: string;
          url: string;
          headers?: Record<string, unknown>;
          routeOptions?: { url?: string };
        },
        reply: unknown,
        done: () => void,
      ) => void,
    ): unknown;
    addHook(
      name: "onResponse" | "onRequestAbort",
      hook: (
        request: {
          id: string;
          method: string;
          url: string;
          headers?: Record<string, unknown>;
          routeOptions?: { url?: string };
        },
        reply?: { statusCode: number },
      ) => Promise<void> | void,
    ): unknown;
  },
  perfLogger: PerformanceLogger | undefined,
  options: {
    shouldIgnore: (request: { url: string; headers?: Record<string, unknown> }) => boolean;
    sanitizeUrl: (url: string) => string;
  },
): void {
  if (!perfLogger?.config.enabled) return;
  const handles = new WeakMap<object, ReturnType<PerformanceLogger["startOperation"]>>();

  app.addHook("onRequest", (request, _reply, done) => {
    if (options.shouldIgnore(request) || isWebSocketUpgradeRequest(request)) {
      exitPerformanceContext(done);
      return;
    }
    const route = request.routeOptions?.url ?? options.sanitizeUrl(request.url);
    const handle = perfLogger.startOperation({
      module: "http",
      category: "http",
      operation: `${request.method} ${route}`,
      requestId: request.id,
      attributes: {
        httpMethod: request.method,
        httpRoute: route,
      },
    });
    handles.set(request, handle);
    runWithPerformanceContext(handle.context, done);
  });

  app.addHook("onResponse", (request, reply) => {
    const handle = handles.get(request);
    if (!handle) return;
    handles.delete(request);
    const status = reply?.statusCode ?? 200;
    if (status >= 500) {
      handle.fail(undefined, { status }, "HTTP_REQUEST_FAILED");
    } else {
      handle.complete({ status });
    }
  });

  app.addHook("onRequestAbort", (request) => {
    const handle = handles.get(request);
    if (!handle) return;
    handles.delete(request);
    handle.fail(undefined, { aborted: true }, "HTTP_REQUEST_ABORTED");
  });
}

const TOP_LEVEL_SERVICE_NAMES: ReadonlyArray<readonly [string, string]> = [
  ["authService", "AuthService"],
  ["agentService", "AgentService"],
  ["agentSetupService", "AgentSetupService"],
  ["agentRuntimeOptionsService", "AgentRuntimeOptionsService"],
  ["agentRuntimeTestService", "AgentRuntimeTestService"],
  ["contextTreeOperationService", "ContextTreeOperationService"],
  ["computerService", "ComputerService"],
  ["machineAuthService", "MachineAuthService"],
  ["sandboxService", "SandboxService"],
  ["sandboxRunnerService", "SandboxRunnerService"],
  ["cloudOverviewService", "CloudOverviewService"],
  ["cloudUsage", "CloudUsageService"],
  ["runnerWorkspace", "RunnerWorkspaceService"],
  ["imBindingService", "ImBindingService"],
  ["feishuSetupService", "FeishuSetupService"],
  ["imResourceService", "ImResourceService"],
  ["taskService", "TaskService"],
  ["accountSetupService", "AccountSetupService"],
  ["setupResetService", "OnboardingResetService"],
];

const CONTAINER_SERVICE_FIELDS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ["connectCode", [["issuer", "ConnectCodeService"]]],
  ["slackOAuth", [["slackOAuth", "SlackOAuthService"]]],
  ["agentSchedules", [["service", "ScheduleService"]]],
  ["runtimeAgentSchedules", [["service", "ScheduleService"]]],
  ["runtimeAgent", [["service", "AgentSelfService"]]],
  ["runtimeAgentSlackProvision", [["service", "AgentSlackProvisionService"]]],
  ["runtimeDurableWork", [["store", "RuntimeDurableWorkStore"]]],
  ["runtimeWeb", [["service", "RuntimeWebService"]]],
  ["mcpGateway", [["service", "McpGatewayService"]]],
  ["cloudModel", [["modelService", "CloudModelService"]]],
  [
    "mcp",
    [
      ["authorization", "McpAuthorizationService"],
      ["flows", "McpOAuthFlowService"],
      ["servers", "McpServerService"],
    ],
  ],
  [
    "skills",
    [
      ["service", "SkillService"],
      ["remote", "RemoteSkillService"],
      ["preset", "SkillPresetService"],
      ["proofs", "SessionCliProofService"],
    ],
  ],
  [
    "slackConfiguration",
    [
      ["service", "SlackConfigurationService"],
      ["autoSetup", "SlackAutoSetupService"],
    ],
  ],
  [
    "runtimeSessions",
    [
      ["collaboration", "SessionCollaborationService"],
      ["proofs", "SessionCliProofService"],
      ["sessions", "SessionService"],
    ],
  ],
  [
    "runtime",
    [
      ["domainOwner", "RuntimeDomainOwner"],
      ["approvalOwner", "RuntimeApprovalOwner"],
    ],
  ],
  [
    "runnerChannel",
    [
      ["cloudDelivery", "CloudDeliveryOwner"],
      ["cloudSession", "CloudSessionCollaborationOwner"],
    ],
  ],
];

function wrapNestedField(
  container: Record<string, unknown>,
  field: string,
  serviceName: string,
  perfLogger: PerformanceLogger,
): void {
  const target = container[field];
  if (typeof target === "object" && target !== null) {
    container[field] = instrumentService(target, { serviceName, perfLogger });
  }
}

function wrapContainerFields(
  copy: Record<string, unknown>,
  containerKey: string,
  fields: ReadonlyArray<readonly [string, string]>,
  perfLogger: PerformanceLogger,
): void {
  const raw = copy[containerKey];
  if (typeof raw !== "object" || raw === null) return;
  const next = { ...(raw as Record<string, unknown>) };
  for (const [field, serviceName] of fields) {
    wrapNestedField(next, field, serviceName, perfLogger);
  }
  if (containerKey === "runtime" || containerKey === "runnerChannel" || containerKey === "cloudModel") {
    next.performanceLogger = perfLogger;
  }
  copy[containerKey] = next;
}

export function instrumentAppOptions<T extends object>(options: T, perfLogger: PerformanceLogger | undefined): T {
  if (!perfLogger?.config.enabled) return options;
  const copy = { ...(options as Record<string, unknown>) };

  for (const [key, serviceName] of TOP_LEVEL_SERVICE_NAMES) {
    wrapNestedField(copy, key, serviceName, perfLogger);
  }
  for (const [containerKey, fields] of CONTAINER_SERVICE_FIELDS) {
    wrapContainerFields(copy, containerKey, fields, perfLogger);
  }
  if (typeof copy.runnerChannel === "object" && copy.runnerChannel !== null) {
    copy.runnerChannel = {
      ...(copy.runnerChannel as Record<string, unknown>),
      performanceLogger: perfLogger,
    };
  }

  return copy as T;
}

const DEFAULT_WORKER_METHODS = [
  "runOnce",
  "runPass",
  "runJanitorOnce",
  "runExpiryOnce",
  "runRetentionOnce",
  "maintain",
  "maintainHeartbeat",
  "maintainSweep",
  "poll",
  "reconcile",
  "check",
  "refresh",
  "notifyComputerReady",
  "notifyCloudRunnerReady",
] as const;

const WORKER_METHOD_OVERRIDES: Readonly<Record<string, readonly string[]>> = {
  FeishuSetupService: ["maintainHeartbeat", "maintainSweep"],
  FeishuConnectionManager: ["maintain"],
  RuntimeApprovalOwner: ["poll"],
  CloudModelService: ["reconcile"],
  ImFeedbackWorker: ["runPass"],
};

const instrumentedWorkers = new WeakSet<object>();

export function instrumentWorker<T extends object>(
  worker: T | undefined,
  options: {
    workerName: string;
    perfLogger: PerformanceLogger | undefined;
    methods?: readonly string[];
  },
): T | undefined {
  const perfLogger = options.perfLogger;
  if (!worker || !perfLogger?.config.enabled || instrumentedWorkers.has(worker)) return worker;
  const methods = options.methods ?? WORKER_METHOD_OVERRIDES[options.workerName] ?? DEFAULT_WORKER_METHODS;
  const record = worker as Record<string, unknown>;
  for (const methodName of methods) {
    const original = Reflect.get(worker, methodName, worker);
    if (typeof original !== "function") continue;
    const operation = `${options.workerName}.${methodName}`;
    record[methodName] = (...args: unknown[]) =>
      perfLogger.traceOperation(
        {
          module: options.workerName,
          category: "worker",
          operation,
          ...extractResourceIds(args[0]),
        },
        () => Reflect.apply(original, worker, args),
        { fallbackErrorCode: "WORKER_OPERATION_FAILED" },
      );
  }
  instrumentedWorkers.add(worker);
  return worker;
}

export function instrumentServerWorkers(
  workers: ReadonlyArray<readonly [string, object | undefined]>,
  perfLogger: PerformanceLogger | undefined,
): void {
  if (!perfLogger?.config.enabled) return;
  for (const [workerName, worker] of workers) {
    instrumentWorker(worker, { workerName, perfLogger });
  }
}

export function prepareAppPerformance<
  T extends {
    performanceLogger?: PerformanceLogger;
    performanceLogging?: Partial<PerformanceLoggingConfig>;
  },
>(app: { log: FastifyBaseLogger }, options: T): { options: T; perfLogger: PerformanceLogger } {
  const perfLogger = options.performanceLogger ?? createPerformanceLogger(() => app.log, options.performanceLogging);
  return {
    options: instrumentAppOptions(options, perfLogger),
    perfLogger,
  };
}
