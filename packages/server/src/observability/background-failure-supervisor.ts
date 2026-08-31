import {
  boundedSerialize,
  type DiagnosticEvent,
  DiagnosticEventSchema,
  type ErrorRetryability,
  redactSensitive,
  STRUCTURED_ERROR_MAX_CAUSE_DEPTH,
  STRUCTURED_ERROR_MESSAGE_MAX_BYTES,
  STRUCTURED_ERROR_REQUEST_ID_MAX_BYTES,
  type StructuredError,
  type StructuredErrorCategory,
  type StructuredErrorCause,
  type StructuredErrorPhase,
  StructuredErrorSchema,
} from "@opentag/shared";
import { safeDiagnosticCode } from "./attributes.js";

const DEFAULT_CODE = "BACKGROUND_FAILURE";
const COUNTER_NAME = "opentag.background_failures.total";

export interface BackgroundFailureContext {
  code?: string;
  category?: StructuredErrorCategory;
  retryability?: ErrorRetryability;
  phase?: StructuredErrorPhase;
  requestId?: string;
  operation?: string;
  /** An optional outer cause supplied by a boundary that is rethrowing the failure. */
  cause?: unknown;
}

export interface BackgroundFailureCounterLabels {
  code: string;
  category: StructuredErrorCategory;
  phase: StructuredErrorPhase;
  retryability: ErrorRetryability;
}

export interface BackgroundFailureSupervisorOptions {
  logger?: (payload: Record<string, unknown>, message: string) => void;
  onEvent?: (event: DiagnosticEvent) => void;
  onCounter?: (name: string, labels: BackgroundFailureCounterLabels) => void;
  now?: () => Date;
}

type SupervisedOperation<T> = (() => Promise<T> | T) | Promise<T>;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function limitUtf8(value: string, maxBytes: number): string {
  if (utf8ByteLength(value) <= maxBytes) return value;
  const suffix = "...[TRUNCATED]";
  const budget = Math.max(0, maxBytes - utf8ByteLength(suffix));
  let output = "";
  for (const character of value) {
    if (utf8ByteLength(output + character) > budget) break;
    output += character;
  }
  return output + suffix;
}

function limitMessage(value: string): string {
  return limitUtf8(value, STRUCTURED_ERROR_MESSAGE_MAX_BYTES);
}

function messageFromUnknown(error: unknown): string {
  const candidate =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : boundedSerialize(error, STRUCTURED_ERROR_MESSAGE_MAX_BYTES);
  const redacted = redactSensitive(candidate);
  return limitMessage(
    typeof redacted === "string" ? redacted : boundedSerialize(redacted, STRUCTURED_ERROR_MESSAGE_MAX_BYTES),
  );
}

function errorProperty(error: unknown, property: string): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return property in error ? (error as Record<string, unknown>)[property] : undefined;
}

function markCauseSeen(error: unknown, seen: WeakSet<object>): boolean {
  if (typeof error !== "object" || error === null) return true;
  if (seen.has(error)) return false;
  seen.add(error);
  return true;
}

function causeCandidate(error: unknown, seen: WeakSet<object>, depth: number): Record<string, unknown> {
  const rawCode = errorProperty(error, "code");
  const rawCategory = errorProperty(error, "category");
  const rawRetryability = errorProperty(error, "retryability");
  const rawPhase = errorProperty(error, "phase");
  const cause = errorProperty(error, "cause");
  return {
    message: messageFromUnknown(error),
    ...(typeof rawCode === "string" ? { code: safeDiagnosticCode(rawCode) } : {}),
    ...(typeof rawCategory === "string" ? { category: rawCategory } : {}),
    ...(typeof rawRetryability === "string" ? { retryability: rawRetryability } : {}),
    ...(typeof rawPhase === "string" ? { phase: rawPhase } : {}),
    ...(cause !== undefined ? { cause: causeFromUnknown(cause, seen, depth + 1) } : {}),
  };
}

function causeFromUnknown(error: unknown, seen: WeakSet<object>, depth: number): StructuredErrorCause {
  if (depth >= STRUCTURED_ERROR_MAX_CAUSE_DEPTH) {
    return { message: "Cause chain exceeded the diagnostic depth limit" };
  }
  if (!markCauseSeen(error, seen)) return { message: "Cause chain contained a circular reference" };
  const parsed = StructuredErrorSchema.partial().safeParse(causeCandidate(error, seen, depth));
  if (!parsed.success) return { message: messageFromUnknown(error) };
  const { code, category, retryability, phase, message, cause } = parsed.data;
  return {
    ...(code ? { code } : {}),
    ...(category ? { category } : {}),
    ...(retryability ? { retryability } : {}),
    ...(phase ? { phase } : {}),
    message: message ?? messageFromUnknown(error),
    ...(cause ? { cause } : {}),
  };
}

