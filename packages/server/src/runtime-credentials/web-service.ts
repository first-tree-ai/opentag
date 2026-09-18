import {
  capWebTimeoutMs,
  deriveWebIdempotencyKey,
  type WebFetchExecutionRequest,
  type WebFetchParams,
  type WebFetchResult,
  type WebSearchExecutionRequest,
  type WebSearchParams,
  type WebSearchResult,
  webServiceScopeForOperation,
} from "@opentag/shared";
import type { RuntimeExecutionRegistry } from "./execution-registry.js";
import { RuntimeWebError, type RuntimeWebExecutionAuthorizer } from "./web-execution.js";
import type { RuntimeWebTenantResolver } from "./web-policy.js";
import type { RouterWebClient } from "./web-router-client.js";

export interface RuntimeWebServiceOptions {
  readonly authorizer: RuntimeWebExecutionAuthorizer;
  readonly policy: RuntimeWebTenantResolver;
  readonly router: RouterWebClient;
  /**
   * Live execution registry. Revocation or control-connection replacement closes the record and
   * aborts any in-flight web call for it, so a stale dispatch can never finish and deliver.
   */
  readonly executions: RuntimeExecutionRegistry;
  readonly now?: () => number;
}

/** Minimum remaining budget worth dispatching; below this the call fails before any egress. */
const MIN_DISPATCH_REMAINING_MS = 250;

interface DispatchInput {
  readonly computerId: string;
  readonly executionId: string;
  readonly toolCallId: string;
  readonly params: WebSearchParams | WebFetchParams;
  /** Budget carried by the caller (header semantics); `undefined` means the operation cap. */
  readonly remainingMs?: number;
  /** Absolute ingress deadline in epoch milliseconds; takes precedence over `remainingMs`. */
  readonly deadlineAt?: number;
  readonly signal?: AbortSignal;
}

/**
 * The two fixed web operations end to end: fence the execution (before dispatch and again before
 * delivery), resolve the Account's configured Router tenant, derive the stable idempotency key,
 * and dispatch with the remaining end-to-end budget. One absolute deadline starts before the
 * first authority await, covers blocked admission and the Router response body, and is cancelled
 * by caller disconnect or execution revocation. No caller input can select the tenant, the
 * target, or the credentials.
 */
export class RuntimeWebService {
  readonly #authorizer: RuntimeWebExecutionAuthorizer;
  readonly #policy: RuntimeWebTenantResolver;
  readonly #router: RouterWebClient;
  readonly #executions: RuntimeExecutionRegistry;
  readonly #now: () => number;

  constructor(options: RuntimeWebServiceOptions) {
    this.#authorizer = options.authorizer;
    this.#policy = options.policy;
    this.#router = options.router;
    this.#executions = options.executions;
    this.#now = options.now ?? Date.now;
  }

