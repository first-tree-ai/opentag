import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { type Readable, Transform } from "node:stream";
import { domainToASCII } from "node:url";
import { redactSensitive, type StructuredError, StructuredErrorSchema } from "@opentag/shared";

export type PolicyErrorCategory = "security" | "transient" | "validation" | "availability";
export type PolicyRetryability = "retryable" | "not_retryable";
export type PolicyPhase = "request" | "response" | "stream" | "circuit";

type ExternalCallPolicyErrorCategoryOption = { category?: PolicyErrorCategory };
type ExternalCallPolicyErrorRetryabilityOption = { retryability?: PolicyRetryability };
type ExternalCallPolicyErrorPhaseOption = { phase?: PolicyPhase };
type ExternalCallPolicyErrorRequestOption = { requestId?: string };
type ExternalCallPolicyErrorCauseOption = { cause?: unknown };
type ExternalCallPolicyErrorOptionsCore = ExternalCallPolicyErrorCategoryOption &
  /* type-only */ ExternalCallPolicyErrorRetryabilityOption;
type ExternalCallPolicyErrorOptionsWithPhase = ExternalCallPolicyErrorOptionsCore & ExternalCallPolicyErrorPhaseOption;
type ExternalCallPolicyErrorOptionsWithRequest = ExternalCallPolicyErrorOptionsWithPhase &
  /* type-only */ ExternalCallPolicyErrorRequestOption;
export type ExternalCallPolicyErrorOptions = ExternalCallPolicyErrorOptionsWithRequest &
  /* type-only */ ExternalCallPolicyErrorCauseOption;

/** Local copy of the shared error contract. A later integration lane can replace its import. */
export class ExternalCallPolicyError extends Error {
  readonly code: string;
  readonly category: PolicyErrorCategory;
  readonly retryability: PolicyRetryability;
  readonly phase: PolicyPhase;
  readonly requestId: string;
  readonly structuredError: StructuredError;

  constructor(code: string, message: string, options: ExternalCallPolicyErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ExternalCallPolicyError";
    this.code = code;
    this.category = options.category ?? "transient";
    this.retryability = options.retryability ?? "retryable";
    this.phase = options.phase ?? "request";
    this.requestId = options.requestId ?? randomUUID();
    this.structuredError = StructuredErrorSchema.parse({
      code: this.code,
      category: structuredCategory(this.category),
      retryability: this.retryability === "retryable" ? "backoff" : "never",
      phase: structuredPhase(this.phase),
      requestId: this.requestId,
      message: redactSensitive(message).slice(0, 2_048),
    });
  }

  toStructuredError(): StructuredError {
    return this.structuredError;
  }
}

function structuredCategory(category: PolicyErrorCategory): StructuredError["category"] {
  if (category === "security") return "authorization";
  if (category === "validation") return "validation";
  return "unavailable";
}

function structuredPhase(phase: PolicyPhase): StructuredError["phase"] {
  if (phase === "stream") return "transport";
  if (phase === "response" || phase === "circuit") return "provider";
  return "request";
}

type ExternalCallMetricCore =
  | { type: "call" | "circuit"; operation: string; requestId: string }
  | { type: "queue"; operation: string; requestId: string; queueDepth: number; queueRejections: number }
  | { type: "abandoned"; operation: string; requestId: string };
type ExternalCallMetricDuration = { durationMs?: number };
type ExternalCallMetricSuccess = { success?: boolean };
type ExternalCallMetricErrorCode = { errorCode?: string };
type ExternalCallMetricState = { state?: "closed" | "open" | "half_open" };
type ExternalCallMetricDetailsCore = ExternalCallMetricDuration & ExternalCallMetricSuccess;
type ExternalCallMetricDetails = ExternalCallMetricDetailsCore & ExternalCallMetricErrorCode & ExternalCallMetricState;
export type ExternalCallMetric = ExternalCallMetricCore & ExternalCallMetricDetails;

type CircuitEntry = { failures: number; state: "closed" | "open" | "half_open"; openedAt?: number };
type ConcurrencyWaiter = { grant: () => void; cancel: (error: unknown) => void };

