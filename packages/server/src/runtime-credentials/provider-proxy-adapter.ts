import { Readable } from "node:stream";
import type { RuntimeCredentialProvider } from "@opentag/shared";
import type { ServiceLogger } from "../observability/service-logger.js";
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

/**
 * How long the proxy waits for the capture port before returning the confirmed provider response.
 * A capture that overruns this is cancelled or abandoned behind its own bounded deadline; the
 * confirmed send is never delayed past this budget and is never retried.
 */
export const OUTBOUND_CAPTURE_WAIT_MS = 2_000;

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
  /** Trusted adapter registers operation-specific authority while the request/response is alive. */
  setRevalidation?: (check: (signal: AbortSignal) => Promise<void>) => void;
}

export interface ProviderProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
}

export interface ProviderProxyAdapter {
  handle(request: ProviderProxyRequest, authorization: RuntimeProxyAuthorization): Promise<ProviderProxyResponse>;
}

/**
 * One verified platform write success handed to the capture port. The payload is the native JSON
 * exactly as the platform returned it, before any temporary-URL rewriting. No headers, tokens, or
 * raw request bytes ever cross this boundary.
 */
export interface OutboundWriteCaptureEvent {
  provider: RuntimeCredentialProvider;
  operationId: string;
  /** Server-authorized binding identity; never taken from the request body. */
  bindingId: string;
  pathParams: Record<string, string>;
  query: string;
  requestBody: unknown;
  responsePayload: unknown;
  /** Present only when the proxy actually appended a Session ID footer to this outbound request. */
  injectedSessionFooter?: { sessionUrl: string; shortId: string };
  observedAt: Date;
}

/**
 * Port for persisting platform-confirmed outbound messages. The adapter calls it at most once per
 * verified write success, after classification and before response rewriting, and isolates it from
 * the caller: a capture failure is logged and swallowed, never a `write_outcome_unknown`, never a
 * resend.
 */
export interface OutboundWriteCapture {
  capture(event: OutboundWriteCaptureEvent): Promise<void>;
}

