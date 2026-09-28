import {
  capWebTimeoutMs,
  parseWebTimeoutHeader,
  RUNTIME_WEB_FETCH_PATH,
  RUNTIME_WEB_SEARCH_PATH,
  WEB_REQUEST_MAX_BYTES,
  WEB_TIMEOUT_HEADER,
  WebFetchExecutionRequestSchema,
  WebSearchExecutionRequestSchema,
  type WebToolErrorCode,
  type WebToolErrorEnvelope,
  WebToolErrorEnvelopeSchema,
} from "@opentag/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { createServiceLoggerPort } from "../observability/index.js";
import { createComputerAuthPreHandler } from "../plugins/computer-auth.js";
import { RuntimeWebError } from "../runtime-credentials/web-execution.js";
import type { RuntimeWebGatewayTokenStore } from "../runtime-credentials/web-gateway-token-store.js";
import { WEB_GATEWAY_TOKEN_PREFIX } from "../runtime-credentials/web-gateway-token-store.js";
import type { RuntimeWebService } from "../runtime-credentials/web-service.js";
import type { ComputerAuthVerifier } from "../services/computers/index.js";
import { parseRequest } from "./request-validation.js";

export interface RuntimeWebRoutesOptions {
  machineAuth: ComputerAuthVerifier;
  service: RuntimeWebService;
  /**
   * Execution-scoped Cloud bearers. Present only when the deployment enabled web tools; absent, the
   * two routes accept Local machine authentication alone and every Cloud request is refused.
   */
  tokens?: RuntimeWebGatewayTokenStore;
  logger?: ReturnType<typeof createServiceLoggerPort>;
}

/** Authenticated caller of one web route: a Local Computer, or a Cloud execution bearer. */
declare module "fastify" {
  interface FastifyRequest {
    webGatewayContext?: { executionId: string };
  }
}

/** Deterministic status per bounded error code; the envelope stays the only body. */
const ERROR_STATUS: Record<WebToolErrorCode, number> = {
  invalid_request: 400,
  unauthenticated: 401,
  web_disabled: 403,
  credential_scope_denied: 403,
  execution_unknown: 404,
  execution_closed: 409,
  idempotency_conflict: 409,
  request_in_progress: 409,
  request_uncertain: 409,
  insufficient_credit: 402,
  rate_limited: 429,
  timeout: 504,
  aborted: 499,
  upstream_unavailable: 503,
  upstream_error: 502,
  provider_protocol_error: 502,
  response_too_large: 502,
  result_unavailable: 410,
  unknown: 500,
};

/**
 * One absolute request budget per web call. It starts in `onRequest` — before the machine-auth
 * preHandler and before the body is parsed — so authentication, body reads, authority awaits,
 * and the Router response body all share the same decreasing deadline. The timer aborts the
 * service signal and answers a bounded 504 with `Connection: close`; a response-socket close
 * (with `writableFinished` guard) aborts the in-flight call when the caller disconnects.
 */
