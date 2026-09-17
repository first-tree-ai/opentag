import { Readable } from "node:stream";
import type { RuntimeCredentialProvider } from "@opentag/shared";
import { decodeBufferedBody, slackBufferedBodyKind } from "./buffered-body.js";
import type { RuntimeProxyAuthorization } from "./credential-broker.js";
import {
  bufferProxyBody,
  type ProviderOperation,
  type ProviderOperationMatch,
  type ProviderOperationRegistry,
  ProviderProxyBodyTooLargeError,
} from "./operation-registry.js";
import type { RuntimeProviderMaterial } from "./provider-material.js";
import {
  assertHandleUrlAllowed,
  filterResponseHeaders,
  isRedirectStatus,
  MAX_HANDLE_REDIRECTS,
  parseJsonResponse,
  RuntimeProxyError,
  rewriteOperationResponse,
  sanitizeRequestHeaders,
  singleChunk,
  UPSTREAM_TIMEOUT_MS,
  upstreamHeaders,
  webBody,
} from "./provider-proxy-support.js";
import { forwardUpload } from "./upload-forward.js";
import {
  RUNTIME_URL_HANDLE_PATH_PREFIX,
  type RuntimeUrlHandle,
  type RuntimeUrlHandleStore,
  rewriteUrlToHandle,
} from "./url-handle-store.js";
import { classifyStatusWriteOutcome, classifyWriteOutcome } from "./write-outcome.js";

export { RuntimeProxyError, type RuntimeProxyFailureCode } from "./provider-proxy-support.js";

export interface ProviderProxyRequest {
  executionId: string;
  sessionId: string;
  provider: RuntimeCredentialProvider;
  bindingId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  capability: string;
  capabilityTtlSeconds: number;
  signal: AbortSignal;
}

export interface ProviderProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export interface ProviderProxyAdapter {
  handle(request: ProviderProxyRequest, authorization: RuntimeProxyAuthorization): Promise<ProviderProxyResponse>;
}

export interface ImProviderProxyAdapterOptions {
  provider: RuntimeCredentialProvider;
  registry: ProviderOperationRegistry;
  urlHandles: RuntimeUrlHandleStore;
  fetchImpl?: typeof fetch;
  capabilityTtlSeconds?: number;
}

/**
 * Server-side provider adapter: fixed origins, registered operations, one upstream attempt per
 * write. Writes are classified in memory as succeeded, definitely rejected, or unknown; an
 * unknown outcome surfaces as `write_outcome_unknown` and is never journaled or replayed.
 */
export class ImProviderProxyAdapter implements ProviderProxyAdapter {
  readonly #fetch: typeof fetch;
  readonly #options: ImProviderProxyAdapterOptions;

  constructor(options: ImProviderProxyAdapterOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  async handle(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<ProviderProxyResponse> {
    if (request.path.startsWith(RUNTIME_URL_HANDLE_PATH_PREFIX)) {
      return this.#handleUrlHandle(request, authorization);
    }
    const match = this.#matchOperation(request, authorization);
    const headers = sanitizeRequestHeaders(request.headers);
    const prepared = await this.#prepareBody(match, request, headers);
    if (match.operation.localResponse) {
      return this.#localResponse(match.operation, prepared.parsed, request);
    }
    return this.#executeForward(match, prepared, headers, request, authorization);
  }

  #matchOperation(request: ProviderProxyRequest, authorization: RuntimeProxyAuthorization): ProviderOperationMatch {
    const match = this.#options.registry.match(request.method, request.path);
    if (!match || match.operation.provider !== request.provider) {
      throw new RuntimeProxyError("operation_not_registered");
    }
    if (authorization.purpose === "validation" && !match.operation.validationAllowed) {
      throw new RuntimeProxyError("validation_scope");
    }
    return match;
  }

  async #executeForward(
    match: ProviderOperationMatch,
    prepared: { bytes: Uint8Array; parsed: unknown },
    headers: Record<string, string>,
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<ProviderProxyResponse> {
    const operation = match.operation;
    // Preflight boundary: material resolution and the live fence revalidation after that async
    // boundary fail with their own codes (or `cancelled`), before any upstream byte is sent.
    let material: RuntimeProviderMaterial;
    try {
      material = await authorization.resolveMaterial(request.signal);
      await authorization.recheck(request.signal);
    } catch (error) {
      if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
      throw error;
    }
    try {
      const response = await this.#fetchUpstream(operation, prepared, headers, request, material);
      return operation.response === "stream"
        ? this.#streamResponse(match, response)
        : await this.#jsonResponse(match, request, material, response);
    } catch (error) {
      if (error instanceof RuntimeProxyError) {
        // A write whose response cannot be parsed or read is an unconfirmed outcome, never a
        // clean `response_invalid` (that code stays accurate for reads) and never a replay.
        if (operation.kind === "write" && error.code === "response_invalid") {
          throw new RuntimeProxyError("write_outcome_unknown");
        }
        throw error;
      }
      if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
      // A write whose outcome cannot be confirmed is reported unknown, never silently retried.
      if (operation.kind === "write") throw new RuntimeProxyError("write_outcome_unknown");
      throw new RuntimeProxyError("upstream_unavailable");
    }
  }

  async #prepareBody(
    match: ProviderOperationMatch,
    request: ProviderProxyRequest,
    headers: Record<string, string>,
  ): Promise<{ bytes: Uint8Array; parsed: unknown }> {
    const operation = match.operation;
    const maxBytes = operation.maxBodyBytes ?? 128 * 1024;
    try {
      if (operation.body === "none") {
        const bytes = await bufferProxyBody(request.body, 0);
        return { bytes, parsed: undefined };
      }
      if (operation.body === "stream") {
        // Upload/file streams are never buffered; their content type is passed through upstream.
        return { bytes: new Uint8Array(0), parsed: undefined };
      }
      const slackKind = request.provider === "slack" ? slackBufferedBodyKind(headers["content-type"]) : undefined;
      if (slackKind === "unsupported") {
        throw new RuntimeProxyError("body_invalid", "Unsupported Slack content type");
      }
      const bytes = await bufferProxyBody(request.body, maxBytes);
      return decodeBufferedBody({
        bytes,
        operationBody: operation.body,
        path: request.path,
        provider: request.provider,
        slackKind,
      });
    } catch (error) {
      if (error instanceof ProviderProxyBodyTooLargeError) throw new RuntimeProxyError("body_too_large");
      if (error instanceof SyntaxError) throw new RuntimeProxyError("body_invalid");
      throw error;
    }
  }

