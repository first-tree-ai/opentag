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
}

export const DEFAULT_PERFORMANCE_LOGGING_CONFIG: PerformanceLoggingConfig = {
  enabled: true,
  level: "debug",
  slowThresholdMs: 1_000,
};

export interface PerformanceExecutionContext {
  requestId?: string;
  callId: string;
  operation: string;
  accountId?: string;
  agentId?: string;
  computerId?: string;
  sessionId?: string;
  deliveryId?: string;
}

export interface PerformanceStartInput {
  module: string;
  category: PerformanceCategory;
  operation: string;
  requestId?: string;
  accountId?: string;
  agentId?: string;
  computerId?: string;
  sessionId?: string;
  deliveryId?: string;
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

export function getCurrentPerformanceContext(): PerformanceExecutionContext | undefined {
  return performanceContextStorage.getStore();
}

export function runWithPerformanceContext<T>(context: PerformanceExecutionContext, fn: () => T): T {
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
  if (patch.requestId !== undefined) current.requestId = patch.requestId;
  if (patch.accountId !== undefined) current.accountId = patch.accountId;
  if (patch.agentId !== undefined) current.agentId = patch.agentId;
  if (patch.computerId !== undefined) current.computerId = patch.computerId;
  if (patch.sessionId !== undefined) current.sessionId = patch.sessionId;
  if (patch.deliveryId !== undefined) current.deliveryId = patch.deliveryId;
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

function buildChildContext(
  callId: string,
  input: PerformanceStartInput,
  parent: PerformanceExecutionContext | undefined,
): PerformanceExecutionContext {
  const requestId = input.requestId ?? parent?.requestId;
  const accountId = input.accountId ?? parent?.accountId;
  const agentId = input.agentId ?? parent?.agentId;
  const computerId = input.computerId ?? parent?.computerId;
  const sessionId = input.sessionId ?? parent?.sessionId;
  const deliveryId = input.deliveryId ?? parent?.deliveryId;
  return {
    callId,
    operation: input.operation,
    ...(requestId ? { requestId } : {}),
    ...(accountId ? { accountId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(computerId ? { computerId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(deliveryId ? { deliveryId } : {}),
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
    ...(child.requestId ? { requestId: child.requestId } : {}),
    ...(child.accountId ? { accountId: child.accountId } : {}),
    ...(child.agentId ? { agentId: child.agentId } : {}),
    ...(child.computerId ? { computerId: child.computerId } : {}),
    ...(child.sessionId ? { sessionId: child.sessionId } : {}),
    ...(child.deliveryId ? { deliveryId: child.deliveryId } : {}),
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
  const config: PerformanceLoggingConfig = {
    enabled: configOverride?.enabled ?? DEFAULT_PERFORMANCE_LOGGING_CONFIG.enabled,
    level: configOverride?.level ?? DEFAULT_PERFORMANCE_LOGGING_CONFIG.level,
    slowThresholdMs: configOverride?.slowThresholdMs ?? DEFAULT_PERFORMANCE_LOGGING_CONFIG.slowThresholdMs,
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

    const startMono = performance.now();
    const port = portFor(input.module);
    const basePayload = buildBasePayload(input, childContext, parent, startedAt);
    port[config.level]({ ...basePayload, outcome: "started" }, input.startMessage ?? START_MESSAGES[input.category]);

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
        port[config.level](
          {
            ...basePayload,
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

  return {
    config,
    startOperation,
    traceAsync,
    traceOperation,
  };
}
