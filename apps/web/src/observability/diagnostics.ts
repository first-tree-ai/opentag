import { redactSensitive } from "@opentag/shared/browser";
import { forwardErrorReport } from "./error-reporting.js";

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
const STALE_ASSET_RELOAD_KEY = "opentag:stale-asset-reload";
const STALE_ASSET_RELOAD_COOLDOWN_MS = 60_000;
const STALE_ASSET_UNLOAD_GRACE_MS = 500;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTEGER_SEGMENT = /^\d+$/;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const VITE_CSS_PRELOAD_FAILURE = /Unable to preload CSS for\s+([^\s)'"]+)/i;
const DYNAMIC_IMPORT_FAILURE =
  /(?:Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed)/i;
const ASSET_URL_OR_PATH = /(https?:\/\/[^\s)'"]+|\/assets\/[^\s)'"]+)/i;
const LAZY_ROUTE_UNDEFINED_MODULE =
  /(?:Cannot read properties of undefined \(reading '(?:component|default)'\)|undefined is not an object \(evaluating '[^\n']*component'\)|lazyRouteComponent)/i;

let preloadReloadUnloading = false;

/**
 * Calling `event.preventDefault()` on `vite:preloadError` makes Vite's `__vitePreload` resolve the
 * failed `import()` to `undefined` before `location.reload()` unloads the document, which causes
 * TanStack Router's `lazyRouteComponent` to throw a `TypeError` reading `.component` on `undefined`.
 */
export function isStaleAssetPreloadFallout(error: unknown): boolean {
  return preloadReloadUnloading && LAZY_ROUTE_UNDEFINED_MODULE.test(readReasonText(error));
}

/**
 * The flat expression this module matches `name: value` shapes with.
 *
 * It stays its own expression rather than reading `./sensitive-names.js`: this is a value-shape
 * grammar over an error string, whose `authorization` and cookie entries exist to be pre-empted by the
 * dedicated handling above, while `sensitive-names.ts` answers the different question of whether a
 * *name* is a credential carrier.
 */
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
    if (typeof error.stack === "string") error.stack = redactErrorMessage(error.stack);
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
    /*
     * Relayed before the console cooldown, which keys on route and code only: two different
     * failures with the same code inside one window are one console line but two reports. The sink
     * applies its own code-and-message cooldown. Only the error level is relayed; a warning is a
     * handled or degraded path, not a defect.
     */
    if (level === "error") {
      forwardErrorReport({
        code: safe.code,
        ...diagnosticErrorText(safe),
        ...(typeof safe.requestId === "string" ? { requestId: safe.requestId } : {}),
        ...(typeof safe.traceId === "string" ? { traceId: safe.traceId } : {}),
      });
    }
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

  readNow(): number {
    return this.now();
  }
}

/** The already-redacted message and stack of an envelope, or a description built from its stable fields. */
function diagnosticErrorText(safe: DiagnosticEnvelope): { message: string; stack?: string; dedupeKey?: string } {
  const error = safe.error as { message?: unknown; stack?: unknown } | undefined;
  const stack = typeof error?.stack === "string" && error.stack ? { stack: error.stack } : {};
  const dedupe = safe.code === "resource_load_failed" ? { dedupeKey: safe.code } : {};
  if (typeof error?.message === "string" && error.message) return { message: error.message, ...stack, ...dedupe };
  if (typeof safe.resourcePath === "string") {
    /*
     * A stale client after a deploy hunts for every chunk hash that no longer exists; one relayed
     * report per cooldown says that, one per path would only say it louder.
     */
    return { message: `${safe.code}: ${safe.resourcePath}`, dedupeKey: safe.code };
  }
  if (typeof safe.routeTemplate === "string" && safe.routeTemplate) {
    const issueSummary = formatDiagnosticIssues(safe.issues);
    const message = issueSummary
      ? `${safe.code}: ${safe.routeTemplate} (${issueSummary})`
      : `${safe.code}: ${safe.routeTemplate}`;
    return { message, dedupeKey: `${safe.code}:${safe.routeTemplate}` };
  }
  return { message: safe.code, ...dedupe };
}

function formatDiagnosticIssues(issues: unknown): string {
  if (!Array.isArray(issues)) return "";
  return issues
    .slice(0, 3)
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const rawPath = (entry as { path?: unknown }).path;
      const path = Array.isArray(rawPath) ? rawPath.map(String).join(".") : typeof rawPath === "string" ? rawPath : "";
      const rawCode = (entry as { code?: unknown }).code;
      const code = typeof rawCode === "string" && rawCode ? rawCode : "invalid";
      return [`${path || "<root>"}:${code}`];
    })
    .join(", ");
}

