import { inspect } from "node:util";
import { type ChannelName, createErrorReport, type ErrorReportRequest, HTTP_PATHS } from "@opentag/shared";
import type { ClientLogger } from "./logger.js";

/** How long a CLI waits on the relay before giving up; a failing tracker must not hold a command open. */
export const CLIENT_ERROR_REPORT_TIMEOUT_MS = 3_000;
/** How long a crashing process waits for its last report before exiting anyway. */
export const PROCESS_ERROR_REPORT_WAIT_MS = 2_000;
/** How long a crashing process waits for its stderr output to drain before exiting anyway. */
export const PROCESS_ERROR_FLUSH_WAIT_MS = 1_000;

export interface ClientErrorReportMetadata {
  version: string;
  channel: ChannelName;
  /** The command path without user arguments, such as `agent create`. */
  command?: string | undefined;
  environment?: string | undefined;
  occurredAt?: string | undefined;
  /** Correlates the forwarded tracker event with the server log line holding the rest of this. */
  reportId?: string | undefined;
  /** Operating system, architecture, and runtime version, as `doctor` reports them. */
  platform?: string | undefined;
  /** Who this installation signed in as, when it has; the relay is anonymous and does not verify it. */
  userId?: string | undefined;
  computerId?: string | undefined;
  installationId?: string | undefined;
  /** Set when the failure happened inside an Agent turn rather than in a command. */
  agentId?: string | undefined;
  sessionId?: string | undefined;
  turnId?: string | undefined;
  provider?: string | undefined;
}

/** Redact and bound a thrown value into the relay's request shape. */
export function buildClientErrorReport(error: unknown, metadata: ClientErrorReportMetadata): ErrorReportRequest {
  return createErrorReport(error, { source: "cli", ...metadata });
}

/** The slice of `process` the description reads, so a test can describe a machine it is not on. */
export interface PlatformSource {
  readonly platform: string;
  readonly arch: string;
  readonly version: string;
}

/**
 * The machine a CLI failure happened on, as one line.
 *
 * The same three values `doctor` prints, in the same order, so a report and the diagnostic a reader
 * is asked to run describe the machine identically. One field rather than three because the relay
 * bounds each field it accepts, and this is read rather than queried.
 */
export function describePlatform(source: PlatformSource = process): string {
  return `${source.platform} ${source.arch} node-${source.version}`;
}

export interface ReportClientErrorOptions extends ClientErrorReportMetadata {
  serverUrl: string;
  error: unknown;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number;
}

/**
 * Post one failure to the server relay. Never throws and never carries a credential: the relay is
 * anonymous, and a report that cannot be delivered is simply lost.
 */
export async function reportClientError(options: ReportClientErrorOptions): Promise<{ ok: boolean }> {
  const { serverUrl, error, fetchImpl = fetch, timeoutMs = CLIENT_ERROR_REPORT_TIMEOUT_MS, ...metadata } = options;
  let url: URL;
  try {
    url = new URL(HTTP_PATHS.errorReports, serverUrl);
  } catch {
    return { ok: false };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildClientErrorReport(error, metadata)),
      signal: controller.signal,
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timeout);
  }
}

export type ProcessErrorOrigin = "uncaughtException" | "unhandledRejection";

export interface ProcessErrorTarget {
  on(event: ProcessErrorOrigin, listener: (error: unknown) => void): unknown;
  off(event: ProcessErrorOrigin, listener: (error: unknown) => void): unknown;
}

export interface ProcessErrorReportingOptions {
  report: (error: unknown, origin: ProcessErrorOrigin) => Promise<unknown>;
  logger: ClientLogger;
  target?: ProcessErrorTarget;
  /** Ends the process; `process.exit` by default. Injected so tests can observe the code. */
  exit?: (code: number) => void;
  /**
   * Writes the failure to stderr as Node would have. The default writes through `process.stderr`
   * and resolves once the bytes are handed to the operating system, so a piped stderr keeps the
   * crash output that a synchronous exit would have dropped.
   */
  print?: (error: unknown) => void | Promise<void>;
  waitMs?: number;
}

function writeCrashOutput(error: unknown): Promise<void> {
  return new Promise((resolve) => {
    const flushed = setTimeout(resolve, PROCESS_ERROR_FLUSH_WAIT_MS);
    process.stderr.write(`${inspect(error)}\n`, () => {
      clearTimeout(flushed);
      resolve();
    });
  });
}

function describeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(typeof code === "string" ? { errorCode: code } : {}),
    };
  }
  return { errorMessage: String(error) };
}

/**
 * Report an uncaught exception or unhandled rejection, then end the process the way Node would have.
 *
 * Node's default for both is to print the failure and exit with code 1; installing a listener
 * suppresses that, so this does the same after a bounded wait for the report. Exit codes are
 * unchanged, only the report is added. Returns the function that removes both listeners.
 */
export function installProcessErrorReporting(options: ProcessErrorReportingOptions): () => void {
  const target = options.target ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const print = options.print ?? writeCrashOutput;
  const waitMs = options.waitMs ?? PROCESS_ERROR_REPORT_WAIT_MS;
  let terminating = false;

  const handle = (origin: ProcessErrorOrigin) => (error: unknown) => {
    // A second failure while the first is being reported does not restart the exit.
    if (terminating) return;
    terminating = true;
    try {
      options.logger.error({ origin, ...describeFailure(error) }, "Process terminated by an unhandled failure");
    } catch {
      // The failure below is the one that matters; a logging failure must not hide it.
    }
    const report = Promise.resolve()
      .then(() => options.report(error, origin))
      .catch(() => undefined);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    void Promise.race([report, deadline])
      .then(() => print(error))
      .catch(() => undefined)
      .finally(() => exit(1));
  };

  const onException = handle("uncaughtException");
  const onRejection = handle("unhandledRejection");
  target.on("uncaughtException", onException);
  target.on("unhandledRejection", onRejection);
  return () => {
    target.off("uncaughtException", onException);
    target.off("unhandledRejection", onRejection);
  };
}