export interface ImProviderProxyAdapterOptions {
  provider: RuntimeCredentialProvider;
  registry: ProviderOperationRegistry;
  urlHandles: RuntimeUrlHandleStore;
  fetchImpl?: typeof fetch;
  capabilityTtlSeconds?: number;
  /** Public web origin used to append a clickable Session ID footer to outbound IM messages. */
  publicOrigin?: string;
  /**
   * Resolves a Session ID to a stable Task anchor ID at send time (e.g., the latest direct
   * message ID for a group channel Session). Defaults to the Session ID itself.
   */
  resolveTaskAnchor?: (sessionId: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** Optional confirmed-send capture (IM adapters in production); absent keeps the proxy read-only. */
  outboundCapture?: OutboundWriteCapture;
  /** Test/deployment override for the bounded capture-port wait; defaults to the proxy budget. */
  captureWaitMs?: number;
  logger?: Pick<ServiceLogger, "error" | "warn">;
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
    const annotated = await this.#annotateOutboundBodyWithSessionFooter(
      operation,
      prepared,
      headers,
      request,
      authorization,
    );
    try {
      const response = await this.#fetchUpstream(operation, annotated.bytes, headers, request, material);
      return operation.response === "stream"
        ? this.#streamResponse(match, response)
        : await this.#jsonResponse(
            match,
            request,
            authorization,
            material,
            prepared,
            annotated.injectedSessionFooter,
            response,
          );
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
      const prepared = decodeBufferedBody({
        bytes,
        operationBody: operation.body,
        path: request.path,
        provider: request.provider,
        slackKind,
      });
      if (prepared.bytes.byteLength > maxBytes) throw new RuntimeProxyError("body_too_large");
      return prepared;
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
    bodyBytes: Uint8Array,
    headers: Record<string, string>,
    request: ProviderProxyRequest,
    material: RuntimeProviderMaterial,
  ): Promise<Response> {
    const url = `${material.origin}${request.path.startsWith("/") ? request.path : `/${request.path}`}`;
    const upstreamRequestHeaders =
      operation.provider === "slack" &&
      operation.body === "form" &&
      slackBufferedBodyKind(headers["content-type"]) === "json"
        ? { ...headers, "content-type": "application/x-www-form-urlencoded" }
        : headers;
    const init: RequestInit & { duplex?: "half" } = {
      method: operation.method,
      redirect: "error",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      headers: upstreamHeaders(operation.body, upstreamRequestHeaders, material.token),
    };
    if (operation.body === "stream") {
      init.body = Readable.from(request.body);
      init.duplex = "half";
    } else if (operation.body !== "none" && bodyBytes.byteLength > 0) {
      init.body = bodyBytes;
    }
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (request.signal.aborted) throw new RuntimeProxyError("cancelled");
      throw error;
    }
  }

  async #annotateOutboundBodyWithSessionFooter(
    operation: ProviderOperation,
    prepared: { bytes: Uint8Array; parsed: unknown },
    headers: Record<string, string>,
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<AnnotatedOutboundBody> {
    if (!isAnnotatableMessageOperation(operation)) return { bytes: prepared.bytes };
    const origin = this.#options.publicOrigin?.trim().replace(/\/+$/, "");
    if (!origin || authorization.purpose === "validation" || !request.sessionId || !authorization.agentId) {
      return { bytes: prepared.bytes };
    }
    const taskAnchorId =
      (await this.#options.resolveTaskAnchor?.(request.sessionId, request.signal).catch(() => undefined)) ??
      request.sessionId;
    return annotateOutboundBodyWithSessionFooter({
      operation,
      prepared,
      headers,
      request,
      authorization,
      publicOrigin: origin,
      taskAnchorId,
    });
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
    authorization: RuntimeProxyAuthorization,
    material: RuntimeProviderMaterial,
    prepared: { bytes: Uint8Array; parsed: unknown },
    injectedSessionFooter: { sessionUrl: string; shortId: string } | undefined,
    response: Response,
  ): Promise<ProviderProxyResponse> {
    const operation = match.operation;
    const payload = await parseJsonResponse(response, operation.maxResponseBytes ?? 2 * 1024 * 1024);
    if (operation.kind === "write") {
      const outcome = classifyWriteOutcome({ payload, provider: request.provider, status: response.status });
      // An unconfirmed or ambiguous outcome must never reach the caller as a successful write.
      if (outcome.state === "unknown") throw new RuntimeProxyError("write_outcome_unknown");
      if (outcome.state === "succeeded") {
        await this.#captureConfirmedWrite(
          match,
          request,
          authorization,
          prepared.parsed,
          injectedSessionFooter,
          payload,
        );
      }
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

  /**
   * Hand one verified write success to the capture port, before the response is rewritten. The
   * wait is bounded so a stalled port cannot hold the confirmed response, and the capture runs
   * behind its own try/catch so a persistence failure can never downgrade the confirmed send
   * into `write_outcome_unknown` or make the caller retry the platform write.
   */
  async #captureConfirmedWrite(
    match: ProviderOperationMatch,
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    parsedRequest: unknown,
    injectedSessionFooter: { sessionUrl: string; shortId: string } | undefined,
    payload: unknown,
  ): Promise<void> {
    const capture = this.#options.outboundCapture;
    if (!capture) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        capture
          .capture({
            provider: request.provider,
            operationId: match.operation.operationId,
            bindingId: authorization.bindingId,
            pathParams: match.params,
            query: match.query,
            requestBody: parsedRequest,
            responsePayload: payload,
            ...(injectedSessionFooter ? { injectedSessionFooter } : {}),
            observedAt: new Date(),
          })
          .then(() => "settled" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), this.#options.captureWaitMs ?? OUTBOUND_CAPTURE_WAIT_MS);
        }),
      ]);
      if (outcome === "timeout") {
        this.#options.logger?.warn(
          {
            code: "IM_OUTBOUND_CAPTURE_TIMEOUT",
            provider: request.provider,
            operationId: match.operation.operationId,
          },
          "IM outbound capture did not settle before the proxy deadline",
        );
      }
    } catch {
      // Controlled identifiers only: a database failure can embed SQL parameters and bodies.
      this.#options.logger?.error(
        { code: "IM_OUTBOUND_CAPTURE_FAILED", provider: request.provider, operationId: match.operation.operationId },
        "IM outbound capture failed",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
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

const SLACK_TEXT_MAX_CHARS = 4_000;
const SLACK_MARKDOWN_TEXT_MAX_CHARS = 12_000;

interface AnnotatedOutboundBody {
  bytes: Uint8Array;
  injectedSessionFooter?: { sessionUrl: string; shortId: string };
}

function isAnnotatableMessageOperation(operation: ProviderOperation): boolean {
  if (operation.provider === "slack") {
    return operation.operationId === "chat.postMessage" || operation.operationId === "chat.update";
  }
  if (operation.provider === "feishu") {
    return (
      operation.operationId === "feishu.im.messages.create" ||
      operation.operationId === "feishu.im.messages.reply" ||
      operation.operationId === "feishu.im.messages.update" ||
      operation.operationId === "feishu.im.messages.patch"
    );
  }
  return false;
}

function annotateOutboundBodyWithSessionFooter(input: {
  operation: ProviderOperation;
  prepared: { bytes: Uint8Array; parsed: unknown };
  headers: Record<string, string>;
  request: ProviderProxyRequest;
  authorization: RuntimeProxyAuthorization;
  publicOrigin: string | undefined;
  taskAnchorId?: string;
}): AnnotatedOutboundBody {
  const { operation, prepared, headers, request, authorization, publicOrigin, taskAnchorId } = input;
  const footer = buildSessionFooter(publicOrigin, authorization, request, taskAnchorId);
  if (!footer) return { bytes: prepared.bytes };
  let annotated: Uint8Array | undefined;
  if (operation.provider === "slack" && isAnnotatableMessageOperation(operation)) {
    annotated = annotateSlackPostMessage(prepared.parsed, footer.shortId, footer.sessionUrl, headers);
  } else if (operation.provider === "feishu" && isAnnotatableMessageOperation(operation)) {
    annotated = annotateFeishuSend(prepared.parsed, footer.shortId, footer.sessionUrl);
  }
  const maxBytes = operation.maxBodyBytes ?? 128 * 1024;
  if (!annotated || annotated.byteLength > maxBytes) {
    return { bytes: prepared.bytes };
  }
  return { bytes: annotated, injectedSessionFooter: footer };
}

function buildSessionFooter(
  publicOrigin: string | undefined,
  authorization: RuntimeProxyAuthorization,
  request: ProviderProxyRequest,
  taskAnchorId: string = request.sessionId,
): { shortId: string; sessionUrl: string } | undefined {
  const origin = publicOrigin?.trim().replace(/\/+$/, "");
  if (!origin || authorization.purpose === "validation" || !request.sessionId || !authorization.agentId) {
    return undefined;
  }
  return {
    shortId: request.sessionId.slice(0, 8),
    sessionUrl: `${origin}/agents/${encodeURIComponent(authorization.agentId)}/tasks/${encodeURIComponent(taskAnchorId || request.sessionId)}`,
  };
}

function annotateSlackBlocks(blocks: unknown, shortId: string, sessionUrl: string): unknown {
  const footerBlock = {
    type: "context",
    elements: [{ type: "mrkdwn", text: `<${sessionUrl}|Session ${shortId}>` }],
  };
  if (Array.isArray(blocks)) {
    if (blocks.length >= 50 || JSON.stringify(blocks).includes(sessionUrl)) return undefined;
    return [...blocks, footerBlock];
  }
  if (typeof blocks === "string") {
    if (blocks.includes(sessionUrl)) return undefined;
    try {
      const parsed = JSON.parse(blocks) as unknown;
      if (!Array.isArray(parsed) || parsed.length >= 50) return undefined;
      return JSON.stringify([...parsed, footerBlock]);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function annotateSlackPostMessage(
  parsed: unknown,
  shortId: string,
  sessionUrl: string,
  headers: Record<string, string>,
): Uint8Array | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let changed = false;
  const annotatedBlocks = annotateSlackBlocks(record.blocks, shortId, sessionUrl);
  if (annotatedBlocks !== undefined) {
    next.blocks = annotatedBlocks;
    changed = true;
  }
  const textFooter = `\n\n_<${sessionUrl}|Session ${shortId}>_`;
  if (
    typeof record.text === "string" &&
    record.text.trim().length > 0 &&
    !record.text.includes(sessionUrl) &&
    record.text.length + textFooter.length <= SLACK_TEXT_MAX_CHARS
  ) {
    next.text = `${record.text}${textFooter}`;
    changed = true;
  }
  const markdownFooter = `\n\n_[Session ${shortId}](${sessionUrl})_`;
  if (
    typeof record.markdown_text === "string" &&
    record.markdown_text.trim().length > 0 &&
    !record.markdown_text.includes(sessionUrl) &&
    record.markdown_text.length + markdownFooter.length <= SLACK_MARKDOWN_TEXT_MAX_CHARS
  ) {
    next.markdown_text = `${record.markdown_text}${markdownFooter}`;
    changed = true;
  }
  if (!changed) return undefined;
  if (slackBufferedBodyKind(headers["content-type"]) === "form") {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(next)) {
      form.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return new TextEncoder().encode(form.toString());
  }
  return new TextEncoder().encode(JSON.stringify(next));
}

function annotateFeishuPostContent(
  contentObj: Record<string, unknown>,
  shortId: string,
  sessionUrl: string,
): Record<string, unknown> | undefined {
  const footerParagraph = [{ tag: "a", text: `Session ${shortId}`, href: sessionUrl }];
  if (Array.isArray(contentObj.content)) {
    if (JSON.stringify(contentObj.content).includes(sessionUrl)) return undefined;
    return { ...contentObj, content: [...contentObj.content, footerParagraph] };
  }
  let changed = false;
  const next: Record<string, unknown> = { ...contentObj };
  for (const [key, value] of Object.entries(contentObj)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const locale = value as Record<string, unknown>;
    if (!Array.isArray(locale.content) || JSON.stringify(locale.content).includes(sessionUrl)) continue;
    next[key] = { ...locale, content: [...locale.content, footerParagraph] };
    changed = true;
  }
  return changed ? next : undefined;
}

function annotateFeishuInteractiveContent(
  contentObj: Record<string, unknown>,
  shortId: string,
  sessionUrl: string,
): Record<string, unknown> | undefined {
  const link = `[Session ${shortId}](${sessionUrl})`;
  if (contentObj.schema === "2.0") {
    const body =
      contentObj.body && typeof contentObj.body === "object" && !Array.isArray(contentObj.body)
        ? (contentObj.body as Record<string, unknown>)
        : undefined;
    if (!body || !Array.isArray(body.elements) || JSON.stringify(body.elements).includes(sessionUrl)) return undefined;
    return {
      ...contentObj,
      body: {
        ...body,
        elements: [...body.elements, { tag: "markdown", text_size: "notation", content: link }],
      },
    };
  }
  if (!Array.isArray(contentObj.elements) || JSON.stringify(contentObj.elements).includes(sessionUrl)) return undefined;
  return {
    ...contentObj,
    elements: [...contentObj.elements, { tag: "note", elements: [{ tag: "lark_md", content: link }] }],
  };
}

function annotateFeishuSend(parsed: unknown, shortId: string, sessionUrl: string): Uint8Array | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.content !== "string") return undefined;
  let contentObj: Record<string, unknown>;
  try {
    const raw = JSON.parse(record.content) as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    contentObj = raw as Record<string, unknown>;
  } catch {
    return undefined;
  }
  let nextContent: Record<string, unknown> | undefined;
  if (record.msg_type === "text") {
    if (
      typeof contentObj.text === "string" &&
      contentObj.text.trim().length > 0 &&
      !contentObj.text.includes(sessionUrl)
    ) {
      nextContent = { ...contentObj, text: `${contentObj.text}\n\nSession ${shortId}: ${sessionUrl}` };
    }
  } else if (record.msg_type === "post") {
    nextContent = annotateFeishuPostContent(contentObj, shortId, sessionUrl);
  } else if (record.msg_type === "interactive" || record.msg_type === undefined) {
    nextContent = annotateFeishuInteractiveContent(contentObj, shortId, sessionUrl);
  }
  if (!nextContent) return undefined;
  return new TextEncoder().encode(JSON.stringify({ ...record, content: JSON.stringify(nextContent) }));
}
