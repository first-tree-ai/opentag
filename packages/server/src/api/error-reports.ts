import { ErrorReportRequestSchema, HTTP_PATHS, redactForLog } from "@opentag/shared";
import type { FastifyInstance } from "fastify";
import { createErrorReporter, type ErrorReporter } from "../observability/error-reporting.js";
import { AuthServiceError } from "../services/auth/errors.js";
import { type BrowserAuthRateLimiter, RouteRateLimiter } from "./browser-auth.js";
import { parseRequest } from "./request-validation.js";

/** Reports accepted from one address per minute. Generous for a browser in a crash loop, tight for a flood. */
export const ERROR_REPORT_RATE_LIMIT = 30;
export const ERROR_REPORT_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export interface ErrorReportRoutesOptions {
  reporter?: ErrorReporter;
  /** Per-address budget; process-local by default, the same trade-off the sign-in routes make. */
  rateLimiter?: BrowserAuthRateLimiter;
}

/**
 * `POST /api/v1/error-reports`: the relay Web App and CLI failures travel through.
 *
 * No authentication, because an error before sign-in is still an error. The body is strictly
 * validated and bounded, the caller is rate limited by address, and the redacted event is always
 * written to the server log so an operator without a Google Cloud project still sees it. The reply
 * is `202` regardless of whether forwarding succeeded: a client is never made to wait on, or fail
 * because of, an error tracker.
 */
export function registerErrorReportRoutes(app: FastifyInstance, options: ErrorReportRoutesOptions = {}): void {
  const reporter = options.reporter ?? createErrorReporter({ logger: () => app.log });
  const rateLimiter =
    options.rateLimiter ?? new RouteRateLimiter(ERROR_REPORT_RATE_LIMIT, ERROR_REPORT_RATE_LIMIT_WINDOW_MS);

  app.post(HTTP_PATHS.errorReports, async (request, reply) => {
    try {
      rateLimiter.check(request.ip);
    } catch (error) {
      if (error instanceof AuthServiceError && error.code === "RATE_LIMITED") {
        throw new AuthServiceError("RATE_LIMITED", "rate_limit", "Too many error reports", 429);
      }
      throw error;
    }
    const event = redactForLog(parseRequest(ErrorReportRequestSchema, request.body));
    request.log.warn(
      { module: "error-reporting", source: event.source, errorCode: event.code, errorReport: event },
      "Client error reported",
    );
    try {
      await reporter.report(event, { ip: request.ip });
    } catch (error) {
      // The reporter contract is to swallow its own failures; one that leaks is still not the caller's problem.
      request.log.warn({ module: "error-reporting", err: error }, "Error reporter failed");
    }
    reply.header("cache-control", "no-store");
    return reply.code(202).send();
  });
}
