import { redactSensitive } from "@opentag/shared/browser";

export type DiagnosticSource = "api" | "ui" | "window";
export type DiagnosticLevel = "warn" | "error";

export type DiagnosticEnvelope = {
  readonly source: DiagnosticSource;
  readonly code: string;
  readonly routeTemplate: string;
  readonly [key: string]: unknown;
};

export type NormalizedError = {
  readonly error: Error;
  readonly code: string;
};

export type DiagnosticReporterOptions = {
  readonly cooldownMs?: number;
  readonly now?: () => number;
  readonly warn?: (...args: unknown[]) => void;
  readonly error?: (...args: unknown[]) => void;
};

const DEFAULT_COOLDOWN_MS = 30_000;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_SEGMENT = /^\d+$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

const credentialKey = "(?:password|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)";
const quotedValue = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')`;
const arrayValue = String.raw`\[(?:${quotedValue}|[^\[\]"'])*\]`;
const objectValue = String.raw`\{(?:${quotedValue}|[^{}"'])*\}`;
const structuredValue = `(?:${arrayValue}|${objectValue}|${quotedValue})`;
const structuredValueWithBoundary = String.raw`${structuredValue}(?=\s*(?:[,}\n]|$))`;
const authorizationField = new RegExp(
  String.raw`(["']?authorization["']?\s*[:=]\s*)(${structuredValueWithBoundary}|[^\r\n]*)`,
  "gi",
);
const cookieField = new RegExp(
  String.raw`(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*)(${structuredValueWithBoundary}|[^\r\n]*)`,
  "gi",
);
const credentialField = new RegExp(
  String.raw`(["']?${credentialKey}["']?\s*[:=]\s*)(Bearer\s+(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)|"[^"]*"|'[^']*'|[^\s,;}\]]+)`,
  "gi",
);