interface WebRequestBudget {
  readonly controller: AbortController;
  readonly deadlineAt: number;
  /** Remaining budget from the request header (`undefined` when absent or malformed). */
  readonly headerRemainingMs: number | undefined;
  readonly invalidHeader: boolean;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

const budgets = new WeakMap<FastifyRequest, WebRequestBudget>();

/**
 * The two fixed runtime web routes. Inbound `Authorization` is either a Local Computer machine
 * token or the execution web bearer issued for one live Cloud execution; it is consumed for
 * execution fencing only and is never forwarded. A Cloud control credential is explicitly refused
 * here. Outbound Router credentials are reconstructed by the service from deployment config.
 */
export function registerRuntimeWebRoutes(app: FastifyInstance, options: RuntimeWebRoutesOptions): void {
  const authPreHandler = boundedAuthPreHandler(createRuntimeWebAuthPreHandler(options));
  // Fastify 5 route hooks must be async (or callback-style); sync hooks never settle.
  const settleOnSend = async (request: FastifyRequest, _reply: FastifyReply, payload: unknown): Promise<unknown> => {
    settleWebBudget(request);
    return payload;
  };
  app.post(
    RUNTIME_WEB_SEARCH_PATH,
    {
      onRequest: async (request, reply) => {
        startWebBudget(request, reply, "search");
      },
      preHandler: authPreHandler,
      onSend: settleOnSend,
      bodyLimit: WEB_REQUEST_MAX_BYTES,
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const gate = prepareWebRequest(request, reply, options);
      if (!gate) return reply;
      const body = parseRequest(WebSearchExecutionRequestSchema, request.body);
      const mismatch = matchBearerExecution(request, reply, body.executionId);
      if (mismatch) return mismatch;
      return runWebOperation(reply, options, gate.budget, (signal, deadlineAt, remainingMs) =>
        options.service.search({
          computerId: gate.computerId,
          request: body,
          ...(remainingMs !== undefined ? { remainingMs } : {}),
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          signal,
        }),
      );
    },
  );
  app.post(
    RUNTIME_WEB_FETCH_PATH,
    {
      onRequest: async (request, reply) => {
        startWebBudget(request, reply, "fetch");
      },
      preHandler: authPreHandler,
      onSend: settleOnSend,
      bodyLimit: WEB_REQUEST_MAX_BYTES,
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const gate = prepareWebRequest(request, reply, options);
      if (!gate) return reply;
      const body = parseRequest(WebFetchExecutionRequestSchema, request.body);
      const mismatch = matchBearerExecution(request, reply, body.executionId);
      if (mismatch) return mismatch;
      return runWebOperation(reply, options, gate.budget, (signal, deadlineAt, remainingMs) =>
        options.service.fetch({
          computerId: gate.computerId,
          request: body,
          ...(remainingMs !== undefined ? { remainingMs } : {}),
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
          signal,
        }),
      );
    },
  );
}

/** Starts the ingress deadline; never sends a response so authentication precedence is preserved. */
function startWebBudget(request: FastifyRequest, reply: FastifyReply, operation: "search" | "fetch"): void {
  const timeoutRaw = request.headers[WEB_TIMEOUT_HEADER];
  const headerValue = Array.isArray(timeoutRaw) ? timeoutRaw[0] : timeoutRaw;
  const parsed = parseWebTimeoutHeader(headerValue, operation);
  const invalidHeader = headerValue !== undefined && parsed === undefined;
  // A malformed header is rejected later as invalid_request, but the request is still bounded by
  // the operation cap instead of being allowed to run unbounded.
  const budgetMs = parsed ?? capWebTimeoutMs(operation, undefined);
  const budget: WebRequestBudget = {
    controller: new AbortController(),
    deadlineAt: Date.now() + budgetMs,
    headerRemainingMs: parsed,
    invalidHeader,
    timer: setTimeout(() => expireWebBudget(request, reply), budgetMs),
    settled: false,
  };
  budget.timer.unref?.();
  budgets.set(request, budget);
  reply.raw.once("close", () => {
    // `request.raw` close/aborted only observes the request side; once the body is fully read,
    // only the response socket close reflects a caller that hung up mid-dispatch.
    if (budget.settled || reply.raw.writableFinished) return;
    budget.settled = true;
    budget.controller.abort(new RuntimeWebError("aborted", "The web request was aborted"));
  });
}

function expireWebBudget(request: FastifyRequest, reply: FastifyReply): void {
  const budget = budgets.get(request);
  if (!budget || budget.settled) return;
  budget.settled = true;
  budget.controller.abort(
    new RuntimeWebError("timeout", "The web request exceeded its remaining budget", {
      retryable: true,
    }),
  );
  reply.header("connection", "close");
  sendWebError(reply, timeoutError());
}

function settleWebBudget(request: FastifyRequest): void {
  const budget = budgets.get(request);
  if (!budget || budget.settled) return;
  budget.settled = true;
  clearTimeout(budget.timer);
}

function timeoutError(): RuntimeWebError {
  return new RuntimeWebError("timeout", "The web request exceeded its remaining budget", { retryable: true });
}

function abortError(budget: WebRequestBudget): RuntimeWebError {
  return budget.controller.signal.reason instanceof RuntimeWebError
    ? budget.controller.signal.reason
    : new RuntimeWebError("aborted", "The web request was aborted");
}

/**
 * Authentication for the two web routes.
 *
 * Two credential families are accepted and neither can stand in for the other. A Local Computer
 * presents its machine token exactly as before. A Cloud Runner presents the execution web bearer
 * issued over the credential tunnel for one live execution; the request body's `executionId` must
 * then match that bearer. A Cloud control credential is never web authorization, so a machine-auth
 * result for a Cloud Computer is refused here rather than silently accepted as a hardware token.
 */
function createRuntimeWebAuthPreHandler(
  options: RuntimeWebRoutesOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const machineAuth = createComputerAuthPreHandler(options.machineAuth);
  return async function runtimeWebAuthPreHandler(request, reply): Promise<void> {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
    if (token.startsWith(WEB_GATEWAY_TOKEN_PREFIX)) {
      // The bearer family is its own credential space: it never falls through to machine auth, so
      // an unknown, expired, or revoked bearer cannot be reinterpreted as some other credential.
      // All three are one answer — a caller learns only that it may not proceed, never whether the
      // value was ever real.
      const record = options.tokens?.resolve(token);
      if (record) {
        request.webGatewayContext = { executionId: record.executionId };
        return;
      }
      sendWebError(reply, new RuntimeWebError("unauthenticated", "The web execution bearer is invalid"));
      return;
    }
    await machineAuth(request, reply);
    if (request.computerAuthContext?.kind === "cloud") {
      request.computerAuthContext = undefined;
      sendWebError(reply, new RuntimeWebError("unauthenticated", "Cloud Computers must use the execution web bearer"));
    }
  };
}

/** Races the auth preHandler against the ingress deadline instead of awaiting it blindly. */
function boundedAuthPreHandler(
  preHandler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async function runtimeWebAuthPreHandler(request, reply): Promise<void> {
    const budget = budgets.get(request);
    if (!budget) return preHandler(request, reply);
    if (budget.controller.signal.aborted) {
      sendWebError(reply, abortError(budget));
      return;
    }
    const auth = preHandler(request, reply);
    // A blocked verifier may still settle after the deadline; keep its rejection handled.
    auth.catch(() => undefined);
    await Promise.race([auth, waitForAbort(budget.controller.signal)]);
    if (budget.controller.signal.aborted) sendWebError(reply, abortError(budget));
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Authenticated caller identity plus the strict remaining-budget header, or an error reply.
 *
 * A Local request uses the Computer the machine token proved. A bearer request carries no Computer
 * of its own: the identity is read from the live execution record, and the authorizer re-fences it
 * before dispatch and again before delivery.
 */
function prepareWebRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  options: RuntimeWebRoutesOptions,
): { computerId: string; budget: WebRequestBudget } | undefined {
  const budget = budgets.get(request);
  const computerId = request.computerAuthContext?.computerId ?? executionComputerId(request, options, reply);
  if (!computerId) return undefined;
  if (!budget) {
    sendWebError(reply, new RuntimeWebError("unknown", "The web request budget was not initialized"));
    return undefined;
  }
  if (budget.invalidHeader) {
    sendWebError(reply, new RuntimeWebError("invalid_request", "The remaining-budget header is invalid"));
    return undefined;
  }
  if (budget.controller.signal.aborted) {
    sendWebError(reply, abortError(budget));
    return undefined;
  }
  return { computerId, budget };
}

/** The live execution's Computer for a bearer request; unknown executions are not distinguishable. */
function executionComputerId(
  request: FastifyRequest,
  options: RuntimeWebRoutesOptions,
  reply: FastifyReply,
): string | undefined {
  const executionId = request.webGatewayContext?.executionId;
  if (!executionId) {
    sendWebError(reply, new RuntimeWebError("unauthenticated", "Authentication is required"));
    return undefined;
  }
  const computerId = options.service.executionComputerId(executionId);
  if (!computerId) {
    sendWebError(reply, new RuntimeWebError("execution_unknown", "The execution is unknown"));
    return undefined;
  }
  return computerId;
}

/**
 * A bearer authorizes exactly the execution it was issued for. A request naming another execution
 * is refused as unknown: the token is real, but binding it to a foreign body is the confusion the
 * bearer exists to prevent, and the refusal must not confirm that the named execution exists.
 */
function matchBearerExecution(
  request: FastifyRequest,
  reply: FastifyReply,
  executionId: string,
): FastifyReply | undefined {
  const bearerExecutionId = request.webGatewayContext?.executionId;
  if (!bearerExecutionId || bearerExecutionId === executionId) return undefined;
  return sendWebError(reply, new RuntimeWebError("execution_unknown", "The execution is unknown"));
}

/** Run one fenced web operation with abort propagation and the bounded error envelope. */
async function runWebOperation(
  reply: FastifyReply,
  options: RuntimeWebRoutesOptions,
  budget: WebRequestBudget,
  invoke: (signal: AbortSignal, deadlineAt?: number, remainingMs?: number) => Promise<unknown>,
): Promise<FastifyReply> {
  try {
    const result = await invoke(budget.controller.signal, budget.deadlineAt, budget.headerRemainingMs);
    if (budget.controller.signal.aborted) return sendWebError(reply, abortError(budget));
    return reply.code(200).send(result);
  } catch (error) {
    if (error instanceof RuntimeWebError) return sendWebError(reply, error);
    if (budget.controller.signal.aborted) return sendWebError(reply, abortError(budget));
    try {
      options.logger?.warn(
        { code: "runtime_web_route_failed", error: error instanceof Error ? error.name : "Error" },
        "Runtime web route failed",
      );
    } catch {
      // Logging must never replace the error response.
    }
    return sendWebError(reply, new RuntimeWebError("unknown", "The web request failed"));
  }
}

function sendWebError(reply: FastifyReply, error: RuntimeWebError): FastifyReply {
  if (reply.sent) return reply;
  const envelope: WebToolErrorEnvelope = WebToolErrorEnvelopeSchema.parse({
    error: {
      code: error.code,
      message: error.message.slice(0, 256),
      ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    },
  });
  return reply.code(ERROR_STATUS[error.code] ?? 500).send(envelope);
}