/**
 * Register global listeners for failures that React root handlers cannot observe: unhandled promise
 * rejections, uncaught exceptions outside React, and same-origin resource load failures.
 */
export function installWindowDiagnosticHandlers(
  target: Window = window,
  reporter: DiagnosticReporter = windowDiagnosticReporter,
): () => void {
  preloadReloadUnloading = false;
  let reloadSource: "preload" | "rejection" | "element" | undefined;
  let reloadAt = -Infinity;

  const shouldSuppressForStaleAsset = (
    source: "preload" | "rejection" | "element",
    resourcePath: string | undefined,
  ): boolean => {
    if (!resourcePath?.startsWith("/assets/")) return false;
    const now = reporter.readNow();
    if (reloadSource !== undefined && now >= reloadAt && now - reloadAt < STALE_ASSET_UNLOAD_GRACE_MS) {
      if (source === "preload") preloadReloadUnloading = true;
      return true;
    }
    if (!tryReloadOnStaleAsset(target, resourcePath, () => now)) return false;
    reloadSource = source;
    reloadAt = now;
    preloadReloadUnloading = true;
    return true;
  };

  const onUnhandledRejection = (event: PromiseRejectionEvent) => {
    if (isStaleAssetPreloadFallout(event.reason)) return;
    const staleAssetPath = extractStaleAssetPath(event.reason, target);
    if (staleAssetPath) {
      if (shouldSuppressForStaleAsset("rejection", staleAssetPath)) return;
      const normalized = normalizeError(event.reason, "resource_load_failed");
      reporter.report(
        {
          source: "window",
          code: "resource_load_failed",
          routeTemplate: "window",
          resourcePath: staleAssetPath,
          error: { name: normalized.error.name, message: normalized.error.message, stack: normalized.error.stack },
        },
        "error",
      );
      return;
    }
    const normalized = normalizeError(event.reason, "unhandled_rejection");
    reporter.report(
      {
        source: "window",
        code: normalized.code,
        routeTemplate: "window",
        error: { name: normalized.error.name, message: normalized.error.message, stack: normalized.error.stack },
      },
      "error",
    );
  };

  const onVitePreloadError = (event: Event) => {
    const payload = (event as { payload?: unknown }).payload;
    const resourcePath = extractStaleAssetPath(payload, target);
    if (shouldSuppressForStaleAsset("preload", resourcePath ?? "/assets/")) {
      event.preventDefault();
      return;
    }
    const normalized = payload !== undefined ? normalizeError(payload, "resource_load_failed") : undefined;
    reporter.report(
      {
        source: "window",
        code: "resource_load_failed",
        routeTemplate: "window",
        ...(resourcePath ? { resourcePath } : {}),
        ...(normalized
          ? { error: { name: normalized.error.name, message: normalized.error.message, stack: normalized.error.stack } }
          : {}),
      },
      "error",
    );
  };

  const onWindowError = (event: ErrorEvent) => {
    // An uncaught exception outside React (a timer, a native listener) arrives as an ErrorEvent
    // carrying the thrown value; a resource that failed to load carries none and targets its element.
    const thrown = event.error;
    if ((thrown !== undefined && thrown !== null) || event.target === target) {
      if (isStaleAssetPreloadFallout(thrown ?? event.message)) return;
      const normalized = normalizeError(thrown ?? event.message, "unhandled_error");
      reporter.report(
        {
          source: "window",
          code: normalized.code,
          routeTemplate: "window",
          error: { name: normalized.error.name, message: normalized.error.message, stack: normalized.error.stack },
        },
        "error",
      );
      return;
    }
    const resource = readResourceTarget(event.target);
    /*
     * Only this origin's own resources are this application's failures. A third-party resource that
     * does not load is routinely a content blocker, an extension, or a network policy — a choice
     * somebody made rather than a defect — and reporting it would turn that choice into an error on
     * every page load, including in suites that fail a run on any console error at all.
     */
    if (!resource || !isSameOrigin(resource.source, target)) return;
    const resourcePath = resourcePathWithoutQuery(resource.source, target);
    if (shouldSuppressForStaleAsset("element", resourcePath)) return;
    reporter.report(
      {
        source: "window",
        code: "resource_load_failed",
        routeTemplate: "window",
        resourceType: resource.resourceType,
        resourcePath,
      },
      "error",
    );
  };

  target.addEventListener("unhandledrejection", onUnhandledRejection);
  target.addEventListener("vite:preloadError", onVitePreloadError);
  target.addEventListener("error", onWindowError, true);
  return () => {
    preloadReloadUnloading = false;
    target.removeEventListener("unhandledrejection", onUnhandledRejection);
    target.removeEventListener("vite:preloadError", onVitePreloadError);
    target.removeEventListener("error", onWindowError, true);
  };
}

