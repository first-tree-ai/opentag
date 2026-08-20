import fastifyOpenTelemetry from "@autotelic/fastify-opentelemetry";
import websocket from "@fastify/websocket";
import type { ChannelName } from "@opentag/shared";
import { ErrorEnvelopeSchema, HTTP_PATHS, ServerHealthSchema } from "@opentag/shared";
import Fastify, { type FastifyLoggerOptions } from "fastify";
import { registerAgentRoutes } from "./api/agents.js";
import { registerAuthRoutes } from "./api/auth.js";
import { type BrowserAuthRoutesOptions, registerBrowserAuthRoutes } from "./api/browser-auth.js";
import { registerComputerRoutes } from "./api/computers.js";
import { registerImBindingRoutes } from "./api/im-bindings.js";
import { registerImResourceRoute } from "./api/im-resources.js";
import { registerInvitationRoutes } from "./api/invitations.js";
import { registerMeRoutes } from "./api/me.js";
import { RequestValidationError } from "./api/request-validation.js";
import { type RuntimeRoutesOptions, registerRuntimeRoutes } from "./api/runtime.js";
import { registerSlackEventsRoute, type SlackEventsRouteOptions } from "./api/slack-events.js";
import { registerTeamRoutes } from "./api/teams.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { currentTraceId } from "./observability/index.js";
import { type AgentService, AgentServiceError } from "./services/agents/index.js";
import { AuthServiceError, type ConnectCodeIssuer, type UserAuthService } from "./services/auth/index.js";
import type { ComputerService } from "./services/computers/index.js";
import type { ImResourceService } from "./services/im/index.js";
import { type FeishuSetupService, feishuPublicFailure } from "./services/im-bindings/feishu/index.js";
import { type ImBindingService, ImBindingServiceError } from "./services/im-bindings/index.js";
import type { InvitationService } from "./services/invitations/index.js";
import type { TeamMembershipService } from "./services/teams/index.js";
import { registerWebApp } from "./web-app.js";

export interface CreateAppOptions {
  authService?: UserAuthService;
  webAppRoot?: string;
  agentService?: AgentService;
  computerService?: ComputerService;
  connectCode?: {
    issuer: ConnectCodeIssuer;
    environment: ChannelName;
    publicUrl: string;
  };
  browserAuth?: BrowserAuthRoutesOptions;
  invitationService?: InvitationService;
  imBindingService?: ImBindingService;
  imResourceService?: ImResourceService;
  feishuSetupService?: FeishuSetupService;
  loggerStream?: FastifyLoggerOptions["stream"];
  readiness?: BootstrapReadiness;
  runtime?: RuntimeRoutesOptions;
  slackEvents?: SlackEventsRouteOptions;
  teamService?: TeamMembershipService;
}

export function sanitizeRequestUrl(url: string): string {
  const path = url.split("?", 1)[0] ?? "/";
  return path
    .replace(/^(\/invites\/)[^/]+/, "$1[REDACTED]")
    .replace(/^(\/api\/v1\/invitations\/)[^/]+/, "$1[REDACTED]");
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

export function createApp(options: CreateAppOptions = {}) {
  const app = Fastify({
    logger: {
      ...(options.loggerStream ? { stream: options.loggerStream } : {}),
      serializers: {
        req: (request) => ({
          method: request.method,
          url: sanitizeRequestUrl(request.url),
          host: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket.remotePort,
        }),
      },
    },
  });
  const readiness = options.readiness ?? new BootstrapReadiness();

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

  app.get("/readyz", async (_request, reply) => {
    const snapshot = readiness.snapshot();
    if (!snapshot.ready) {
      return reply.code(503).send({ status: "not_ready", ...snapshot });
    }
    return reply.code(200).send({ status: "ready" });
  });

  const slackEvents = options.slackEvents;
  if (slackEvents) {
    app.register(async (slackApp) => registerSlackEventsRoute(slackApp, slackEvents));
  }

  if (options.authService) {
    const authService = options.authService;
    const publicOrigin = options.browserAuth?.publicOrigin;
    registerAuthRoutes(app, authService);
    registerMeRoutes(app, authService, {
      ...(options.connectCode
        ? {
            connectCodeIssuer: options.connectCode.issuer,
            environment: options.connectCode.environment,
            publicUrl: options.connectCode.publicUrl,
          }
        : {}),
      publicOrigin,
    });
    if (options.browserAuth) registerBrowserAuthRoutes(app, authService, options.browserAuth);
    if (options.agentService) {
      registerAgentRoutes(app, authService, options.agentService, publicOrigin);
    }
    if (options.teamService) {
      registerTeamRoutes(app, authService, options.teamService, publicOrigin);
    }
    if (options.invitationService) {
      registerInvitationRoutes(app, authService, options.invitationService, publicOrigin);
    }
    if (options.imBindingService) {
      registerImBindingRoutes(app, authService, options.imBindingService, options.feishuSetupService, publicOrigin);
    }
    if (options.imResourceService) {
      registerImResourceRoute(app, authService, options.imResourceService, publicOrigin);
    }
    if (options.computerService) {
      const computerService = options.computerService;
      registerComputerRoutes(app, authService, computerService, publicOrigin);
      app.register(async (runtimeApp) => {
        await runtimeApp.register(websocket, { options: { maxPayload: 64 * 1024 } });
        registerRuntimeRoutes(runtimeApp, authService, computerService, options.runtime);
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
      error instanceof ImBindingServiceError
    ) {
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
    if (error instanceof RequestValidationError) {
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
