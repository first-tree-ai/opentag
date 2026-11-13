import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { redactForLog, StructuredErrorCodeSchema } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";
import { createServiceLoggerPort, type ServiceLogger } from "./service-logger.js";

export type PerformanceLogLevel = "debug" | "info" | "warn";
export type PerformanceCategory = "http" | "ws" | "worker" | "service" | "db" | "external";

export interface PerformanceLoggingConfig {
  enabled: boolean;
  level: PerformanceLogLevel;
  slowThresholdMs: number;
  dbLevel?: PerformanceLogLevel;
  startLevel?: PerformanceLogLevel;
}

export const DEFAULT_PERFORMANCE_LOGGING_CONFIG: PerformanceLoggingConfig = {
  enabled: true,
  level: "debug",
  slowThresholdMs: 1_000,
};

const VALID_PERFORMANCE_LOG_LEVELS = new Set<PerformanceLogLevel>(["debug", "info", "warn"]);

function parsePerformanceLogLevel(
  raw: string | undefined,
  envName: string,
  fallback: PerformanceLogLevel,
): PerformanceLogLevel {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (VALID_PERFORMANCE_LOG_LEVELS.has(trimmed as PerformanceLogLevel)) {
    return trimmed as PerformanceLogLevel;
  }
  throw new Error(`${envName} must be one of: debug, info, warn`);
}

function parsePerformanceLogEnabled(raw: string | undefined): boolean {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_PERFORMANCE_LOGGING_CONFIG.enabled;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error("OPENTAG_PERF_LOG_ENABLED must be true or false");
}

function parseSlowThresholdMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_PERFORMANCE_LOGGING_CONFIG.slowThresholdMs;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("OPENTAG_PERF_SLOW_THRESHOLD_MS must be a positive integer");
  }
  return parsed;
}

export function resolvePerformanceLoggingConfig(env: NodeJS.ProcessEnv = process.env): PerformanceLoggingConfig {
  return {
    enabled: parsePerformanceLogEnabled(env.OPENTAG_PERF_LOG_ENABLED),
    level: parsePerformanceLogLevel(
      env.OPENTAG_PERF_LOG_LEVEL,
      "OPENTAG_PERF_LOG_LEVEL",
      DEFAULT_PERFORMANCE_LOGGING_CONFIG.level,
    ),
    dbLevel: parsePerformanceLogLevel(env.OPENTAG_PERF_DB_LOG_LEVEL, "OPENTAG_PERF_DB_LOG_LEVEL", "debug"),
    startLevel: parsePerformanceLogLevel(env.OPENTAG_PERF_START_LOG_LEVEL, "OPENTAG_PERF_START_LOG_LEVEL", "debug"),
    slowThresholdMs: parseSlowThresholdMs(env.OPENTAG_PERF_SLOW_THRESHOLD_MS),
  };
}

export interface PerformanceExecutionContext {
  requestId?: string;
  callId: string;
  operation: string;
  accountId?: string;
  agentId?: string;
  computerId?: string;
  sandboxId?: string;
  environmentGeneration?: number;
  sessionId?: string;
  deliveryId?: string;
  messageId?: string;
  dispatchRequestId?: string;
  attempt?: number;
  turnId?: string;
}

export interface PerformanceStartInput {
  module: string;
  category: PerformanceCategory;
  operation: string;
  requestId?: string;
  accountId?: string;
  agentId?: string;
  computerId?: string;
  sandboxId?: string;
  environmentGeneration?: number;
  sessionId?: string;
  deliveryId?: string;
  messageId?: string;
  dispatchRequestId?: string;
  attempt?: number;
  turnId?: string;
  attributes?: Record<string, unknown>;
  startMessage?: string;
  completeMessage?: string;
  failMessage?: string;
}

export interface PerformanceOperationHandle {
  readonly callId: string;
  readonly startedAt: string;
  readonly context: PerformanceExecutionContext;
  complete(extraAttributes?: Record<string, unknown>): void;
  fail(error: unknown, extraAttributes?: Record<string, unknown>, fallbackErrorCode?: string): void;
}

