import type { RuntimeCredentialProvider } from "@opentag/shared";

export type ProviderOperationMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
/** `auto` streams multipart bodies and forwards any other body as bounded raw bytes. */
export type ProviderOperationBody = "none" | "json" | "form" | "stream" | "auto";
/** `auto` parses JSON content types and streams any other response (downloads). */
export type ProviderOperationResponse = "stream" | "json" | "auto";

/**
 * One provider operation. Explicit operations ship with the Server and always match first; a
 * provider passthrough rule may then supply a generic operation for any other path under its
 * fixed origin and prefix (see {@link ProviderPassthroughRule}). The caller never selects the
 * upstream origin.
 */
export interface ProviderOperation {
  operationId: string;
  provider: RuntimeCredentialProvider;
  method: ProviderOperationMethod;
  pathTemplate: string;
  kind: "read" | "write";
  body: ProviderOperationBody;
  response: ProviderOperationResponse;
  /** Generic operation supplied by a passthrough rule rather than the explicit table. */
  passthrough?: boolean;
  /** Read-only identity operations a validation-purpose capability may call. */
  validationAllowed?: boolean;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  /**
   * Operations answered locally by the Server without any upstream call (e.g. the Feishu tenant
   * token endpoint, which must never expose the real token).
   */
  localResponse?(body: unknown, context: ProviderOperationLocalContext): unknown;
  /** Bounded response JSON rewriting (e.g. signed URL → Server-held handle). */
  rewriteResponseJson?(body: unknown, context: ProviderOperationRewriteContext): unknown;
}

export interface ProviderOperationLocalContext {
  executionId: string;
  /** Capability lifetime hint for locally answered platform handshakes; never a real token. */
  capabilityTtlSeconds: number;
}

export interface ProviderOperationRewriteContext {
  executionId: string;
  provider: RuntimeCredentialProvider;
  origin: string;
  createDownloadHandle(url: string): string;
  createUploadHandle(url: string): string;
}

export interface ProviderOperationMatch {
  operation: ProviderOperation;
  params: Record<string, string>;
  /** Raw query string (without `?`), forwarded verbatim after registration checks. */
  query: string;
}

const MAX_PATH_BYTES = 8192;

/**
 * Normalized path check: rejects path confusion (`//`, `.` segments, backslashes, encoded
 * separators) before any template matching so authorization can never be bypassed by aliases.
 */
export function normalizeProxyPath(raw: string): { path: string; query: string } | undefined {
  if (raw.length === 0 || raw.length > MAX_PATH_BYTES || !raw.startsWith("/")) return undefined;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f || char === "\\") return undefined;
  }
  const [pathname, ...queryParts] = raw.split("?");
  const query = queryParts.join("?");
  if (!pathname || pathname.includes("//")) return undefined;
  const lowered = pathname.toLowerCase();
  if (lowered.includes("%2f") || lowered.includes("%5c") || lowered.includes("%00")) return undefined;
  const segments = pathname.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "." || segment === "..") return undefined;
  }
  return { path: pathname, query };
}

interface CompiledTemplate {
  operation: ProviderOperation;
  segments: readonly string[];
}

/**
 * Fallback for requests no explicit operation matches. It receives the normalized path (no query)
 * and returns the generic operation to apply, or `undefined` when the path is outside its prefix
 * or on its denylist.
 */
export interface ProviderPassthroughRule {
  resolve(method: string, path: string): ProviderOperation | undefined;
}

/**
 * Method + normalized-path registry over the concrete operation table, with an optional
 * passthrough rule consulted only after every explicit template misses. Query strings never
 * influence template identity beyond the operation's own registration.
 */
export class ProviderOperationRegistry {
  readonly #templates = new Map<string, CompiledTemplate[]>();
  readonly #passthrough: ProviderPassthroughRule | undefined;

  constructor(operations: readonly ProviderOperation[], passthrough?: ProviderPassthroughRule) {
    this.#passthrough = passthrough;
    for (const operation of operations) {
      const normalized = normalizeProxyPath(operation.pathTemplate);
      if (!normalized || normalized.query) throw new Error(`Invalid operation path template ${operation.pathTemplate}`);
      const list = this.#templates.get(operation.method) ?? [];
      list.push({ operation, segments: normalized.path.split("/").slice(1) });
      this.#templates.set(operation.method, list);
    }
  }

  match(method: string, rawPath: string): ProviderOperationMatch | undefined {
    const normalized = normalizeProxyPath(rawPath);
    if (!normalized) return undefined;
    const segments = normalized.path.split("/").slice(1);
    for (const candidate of this.#templates.get(method) ?? []) {
      const params = matchTemplateSegments(candidate.segments, segments);
      if (params) return { operation: candidate.operation, params, query: normalized.query };
    }
    const operation = this.#passthrough?.resolve(method, normalized.path);
    return operation ? { operation, params: {}, query: normalized.query } : undefined;
  }
}

/** Returns the captured path params when the actual segments match the compiled template. */
function matchTemplateSegments(
  template: readonly string[],
  actual: readonly string[],
): Record<string, string> | undefined {
  if (template.length !== actual.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < actual.length; index += 1) {
    const expected = template[index];
    const value = actual[index];
    if (expected === undefined || value === undefined) return undefined;
    if (expected.startsWith("{") && expected.endsWith("}")) {
      params[expected.slice(1, -1)] = value;
      continue;
    }
    if (expected !== value) return undefined;
  }
  return params;
}

export class ProviderProxyBodyTooLargeError extends Error {
  constructor() {
    super("The provider request body exceeds the registered bound");
    this.name = "ProviderProxyBodyTooLargeError";
  }
}

/** Bounded body buffering used only for operations registered with a parsed body kind. */
export async function bufferProxyBody(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new ProviderProxyBodyTooLargeError();
    chunks.push(chunk);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/**
 * Path for audit logs: keeps API words and version segments, replaces every segment that may be
 * an identifier (digits, uppercase, or other characters) with `{id}`. Never logs query values.
 */
export function redactProxyPath(path: string): string {
  const [pathname = ""] = path.split("?", 1);
  return pathname
    .split("/")
    .map((segment) => (segment === "" || /^(?:v\d+|[a-z]+(?:[_-][a-z]+)*)$/.test(segment) ? segment : "{id}"))
    .join("/");
}