function readResourceTarget(
  target: EventTarget | null,
): { resourceType: "script" | "link"; source: string } | undefined {
  if (target instanceof HTMLScriptElement) return { resourceType: "script", source: target.src };
  if (target instanceof HTMLLinkElement) return { resourceType: "link", source: target.href };
  return undefined;
}

/**
 * Reload once per route within a 60-second window when a hashed `/assets/*` chunk or stylesheet
 * disappears after a deployment. If the reload fails or repeats within the window, fall back to
 * reporting `resource_load_failed` so genuine broken assets still surface.
 */
function tryReloadOnStaleAsset(target: Window, resourcePath: string | undefined, now: () => number): boolean {
  if (!resourcePath?.startsWith("/assets/")) return false;
  try {
    const reload = target.location?.reload;
    const storage = target.sessionStorage;
    if (typeof reload !== "function" || !storage) return false;
    const pathname = target.location?.pathname || "/";
    const currentTime = now();
    if (hasRecentReload(storage.getItem(STALE_ASSET_RELOAD_KEY), pathname, currentTime)) return false;
    storage.setItem(STALE_ASSET_RELOAD_KEY, JSON.stringify({ pathname, at: currentTime }));
    reload.call(target.location);
    return true;
  } catch {
    return false;
  }
}

function hasRecentReload(raw: string | null, pathname: string, currentTime: number): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { pathname?: unknown; at?: unknown };
    return (
      parsed?.pathname === pathname &&
      typeof parsed.at === "number" &&
      currentTime >= parsed.at &&
      currentTime - parsed.at < STALE_ASSET_RELOAD_COOLDOWN_MS
    );
  } catch {
    return false;
  }
}

function extractStaleAssetPath(reason: unknown, target: Window): string | undefined {
  const text = readReasonText(reason);
  if (!text) return undefined;
  const cssPreload = VITE_CSS_PRELOAD_FAILURE.exec(text)?.[1];
  if (cssPreload) return assetPath(cssPreload, target);
  if (!DYNAMIC_IMPORT_FAILURE.test(text)) return undefined;
  const candidate = ASSET_URL_OR_PATH.exec(text)?.[1];
  return candidate && isSameOrigin(candidate, target) ? assetPath(candidate, target) : undefined;
}

function readReasonText(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (!reason || typeof reason !== "object") return "";
  const { message, stack } = reason as { message?: unknown; stack?: unknown };
  const head = typeof message === "string" ? message : "";
  const tail = typeof stack === "string" ? `\n${stack}` : "";
  return `${head}${tail}`;
}

function assetPath(source: string, target: Window): string | undefined {
  const pathname = resourcePathWithoutQuery(source, target);
  return pathname?.startsWith("/assets/") ? pathname : undefined;
}

function isSameOrigin(source: string, target: Window): boolean {
  if (!source) return false;
  try {
    return new URL(source, target.location.href).origin === target.location.origin;
  } catch {
    return false;
  }
}

function resourcePathWithoutQuery(source: string, target: Window = window): string | undefined {
  if (!source) return undefined;
  try {
    return new URL(source, target.location.href).pathname;
  } catch {
    return undefined;
  }
}

export const windowDiagnosticReporter = new DiagnosticReporter();
