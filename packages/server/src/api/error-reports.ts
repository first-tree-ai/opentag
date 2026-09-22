import { ErrorReportRequestSchema, HTTP_PATHS, redactForLog, redactSensitive } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createErrorReporter, type ErrorReporter } from "../observability/error-reporting.js";
import { AuthServiceError } from "../services/auth/errors.js";
import { type BrowserAuthRateLimiter, RouteRateLimiter } from "./browser-auth.js";
import { parseRequest } from "./request-validation.js";

/** Reports accepted from one address per minute. Generous for a browser in a crash loop, tight for a flood. */
export const ERROR_REPORT_RATE_LIMIT = 30;
export const ERROR_REPORT_RATE_LIMIT_WINDOW_MS = 60 * 1000;
/**
 * The schema bounds a report to roughly 22 KiB of useful content; this leaves room for JSON overhead
 * and escaping while keeping the route far below Fastify's 1 MiB default. An anonymous endpoint has
 * no reason to read a megabyte it is guaranteed to reject.
 */
export const ERROR_REPORT_BODY_LIMIT_BYTES = 64 * 1024;

export interface ErrorReportRoutesOptions {
  reporter?: ErrorReporter;
  /** Per-address budget; process-local by default, the same trade-off the sign-in routes make. */
  rateLimiter?: BrowserAuthRateLimiter;
}

/**
 * `POST /api/v1/error-reports`, the relay for Web App and CLI failures. Anonymous, because an error
 * before sign-in is still an error; always logged, so an operator without a Google Cloud project
 * still sees it; answered before forwarding, so a client never waits on the error tracker.
 */
export function registerErrorReportRoutes(app: FastifyInstance, options: ErrorReportRoutesOptions = {}): void {
  const reporter = options.reporter ?? createErrorReporter({ logger: () => app.log });
  const rateLimiter =
    options.rateLimiter ?? new RouteRateLimiter(ERROR_REPORT_RATE_LIMIT, ERROR_REPORT_RATE_LIMIT_WINDOW_MS);

  app.post(HTTP_PATHS.errorReports, { bodyLimit: ERROR_REPORT_BODY_LIMIT_BYTES }, async (request, reply) => {
    try {
      rateLimiter.check(request.ip);
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "RATE_LIMITED") {
        throw new AuthServiceError("RATE_LIMITED", "rate_limit", "Too many error reports", 429);
      }
      throw error;
    }
    const event = parseRequest(ErrorReportRequestSchema, request.body);
    /*
     * The log line is capped per field; the forwarded copy keeps the full stack the schema allows.
     *
     * The tracker keeps only the fields it understands, so this line is where the rest of a report's
     * context lives. The identifiers most worth filtering on are lifted out of the nested payload:
     * `reportId` is what ties a tracker event back to this line, and `userId` is who to ask.
     */
    request.log.warn(
      {
        module: "error-reporting",
        source: event.source,
        errorCode: event.code,
        reportId: event.reportId,
        userId: event.userId,
        errorReport: redactForLog(event),
      },
      "Client error reported",
    );
    const { ip } = request;
    void Promise.resolve()
      .then(() => reporter.report(redactSensitive(event), { ip }))
      .catch((error: unknown) => {
        // The reporter contract is to swallow its own failures; one that leaks is still not the caller's problem.
        request.log.warn({ module: "error-reporting", err: error }, "Error reporter failed");
      });
    reply.header("cache-control", "no-store");
    return reply.code(202).send();
  });
}
