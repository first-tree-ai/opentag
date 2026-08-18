import websocket from "@fastify/websocket";
import { ErrorEnvelopeSchema, ServerHealthSchema } from "@opentag/shared";
import Fastify from "fastify";
import { registerAuthRoutes } from "./api/auth.js";
import { registerComputerRoutes } from "./api/computers.js";
import { registerMeRoute } from "./api/me.js";
import { RequestValidationError } from "./api/request-validation.js";
import { type RuntimeRoutesOptions, registerRuntimeRoutes } from "./api/runtime.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { AuthServiceError, type UserAuthService } from "./services/auth/index.js";
import type { ComputerService } from "./services/computers/index.js";

export interface CreateAppOptions {
  authService?: UserAuthService;
  computerService?: ComputerService;
  readiness?: BootstrapReadiness;
  runtime?: RuntimeRoutesOptions;
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
  const app = Fastify({ logger: true });
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

  if (options.authService) {
    const authService = options.authService;
    registerAuthRoutes(app, authService);
    registerMeRoute(app, authService);
    if (options.computerService) {
      const computerService = options.computerService;
      registerComputerRoutes(app, authService, computerService);
      app.register(async (runtimeApp) => {
        await runtimeApp.register(websocket, { options: { maxPayload: 64 * 1024 } });
        registerRuntimeRoutes(runtimeApp, authService, computerService, options.runtime);
      });
    }
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthServiceError) {
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