type ExternalCallPolicyClockOptions = { clock?: () => Date };
type ExternalCallPolicySleepOptions = { sleep?: (delayMs: number) => Promise<void> };
type ExternalCallPolicyTransportOptions = { transport?: typeof fetch };
type ExternalCallPolicyTimingOptions = ExternalCallPolicyClockOptions &
  /* type-only */ ExternalCallPolicySleepOptions &
  /* type-only */ ExternalCallPolicyTransportOptions;
type ExternalCallPolicyLimitOptions = {
  defaultTimeoutMs?: number;
  maxConcurrency?: number;
  maxAttempts?: number;
  maxQueueDepth?: number;
  abandonmentWindowMs?: number;
};
type ExternalCallPolicyBackoffOptions = { backoffBaseMs?: number; backoffMaxMs?: number };
type ExternalCallPolicyCircuitOptions = { circuitFailureThreshold?: number; circuitResetMs?: number };
type ExternalCallPolicySecurityOptions = {
  allowedHosts?: readonly string[];
  /** Test-only escape hatch for a loopback HTTP transport. Production wiring never sets this. */
  allowHttpLoopbackForTests?: boolean;
};
type ExternalCallPolicyMetricOptions = { onMetric?: (metric: ExternalCallMetric) => void };
type ExternalCallPolicyOptionsCore = ExternalCallPolicyTimingOptions & ExternalCallPolicyLimitOptions;
type ExternalCallPolicyOptionsWithCircuit = ExternalCallPolicyOptionsCore &
  /* type-only */ ExternalCallPolicyBackoffOptions &
  /* type-only */ ExternalCallPolicyCircuitOptions;
type ExternalCallPolicyOptionsWithSecurity = ExternalCallPolicyOptionsWithCircuit & ExternalCallPolicySecurityOptions;
export type ExternalCallPolicyOptions = ExternalCallPolicyOptionsWithSecurity & ExternalCallPolicyMetricOptions;

type ExternalCallOptionsDeadline = {
  timeoutMs?: number;
  signal?: AbortSignal;
  abandonmentWindowMs?: number;
};
type ExternalCallOptionsRetry = { maxAttempts?: number; retryable?: (error: unknown) => boolean };
type ExternalCallOptionsCircuit = { circuitKey?: string };
type ExternalCallOptionsCore = ExternalCallOptionsDeadline & ExternalCallOptionsRetry;
export type ExternalCallOptions = ExternalCallOptionsCore & ExternalCallOptionsCircuit;

type PolicyAction<T> = (signal: AbortSignal, requestId: string) => Promise<T>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_BACKOFF_BASE_MS = 100;
const DEFAULT_BACKOFF_MAX_MS = 2_000;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_RESET_MS = 30_000;
const DEFAULT_MAX_QUEUE_DEPTH = 32;
const DEFAULT_ABANDONMENT_WINDOW_MS = 1_000;

function errorCode(error: unknown): string | undefined {
  return error instanceof ExternalCallPolicyError ? error.code : undefined;
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof ExternalCallPolicyError) || error.retryability === "retryable";
}

/**
 * A caller withdrawing its own call is not the provider failing.
 *
 * The breaker exists to stop hammering something that is broken. Counting cancellations toward it
 * means a caller that legitimately abandons work — a reader who changes their mind mid-flow — trips
 * a breaker against a provider that never misbehaved, and takes the next caller down with them.
 */
function isCancellation(error: unknown): boolean {
  return error instanceof ExternalCallPolicyError && error.code === "IM_PROVIDER_CALL_ABORTED";
}

function isDeadlineExceeded(error: unknown): boolean {
  return error instanceof ExternalCallPolicyError && error.code === "IM_PROVIDER_CALL_DEADLINE_EXCEEDED";
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function isIpLiteral(hostname: string): boolean {
  const candidate = stripIpv6Brackets(hostname);
  if (isIP(candidate) !== 0) return true;
  try {
    return isIP(decodeURIComponent(candidate)) !== 0;
  } catch {
    return true;
  }
}

function normalizedHostname(hostname: string): string | undefined {
  const candidate = stripIpv6Brackets(hostname).replace(/\.+$/, "");
  if (!candidate || isIpLiteral(candidate)) return undefined;
  const ascii = domainToASCII(candidate);
  return ascii ? ascii.toLowerCase() : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const candidate = stripIpv6Brackets(hostname).toLowerCase();
  if (candidate === "localhost") return true;
  const ipVersion = isIP(candidate);
  if (ipVersion === 4) return candidate.split(".")[0] === "127";
  return ipVersion === 6 && candidate === "::1";
}

function hostAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  const hostname = normalizedHostname(url.hostname);
  if (allowedHosts.length === 0) return false;
  if (hostname) return allowedHosts.some((allowed) => normalizedHostname(allowed) === hostname);
  const rawHostname = stripIpv6Brackets(url.hostname).toLowerCase();
  return allowedHosts.some((allowed) => stripIpv6Brackets(allowed).toLowerCase() === rawHostname);
}

