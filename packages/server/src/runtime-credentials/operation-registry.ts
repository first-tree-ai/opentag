import type { RuntimeCredentialProvider } from "@opentag/shared";

export type ProviderOperationMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ProviderOperationBody = "none" | "json" | "form" | "stream";
export type ProviderOperationResponse = "stream" | "json";

/**
 * One registered provider operation. The table ships with the Server; there is no wildcard
 * operation and no caller-selected upstream. `resource` extracts the stable resource identifier
 * used for authorization and journaling from path params plus a bounded parsed body.
 */
export interface ProviderOperation {
  operationId: string;
  provider: RuntimeCredentialProvider;
  method: ProviderOperationMethod;
  pathTemplate: string;
  kind: "read" | "write";
  body: ProviderOperationBody;
  response: ProviderOperationResponse;
  /** Read-only identity operations a validation-purpose capability may call. */
  validationAllowed?: boolean;
  /**
   * Durable source-recording requirement for reads. Reads default to `"required"`: protected
   * output must be recorded before it is exposed, and a failing recorder fails the response.
   * `"exempt"` is reserved for identity/public operations that return no protected resource.
   */
  sourceRecord?: "required" | "exempt";
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  resource?(params: Record<string, string>, body: unknown, query: URLSearchParams): string | undefined;
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
  createDownloadHandle(url: string, resource?: string): string;
  createUploadHandle(url: string, resource?: string): string;
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
 * Method + normalized-path registry over the concrete operation table. Query strings never
 * influence template identity beyond the operation's own registration.
 */
export class ProviderOperationRegistry {
  readonly #templates = new Map<string, CompiledTemplate[]>();

  constructor(operations: readonly ProviderOperation[]) {
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
    return undefined;
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

/**
 * True when a read must durably record its protected output before returning it. Reads default
 * to required; only explicit identity/public operation metadata opts out.
 */
export function operationRequiresSourceRecord(operation: ProviderOperation): boolean {
  return operation.kind === "read" && operation.sourceRecord !== "exempt";
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
