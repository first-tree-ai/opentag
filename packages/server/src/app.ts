import { ErrorEnvelopeSchema, ServerHealthSchema } from "@opentag/shared";
import Fastify from "fastify";
import { registerAuthRoutes } from "./api/auth.js";
import { registerMeRoute } from "./api/me.js";
import { RequestValidationError } from "./api/request-validation.js";
import { BootstrapReadiness } from "./bootstrap-readiness.js";
import { AuthServiceError, type UserAuthService } from "./services/auth/index.js";

export interface CreateAppOptions {
  authService?: UserAuthService;
  readiness?: BootstrapReadiness;
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
    registerAuthRoutes(app, options.authService);
    registerMeRoute(app, options.authService);
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
