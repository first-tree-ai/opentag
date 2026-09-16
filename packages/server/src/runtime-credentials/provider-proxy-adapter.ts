import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { RuntimeCredentialProvider } from "@opentag/shared";
import { decodeBufferedBody, requestQuery, slackBufferedBodyKind } from "./buffered-body.js";
import type { RuntimeProxyAuthorization } from "./credential-broker.js";
import {
  bufferProxyBody,
  operationRequiresSourceRecord,
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
  journalSafeResource,
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
import { type RuntimeSourceRecorder, UnavailableRuntimeSourceRecorder } from "./source-recorder.js";
import { forwardUploadWithReceipt } from "./upload-receipt.js";
import {
  RUNTIME_URL_HANDLE_PATH_PREFIX,
  type RuntimeUrlHandle,
  type RuntimeUrlHandleStore,
  rewriteUrlToHandle,
} from "./url-handle-store.js";
import type { RuntimeWriteJournal } from "./write-journal.js";
import {
  beginWriteReceipt,
  classifyStatusWriteReceipt,
  classifyWriteReceipt,
  completeWriteReceipt,
  completeWriteReceiptUnknown,
  type WriteReceiptContext,
} from "./write-receipt.js";

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
  journal: RuntimeWriteJournal;
  /** Durable audit for protected read outputs; fail-closed by default. */
  sourceRecorder?: RuntimeSourceRecorder;
  fetchImpl?: typeof fetch;
  capabilityTtlSeconds?: number;
  now?: () => Date;
}

/** Server-side provider adapter: fixed origins, registered operations, journaled writes. */
export class ImProviderProxyAdapter implements ProviderProxyAdapter {
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #options: ImProviderProxyAdapterOptions;
  readonly #sourceRecorder: RuntimeSourceRecorder;

  constructor(options: ImProviderProxyAdapterOptions) {
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => new Date());
    this.#sourceRecorder = options.sourceRecorder ?? new UnavailableRuntimeSourceRecorder();
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
    const journalContext =
      match.operation.kind === "write"
        ? await this.#beginOperationWrite(match, prepared, request, authorization)
        : undefined;
    try {
      return await this.#forward(match, prepared, headers, request, authorization, journalContext);
    } catch (error) {
      // A durable unknown receipt never overwrites an outcome this write already attempted.
      if (journalContext) {
        await completeWriteReceiptUnknown(this.#options.journal, request.sessionId, journalContext, this.#now);
      }
      if (error instanceof RuntimeProxyError) throw error;
      if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
      if (journalContext) throw new RuntimeProxyError("write_outcome_unknown");
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

  async #recordSource(
    operation: ProviderOperation,
    params: Record<string, string>,
    parsed: unknown,
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<void> {
    const query = requestQuery(request.path);
    const resource = operation.resource?.(params, parsed, query) ?? `operation:${operation.operationId}`;
    await this.#recordResource(resource, request, authorization);
  }

  /**
   * Durable source metadata for one protected output. Records only the bounded resource id and
   * never payloads, URLs, or credentials; a failing recorder fails the response.
   */
  async #recordResource(
    resource: string,
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<void> {
    try {
      await this.#sourceRecorder.recordSource({
        sessionId: authorization.sessionId,
        provider: request.provider,
        resource: journalSafeResource(resource),
        policyRevision: authorization.authorizationRevision,
        recordedAt: this.#now().toISOString(),
      });
    } catch {
      throw new RuntimeProxyError("source_record_unavailable");
    }
  }