export interface PerformanceTraceOptions<T> {
  resultAttributes?: (result: T) => Record<string, unknown> | undefined;
  errorAttributes?: (error: unknown) => Record<string, unknown> | undefined;
  fallbackErrorCode?: string;
}

export interface PerformanceLogger {
  readonly config: PerformanceLoggingConfig;
  startOperation(input: PerformanceStartInput): PerformanceOperationHandle;
  traceAsync<T>(
    input: PerformanceStartInput,
    fn: (handle: PerformanceOperationHandle) => Promise<T>,
    options?: PerformanceTraceOptions<T>,
  ): Promise<T>;
  traceOperation<T>(
    input: PerformanceStartInput,
    fn: (handle: PerformanceOperationHandle) => Promise<T> | T,
    options?: PerformanceTraceOptions<T>,
  ): Promise<T> | T;
}

const performanceContextStorage = new AsyncLocalStorage<PerformanceExecutionContext>();
const contextLoggers = new WeakMap<PerformanceExecutionContext, PerformanceLogger>();
const contextAttributes = new WeakMap<PerformanceExecutionContext, Record<string, unknown>>();

export function getCurrentPerformanceContext(): PerformanceExecutionContext | undefined {
  return performanceContextStorage.getStore();
}

export function getCurrentPerformanceLogger(): PerformanceLogger | undefined {
  const current = performanceContextStorage.getStore();
  return current ? contextLoggers.get(current) : undefined;
}

export function setCurrentPerformanceAttributes(attributes: Record<string, unknown>): void {
  const current = performanceContextStorage.getStore();
  if (!current) return;
  let target = contextAttributes.get(current);
  if (!target) {
    target = {};
    contextAttributes.set(current, target);
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined) target[key] = value;
  }
}

export function runWithPerformanceContext<T>(context: PerformanceExecutionContext, fn: () => T): T {
  const parent = performanceContextStorage.getStore();
  if (parent && !contextLoggers.has(context)) {
    const parentLogger = contextLoggers.get(parent);
    if (parentLogger) contextLoggers.set(context, parentLogger);
  }
  return performanceContextStorage.run(context, fn);
}

export function exitPerformanceContext<T>(fn: () => T): T {
  return performanceContextStorage.exit(fn);
}

export function updateCurrentPerformanceContext(
  patch: Partial<Omit<PerformanceExecutionContext, "callId" | "operation">>,
): void {
  const current = performanceContextStorage.getStore();
  if (!current) return;
  const target = current as unknown as Record<string, unknown>;
  for (const key of CONTEXT_ID_KEYS) {
    const value = patch[key];
    if (value !== undefined) target[key] = value;
  }
}

function roundDurationMs(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
  return Math.round(elapsedMs * 100) / 100;
}

function isSafeErrorCode(candidate: unknown): candidate is string {
  if (typeof candidate !== "string") return false;
  if (!StructuredErrorCodeSchema.safeParse(candidate).success) return false;
  return redactForLog(candidate) === candidate;
}

