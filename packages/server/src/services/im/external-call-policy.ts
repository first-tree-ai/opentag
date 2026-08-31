import { randomUUID } from "node:crypto";
import { type Readable, Transform } from "node:stream";

export type PolicyErrorCategory = "security" | "transient" | "validation" | "availability";
export type PolicyRetryability = "retryable" | "not_retryable";
export type PolicyPhase = "request" | "response" | "stream" | "circuit";

export interface ExternalCallPolicyErrorOptions {
  category?: PolicyErrorCategory;
  retryability?: PolicyRetryability;
  phase?: PolicyPhase;
  requestId?: string;
  cause?: unknown;
}

/** Local copy of the shared error contract. A later integration lane can replace its import. */
export class ExternalCallPolicyError extends Error {
  readonly code: string;
  readonly category: PolicyErrorCategory;
  readonly retryability: PolicyRetryability;
  readonly phase: PolicyPhase;
  readonly requestId: string;

  constructor(code: string, message: string, options: ExternalCallPolicyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExternalCallPolicyError";
    this.code = code;
    this.category = options.category ?? "transient";
    this.retryability = options.retryability ?? "retryable";
    this.phase = options.phase ?? "request";
    this.requestId = options.requestId ?? randomUUID();
  }
}

export interface ExternalCallMetric {
  type: "call" | "circuit";
  operation: string;
  requestId: string;
  durationMs?: number;
  success?: boolean;
  errorCode?: string;
  state?: "closed" | "open" | "half_open";
}

interface CircuitEntry {
  failures: number;
  state: "closed" | "open" | "half_open";
  openedAt?: number;
}

export interface ExternalCallPolicyOptions {
  clock?: () => Date;
  sleep?: (delayMs: number) => Promise<void>;
  transport?: typeof fetch;
  defaultTimeoutMs?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  circuitFailureThreshold?: number;
  circuitResetMs?: number;
  allowedHosts?: readonly string[];
  onMetric?: (metric: ExternalCallMetric) => void;
}

export interface ExternalCallOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  retryable?: (error: unknown) => boolean;
  signal?: AbortSignal;
  circuitKey?: string;
}

type PolicyAction<T> = (signal: AbortSignal, requestId: string) => Promise<T>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 2_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;

function errorCode(error: unknown): string | undefined {
  return error instanceof ExternalCallPolicyError ? error.code : undefined;
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof ExternalCallPolicyError) || error.retryability === "retryable";
}

function hostAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return true;
  return allowedHosts.some((allowed) => {
    const normalized = allowed.toLowerCase();
    return url.hostname.toLowerCase() === normalized || url.host.toLowerCase() === normalized;
  });
}

export class ExternalCallPolicy {
  readonly #clock: () => Date;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #transport: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #maxConcurrency: number;
  readonly #maxAttempts: number;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #circuitFailureThreshold: number;
  readonly #circuitResetMs: number;
  readonly #allowedHosts: readonly string[];
  readonly #onMetric: (metric: ExternalCallMetric) => void;
  readonly #circuits = new Map<string, CircuitEntry>();
  #active = 0;
  readonly #waiters: Array<() => void> = [];

  constructor(options: ExternalCallPolicyOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
    this.#transport = options.transport ?? globalThis.fetch.bind(globalThis);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? 8);
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#backoffBaseMs = Math.max(0, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
    this.#backoffMaxMs = Math.max(this.#backoffBaseMs, options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
    this.#circuitFailureThreshold = Math.max(1, options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD);
    this.#circuitResetMs = Math.max(1, options.circuitResetMs ?? DEFAULT_CIRCUIT_RESET_MS);
    this.#allowedHosts = [...(options.allowedHosts ?? [])];
    this.#onMetric = options.onMetric ?? (() => undefined);
  }

