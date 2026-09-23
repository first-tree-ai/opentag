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
 * The schema bounds a report's fields in UTF-16 code units, not bytes: a maximal report written
 * entirely in CJK — 4096 characters of message, 16384 of stack, a full URL and the short fields —
 * is roughly 71 KB on the wire, and the product ships a Chinese UI. 128 KiB keeps every
 * schema-valid report readable with room for JSON escaping, while staying far below Fastify's
 * 1 MiB default: an anonymous endpoint has no reason to read a megabyte it is guaranteed to reject.
 */
export const ERROR_REPORT_BODY_LIMIT_BYTES = 128 * 1024;

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
     * `reportId` is what ties a tracker event back to this line, and `userId` is who to ask. They are
     * lifted from the redacted copy, never from the raw event: the relay is anonymous, so either
     * value is whatever the caller chose to post, credential-shaped or not.
     */
    const errorReport = redactForLog(event);
    request.log.warn(
      {
        module: "error-reporting",
        source: event.source,
        errorCode: event.code,
        reportId: errorReport.reportId,
        userId: errorReport.userId,
        errorReport,
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
