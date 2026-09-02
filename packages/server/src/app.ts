import { randomUUID } from "node:crypto";
import fastifyOpenTelemetry from "@autotelic/fastify-opentelemetry";
import websocket from "@fastify/websocket";
import type { ChannelName } from "@opentag/shared";
import { ErrorEnvelopeSchema, HTTP_PATHS, redactForLog, ServerHealthSchema } from "@opentag/shared";
import { DrizzleQueryError, sql } from "drizzle-orm";
import Fastify, { type FastifyLoggerOptions, type FastifyRequest, LogController } from "fastify";
import { type InternalNavigationVisibilityService, registerAccountRoutes } from "./api/account.js";
import { registerAgentRoutes } from "./api/agents.js";
import { registerAuthRoutes } from "./api/auth.js";
import {
  type BrowserAuthRoutesOptions,
  rateLimitFailureMetadata,
  registerBrowserAuthRoutes,
} from "./api/browser-auth.js";
import { registerComputerRoutes } from "./api/computers.js";
import { registerImBindingRoutes } from "./api/im-bindings.js";
import { registerImResourceRoute } from "./api/im-resources.js";
import { registerMeRoutes } from "./api/me.js";
import { RequestValidationError } from "./api/request-validation.js";
import { type RuntimeRoutesOptions, registerRuntimeRoutes } from "./api/runtime.js";
import { type RuntimeDurableWorkRoutesOptions, registerRuntimeDurableWorkRoutes } from "./api/runtime-durable-work.js";
import { type RuntimeSessionRoutesOptions, registerRuntimeSessionRoutes } from "./api/runtime-sessions.js";
import { registerSlackEventsRoute, type SlackEventsRouteOptions } from "./api/slack-events.js";
import { registerSlackOAuthRoutes, type SlackOAuthRouteOptions } from "./api/slack-oauth.js";

import type { OpenTagBetterAuth } from "./auth/better-auth.js";
import { registerBetterAuthRoutes } from "./auth/fastify-handler.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import type { DatabaseClient } from "./db/client.js";
import { currentTraceId } from "./observability/index.js";
import { type AgentRuntimeTestService, type AgentService, AgentServiceError } from "./services/agents/index.js";
import { AuthServiceError, type ConnectCodeIssuer, type UserAuthService } from "./services/auth/index.js";
import type { ComputerService, MachineAuthService } from "./services/computers/index.js";
import type { ImResourceService } from "./services/im/index.js";
import { type FeishuSetupService, feishuPublicFailure } from "./services/im-bindings/feishu/index.js";
import { type ImBindingService, ImBindingServiceError } from "./services/im-bindings/index.js";
import { SlackConfigurationServiceError } from "./services/im-bindings/slack/index.js";
import { OnboardingResetError, type OnboardingResetService } from "./services/onboarding-reset/index.js";
import { SessionCliProofError, SessionServiceError } from "./services/sessions/index.js";
import { type AccountSetupService, AccountSetupServiceError } from "./services/setup/index.js";
import { TaskQueryError, type TaskService } from "./services/tasks/index.js";
import { registerWebApp } from "./web-app.js";

export interface CreateAppOptions {
  /** Drizzle client used by the readiness probe. The production bootstrap also exposes it through TaskService. */
  database?: DatabaseClient;
  authService?: UserAuthService;
  /** Publishes Better Auth's allowlisted endpoints and lets every authenticated route resolve its sessions. */
  betterAuth?: { instance: OpenTagBetterAuth; publicUrl: string };
  webAppRoot?: string;
  agentService?: AgentService;
  agentRuntimeTestService?: AgentRuntimeTestService;
  computerService?: ComputerService;
  machineAuthService?: MachineAuthService;
  connectCode?: {
    issuer: ConnectCodeIssuer;
    environment: ChannelName;
    publicUrl: string;
  };
  computerConnectCode?: {
    environment: ChannelName;
    publicUrl: string;
  };
  browserAuth?: BrowserAuthRoutesOptions;
  imBindingService?: ImBindingService;
  imResourceService?: ImResourceService;
  feishuSetupService?: FeishuSetupService;
  slackOAuth?: SlackOAuthRouteOptions;
  loggerStream?: FastifyLoggerOptions["stream"];
  loggerLevel?: FastifyLoggerOptions["level"];
  readiness?: BootstrapReadiness;
  runtime?: RuntimeRoutesOptions;
  runtimeSessions?: RuntimeSessionRoutesOptions;
  runtimeDurableWork?: RuntimeDurableWorkRoutesOptions;
  slackEvents?: SlackEventsRouteOptions;
  /**
   * Undoing setup so onboarding can be walked again. Any staging deployment supplies it, and every
   * deployment outside staging stays indistinguishable from one that never had the capability.
   */
  setupResetService?: OnboardingResetService;
  internalNavigationService?: InternalNavigationVisibilityService;
  taskService?: TaskService;
  accountSetupService?: AccountSetupService;
}