  async #beginOperationWrite(
    match: ProviderOperationMatch,
    prepared: { bytes: Uint8Array; parsed: unknown },
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<WriteReceiptContext> {
    const query = requestQuery(request.path);
    const resource =
      match.operation.resource?.(match.params, prepared.parsed, query) ?? `operation:${match.operation.operationId}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify([match.operation.method, request.path, prepared.parsed ?? null]))
      .digest("hex");
    return beginWriteReceipt(this.#options.journal, {
      executionId: request.executionId,
      now: this.#now,
      operation: match.operation.operationId,
      policyRevision: authorization.authorizationRevision,
      provider: request.provider,
      requestHash,
      resource: journalSafeResource(resource),
      sessionId: authorization.sessionId,
    });
  }

  async #forward(
    match: ProviderOperationMatch,
    prepared: { bytes: Uint8Array; parsed: unknown },
    headers: Record<string, string>,
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    journalContext?: WriteReceiptContext,
  ): Promise<ProviderProxyResponse> {
    const operation = match.operation;
    const material = await authorization.resolveMaterial(request.signal);
    // The async material/cipher boundary is over: revalidate the live fence before any upstream byte.
    await authorization.recheck(request.signal);
    const response = await this.#fetchUpstream(operation, prepared, headers, request, material);
    return operation.response === "stream"
      ? this.#streamResponse(match, prepared, request, authorization, response, journalContext)
      : this.#jsonResponse(match, prepared, request, authorization, material, response, journalContext);
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

  async #streamResponse(
    match: ProviderOperationMatch,
    prepared: { bytes: Uint8Array; parsed: unknown },
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    response: Response,
    journalContext?: WriteReceiptContext,
  ): Promise<ProviderProxyResponse> {
    if (operationRequiresSourceRecord(match.operation)) {
      // Durable audit before the first protected byte reaches the caller.
      await this.#recordSource(match.operation, match.params, prepared.parsed, request, authorization);
    }
    if (journalContext) {
      const receipt = classifyStatusWriteReceipt(response.status);
      await completeWriteReceipt(this.#options.journal, request.sessionId, journalContext, receipt, this.#now);
      if (receipt.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
    }
    return {
      status: response.status,
      headers: filterResponseHeaders(response.headers),
      body: response.body ? webBody(response.body) : singleChunk(new Uint8Array(0)),
    };
  }

  async #jsonResponse(
    match: ProviderOperationMatch,
    prepared: { bytes: Uint8Array; parsed: unknown },
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    material: RuntimeProviderMaterial,
    response: Response,
    journalContext?: WriteReceiptContext,
  ): Promise<ProviderProxyResponse> {
    const operation = match.operation;
    const payload = await parseJsonResponse(response, operation.maxResponseBytes ?? 2 * 1024 * 1024);
    if (journalContext) {
      const receipt = classifyWriteReceipt({ payload, provider: request.provider, status: response.status });
      await completeWriteReceipt(this.#options.journal, request.sessionId, journalContext, receipt, this.#now);
      // An unconfirmed or ambiguous outcome must never reach the caller as a successful write.
      if (receipt.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
    }
    const rewritten = rewriteOperationResponse(operation, payload, {
      executionId: request.executionId,
      provider: request.provider,
      origin: material.origin,
      createDownloadHandle: (target, resource) =>
        this.#createHandle(request, material.origin, "download", target, resource),
      createUploadHandle: (target, resource) =>
        this.#createHandle(request, material.origin, "upload", target, resource),
    });
    if (operationRequiresSourceRecord(operation)) {
      // Every protected read records durable metadata before its output is exposed, whether or
      // not the response happened to contain a protected URL to rewrite.
      await this.#recordSource(operation, match.params, prepared.parsed, request, authorization);
    }
    return {
      status: response.status,
      headers: { ...filterResponseHeaders(response.headers), "content-type": "application/json" },
      body: singleChunk(new TextEncoder().encode(JSON.stringify(rewritten.payload))),
    };
  }

  #createHandle(
    request: ProviderProxyRequest,
    origin: string,
    kind: "upload" | "download",
    url: string,
    resource?: string,
  ): string {
    assertHandleUrlAllowed(request.provider, url);
    const handleId = this.#options.urlHandles.create({
      executionId: request.executionId,
      provider: request.provider,
      kind,
      url,
      ...(resource ? { resource } : {}),
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
      return forwardUploadWithReceipt({
        authorization,
        fetchImpl: this.#fetch,
        handle,
        journal: this.#options.journal,
        now: this.#now,
        request,
      });
    }
    // Every protected download records durable metadata before its body is exposed, including
    // handles minted by write responses that only have a write receipt. The handle resource is
    // the file identity; the bounded opaque fallback never contains the upstream URL.
    await this.#recordResource(handle.resource ?? `handle:${handle.handleId}`, request, authorization);
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
