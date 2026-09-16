import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { ProviderOperation, ProviderOperationRewriteContext } from "./operation-registry.js";

export type RuntimeProxyFailureCode =
  | "operation_not_registered"
  | "validation_scope"
  | "header_rejected"
  | "body_invalid"
  | "body_too_large"
  | "write_journal_unavailable"
  | "write_outcome_unknown"
  | "source_record_unavailable"
  | "upstream_unavailable"
  | "handle_invalid"
  | "cancelled"
  | "response_invalid";

export class RuntimeProxyError extends Error {
  constructor(
    readonly code: RuntimeProxyFailureCode,
    message?: string,
  ) {
    super(message ?? `Provider proxy failed: ${code}`);
    this.name = "RuntimeProxyError";
  }
}

export const REQUEST_HEADER_ALLOWLIST = new Set(["content-type", "accept"]);
export const REQUEST_HEADER_REJECT = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "host",
  "proxy-authorization",
  "x-opentag-binding-id",
]);
export const RESPONSE_HEADER_ALLOWLIST = new Set([
  "content-type",
  "content-length",
  "content-disposition",
  "cache-control",
  "retry-after",
  "x-request-id",
  "x-tt-logid",
  "x-oauth-scopes",
  "x-accepted-oauth-scopes",
]);
export const UPSTREAM_TIMEOUT_MS = 30_000;
export const ALLOWED_HANDLE_HOSTS: Record<RuntimeCredentialProvider, ReadonlySet<string>> = {
  slack: new Set(["slack.com", "files.slack.com"]),
  feishu: new Set(["open.feishu.cn", "open.larksuite.com"]),
  github: new Set(["api.github.com", "github.com", "codeload.github.com"]),
};
export const MAX_HANDLE_REDIRECTS = 3;

export async function* singleChunk(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  yield chunk;
}

export async function* webBody(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.byteLength > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function filterResponseHeaders(headers: Headers): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) filtered[name] = value;
  }
  return filtered;
}

export function sanitizeRequestHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (REQUEST_HEADER_REJECT.has(lowered) || lowered.startsWith("x-opentag-")) {
      throw new RuntimeProxyError("header_rejected");
    }
    if (REQUEST_HEADER_ALLOWLIST.has(lowered)) sanitized[lowered] = value;
  }
  return sanitized;
}

export function upstreamHeaders(
  body: "none" | "json" | "form" | "stream",
  headers: Record<string, string>,
  token: string,
): Record<string, string> {
  const upstream: Record<string, string> = { authorization: `Bearer ${token}` };
  const contentType = headers["content-type"];
  if (contentType) upstream["content-type"] = contentType;
  else if (body === "json") upstream["content-type"] = "application/json; charset=utf-8";
  else if (body === "form") upstream["content-type"] = "application/x-www-form-urlencoded";
  if (headers.accept) upstream.accept = headers.accept;
  return upstream;
}

export function journalSafeResource(resource: string): string {
  const sanitized = resource.replace(/[^a-zA-Z0-9:._/@-]/g, "_").slice(0, 512);
  return sanitized.length > 0 ? sanitized : "resource";
}

export function assertHandleUrlAllowed(provider: RuntimeCredentialProvider, url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RuntimeProxyError("handle_invalid");
  }
  if (parsed.protocol !== "https:" || !ALLOWED_HANDLE_HOSTS[provider].has(parsed.hostname.toLowerCase())) {
    throw new RuntimeProxyError("handle_invalid");
  }
}

export function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}
/** Bounded JSON parse used by every registered JSON-response operation. */
export async function parseJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const raw = await readBoundedResponse(response, maxBytes);
  if (raw.byteLength === 0) return {};
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new RuntimeProxyError("response_invalid");
  }
}

/**
 * Reads at most `maxBytes` from a provider response and cancels the reader as soon as the limit
 * is exceeded, so an oversized JSON response is never fully buffered. Empty bodies return `{}`,
 * malformed or oversized JSON fails closed with `response_invalid`.
 */
async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RuntimeProxyError("response_invalid");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Counts created handles so a read with protected URL rewrites is audited through the recorder. */
export function rewriteOperationResponse(
  operation: ProviderOperation,
  payload: unknown,
  context: ProviderOperationRewriteContext,
): { payload: unknown; handles: number } {
  if (!operation.rewriteResponseJson) return { payload, handles: 0 };
  let handles = 0;
  const rewritten = operation.rewriteResponseJson(payload, {
    ...context,
    createDownloadHandle: (target, resource) => {
      handles += 1;
      return context.createDownloadHandle(target, resource);
    },
    createUploadHandle: (target, resource) => {
      handles += 1;
      return context.createUploadHandle(target, resource);
    },
  });
  return { payload: rewritten, handles };
}
