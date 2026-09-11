import { ErrorReporting } from "@google-cloud/error-reporting";
import { type ErrorReportRequest, redactForLog } from "@opentag/shared";
import type { FastifyBaseLogger } from "fastify";

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
  logger: () => FastifyBaseLogger | undefined;
  /** Injectable for tests. Defaults to the Google Cloud SDK, constructed on the first report. */
  createClient?: (projectId: string) => ErrorReportingClient;
}

const SERVICE_BY_SOURCE: Record<ErrorReportRequest["source"], string> = {
  web: "opentag-web",
  cli: "opentag-cli",
};

function defaultCreateClient(projectId: string): ErrorReportingClient {
  /*
   * `reportMode: "always"`: the SDK otherwise reports only under NODE_ENV=production, and a staging
   * container is the environment most likely to be watched. Log level 1 keeps the SDK's own console
   * output to genuine errors such as missing credentials.
   */
  const sdk = new ErrorReporting({ projectId, reportMode: "always", logLevel: 1 });
  return { report: (error, request, callback) => sdk.report(error, request, undefined, callback) };
}

/** The text Error Reporting groups on: the stack when the client sent one, otherwise the message. */
export function reportedMessage(event: ErrorReportRequest): string {
  if (!event.stack) return event.message;
  return event.stack.includes(event.message) ? event.stack : `${event.message}\n${event.stack}`;
}

/**
 * Shape the SDK turns into a `ReportedErrorEvent`. A stack-bearing report is presented as an
 * error so the client's frames are what gets grouped; a message-only report carries a synthetic
 * `reportLocation`, which the API requires when the message is not itself a stack trace.
 */
export function toReportedError(event: ErrorReportRequest): Record<string, unknown> {
  const serviceContext = {
    service: SERVICE_BY_SOURCE[event.source],
    ...(event.version ? { version: event.version } : {}),
  };
  if (event.stack) return { stack: reportedMessage(event), serviceContext };
  return {
    message: event.message,
    filePath: event.url ?? event.command ?? event.source,
    lineNumber: 0,
    functionName: event.code ?? "unknown",
    serviceContext,
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
  return {
    async report(event, context = {}) {
      const safe = redactForLog(event);
      try {
        client ??= createClient(projectId);
        await new Promise<void>((resolve, reject) => {
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
      } catch (error) {
        options
          .logger()
          ?.warn(
            { module: "error-reporting", err: error, source: safe.source, errorCode: safe.code },
            "Forwarding an error report to Google Cloud Error Reporting failed",
          );
      }
    },
  };
}