function defaultError(context: BackgroundFailureContext, thrown: unknown): StructuredError {
  const rawCode = context.code ?? errorProperty(thrown, "code");
  const code = safeDiagnosticCode(typeof rawCode === "string" ? rawCode : DEFAULT_CODE);
  const category = context.category ?? "internal";
  const retryability = context.retryability ?? "never";
  const phase = context.phase ?? "unknown";
  const cause = context.cause ?? errorProperty(thrown, "cause") ?? thrown;
  return StructuredErrorSchema.parse({
    code,
    category,
    retryability,
    phase,
    ...(context.requestId ? { requestId: limitUtf8(context.requestId, STRUCTURED_ERROR_REQUEST_ID_MAX_BYTES) } : {}),
    message: messageFromUnknown(thrown),
    cause: causeFromUnknown(cause, new WeakSet<object>(), 0),
  });
}

/**
 * Supervises failures at asynchronous boundaries without changing the original rejection contract.
 * Observers are isolated: a broken logger, counter, or event sink cannot create a second failure.
 */
export class BackgroundFailureSupervisor {
  readonly #logger?: BackgroundFailureSupervisorOptions["logger"];
  readonly #onEvent?: BackgroundFailureSupervisorOptions["onEvent"];
  readonly #onCounter?: BackgroundFailureSupervisorOptions["onCounter"];
  readonly #now: () => Date;

  constructor(options: BackgroundFailureSupervisorOptions = {}) {
    this.#logger = options.logger;
    this.#onEvent = options.onEvent;
    this.#onCounter = options.onCounter;
    this.#now = options.now ?? (() => new Date());
  }

  /** Await a supervised operation. The original error is emitted, then rethrown unchanged. */
  supervise<T>(operation: SupervisedOperation<T>, context: BackgroundFailureContext = {}): Promise<T> {
    return Promise.resolve()
      .then(() => (typeof operation === "function" ? operation() : operation))
      .catch((error: unknown) => {
        this.#record(error, context);
        throw error;
      });
  }

  /** Track a detached promise or factory and consume its rejection after recording it. */
  track<T>(operation: SupervisedOperation<T>, context: BackgroundFailureContext = {}): void {
    void this.supervise(operation, context).catch(() => undefined);
  }

  #record(thrown: unknown, context: BackgroundFailureContext): void {
    let error: StructuredError;
    try {
      error = defaultError(context, thrown);
    } catch {
      error = {
        code: DEFAULT_CODE,
        category: "internal",
        retryability: "never",
        phase: "unknown",
        message: "Background failure could not be classified",
      };
    }
    let event: DiagnosticEvent;
    try {
      const now = this.#now();
      event = DiagnosticEventSchema.parse({
        type: "diagnostic.error",
        occurredAt: Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString(),
        error,
      });
    } catch {
      event = DiagnosticEventSchema.parse({
        type: "diagnostic.error",
        occurredAt: new Date().toISOString(),
        error: {
          code: DEFAULT_CODE,
          category: "internal",
          retryability: "never",
          phase: "unknown",
          message: "Background failure could not be classified",
        },
      });
    }
    const labels: BackgroundFailureCounterLabels = {
      code: error.code,
      category: error.category,
      phase: error.phase,
      retryability: error.retryability,
    };
    try {
      this.#onEvent?.(event);
    } catch {
      // Diagnostic sinks are best-effort and never replace a business failure.
    }
    try {
      this.#onCounter?.(COUNTER_NAME, labels);
    } catch {
      // Metric exporters are best-effort and never replace a business failure.
    }
    try {
      const payload = redactSensitive({ event, ...(context.operation ? { operation: context.operation } : {}) });
      this.#logger?.(payload as Record<string, unknown>, "Background failure");
    } catch {
      // Logging is best-effort and never replaces a business failure.
    }
  }
}

export function createBackgroundFailureSupervisor(
  options: BackgroundFailureSupervisorOptions = {},
): BackgroundFailureSupervisor {
  return new BackgroundFailureSupervisor(options);
}

export const BACKGROUND_FAILURE_COUNTER_NAME = COUNTER_NAME;
