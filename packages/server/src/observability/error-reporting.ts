import { ErrorReporting } from "@google-cloud/error-reporting";
import { type ErrorReportRequest, redactSensitive } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";
import type { ErrorReportingCredentials } from "../error-reporting-config.js";
import { markExternalCallTimedOut, traceExternalCall } from "./external-call-logger.js";
import type { PerformanceLogger } from "./performance-logger.js";

/** Forwards one relayed client failure. Implementations never throw; a lost report is logged, not surfaced. */
export interface ErrorReporter {
  report(event: ErrorReportRequest, context?: { ip?: string }): Promise<void>;
}

/** The slice of the Google Cloud SDK the reporter drives, so tests can hand in a fake and stay offline. */
export interface ErrorReportingClient {
  report(
    error: object,
    request: { method?: string; url?: string; userAgent?: string; remoteAddress?: string },
    callback: (error: Error | null) => void,
  ): unknown;
}

export interface ErrorReporterOptions {
  /** Unset disables forwarding; the relay then only writes the server log line. */
  projectId?: string | undefined;
  /** An explicit service account key; unset uses Application Default Credentials. */
  credentials?: ErrorReportingCredentials | undefined;
  logger: () => FastifyBaseLogger | undefined;
  /** Injectable for tests. Defaults to the Google Cloud SDK, constructed on the first report. */
  createClient?: (projectId: string, credentials?: ErrorReportingCredentials) => ErrorReportingClient;
  /** Longest a single forward may take before it is given up on and logged. */
  timeoutMs?: number;
  performanceLogger?: PerformanceLogger;
}

/**
 * The SDK sets no deadline of its own and retries with backoff, so a blocked or slow egress to
 * Google would otherwise hold a forward open indefinitely.
 */
export const ERROR_REPORT_FORWARD_TIMEOUT_MS = 5_000;

const SERVICE_BY_SOURCE: Record<ErrorReportRequest["source"], string> = {
  web: "opentag-web",
  cli: "opentag-cli",
};
const V8_STACK_FRAME = /(?:^|\n)\s*at\s+\S/;
const noop = () => undefined;

function silenceSdkLogger(sdk: unknown): void {
  const logger = (sdk as { _logger?: Record<string, unknown> } | null)?._logger;
  if (!logger || typeof logger !== "object") return;
  for (const level of ["fatal", "error", "warn", "info", "debug", "trace"]) {
    logger[level] = noop;
  }
}

function sanitizedForwardError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(redactSensitive(String(error)));
  const clean = new Error(redactSensitive(error.message));
  clean.name = error.name;
  if (error.stack) clean.stack = redactSensitive(error.stack);
  return clean;
}

function defaultCreateClient(projectId: string, credentials?: ErrorReportingCredentials): ErrorReportingClient {
  /*
   * `reportMode: "always"`: the SDK otherwise reports only under NODE_ENV=production, and a staging
   * container is the environment most likely to be watched. `createLogger` in @google-cloud/error-reporting
   * treats `logLevel: 0` as falsy (`Number(0) || 2` -> warn); `-1` clamps to `fatal` during construction
   * and `silenceSdkLogger` replaces all `_logger` methods with no-ops so `sendError` never writes raw
   * transport errors or headers to console.
   */
  const sdk = new ErrorReporting({
    projectId,
    reportMode: "always",
    logLevel: -1,
    ...(credentials ? { credentials } : {}),
  });
  silenceSdkLogger(sdk);
  return { report: (error, request, callback) => sdk.report(error, request, undefined, callback) };
}

/** The text Error Reporting groups on: the stack when the client sent one, otherwise the message. */
export function reportedMessage(event: ErrorReportRequest): string {
  if (!event.stack) return event.message;
  return event.stack.includes(event.message) ? event.stack : `${event.message}\n${event.stack}`;
}

/**
 * The line that carries a report's own identifier into the tracker event, so the event can be
 * joined back to the server log line holding the rest of the report's context.
 *
 * The SDK forwards nothing but the message text, the user, the service context, the report
 * location, and the HTTP request, so the identifier has to ride in the text. It goes last:
 * Error Reporting groups a stack trace by exception type and its five topmost frames, and a bare
 * message by its first three tokens, so a trailing line changes neither grouping while staying
 * visible in the event's message.
 */