function hostNotAllowedError(message = "The provider URL is not allowlisted"): ExternalCallPolicyError {
  return new ExternalCallPolicyError("IM_PROVIDER_HOST_NOT_ALLOWED", message, {
    category: "security",
    retryability: "not_retryable",
    phase: "request",
  });
}

function hasEncodedAuthority(input: string | URL): boolean {
  if (input instanceof URL) return false;
  const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(input)?.[1];
  if (!authority) return false;
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  return hostPort.includes("%");
}

function parseProviderUrl(input: string | URL): URL {
  try {
    return new URL(input.toString());
  } catch (error) {
    throw new ExternalCallPolicyError("IM_PROVIDER_HOST_NOT_ALLOWED", "The provider URL is invalid", {
      category: "security",
      retryability: "not_retryable",
      phase: "request",
      cause: error,
    });
  }
}

function usesAllowedTransport(url: URL, allowHttpLoopbackForTests: boolean): boolean {
  if (url.protocol === "https:" && url.port === "") return true;
  return allowHttpLoopbackForTests && url.protocol === "http:" && url.port === "" && isLoopbackHostname(url.hostname);
}

type DeadlineAttempt<T> = { result: Promise<T>; settled: Promise<void> };

export class ExternalCallPolicy {
  readonly #clock: () => Date;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #transport: typeof fetch;
  readonly #defaultTimeoutMs: number;
  readonly #maxConcurrency: number;
  readonly #maxAttempts: number;
  readonly #maxQueueDepth: number;
  readonly #abandonmentWindowMs: number | undefined;
  readonly #backoffBaseMs: number;
  readonly #backoffMaxMs: number;
  readonly #circuitFailureThreshold: number;
  readonly #circuitResetMs: number;
  readonly #allowedHosts: readonly string[];
  readonly #onMetric: (metric: ExternalCallMetric) => void;
  readonly #circuits = new Map<string, CircuitEntry>();
  #active = 0;
  readonly #waiters: ConcurrencyWaiter[] = [];
  #queueRejections = 0;
  readonly #allowHttpLoopbackForTests: boolean;

  constructor(options: ExternalCallPolicyOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#sleep = options.sleep ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
    this.#transport = options.transport ?? globalThis.fetch.bind(globalThis);
    this.#defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxConcurrency = Math.max(1, options.maxConcurrency ?? 8);
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.#maxQueueDepth = Math.max(0, Math.floor(options.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH));
    this.#abandonmentWindowMs =
      options.abandonmentWindowMs === undefined ? undefined : Math.max(1, options.abandonmentWindowMs);
    this.#backoffBaseMs = Math.max(0, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
    this.#backoffMaxMs = Math.max(this.#backoffBaseMs, options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS);
    this.#circuitFailureThreshold = Math.max(1, options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD);
    this.#circuitResetMs = Math.max(1, options.circuitResetMs ?? DEFAULT_CIRCUIT_RESET_MS);
    this.#allowedHosts = [...(options.allowedHosts ?? [])];
    this.#allowHttpLoopbackForTests = options.allowHttpLoopbackForTests === true;
    this.#onMetric = options.onMetric ?? (() => undefined);
  }