  search(input: {
    computerId: string;
    request: WebSearchExecutionRequest;
    remainingMs?: number;
    deadlineAt?: number;
    signal?: AbortSignal;
  }): Promise<WebSearchResult> {
    const { protocolVersion: _protocol, executionId, toolCallId, ...params } = input.request;
    return this.#dispatch("search", {
      computerId: input.computerId,
      executionId,
      toolCallId,
      params,
      ...(input.remainingMs !== undefined ? { remainingMs: input.remainingMs } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }) as Promise<WebSearchResult>;
  }

  fetch(input: {
    computerId: string;
    request: WebFetchExecutionRequest;
    remainingMs?: number;
    deadlineAt?: number;
    signal?: AbortSignal;
  }): Promise<WebFetchResult> {
    const { protocolVersion: _protocol, executionId, toolCallId, ...params } = input.request;
    return this.#dispatch("fetch", {
      computerId: input.computerId,
      executionId,
      toolCallId,
      params,
      ...(input.remainingMs !== undefined ? { remainingMs: input.remainingMs } : {}),
      ...(input.deadlineAt !== undefined ? { deadlineAt: input.deadlineAt } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    }) as Promise<WebFetchResult>;
  }

  async #dispatch(operation: "search" | "fetch", input: DispatchInput): Promise<WebSearchResult | WebFetchResult> {
    const startedAt = this.#now();
    // Absent => operation cap; explicitly invalid (0/negative/NaN) => zero, so it fails closed.
    const budgetMs = capWebTimeoutMs(operation, input.remainingMs);
    const deadlineAt = input.deadlineAt ?? startedAt + budgetMs;
    const remainingToDeadline = deadlineAt - startedAt;
    if (!Number.isFinite(remainingToDeadline) || remainingToDeadline <= 0) {
      throw budgetExhaustedError();
    }
    const revocation = new AbortController();
    const deadlineTimer = setTimeout(() => revocation.abort(budgetExhaustedError()), remainingToDeadline);
    deadlineTimer.unref?.();
    // Revocation/control close aborts the in-flight call; a successor execution gets its own
    // dispatch and is never cancelled by a stale close.
    const unsubscribe = this.#executions.onClose((event) => {
      if (event.executionId === input.executionId) {
        revocation.abort(new RuntimeWebError("execution_closed", "The execution was revoked in flight"));
      }
    });
    const signal = input.signal ? AbortSignal.any([input.signal, revocation.signal]) : revocation.signal;
    const abortError = (): RuntimeWebError =>
      revocation.signal.aborted
        ? asRuntimeWebError(revocation.signal.reason)
        : input.signal?.aborted
          ? asRuntimeWebError(input.signal.reason)
          : new RuntimeWebError("aborted", "The web request was aborted");
    try {
      if (signal.aborted) throw abortError();
      const scope = webServiceScopeForOperation(operation);
      // The authorization/admission awaits are raced against the same signal, so a blocked
      // authority cannot outlive the budget or survive a revoked execution.
      const execution = await raceAbort(
        this.#authorizer.authorize({
          executionId: input.executionId,
          computerId: input.computerId,
          scope,
          signal,
        }),
        signal,
        abortError,
      );
      const tenant = this.#policy.resolveTenant({ accountId: execution.accountId });
      if (!tenant) {
        // Missing per-Account mapping refuses the call; there is no shared default tenant.
        throw new RuntimeWebError("web_disabled", "The web service is not enabled for this Account");
      }
      // Admission time is subtracted immediately before dispatch; the cached budget is not reused.
      const remainingMs = deadlineAt - this.#now();
      if (remainingMs < MIN_DISPATCH_REMAINING_MS) throw budgetExhaustedError();
      const idempotencyKey = deriveWebIdempotencyKey({
        executionId: execution.executionId,
        toolCallId: input.toolCallId,
      });
      const dispatch = {
        idempotencyKey,
        remainingMs,
        routerKey: tenant.routerKey,
        signal,
      };
      // The Router receives business parameters only; identity and tenant never enter the body.
      const result =
        operation === "search"
          ? await this.#router.search({ ...dispatch, params: input.params as WebSearchParams })
          : await this.#router.fetch({ ...dispatch, params: input.params as WebFetchParams });
      // Delivery fence: a revoked/replaced execution must never receive the completed result.
      await raceAbort(
        this.#authorizer.authorize({
          executionId: execution.executionId,
          computerId: input.computerId,
          scope,
          signal,
        }),
        signal,
        abortError,
      );
      return result;
    } catch (error) {
      // Preserve the specific revocation/timeout reason rather than a generic abort code.
      if (
        revocation.signal.aborted &&
        revocation.signal.reason instanceof RuntimeWebError &&
        (!(error instanceof RuntimeWebError) || error.code === "aborted" || error.code === "timeout")
      ) {
        throw revocation.signal.reason;
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      unsubscribe();
    }
  }
}

function budgetExhaustedError(): RuntimeWebError {
  return new RuntimeWebError("timeout", "The remaining web budget was exhausted before dispatch", {
    retryable: true,
  });
}

function asRuntimeWebError(reason: unknown): RuntimeWebError {
  return reason instanceof RuntimeWebError ? reason : new RuntimeWebError("aborted", "The web request was aborted");
}

/** Races one awaited port against the abort signal; the port promise stays handled on abort. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, abortError: () => RuntimeWebError): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