export function reportIdMarker(reportId: string): string {
  return `[reportId=${reportId}]`;
}

function withReportIdMarker(text: string, reportId: string | undefined): string {
  return reportId ? `${text}\n${reportIdMarker(reportId)}` : text;
}

/**
 * Who the report says it came from, for `context.user`.
 *
 * The relay is anonymous, so this is what the caller claimed rather than what the server verified —
 * it groups a tracker event with the person to ask about it, and proves nothing. A CLI that has only
 * ever connected a Computer knows no Account, so its Computer is the next best handle and is prefixed
 * rather than passed bare, so the two kinds of identifier can never be mistaken for each other.
 */
function reportedUser(event: ErrorReportRequest): string | undefined {
  if (event.userId) return event.userId;
  if (event.computerId) return `computer:${event.computerId}`;
  return undefined;
}

/**
 * Shape the SDK turns into a `ReportedErrorEvent`. A stack-bearing report is presented as an
 * error so the client's frames are what gets grouped; a message-only report carries a synthetic
 * `reportLocation`, which the API requires when the message is not itself a stack trace.
 *
 * Only the fields the SDK reads reach the tracker: it copies `user`, `serviceContext` and the
 * report-location trio off this object and drops everything else. The rest of a report's context —
 * platform, route, Agent, Computer — is kept on the server's own log line instead, correlated by
 * `reportId`, which is why that one identifier is written into the reported text itself.
 */
export function toReportedError(event: ErrorReportRequest): Record<string, unknown> {
  const serviceContext = {
    service: SERVICE_BY_SOURCE[event.source],
    ...(event.version ? { version: event.version } : {}),
  };
  const user = reportedUser(event);
  const attribution = { ...(user ? { user } : {}), serviceContext };
  const text = withReportIdMarker(reportedMessage(event), event.reportId);
  // Error Reporting rejects an empty reportLocation with HTTP 400 unless the text has V8 `at ...` frames.
  if (event.stack && V8_STACK_FRAME.test(event.stack)) return { stack: text, ...attribution };
  return {
    message: text,
    filePath: event.url ?? event.command ?? event.source,
    lineNumber: 0,
    functionName: event.code ?? "unknown",
    ...attribution,
  };
}

export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const { projectId } = options;
  if (!projectId) {
    let announced = false;
    return {
      async report() {
        if (announced) return;
        announced = true;
        options
          .logger()
          ?.info({ module: "error-reporting" }, "Error reports are logged only; GOOGLE_CLOUD_PROJECT is not set");
      },
    };
  }

  let client: ErrorReportingClient | undefined;
  const createClient = options.createClient ?? defaultCreateClient;
  const timeoutMs = options.timeoutMs ?? ERROR_REPORT_FORWARD_TIMEOUT_MS;
  return {
    async report(event, context = {}) {
      // No per-field cap here: the log line already applied one, and the schema bounds the stack.
      const safe = redactSensitive(event);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        client ??= options.credentials ? createClient(projectId, options.credentials) : createClient(projectId);
        const forward = new Promise<void>((resolve, reject) => {
          client?.report(
            toReportedError(safe),
            {
              ...(safe.source === "web" ? { method: "GET" } : {}),
              ...(safe.url ? { url: safe.url } : {}),
              ...(safe.userAgent ? { userAgent: safe.userAgent } : {}),
              ...(context.ip ? { remoteAddress: context.ip } : {}),
            },
            (error) => (error ? reject(error) : resolve()),
          );
        });
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(markExternalCallTimedOut(new Error(`Error report forwarding exceeded ${timeoutMs}ms`))),
            timeoutMs,
          );
        });
        await traceExternalCall(
          options.performanceLogger,
          {
            provider: "gcp-error-reporting",
            operation: "external.gcp.error-reporting.report",
            attributes: { source: safe.source },
          },
          () => Promise.race([forward, deadline]),
        );
      } catch (error) {
        options
          .logger()
          ?.warn(
            { module: "error-reporting", err: sanitizedForwardError(error), source: safe.source, errorCode: safe.code },
            "Forwarding an error report to Google Cloud Error Reporting failed",
          );
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}