  /** Validate a provider URL before any credential-bearing request headers are constructed. */
  admitUrl(input: string | URL): URL {
    if (hasEncodedAuthority(input)) throw hostNotAllowedError("Encoded provider hosts are not allowed");
    const url = parseProviderUrl(input);
    const isLoopbackHttp = url.protocol === "http:" && isLoopbackHostname(url.hostname);
    if (!usesAllowedTransport(url, this.#allowHttpLoopbackForTests)) {
      throw hostNotAllowedError("The provider URL must use HTTPS and its default port");
    }
    if (isIpLiteral(url.hostname) && !isLoopbackHttp) {
      throw hostNotAllowedError("Provider IP literals are not allowed");
    }
    if (!hostAllowed(url, this.#allowedHosts)) {
      throw hostNotAllowedError();
    }
    return url;
  }

  async run<T>(operation: string, action: PolicyAction<T>, options: ExternalCallOptions = {}): Promise<T> {
    const requestId = randomUUID();
    const circuitKey = options.circuitKey ?? operation;
    const circuit = this.#circuit(circuitKey);
    this.#assertCircuitAvailable(circuit, operation, requestId);

    await this.#acquire(operation, requestId, options);
    const startedAt = this.#clock().getTime();
    let permitSettled = Promise.resolve();
    try {
      return await this.#runAttempts(operation, requestId, action, options, circuit, startedAt, (settled) => {
        permitSettled = settled;
      });
    } catch (error) {
      this.#recordFailure(circuit, operation, requestId, error);
      const code = errorCode(error);
      this.#onMetric({
        type: "call",
        operation,
        requestId,
        durationMs: Math.max(0, this.#clock().getTime() - startedAt),
        success: false,
        ...(code ? { errorCode: code } : {}),
      });
      throw error;
    } finally {
      void permitSettled.then(() => this.#release());
    }
  }

  #assertCircuitAvailable(circuit: CircuitEntry, operation: string, requestId: string): void {
    if (circuit.state !== "open") return;
    const current = this.#clock().getTime();
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