export function sanitizeRequestUrl(url: string): string {
  return url.split("?", 1)[0] ?? "/";
}

export function formatHttpSpanName(request: { method?: string; routeOptions?: { url?: string } }): string {
  return `${request.method ?? "GET"} ${request.routeOptions?.url ?? "unmatched"}`;
}

export function ignoreHttpTraceRoute(path: string): boolean {
  const pathname = path.split("?", 1)[0] ?? "/";
  return (
    pathname === "/" ||
    pathname === "/*" ||
    pathname === "/healthz" ||
    pathname === "/readyz" ||
    pathname === HTTP_PATHS.computerRuntimeWebSocket ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/fonts/")
  );
}

function disableProbeRequestLogging(request: FastifyRequest): boolean {
  const pathname = sanitizeRequestUrl(request.url);
  return pathname === "/healthz" || pathname === "/readyz";
}

const MAX_ERROR_STACK_LENGTH = 8_192;
const DATABASE_READINESS_TIMEOUT_MS = 1_000;
const READINESS_ATTEMPT_MAX_AGE_MS = 10_000;

type SerializedError = { type: string; message: string; stack: string };
type DrizzleQueryErrorLike = { params?: unknown; query?: unknown };

function hasOwnField(value: object, key: string): boolean {
  return Object.hasOwn(value, key);
}

function isDrizzleQueryError(error: unknown): error is DrizzleQueryError | (Error & DrizzleQueryErrorLike) {
  if (error instanceof DrizzleQueryError) return true;
  if (typeof error !== "object" || error === null) return false;
  return hasOwnField(error, "query") && hasOwnField(error, "params");
}

function redactLogString(value: string): string {
  const redacted = redactForLog(value);
  return (typeof redacted === "string" ? redacted : String(redacted)).slice(0, MAX_ERROR_STACK_LENGTH);
}

function serializeError(error: unknown): SerializedError {
  if (isDrizzleQueryError(error)) {
    const parameterCount = Array.isArray(error.params) ? error.params.length : undefined;
    const summary = redactLogString(
      `Database query failed${parameterCount === undefined ? "" : ` (${parameterCount} parameter${parameterCount === 1 ? "" : "s"})`}`,
    );
    return {
      type: "DrizzleQueryError",
      message: summary,
      stack: redactLogString(`DrizzleQueryError: ${summary}`),
    };
  }
  if (!(error instanceof Error)) {
    const summary = redactLogString(String(error));
    return { type: typeof error, message: summary, stack: summary };
  }
  return {
    type: error.name,
    message: redactLogString(error.message),
    stack: redactLogString(error.stack ?? `${error.name}: ${error.message}`),
  };
}

class DatabaseReadinessTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Database readiness probe exceeded ${timeoutMs}ms`);
    this.name = "DatabaseReadinessTimeoutError";
  }
}

function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DatabaseReadinessTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

type DatabaseReadinessAttempt = {
  promise: Promise<void>;
  startedAt: number;
};

function createDatabaseReadinessProbe(database: DatabaseClient | undefined): (() => Promise<void>) | undefined {
  if (!database) return undefined;

  let inFlight: DatabaseReadinessAttempt | undefined;
  return async () => {
    const now = Date.now();
    const current = inFlight;
    if (!current || now - current.startedAt >= READINESS_ATTEMPT_MAX_AGE_MS) {
      if (current) {
        void current.promise.catch(() => undefined);
      }
      const execution = Promise.resolve()
        .then(() => database.execute(sql`select 1`))
        .then(() => undefined);
      let attempt: DatabaseReadinessAttempt;
      const settled = execution.finally(() => {
        if (inFlight === attempt) inFlight = undefined;
      });
      attempt = { promise: settled, startedAt: now };
      inFlight = attempt;
    }
    const running = inFlight;
    if (!running) return;
    await withDeadline(running.promise, DATABASE_READINESS_TIMEOUT_MS);
  };
}

function createFastifyLoggerOptions(options: CreateAppOptions): FastifyLoggerOptions {
  return {
    level: options.loggerLevel ?? "info",
    ...(options.loggerStream ? { stream: options.loggerStream } : {}),
    serializers: {
      err: serializeError,
      req: (request) => ({
        method: request.method,
        url: sanitizeRequestUrl(request.url),
        host: request.hostname,
        remoteAddress: request.ip,
        remotePort: request.socket.remotePort,
      }),
    },
  };
}

type ClassifiedFailure = {
  code: string;
  category: string;
  statusCode: number;
};

const rateLimitLogWindows = new WeakMap<object, Map<string, number>>();

function logClassifiedFailure(request: FastifyRequest, failure: ClassifiedFailure, error: unknown): void {
  if (error instanceof AuthServiceError && error.statusCode === 401) return;

  const rateLimit = rateLimitFailureMetadata(error);
  if (failure.code === "RATE_LIMITED" && rateLimit) {
    const route = request.routeOptions?.url ?? sanitizeRequestUrl(request.url);
    const bucket = `${route}:${rateLimit.keyKind}`;
    const now = Date.now();
    const limiterWindows = rateLimitLogWindows.get(rateLimit.limiter) ?? new Map<string, number>();
    const previousResetAt = limiterWindows.get(bucket);
    if (previousResetAt !== undefined && previousResetAt > now) return;
    limiterWindows.set(bucket, now + rateLimit.windowMs);
    rateLimitLogWindows.set(rateLimit.limiter, limiterWindows);
  }

  const level = failure.statusCode >= 500 ? "error" : [409, 429].includes(failure.statusCode) ? "warn" : "info";
  request.log[level](
    {
      category: failure.category,
      code: failure.code,
      err: error,
      requestId: request.id,
      statusCode: failure.statusCode,
      ...(rateLimit ? { keyKind: rateLimit.keyKind } : {}),
    },
    "Request failed",
  );
}

function contentTypeParserErrorStatus(error: unknown): number | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("statusCode" in error) ||
    typeof error.code !== "string" ||
    !error.code.startsWith("FST_ERR_CTP_")
  ) {
    return undefined;
  }
  const statusCode = error.statusCode;
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : undefined;
}

/** Bounded, log-safe shape for a caller-supplied correlation id: the shared request-id contract. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,256}$/;

/**
 * Accept an inbound `x-request-id` only when it matches the bounded identifier contract shared with
 * `StructuredError.requestId`. Anything longer, multi-valued, or carrying characters that would be
 * awkward in a log or span attribute is rejected so the caller gets a minted UUID instead.
 */
export function safeInboundRequestId(header: string | string[] | undefined): string | undefined {
  if (typeof header !== "string") return undefined;
  const candidate = header.trim();
  return SAFE_REQUEST_ID.test(candidate) ? candidate : undefined;
}

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({
    /*
     * requestIdHeader is deliberately false. When it names a header, Fastify adopts that value
     * verbatim and never calls genReqId, so an unbounded or colliding caller-chosen id would flow
     * straight into Pino and OTel. Doing the read here keeps the header contract but validates it.
     */
    requestIdHeader: false,
    logController: new LogController({
      disableRequestLogging: disableProbeRequestLogging,
      requestIdLogLabel: "requestId",
    }),
    genReqId: (request) => safeInboundRequestId(request.headers["x-request-id"]) ?? randomUUID(),
    logger: createFastifyLoggerOptions(options),
  });
  const readiness = options.readiness ?? new BootstrapReadiness();
  const healthDatabase = options.database ?? options.taskService?.database;
  const databaseReadinessProbe = createDatabaseReadinessProbe(healthDatabase);

  if (options.runtimeSessions) registerRuntimeSessionRoutes(app, options.runtimeSessions);
  if (options.runtimeDurableWork) registerRuntimeDurableWorkRoutes(app, options.runtimeDurableWork);

  app.register(fastifyOpenTelemetry, {
    wrapRoutes: true,
    formatSpanName: formatHttpSpanName,
    formatSpanAttributes: {
      request: (request) => ({
        "http.method": request.method,
        "http.url": sanitizeRequestUrl(request.url),
        "http.target": sanitizeRequestUrl(request.url),
        "http.route": request.routeOptions?.url ?? "unmatched",
        "request.id": request.id,
      }),
      reply: (reply) => ({
        "http.status_code": reply.statusCode,
        "http.response.status_code": reply.statusCode,
      }),
      error: (_error) => ({
        "exception.type": "HttpRequestError",
        "exception.message": "Request failed",
      }),
    },
    ignoreRoutes: ignoreHttpTraceRoute,
  });

  app.addHook("onRequest", async (_request, reply) => {
    reply.header("x-request-id", _request.id);
    const traceId = currentTraceId();
    if (traceId) reply.header("x-trace-id", traceId);
  });

  app.get("/healthz", async (_request, reply) => {
    const health = ServerHealthSchema.parse({
      status: "ok",
      service: "opentag-server",
    });

    return reply.code(200).send(health);
  });

  app.get("/readyz", async (request, reply) => {
    const snapshot = readiness.snapshot();
    if (!snapshot.ready) {
      return reply.code(503).send({ status: "not_ready", ...snapshot });
    }
    if (databaseReadinessProbe) {
      try {
        await databaseReadinessProbe();
      } catch (error) {
        request.log.warn({ check: "database", err: error }, "Readiness check failed");
        return reply.code(503).send({ status: "not_ready", ...snapshot });
      }
    }
    return reply.code(200).send({ status: "ready" });
  });

  const slackEvents = options.slackEvents;
  if (slackEvents) {
    app.register(async (slackApp) => registerSlackEventsRoute(slackApp, slackEvents));
  }

  if (options.betterAuth) {
    registerBetterAuthRoutes(app, options.betterAuth.instance, {
      publicUrl: options.betterAuth.publicUrl,
      secureCookies: options.browserAuth?.secureCookies ?? true,
      sessionTtlSeconds: options.browserAuth?.sessionTtlSeconds ?? 60 * 60 * 24 * 7,
    });
  }
  // Signing in has no authenticated caller by definition, so these routes do not depend on the authenticated surface.
  if (options.browserAuth) {
    registerBrowserAuthRoutes(app, {
      ...options.browserAuth,
      ...(options.betterAuth ? { betterAuth: options.betterAuth } : {}),
    });
  }

  if (options.authService) {
    const authService = options.authService;
    const publicOrigin = options.browserAuth?.publicOrigin;
    const authOptions = {
      ...(options.betterAuth ? { betterAuth: options.betterAuth.instance } : {}),
      ...(publicOrigin ? { publicOrigin } : {}),
      /*
       * The pre-handler needs both to renew the double-submit token alongside a rolling session. Without them it
       * silently declines to, and an active browser stays readable while losing the ability to mutate or sign out.
       */
      ...(options.browserAuth
        ? {
            secureCookies: options.browserAuth.secureCookies,
            sessionTtlSeconds: options.browserAuth.sessionTtlSeconds,
          }
        : {}),
    };
    registerAuthRoutes(app, authService);
    registerMeRoutes(app, authService, {
      ...(options.connectCode
        ? {
            connectCodeIssuer: options.connectCode.issuer,
            environment: options.connectCode.environment,
            publicUrl: options.connectCode.publicUrl,
          }
        : {}),
      authOptions,
    });
    if (options.agentService) {
      registerAgentRoutes(app, authService, options.agentService, authOptions, options.agentRuntimeTestService);
    }
    if (
      options.agentService ||
      options.taskService ||
      options.computerService ||
      options.setupResetService ||
      options.accountSetupService ||
      (options.machineAuthService && options.computerConnectCode)
    ) {
      registerAccountRoutes(app, authService, {
        ...(options.agentService ? { agentService: options.agentService } : {}),
        ...(options.computerConnectCode ? { computerConnectCode: options.computerConnectCode } : {}),
        ...(options.computerService ? { computerService: options.computerService } : {}),
        ...(options.machineAuthService ? { machineAuthService: options.machineAuthService } : {}),
        ...(options.accountSetupService ? { accountSetupService: options.accountSetupService } : {}),
        ...(options.taskService ? { taskService: options.taskService } : {}),
        ...(options.setupResetService ? { setupResetService: options.setupResetService } : {}),
        internalNavigationService: options.internalNavigationService,
        authOptions,
      });
    }
    if (options.imBindingService) {
      registerImBindingRoutes(app, authService, options.imBindingService, options.feishuSetupService, authOptions);
    }
    if (options.slackOAuth) registerSlackOAuthRoutes(app, { ...options.slackOAuth, authOptions });
    if (options.imResourceService && options.machineAuthService) {
      registerImResourceRoute(app, options.machineAuthService, options.imResourceService);
    }
    if (options.computerService && options.machineAuthService) {
      const computerService = options.computerService;
      const machineAuthService = options.machineAuthService;
      registerComputerRoutes(app, machineAuthService);
      app.register(async (runtimeApp) => {
        await runtimeApp.register(websocket, { options: { maxPayload: 64 * 1024 } });
        registerRuntimeRoutes(runtimeApp, machineAuthService, computerService, options.runtime);
      });
    }
  }

  if (options.webAppRoot) registerWebApp(app, options.webAppRoot);

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(
      ErrorEnvelopeSchema.parse({
        error: {
          code: "RESOURCE_NOT_FOUND",
          category: "deterministic",
          message: "The requested resource was not found",
          requestId: request.id,
        },
      }),
    ),
  );

  app.setErrorHandler((error, request, reply) => {
    const feishuFailure = feishuPublicFailure(error);
    if (feishuFailure) {
      logClassifiedFailure(request, feishuFailure, error);
      const envelope = ErrorEnvelopeSchema.parse({
        error: {
          code: feishuFailure.code,
          category: feishuFailure.category,
          message: feishuFailure.message,
          requestId: request.id,
        },
      });
      return reply.code(feishuFailure.statusCode).send(envelope);
    }
    if (
      error instanceof AuthServiceError ||
      error instanceof AgentServiceError ||
      error instanceof ImBindingServiceError ||
      error instanceof OnboardingResetError ||
      error instanceof TaskQueryError ||
      error instanceof SlackConfigurationServiceError ||
      error instanceof AccountSetupServiceError
    ) {
      logClassifiedFailure(request, error, error);
      const envelope = ErrorEnvelopeSchema.parse({
        error: {
          code: error.code,
          category: error.category,
          message: error.message,
          requestId: request.id,
        },
      });
      return reply.code(error.statusCode).send(envelope);
    }
    if (error instanceof SessionCliProofError) {
      logClassifiedFailure(request, { code: "SESSION_PROOF_INVALID", category: "credential", statusCode: 401 }, error);
      return reply.code(401).send(
        ErrorEnvelopeSchema.parse({
          error: {
            code: "SESSION_PROOF_INVALID",
            category: "credential",
            message: "The Session CLI proof is invalid or stale",
            requestId: request.id,
          },
        }),
      );
    }
    if (error instanceof SessionServiceError && error.code === "SESSION_CURSOR_INVALID") {
      logClassifiedFailure(request, { code: error.code, category: "validation", statusCode: 400 }, error);
      return reply.code(400).send(
        ErrorEnvelopeSchema.parse({
          error: {
            code: error.code,
            category: "validation",
            message: error.message,
            requestId: request.id,
          },
        }),
      );
    }
    if (error instanceof RequestValidationError) {
      logClassifiedFailure(request, { code: "VALIDATION_ERROR", category: "validation", statusCode: 400 }, error);
      const envelope = ErrorEnvelopeSchema.parse({
        error: {
          code: "VALIDATION_ERROR",
          category: "validation",
          message: "The request payload is invalid",
          requestId: request.id,
          issues: [...error.issues],
        },
      });
      return reply.code(400).send(envelope);
    }
    const statusCode = contentTypeParserErrorStatus(error);
    if (statusCode !== undefined) {
      logClassifiedFailure(request, { code: "VALIDATION_ERROR", category: "validation", statusCode }, error);
      const envelope = ErrorEnvelopeSchema.parse({
        error: {
          code: "VALIDATION_ERROR",
          category: "validation",
          message: "The request payload is invalid",
          requestId: request.id,
        },
      });
      return reply.code(statusCode).send(envelope);
    }
    request.log.error({ err: error }, "Request failed");
    const envelope = ErrorEnvelopeSchema.parse({
      error: {
        code: "INTERNAL_ERROR",
        category: "transient",
        message: "The request could not be completed",
        requestId: request.id,
      },
    });
    return reply.code(500).send(envelope);
  });

  return app;
}