  #localResponse(operation: ProviderOperation, parsed: unknown, request: ProviderProxyRequest): ProviderProxyResponse {
    const payload = operation.localResponse?.(parsed, {
      executionId: request.executionId,
      capabilityTtlSeconds: request.capabilityTtlSeconds,
    });
    const bytes = new TextEncoder().encode(JSON.stringify(payload ?? {}));
    return { status: 200, headers: { "content-type": "application/json" }, body: singleChunk(bytes) };
  }

  async #fetchUpstream(
    operation: ProviderOperation,
    prepared: { bytes: Uint8Array; parsed: unknown },
    headers: Record<string, string>,
    request: ProviderProxyRequest,
    material: RuntimeProviderMaterial,
  ): Promise<Response> {
    const url = `${material.origin}${request.path.startsWith("/") ? request.path : `/${request.path}`}`;
    const init: RequestInit & { duplex?: "half" } = {
      method: operation.method,
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      headers: upstreamHeaders(operation.body, headers, material.token),
    };
    if (operation.body === "stream") {
      init.body = Readable.from(request.body);
      init.duplex = "half";
    } else if (operation.body !== "none" && prepared.bytes.byteLength > 0) {
      init.body = prepared.bytes;
    }
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
      throw error;
    }
  }

  #streamResponse(match: ProviderOperationMatch, response: Response): ProviderProxyResponse {
    if (match.operation.kind === "write") {
      const outcome = classifyStatusWriteOutcome(response.status);
      // An unconfirmed or ambiguous outcome must never reach the caller as a successful write.
      if (outcome.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
    }
    return {
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      body: response.body ? webBody(response.body) : singleChunk(new Uint8Array(0)),
    };
  }

  async #jsonResponse(
    match: ProviderOperationMatch,
    request: ProviderProxyRequest,
    material: RuntimeProviderMaterial,
    response: Response,
  ): Promise<ProviderProxyResponse> {
    const operation = match.operation;
    const payload = await parseJsonResponse(response, operation.maxResponseBytes ?? 2 * 1024 * 1024);
    if (operation.kind === "write") {
      const outcome = classifyWriteOutcome({ payload, provider: request.provider, status: response.status });
      // An unconfirmed or ambiguous outcome must never reach the caller as a successful write.
      if (outcome.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
    }
    const rewritten = rewriteOperationResponse(operation, payload, {
      executionId: request.executionId,
      provider: request.provider,
      origin: material.origin,
      createDownloadHandle: (target) => this.#createHandle(request, material.origin, "download", target),
      createUploadHandle: (target) => this.#createHandle(request, material.origin, "upload", target),
    });
    return {
      status: response.status,
      headers: { ...filterResponseHeaders(response.headers), "content-type": "application/json" },
      body: singleChunk(new TextEncoder().encode(JSON.stringify(rewritten.payload))),
    };
  }

  #createHandle(request: ProviderProxyRequest, origin: string, kind: "upload" | "download", url: string): string {
    assertHandleUrlAllowed(request.provider, url);
    const handleId = this.#options.urlHandles.create({
      executionId: request.executionId,
      provider: request.provider,
      kind,
      url,
    });
    return rewriteUrlToHandle(origin, handleId);
  }

  async #handleUrlHandle(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<ProviderProxyResponse> {
    const kind = request.method === "POST" ? "upload" : request.method === "GET" ? "download" : undefined;
    if (!kind) throw new RuntimeProxyError("operation_not_registered");
    const handle = this.#resolveUrlHandle(request, kind);
    if (kind === "upload") {
      return forwardUpload({
        authorization,
        fetchImpl: this.#fetch,
        handle,
        request,
      });
    }
    // Every handle use re-runs the current fence before touching the upstream URL.
    await authorization.recheck(request.signal);
    return this.#proxyDownload(request, handle.url, authorization);
  }

  #resolveUrlHandle(request: ProviderProxyRequest, kind: "upload" | "download"): RuntimeUrlHandle {
    const handleId = request.path.slice(RUNTIME_URL_HANDLE_PATH_PREFIX.length).split("?", 1)[0] ?? "";
    const handle = this.#options.urlHandles.resolve(handleId, {
      executionId: request.executionId,
      provider: request.provider,
      kind,
    });
    if (!handle) throw new RuntimeProxyError("handle_invalid");
    assertHandleUrlAllowed(request.provider, handle.url);
    return handle;
  }

  async #proxyDownload(
    request: ProviderProxyRequest,
    url: string,
    authorization: RuntimeProxyAuthorization,
  ): Promise<ProviderProxyResponse> {
    const material = await authorization.resolveMaterial(request.signal);
    await authorization.recheck(request.signal);
    let response: Response;
    try {
      response = await this.#followHandleRedirects(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
        headers: { authorization: `Bearer ${material.token}` },
      });
    } catch (error) {
      if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
      if (error instanceof RuntimeProxyError) throw error;
      throw new RuntimeProxyError("upstream_unavailable");
    }
    return {
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      body: response.body ? webBody(response.body) : singleChunk(new Uint8Array(0)),
    };
  }

  /**
   * Slack `url_private*` downloads answer with a redirect to the signed file host. Follow at most
   * a few hops manually so every hop is re-checked against the provider host allowlist; a native
   * signed URL is never returned to the caller either way.
   */
  async #followHandleRedirects(url: string, init: RequestInit): Promise<Response> {
    let current = url;
    for (let redirects = 0; redirects <= MAX_HANDLE_REDIRECTS; redirects += 1) {
      const response = await this.#fetch(current, { ...init, redirect: "manual" });
      if (!isRedirectStatus(response.status)) return response;
      const location = response.headers.get("location");
      if (!location || redirects === MAX_HANDLE_REDIRECTS) throw new RuntimeProxyError("handle_invalid");
      current = new URL(location, current).toString();
      assertHandleUrlAllowed(this.#options.provider, current);
    }
    throw new RuntimeProxyError("handle_invalid");
  }
}