  async run<T>(operation: string, action: PolicyAction<T>, options: ExternalCallOptions = {}): Promise<T> {
    const requestId = randomUUID();
    const circuitKey = options.circuitKey ?? operation;
    const circuit = this.#circuit(circuitKey);
    const current = this.#clock().getTime();
    if (circuit.state === "open") {
      if (current - (circuit.openedAt ?? current) < this.#circuitResetMs) {
        const error = new ExternalCallPolicyError("IM_PROVIDER_CIRCUIT_OPEN", "The provider circuit is open", {
          category: "availability",
          retryability: "retryable",
          phase: "circuit",
          requestId,
        });
        this.#onMetric({ type: "call", operation, requestId, durationMs: 0, success: false, errorCode: error.code });
        throw error;
      }
      circuit.state = "half_open";
      this.#onMetric({ type: "circuit", operation, requestId, state: "half_open" });
    }

    await this.#acquire();
    const startedAt = this.#clock().getTime();
    try {
      const attempts = Math.max(1, options.maxAttempts ?? this.#maxAttempts);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const result = await this.#withDeadline(operation, requestId, action, options);
          const wasOpen = circuit.state !== "closed";
          circuit.failures = 0;
          circuit.state = "closed";
          if (wasOpen) this.#onMetric({ type: "circuit", operation, requestId, state: "closed" });
          this.#onMetric({
            type: "call",
            operation,
            requestId,
            durationMs: Math.max(0, this.#clock().getTime() - startedAt),
            success: true,
          });
          return result;
        } catch (error) {
          lastError = error;
          const retry = (options.retryable ?? isRetryable)(error);
          if (!retry || attempt >= attempts) break;
          const delay = Math.min(this.#backoffMaxMs, this.#backoffBaseMs * 2 ** (attempt - 1));
          await this.#sleep(delay);
        }
      }
      circuit.failures += 1;
      if (circuit.failures >= this.#circuitFailureThreshold) {
        circuit.state = "open";
        circuit.openedAt = this.#clock().getTime();
        this.#onMetric({ type: "circuit", operation, requestId, state: "open" });
      }
      const code = errorCode(lastError);
      this.#onMetric({
        type: "call",
        operation,
        requestId,
        durationMs: Math.max(0, this.#clock().getTime() - startedAt),
        success: false,
        ...(code ? { errorCode: code } : {}),
      });
      throw lastError;
    } finally {
      this.#release();
    }
  }

  async fetch(input: string | URL, init: RequestInit = {}, options: ExternalCallOptions = {}): Promise<Response> {
    const url = new URL(input.toString());
    if (!hostAllowed(url, this.#allowedHosts)) {
      throw new ExternalCallPolicyError("IM_PROVIDER_HOST_NOT_ALLOWED", "The provider host is not allowlisted", {
        category: "security",
        retryability: "not_retryable",
        phase: "request",
      });
    }
    return this.run(
      `http:${url.hostname}`,
      async (signal) => {
        const response = await this.#transport(url.toString(), { ...init, redirect: "error", signal });
        if (response.redirected || (response.status >= 300 && response.status < 400)) {
          throw new ExternalCallPolicyError("IM_PROVIDER_REDIRECT_REJECTED", "Provider redirects are not allowed", {
            category: "security",
            retryability: "not_retryable",
            phase: "response",
          });
        }
        if (response.url) {
          const finalUrl = new URL(response.url);
          if (!hostAllowed(finalUrl, this.#allowedHosts)) {
            throw new ExternalCallPolicyError("IM_PROVIDER_REDIRECT_REJECTED", "Provider redirects are not allowed", {
              category: "security",
              retryability: "not_retryable",
              phase: "response",
            });
          }
        }
        return response;
      },
      options,
    );
  }

  circuitState(operation: string): "closed" | "open" | "half_open" {
    return this.#circuit(operation).state;
  }

  stream(stream: Readable, maxBytes: number): Readable {
    return limitReadableStream(stream, maxBytes);
  }

  async #withDeadline<T>(
    operation: string,
    requestId: string,
    action: PolicyAction<T>,
    options: ExternalCallOptions,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.#defaultTimeoutMs);
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort, { once: true });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ExternalCallPolicyError(
          "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
          `Provider call ${operation} exceeded its deadline`,
          {
            category: "availability",
            retryability: "retryable",
            phase: "request",
            requestId,
          },
        );
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    let rejectCancelledListener: (() => void) | undefined;
    const cancelled = options.signal
      ? new Promise<never>((_, reject) => {
          rejectCancelledListener = () =>
            reject(
              new ExternalCallPolicyError("IM_PROVIDER_CALL_ABORTED", "Provider call was cancelled", {
                category: "availability",
                retryability: "retryable",
                phase: "request",
                requestId,
                cause: options.signal?.reason,
              }),
            );
          if (options.signal?.aborted) rejectCancelledListener?.();
          else options.signal?.addEventListener("abort", rejectCancelledListener, { once: true });
        })
      : undefined;
    const actionPromise = Promise.resolve().then(() => action(controller.signal, requestId));
    actionPromise.catch(() => undefined);
    try {
      return await Promise.race(cancelled ? [actionPromise, timeout, cancelled] : [actionPromise, timeout]);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof ExternalCallPolicyError)) {
        throw new ExternalCallPolicyError("IM_PROVIDER_CALL_ABORTED", "Provider call was cancelled", {
          category: "availability",
          retryability: "retryable",
          phase: "request",
          requestId,
          cause: error,
        });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (rejectCancelledListener) options.signal?.removeEventListener("abort", rejectCancelledListener);
    }
  }

  #circuit(key: string): CircuitEntry {
    const existing = this.#circuits.get(key);
    if (existing) return existing;
    const created: CircuitEntry = { failures: 0, state: "closed" };
    this.#circuits.set(key, created);
    return created;
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrency) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.#waiters.push(resolve));
    this.#active += 1;
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#waiters.shift()?.();
  }
}

export function limitReadableStream(
  source: Readable,
  maxBytes: number,
  code = "IM_PROVIDER_RESPONSE_TOO_LARGE",
): Readable {
  let observed = 0;
  const limiter = new Transform({
    transform(chunk: Buffer | Uint8Array | string, _encoding, callback) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (observed + value.byteLength > maxBytes) {
        const error = new ExternalCallPolicyError(code, code, {
          category: "validation",
          retryability: "not_retryable",
          phase: "stream",
        });
        source.destroy();
        callback(error);
        return;
      }
      observed += value.byteLength;
      callback(null, value);
    },
  });
  source.pipe(limiter);
  return limiter;
}