  async #runAttempts<T>(
    operation: string,
    requestId: string,
    action: PolicyAction<T>,
    options: ExternalCallOptions,
    circuit: CircuitEntry,
    startedAt: number,
    onPermitSettled: (settled: Promise<void>) => void,
  ): Promise<T> {
    const attempts = Math.max(1, options.maxAttempts ?? this.#maxAttempts);
    let lastError: unknown;
    for (let attemptNumber = 1; attemptNumber <= attempts; attemptNumber += 1) {
      try {
        const attempt = this.#withDeadline(operation, requestId, action, options);
        onPermitSettled(attempt.settled);
        const result = await attempt.result;
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
        if (isDeadlineExceeded(error) || isCancellation(error)) break;
        const retry = (options.retryable ?? isRetryable)(error);
        if (!retry || attemptNumber >= attempts) break;
        const delay = Math.min(this.#backoffMaxMs, this.#backoffBaseMs * 2 ** (attemptNumber - 1));
        await this.#sleep(delay);
      }
    }
    throw lastError;
  }

  async fetch(input: string | URL, init: RequestInit = {}, options: ExternalCallOptions = {}): Promise<Response> {
    const url = this.admitUrl(input);
    const requestSignal = init.signal ?? undefined;
    const runOptions = requestSignal
      ? {
          ...options,
          signal: options.signal ? AbortSignal.any([options.signal, requestSignal]) : requestSignal,
        }
      : options;
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
          try {
            this.admitUrl(response.url);
          } catch (error) {
            throw new ExternalCallPolicyError("IM_PROVIDER_REDIRECT_REJECTED", "Provider redirects are not allowed", {
              category: "security",
              retryability: "not_retryable",
              phase: "response",
              cause: error,
            });
          }
        }
        return response;
      },
      runOptions,
    );
  }

  circuitState(operation: string): "closed" | "open" | "half_open" {
    return this.#circuit(operation).state;
  }

  stream(stream: Readable, maxBytes: number): Readable {
    return limitReadableStream(stream, maxBytes);
  }

  #withDeadline<T>(
    operation: string,
    requestId: string,
    action: PolicyAction<T>,
    options: ExternalCallOptions,
  ): DeadlineAttempt<T> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.#defaultTimeoutMs);
    const abandonmentWindowMs = Math.max(
      1,
      options.abandonmentWindowMs ?? this.#abandonmentWindowMs ?? Math.min(timeoutMs, DEFAULT_ABANDONMENT_WINDOW_MS),
    );
    let abandonmentTimer: ReturnType<typeof setTimeout> | undefined;
    let abandon: (() => void) | undefined;
    const abandonment = new Promise<void>((resolve) => {
      abandon = () => {
        this.#onMetric({ type: "abandoned", operation, requestId });
        resolve();
      };
    });
    const scheduleAbandonment = () => {
      if (abandonmentTimer) return;
      abandonmentTimer = setTimeout(() => abandon?.(), abandonmentWindowMs);
      abandonmentTimer.unref?.();
    };
    const actionPromise = Promise.resolve().then(() => action(controller.signal, requestId));
    const actionSettled = actionPromise.then(
      () => undefined,
      () => undefined,
    );
    actionSettled.then(() => {
      if (abandonmentTimer) clearTimeout(abandonmentTimer);
    });
    const settled = Promise.race([actionSettled, abandonment]);
    const onAbort = () => {
      controller.abort(options.signal?.reason);
      scheduleAbandonment();
    };
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
        scheduleAbandonment();
        reject(error);
      }, timeoutMs);
    });
    let rejectCancelledListener: (() => void) | undefined;
    const cancelled = options.signal
      ? new Promise<never>((_, reject) => {
          rejectCancelledListener = () => {
            scheduleAbandonment();
            reject(
              new ExternalCallPolicyError("IM_PROVIDER_CALL_ABORTED", "Provider call was cancelled", {
                category: "availability",
                retryability: "retryable",
                phase: "request",
                requestId,
                cause: options.signal?.reason,
              }),
            );
          };
          if (options.signal?.aborted) rejectCancelledListener?.();
          else options.signal?.addEventListener("abort", rejectCancelledListener, { once: true });
        })
      : undefined;
    actionPromise.catch(() => undefined);
    const result = (async () => {
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
    })();
    return { result, settled };
  }

  #circuit(key: string): CircuitEntry {
    const existing = this.#circuits.get(key);
    if (existing) return existing;
    const created: CircuitEntry = { failures: 0, state: "closed" };
    this.#circuits.set(key, created);
    return created;
  }

  /**
   * Books a failure against the breaker, unless the caller withdrew the call itself.
   *
   * A cancellation says nothing about the provider, so counting it would open the breaker against
   * something that never misbehaved — and where cancelling is ordinary, as it is while someone is
   * choosing which messaging app to connect, it would take the next caller down with it.
   */
  #recordFailure(circuit: CircuitEntry, operation: string, requestId: string, error: unknown): void {
    if (isCancellation(error)) return;
    circuit.failures += 1;
    if (circuit.failures < this.#circuitFailureThreshold) return;
    circuit.state = "open";
    circuit.openedAt = this.#clock().getTime();
    this.#onMetric({ type: "circuit", operation, requestId, state: "open" });
  }

  async #acquire(operation: string, requestId: string, options: ExternalCallOptions): Promise<void> {
    if (this.#active < this.#maxConcurrency) {
      this.#active += 1;
      return;
    }
    if (this.#waiters.length >= this.#maxQueueDepth) {
      this.#queueRejections += 1;
      const error = new ExternalCallPolicyError("IM_PROVIDER_OVERLOADED", "The provider call queue is full", {
        category: "availability",
        retryability: "retryable",
        phase: "request",
        requestId,
      });
      this.#onMetric({
        type: "queue",
        operation,
        requestId,
        queueDepth: this.#waiters.length,
        queueRejections: this.#queueRejections,
        errorCode: error.code,
      });
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: ConcurrencyWaiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          cleanup();
          this.#active += 1;
          resolve();
        },
        cancel: (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(error);
        },
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () =>
        waiter.cancel(
          new ExternalCallPolicyError("IM_PROVIDER_CALL_ABORTED", "Provider call was cancelled", {
            category: "availability",
            retryability: "retryable",
            phase: "request",
            requestId,
            cause: options.signal?.reason,
          }),
        );
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      const timeoutMs = Math.max(1, options.timeoutMs ?? this.#defaultTimeoutMs);
      timer = setTimeout(
        () =>
          waiter.cancel(
            new ExternalCallPolicyError(
              "IM_PROVIDER_CALL_DEADLINE_EXCEEDED",
              `Provider call ${operation} exceeded its deadline while waiting for capacity`,
              {
                category: "availability",
                retryability: "retryable",
                phase: "request",
                requestId,
              },
            ),
          ),
        timeoutMs,
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#onMetric({
        type: "queue",
        operation,
        requestId,
        queueDepth: this.#waiters.length,
        queueRejections: this.#queueRejections,
      });
    });
  }

  #release(): void {
    this.#active = Math.max(0, this.#active - 1);
    this.#waiters.shift()?.grant();
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
