import websocket from "@fastify/websocket";
import { ErrorEnvelopeSchema, ServerHealthSchema } from "@opentag/shared";
import Fastify, { type FastifyLoggerOptions } from "fastify";
import { registerAdminWeb } from "./admin-web.js";
import { registerAgentRoutes } from "./api/agents.js";
import { registerAuthRoutes } from "./api/auth.js";
import { type BrowserAuthRoutesOptions, registerBrowserAuthRoutes } from "./api/browser-auth.js";
import { registerComputerRoutes } from "./api/computers.js";
import { registerInvitationRoutes } from "./api/invitations.js";
import { registerMeRoute } from "./api/me.js";
import { RequestValidationError } from "./api/request-validation.js";
import { type RuntimeRoutesOptions, registerRuntimeRoutes } from "./api/runtime.js";
import { registerTeamRoutes } from "./api/teams.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { type AgentService, AgentServiceError } from "./services/agents/index.js";
import { AuthServiceError, type UserAuthService } from "./services/auth/index.js";
import type { ComputerService } from "./services/computers/index.js";
import type { InvitationService } from "./services/invitations/index.js";
import type { TeamMembershipService } from "./services/teams/index.js";

export interface CreateAppOptions {
  authService?: UserAuthService;
  adminWebRoot?: string;
  agentService?: AgentService;
  computerService?: ComputerService;
  browserAuth?: BrowserAuthRoutesOptions;
  invitationService?: InvitationService;
  loggerStream?: FastifyLoggerOptions["stream"];
  readiness?: BootstrapReadiness;
  runtime?: RuntimeRoutesOptions;
  teamService?: TeamMembershipService;
}

export function sanitizeRequestUrl(url: string): string {
  const path = url.split("?", 1)[0] ?? "/";
  return path.replace(/^(\/invite\/)[^/]+/, "$1[REDACTED]").replace(/^(\/api\/v1\/invitations\/)[^/]+/, "$1[REDACTED]");
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

  if (options.adminWebRoot) registerAdminWeb(app, options.adminWebRoot);

  if (options.authService) {
    const authService = options.authService;
    const publicOrigin = options.browserAuth?.publicOrigin;
    registerAuthRoutes(app, authService);
    registerMeRoute(app, authService, publicOrigin);
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
    if (options.computerService) {
      const computerService = options.computerService;
      registerComputerRoutes(app, authService, computerService, publicOrigin);
      app.register(async (runtimeApp) => {
        await runtimeApp.register(websocket, { options: { maxPayload: 64 * 1024 } });
        registerRuntimeRoutes(runtimeApp, authService, computerService, options.runtime);
      });
    }
  }

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
    if (error instanceof AuthServiceError || error instanceof AgentServiceError) {
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
    const statusCode = contentTypeParserErrorStatus(error);
    if (error instanceof RequestValidationError || statusCode !== undefined) {
      const envelope = ErrorEnvelopeSchema.parse({
        error: {
          code: "VALIDATION_ERROR",
          category: "validation",
          message: "The request payload is invalid",
          requestId: request.id,
        },
      });
      return reply.code(statusCode ?? 400).send(envelope);
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
