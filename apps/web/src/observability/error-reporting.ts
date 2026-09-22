import { createErrorReport, HTTP_PATHS } from "@opentag/shared/browser";

/** An already-redacted failure the boundaries and window handlers hand over for relaying. */
export type ErrorReportInput = {
  readonly code: string;
  readonly message: string;
  readonly stack?: string;
  /** Overrides the code-and-message pair as the cooldown key, for failures whose message varies per occurrence. */
  readonly dedupeKey?: string;
};

export type ErrorReportSink = (input: ErrorReportInput) => void;

/**
 * What the application knows about itself when a failure happens, as opposed to what the failure
 * itself carries. Both halves move without the sink being rebuilt — a reader signs in, a route
 * resolves — so they are read at report time rather than captured at installation.
 */
export type ErrorReportContext = {
  /** The Account on screen, or `undefined` before sign-in and after signing out. */
  readonly userId?: string;
  /** The matched route template, such as `/agents/:agentId`, which the address alone cannot give. */
  readonly route?: string;
};

export type ErrorReportSinkOptions = {
  readonly fetchImpl?: typeof fetch;
  readonly version?: string;
  readonly environment?: string;
  /** Source of the page URL and user agent; the window by default. */
  readonly target?: () => Pick<Window, "location" | "navigator">;
  /** Source of the Account and route; the module-level context by default. */
  readonly context?: () => ErrorReportContext;
  readonly cooldownMs?: number;
  readonly now?: () => number;
  /** Identifies one report so the server log line and the tracker event can be matched up. */
  readonly reportId?: () => string | undefined;
};

const DEFAULT_COOLDOWN_MS = 30_000;
/** Distinct failures remembered for the cooldown; beyond this the oldest is forgotten first. */
const MAX_TRACKED_FAILURES = 200;

/**
 * Posts each failure to the server relay once per cooldown. The relay is anonymous, so the request
 * carries no credentials, and nothing here may throw or log: a failing reporter inside an error path
 * would only produce more errors.
 */
export function createErrorReportSink(options: ErrorReportSinkOptions = {}): ErrorReportSink {
  const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const now = options.now ?? (() => Date.now());
  const lastSentAt = new Map<string, number>();
  return (input) => {
    try {
      const key = input.dedupeKey ?? `${input.code}\u0000${input.message}`;
      if (!rememberFailure(lastSentAt, key, now(), cooldownMs)) return;
      const target = options.target?.() ?? window;
      const context = options.context?.() ?? currentContext;
      const report = createErrorReport(input, {
        source: "web",
        code: input.code,
        version: options.version,
        environment: options.environment,
        url: target.location.href,
        userAgent: target.navigator.userAgent,
        userId: context.userId,
        route: context.route,
        reportId: (options.reportId ?? randomReportId)(),
      });
      const fetchImpl = options.fetchImpl ?? fetch;
      void Promise.resolve()
        .then(() =>
          fetchImpl(HTTP_PATHS.errorReports, {
            method: "POST",
            keepalive: true,
            credentials: "omit",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(report),
          }),
        )
        .catch(() => undefined);
    } catch {
      // Reporting is best effort; the failure being reported is the one that matters.
    }
  };
}

/**
 * Record a failure and say whether it is due to be sent. The table is bounded: expired entries go
 * first, then the oldest, because Map insertion order is age order and every key is inserted once.
 */
function rememberFailure(lastSentAt: Map<string, number>, key: string, at: number, cooldownMs: number): boolean {
  const previous = lastSentAt.get(key);
  if (previous !== undefined && at >= previous && at - previous < cooldownMs) return false;
  for (const [trackedKey, sentAt] of lastSentAt) {
    if (at - sentAt >= cooldownMs) lastSentAt.delete(trackedKey);
  }
  lastSentAt.delete(key);
  lastSentAt.set(key, at);
  while (lastSentAt.size > MAX_TRACKED_FAILURES) {
    const oldest = lastSentAt.keys().next();
    if (oldest.done) break;
    lastSentAt.delete(oldest.value);
  }
  return true;
}

/**
 * An identifier for one report, or nothing at all.
 *
 * `crypto.randomUUID` needs a secure context, so an application served over plain HTTP — a local
 * build, an internal host — does not have it. That costs the correlation between the tracker event
 * and the server log line; it must not cost the report.
 */
function randomReportId(): string | undefined {
  try {
    return globalThis.crypto?.randomUUID();
  } catch {
    return undefined;
  }
}

let activeSink: ErrorReportSink | undefined;
let currentContext: ErrorReportContext = {};

/** Installed once by the entry point. Tests leave it unset, or inject a recording sink. */
export function setErrorReportSink(sink: ErrorReportSink | undefined): void {
  activeSink = sink;
}

/**
 * Name the Account every later report belongs to, or clear it.
 *
 * Called from the one place the session's two exits are both visible, alongside the analytics
 * identity, so a report cannot outlive the session it names. The relay is anonymous and this value
 * is simply what the browser said: it is a lead for whoever reads the report, not a credential.
 */
export function setErrorReportUser(userId: string | undefined): void {
  currentContext = { ...currentContext, userId };
}

/** Name the route every later report happened on, or clear it. */
export function setErrorReportRoute(route: string | undefined): void {
  currentContext = { ...currentContext, route };
}

/** Test seam: drops the Account and route the module is holding. */
export function resetErrorReportContext(): void {
  currentContext = {};
}

export function forwardErrorReport(input: ErrorReportInput): void {
  activeSink?.(input);
}