/** Redact credential-shaped values from a flat diagnostic string. */
export function redactErrorMessage(message: string): string {
  return message
    .replace(
      authorizationField,
      (_match, prefix: string, value: string) => `${prefix}${redactAuthorizationValue(value)}`,
    )
    .replace(cookieField, (_match, prefix: string) => `${prefix}[REDACTED]`)
    .replace(
      credentialField,
      (_match, prefix: string, value: string) =>
        `${prefix}${/^Bearer\s/i.test(value) ? "Bearer [REDACTED]" : "[REDACTED]"}`,
    )
    .replace(/\bBearer\s+(?!\[REDACTED\])(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:code|client_secret|token|secret|password|key)=)[^&#\s]+/gi, "$1[REDACTED]");
}

function redactAuthorizationValue(value: string): string {
  const trimmed = value.trim();
  const quote = /^("|')Bearer\s/i.exec(trimmed)?.[1] ?? "";
  if (!/^['"]?Bearer\s/i.test(trimmed)) return "[REDACTED]";
  return `${quote}Bearer [REDACTED]${quote && trimmed.endsWith(quote) ? quote : ""}`;
}

/** Convert a concrete request path into a low-cardinality, query-free route template. */
export function routeTemplate(path: string): string {
  const pathname = path.split(/[?#]/, 1)[0] || "/";
  return pathname
    .split("/")
    .map((segment) => (UUID_SEGMENT.test(segment) || INTEGER_SEGMENT.test(segment) ? ":id" : segment))
    .join("/");
}

/** Normalize thrown values without using localized message text as the aggregation key. */
export function normalizeError(value: unknown, fallbackCode = "unhandled_error"): NormalizedError {
  const error = isErrorValue(value)
    ? value
    : new Error(typeof value === "string" ? value : "Unknown application error");
  const code = readStableCode(value) ?? (isAbortError(value) ? "cancelled" : (stableName(error.name) ?? fallbackCode));
  return { error, code };
}

function isErrorValue(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (!value || typeof value !== "object") return false;
  const tag = Object.prototype.toString.call(value);
  return tag === "[object Error]" || tag === "[object DOMException]";
}

function readStableCode(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as { code?: unknown }).code;
  return typeof candidate === "string" && SAFE_CODE.test(candidate) ? candidate : undefined;
}

function stableName(name: string): string | undefined {
  const normalized = name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized || normalized.toLowerCase() === "error") return undefined;
  return normalized.toLowerCase();
}

function isAbortError(value: unknown): boolean {
  return isErrorValue(value) && value.name === "AbortError";
}

/**
 * Apply the flat-string redactor before the shared recursive redactor. The first pass handles
 * free-form Error fields and component stacks; the second pass handles structured keys and values.
 */
export function createDiagnosticEnvelope(input: DiagnosticEnvelope): DiagnosticEnvelope {
  const flat = { ...input } as Record<string, unknown>;
  if (typeof flat.componentStack === "string") flat.componentStack = redactErrorMessage(flat.componentStack);
  if (typeof flat.message === "string") flat.message = redactErrorMessage(flat.message);
  if (typeof flat.name === "string") flat.name = redactErrorMessage(flat.name);
  if (flat.error && typeof flat.error === "object" && !Array.isArray(flat.error)) {
    const error = { ...(flat.error as Record<string, unknown>) };
    if (typeof error.message === "string") error.message = redactErrorMessage(error.message);
    if (typeof error.name === "string") error.name = redactErrorMessage(error.name);
    flat.error = error;
  }
  return redactSensitive(flat) as DiagnosticEnvelope;
}

/** Console reporter with low-cardinality (route template, error code) cooldown. */
export class DiagnosticReporter {
  private readonly lastReportedAt = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly warnLogger: (...args: unknown[]) => void;
  private readonly errorLogger: (...args: unknown[]) => void;

  constructor(options: DiagnosticReporterOptions = {}) {
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
    this.now = options.now ?? (() => Date.now());
    this.warnLogger = options.warn ?? ((...args: unknown[]) => console.warn(...args));
    this.errorLogger = options.error ?? ((...args: unknown[]) => console.error(...args));
  }

  report(input: DiagnosticEnvelope, level: DiagnosticLevel = "warn"): boolean {
    const safe = createDiagnosticEnvelope(input);
    const key = `${safe.routeTemplate}\u0000${safe.code}`;
    const now = this.now();
    const previous = this.lastReportedAt.get(key);
    if (previous !== undefined && now >= previous && now - previous < this.cooldownMs) return false;
    this.lastReportedAt.set(key, now);
    const logger = level === "error" ? this.errorLogger : this.warnLogger;
    logger("[OpenTag] Diagnostic", safe);
    return true;
  }

  clear(): void {
    this.lastReportedAt.clear();
  }
}

/** Register global listeners for failures that React root handlers cannot observe. */
export function installWindowDiagnosticHandlers(
  target: Window = window,
  reporter: DiagnosticReporter = windowDiagnosticReporter,
): () => void {
  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    const normalized = normalizeError(event.reason, "unhandled_rejection");
    reporter.report(
      {
        source: "window",
        code: normalized.code,
        routeTemplate: "window",
        error: { name: normalized.error.name, message: normalized.error.message },
      },
      "error",
    );
  };

  const onResourceError = (event: ErrorEvent) => {
    const element = event.target;
    if (!(element instanceof HTMLScriptElement) && !(element instanceof HTMLLinkElement)) return;
    const resourceType = element instanceof HTMLScriptElement ? "script" : "link";
    const source = element instanceof HTMLScriptElement ? element.src : element.href;
    reporter.report(
      {
        source: "window",
        code: "resource_load_failed",
        routeTemplate: "window",
        resourceType,
        resourcePath: resourcePathWithoutQuery(source),
      },
      "error",
    );
  };

  target.addEventListener("unhandledrejection", onUnhandledRejection);
  target.addEventListener("error", onResourceError, true);
  return () => {
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
    target.removeEventListener("error", onResourceError, true);
  };
}

function resourcePathWithoutQuery(source: string): string | undefined {
  if (!source) return undefined;
  try {
    return new URL(source, window.location.href).pathname;
  } catch {
    return undefined;
  }
}

export const windowDiagnosticReporter = new DiagnosticReporter();