export function safePerformanceErrorCode(error: unknown, fallbackCode?: string): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth <= 3 && cursor && typeof cursor === "object"; depth += 1) {
    try {
      const code = (cursor as { code?: unknown }).code;
      if (isSafeErrorCode(code)) return code;
      cursor = (cursor as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return isSafeErrorCode(fallbackCode) ? fallbackCode : undefined;
}

const START_MESSAGES: Record<PerformanceCategory, string> = {
  http: "HTTP request started",
  ws: "WebSocket frame started",
  worker: "Worker operation started",
  service: "Service operation started",
  db: "Database query started",
  external: "External call started",
};

const COMPLETE_MESSAGES: Record<PerformanceCategory, string> = {
  http: "HTTP request completed",
  ws: "WebSocket frame completed",
  worker: "Worker operation completed",
  service: "Service operation completed",
  db: "Database query completed",
  external: "External call completed",
};

const FAIL_MESSAGES: Record<PerformanceCategory, string> = {
  http: "HTTP request failed",
  ws: "WebSocket frame failed",
  worker: "Worker operation failed",
  service: "Service operation failed",
  db: "Database query failed",
  external: "External call failed",
};

const CONTEXT_ID_KEYS = [
  "requestId",
  "accountId",
  "agentId",
  "computerId",
  "sandboxId",
  "environmentGeneration",
  "sessionId",
  "deliveryId",
  "messageId",
  "dispatchRequestId",
  "attempt",
  "turnId",
] as const;

function copyDefinedContextIds(
  source: Partial<Record<(typeof CONTEXT_ID_KEYS)[number], unknown>>,
): Partial<Omit<PerformanceExecutionContext, "callId" | "operation">> {
  const out: Record<string, unknown> = {};
  for (const key of CONTEXT_ID_KEYS) {
    const value = source[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  return out as Partial<Omit<PerformanceExecutionContext, "callId" | "operation">>;
}

function buildChildContext(
  callId: string,
  input: PerformanceStartInput,
  parent: PerformanceExecutionContext | undefined,
): PerformanceExecutionContext {
  return {
    callId,
    operation: input.operation,
    ...(parent ? copyDefinedContextIds(parent) : {}),
    ...copyDefinedContextIds(input),
  };
}

function buildBasePayload(
  input: PerformanceStartInput,
  child: PerformanceExecutionContext,
  parent: PerformanceExecutionContext | undefined,
  startedAt: string,
): Record<string, unknown> {
  return {
    perfCategory: input.category,
    operation: input.operation,
    callId: child.callId,
    ...(parent?.callId ? { parentCallId: parent.callId } : {}),
    ...(parent?.operation ? { callerOperation: parent.operation } : {}),
    ...copyDefinedContextIds(child),
    startedAt,
    ...input.attributes,
  };
}

function isPromiseLike<T>(value: unknown): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

function isEntrypointCategory(category: PerformanceCategory): boolean {
  return category === "http" || category === "ws" || category === "worker";
}

export function createPerformanceLogger(
  getLogger: () => FastifyBaseLogger | undefined,
  configOverride?: Partial<PerformanceLoggingConfig>,
): PerformanceLogger {
  const level = configOverride?.level ?? DEFAULT_PERFORMANCE_LOGGING_CONFIG.level;
  const dbLevel = configOverride?.dbLevel ?? level;
  const startLevel = configOverride?.startLevel ?? level;
  const config: PerformanceLoggingConfig = {
    enabled: configOverride?.enabled ?? DEFAULT_PERFORMANCE_LOGGING_CONFIG.enabled,
    level,
    slowThresholdMs: configOverride?.slowThresholdMs ?? DEFAULT_PERFORMANCE_LOGGING_CONFIG.slowThresholdMs,
    ...(configOverride?.dbLevel !== undefined ? { dbLevel: configOverride.dbLevel } : {}),
    ...(configOverride?.startLevel !== undefined ? { startLevel: configOverride.startLevel } : {}),
  };
  const ports = new Map<string, ServiceLogger>();

  const portFor = (module: string): ServiceLogger => {
    let port = ports.get(module);
    if (!port) {
      port = createServiceLoggerPort(getLogger, module);
      ports.set(module, port);
    }
    return port;
  };

  const startOperation = (input: PerformanceStartInput): PerformanceOperationHandle => {
    const parent = isEntrypointCategory(input.category) ? undefined : getCurrentPerformanceContext();
    const callId = randomUUID();
    const startedAt = new Date().toISOString();
    const childContext = buildChildContext(callId, input, parent);
    if (!config.enabled) {
      return {
        callId,
        startedAt,
        context: childContext,
        complete: () => undefined,
        fail: () => undefined,
      };
    }
    contextLoggers.set(childContext, loggerInstance);

    const startMono = performance.now();
    const port = portFor(input.module);
    const basePayload = buildBasePayload(input, childContext, parent, startedAt);
    port[startLevel]({ ...basePayload, outcome: "started" }, input.startMessage ?? START_MESSAGES[input.category]);

    let settled = false;
    return {
      callId,
      startedAt,
      context: childContext,
      complete(extraAttributes) {
        if (settled) return;
        settled = true;
        const endedAt = new Date().toISOString();
        const durationMs = roundDurationMs(performance.now() - startMono);
        const slow = durationMs >= config.slowThresholdMs;
        const completeLevel = input.category === "db" ? (slow ? config.level : dbLevel) : config.level;
        port[completeLevel](
          {
            ...basePayload,
            ...copyDefinedContextIds(childContext),
            ...contextAttributes.get(childContext),
            ...extraAttributes,
            endedAt,
            durationMs,
            ...(slow ? { slow: true } : {}),
            outcome: "completed",
          },
          input.completeMessage ?? COMPLETE_MESSAGES[input.category],
        );
      },
      fail(error, extraAttributes, fallbackErrorCode) {
        if (settled) return;
        settled = true;
        const endedAt = new Date().toISOString();
        const durationMs = roundDurationMs(performance.now() - startMono);
        const slow = durationMs >= config.slowThresholdMs;
        const code = safePerformanceErrorCode(error, fallbackErrorCode);
        port.warn(
          {
            ...basePayload,
            ...copyDefinedContextIds(childContext),
            ...contextAttributes.get(childContext),
            ...extraAttributes,
            ...(code ? { code, errorCode: code } : {}),
            endedAt,
            durationMs,
            ...(slow ? { slow: true } : {}),
            outcome: "failed",
          },
          input.failMessage ?? FAIL_MESSAGES[input.category],
        );
      },
    };
  };

  const settlePromise = <T>(
    promise: Promise<T>,
    handle: PerformanceOperationHandle,
    options?: PerformanceTraceOptions<T>,
  ): Promise<T> =>
    promise.then(
      (result) => {
        let extra: Record<string, unknown> | undefined;
        try {
          extra = options?.resultAttributes?.(result);
        } catch {
          extra = undefined;
        }
        handle.complete(extra);
        return result;
      },
      (error: unknown) => {
        let extra: Record<string, unknown> | undefined;
        try {
          extra = options?.errorAttributes?.(error);
        } catch {
          extra = undefined;
        }
        handle.fail(error, extra, options?.fallbackErrorCode);
        throw error;
      },
    );

  const traceOperation = <T>(
    input: PerformanceStartInput,
    fn: (handle: PerformanceOperationHandle) => Promise<T> | T,
    options?: PerformanceTraceOptions<T>,
  ): Promise<T> | T => {
    if (!config.enabled) {
      return fn({
        callId: "",
        startedAt: "",
        context: { callId: "", operation: input.operation },
        complete: () => undefined,
        fail: () => undefined,
      });
    }
    const handle = startOperation(input);
    return runWithPerformanceContext(handle.context, () => {
      let output: Promise<T> | T;
      try {
        output = fn(handle);
      } catch (error) {
        let extra: Record<string, unknown> | undefined;
        try {
          extra = options?.errorAttributes?.(error);
        } catch {
          extra = undefined;
        }
        handle.fail(error, extra, options?.fallbackErrorCode);
        throw error;
      }
      if (isPromiseLike<T>(output)) {
        return settlePromise(output, handle, options);
      }
      let extra: Record<string, unknown> | undefined;
      try {
        extra = options?.resultAttributes?.(output);
      } catch {
        extra = undefined;
      }
      handle.complete(extra);
      return output;
    });
  };

  const traceAsync = async <T>(
    input: PerformanceStartInput,
    fn: (handle: PerformanceOperationHandle) => Promise<T>,
    options?: PerformanceTraceOptions<T>,
  ): Promise<T> => traceOperation(input, fn, options);

  const loggerInstance: PerformanceLogger = {
    config,
    startOperation,
    traceAsync,
    traceOperation,
  };
  return loggerInstance;
}
